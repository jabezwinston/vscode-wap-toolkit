/**
 *  Copyright (C) 2026 Jabez Winston
 *
 *  SPDX-License-Identifier: Apache-2.0
 *
 *  WSP client — connectionless GET and connection-oriented POST.
 *
 *  All protocol behaviour lives here: PDU assembly, transaction-id matching,
 *  retransmission, WTP acknowledgement and the two-phase Connect/Post exchange.
 *  The only thing injected is the datagram socket itself, because that is the
 *  one piece a browser cannot provide — the VS Code extension backs it with
 *  node's dgram, the Android port with a Kotlin DatagramSocket.
 *
 *  Reference: WAP-230-WSP, WAP-224-WTP
 */

import {
    WSP_PDU_CONNECT_REPLY, WSP_PDU_REPLY,
    FetchResult,
    buildWspGet, buildWspPost, buildWspConnect, buildClPacket,
    buildWtpInvoke, buildWtpAck, parseWtpResult, parseWtpAck, parseWspReply,
    WTP_TID_RESPONDER_BIT,
    WspRequestHeaders,
} from './wapProtocol';

/**
 * A bound UDP socket. `receive` resolves with the next inbound datagram, or
 * null once `timeoutMs` elapses with nothing received.
 */
export interface DatagramSession {
    send(packet: Buffer): void;
    receive(timeoutMs: number): Promise<Buffer | null>;
    close(): void;
}

export interface DatagramFactory {
    open(host: string, port: number): Promise<DatagramSession>;
}

export interface WspTimings {
    /** Per-attempt wait before retransmitting. */
    recvTimeoutMs: number;
    /** Total attempts, including the first. */
    maxRetries: number;
    /** Overall deadline for the whole exchange. */
    totalTimeoutMs: number;
}

export const DEFAULT_WSP_TIMINGS: WspTimings = {
    recvTimeoutMs: 5000,
    maxRetries: 3,
    totalTimeoutMs: 15000,
};

/**
 * Wait for a datagram the caller recognises, retransmitting on silence.
 *
 * Datagrams that `match` rejects are discarded and waiting continues — a
 * gateway may emit PDUs for other transactions on the same socket.
 */
async function awaitReply<T>(
    session: DatagramSession,
    match: (msg: Buffer) => T | null,
    resend: () => void,
    timings: WspTimings,
    deadline: number,
    label: string,
): Promise<T> {
    let attempt = 0;
    for (;;) {
        const remaining = deadline - Date.now();
        if (remaining <= 0) { throw new Error(`${label} timeout`); }

        const msg = await session.receive(Math.min(timings.recvTimeoutMs, remaining));
        if (msg) {
            const hit = match(msg);
            if (hit !== null) { return hit; }
            continue;   // not our transaction — keep listening
        }

        attempt++;
        if (attempt < timings.maxRetries) { resend(); }
    }
}

/**
 * One WTP class-2 transaction as the initiator (WAP-224 §9.5), returning the
 * Result's WSP PDU once `accept` takes it.
 *
 * Silence re-sends the Invoke with RID set (§8.2.6). A TID verification
 * (Ack with Tve) is answered with Ack(TIDok), which then takes the Invoke's
 * place on re-sends (§7.9.3); after a hold-on Ack (no Tve) the Result is only
 * awaited. Replies are matched on the TID's low 15 bits: the responder sets
 * bit 15 (§7.8.1), and gateways that echo the TID as sent are matched too.
 */
async function wtpTransaction(
    session: DatagramSession,
    tid: number,
    wspPdu: Buffer,
    accept: (wspData: Buffer) => Buffer | null,
    timings: WspTimings,
    deadline: number,
    label: string,
): Promise<Buffer> {
    tid &= ~WTP_TID_RESPONDER_BIT;
    let resend = buildWtpInvoke(tid, wspPdu, true);
    let holdOn = false;
    session.send(buildWtpInvoke(tid, wspPdu));
    const wspData = await awaitReply(
        session,
        (msg) => {
            const ack = parseWtpAck(msg);
            if (ack && (ack.tid & ~WTP_TID_RESPONDER_BIT) === tid) {
                if (ack.tve) {
                    session.send(buildWtpAck(tid, true));
                    resend = buildWtpAck(tid, true, true);
                } else {
                    holdOn = true;
                }
                return null;
            }
            const res = parseWtpResult(msg);
            if (!res || (res.tid & ~WTP_TID_RESPONDER_BIT) !== tid) { return null; }
            return accept(res.wspData);
        },
        () => { if (!holdOn) { session.send(resend); } },
        timings, deadline, label,
    );
    session.send(buildWtpAck(tid));
    return wspData;
}

/**
 * Connectionless WSP GET (default gateway port 9200).
 *
 * The transaction id is one byte and there is no WTP framing on this port.
 */
export async function fetchWspGet(
    factory: DatagramFactory,
    targetUrl: string,
    gatewayHost: string,
    gatewayPort: number,
    hdrs: WspRequestHeaders,
    timings: WspTimings = DEFAULT_WSP_TIMINGS,
    tidSeed: number = Date.now(),
): Promise<FetchResult> {
    const tid = tidSeed & 0xFF;
    const packet = buildClPacket(tid, buildWspGet(targetUrl, hdrs));

    const session = await factory.open(gatewayHost, gatewayPort);
    const deadline = Date.now() + timings.totalTimeoutMs;
    try {
        session.send(packet);

        const wspData = await awaitReply(
            session,
            (msg) => {
                if (msg.length < 3 || msg[0] !== tid) { return null; }
                const data = msg.slice(1);
                if (data[0] !== WSP_PDU_REPLY || data.length < 3) { return null; }
                return data;
            },
            () => session.send(packet),
            timings, deadline, 'WSP request',
        );

        const parsed = parseWspReply(wspData);
        parsed.finalUrl = targetUrl;
        return parsed;
    } finally {
        session.close();
    }
}

/**
 * Connection-oriented WSP POST over WTP (default gateway CO port 9201).
 *
 * Two transactions on one socket: Connect must complete and be acknowledged
 * before the Post is sent, and the Reply is acknowledged in turn.
 */
export async function fetchWspPost(
    factory: DatagramFactory,
    targetUrl: string,
    gatewayHost: string,
    gatewayCoPort: number,
    postBody: string,
    hdrs: WspRequestHeaders,
    timings: WspTimings = DEFAULT_WSP_TIMINGS,
    tidSeed: number = Date.now(),
): Promise<FetchResult> {
    const connectTid = tidSeed & ~WTP_TID_RESPONDER_BIT;
    const postTid = (connectTid + 1) & ~WTP_TID_RESPONDER_BIT;

    const session = await factory.open(gatewayHost, gatewayCoPort);
    const deadline = Date.now() + timings.totalTimeoutMs;
    try {
        // ── Phase 1: Connect ──
        await wtpTransaction(
            session, connectTid, buildWspConnect(),
            (d) => (d.length >= 1 && d[0] === WSP_PDU_CONNECT_REPLY ? d : null),
            timings, deadline, 'WSP connect',
        );

        // ── Phase 2: Post ──
        const wspData = await wtpTransaction(
            session, postTid, buildWspPost(targetUrl, postBody, hdrs),
            (d) => (d.length >= 1 && d[0] === WSP_PDU_REPLY ? d : null),
            timings, deadline, 'WSP POST',
        );

        const parsed = parseWspReply(wspData);
        parsed.finalUrl = targetUrl;
        return parsed;
    } finally {
        session.close();
    }
}
