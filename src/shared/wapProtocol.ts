/**
 *  Copyright (C) 2026 Jabez Winston
 *
 *  SPDX-License-Identifier: Apache-2.0
 *
 *  Shared WAP protocol constants and codecs (WSP, WTP, UintVar).
 *  Reference: WAP-230-WSP, WAP-224-WTP
 */

import { charsetByMib } from './charset';

// ── WTP PDU types ──────────────────────────────────────────────

export const WTP_PDU_INVOKE = 0x01;
export const WTP_PDU_RESULT = 0x02;
export const WTP_PDU_ACK = 0x03;

/** TID: the initiator sends it with bit 15 clear, the responder with it set (WAP-224 §7.8.1). */
export const WTP_TID_RESPONDER_BIT = 0x8000;
/** Byte-0 flags: RID marks a re-transmission (§8.2.6); in an Ack, Tve asks
 *  "is this transaction yours?" and from the initiator Tok answers it. */
export const WTP_RID = 0x01;
export const WTP_ACK_TVE_TOK = 0x04;

// ── WSP PDU types ──────────────────────────────────────────────

export const WSP_PDU_CONNECT = 0x01;
export const WSP_PDU_CONNECT_REPLY = 0x02;
export const WSP_PDU_REPLY = 0x04;
export const WSP_PDU_DISCONNECT = 0x05;
export const WSP_PDU_GET = 0x40;
export const WSP_PDU_POST = 0x60;

// ── WSP well-known content-type codes (WAP-230 Table 40) ───────

export const WSP_CT: Record<number, string> = {
    0x02: 'text/html',
    0x08: 'text/vnd.wap.wml',
    0x09: 'text/vnd.wap.wmlscript',
    0x12: 'application/x-www-form-urlencoded',
    0x14: 'application/vnd.wap.wmlc',
    0x15: 'application/vnd.wap.wmlscriptc',
    0x21: 'image/vnd.wap.wbmp',
};

/** Reverse map: MIME string → WSP content-type code. */
export const CT_WSP: Record<string, number> = {};
for (const [code, mime] of Object.entries(WSP_CT)) {
    CT_WSP[mime] = Number(code);
}

// ── WSP well-known header field codes (WAP-230 Table 39) ───────

export const WSP_HDR_ACCEPT = 0x00;
export const WSP_HDR_LOCATION = 0x1C;
export const WSP_HDR_SET_COOKIE = 0x41;

// ── UintVar encoding/decoding ──────────────────────────────────

export function encodeUintvar(val: number): Buffer {
    if (val === 0) { return Buffer.from([0x00]); }
    const parts: number[] = [];
    parts.push(val & 0x7F);
    val >>>= 7;
    while (val > 0) {
        parts.push(0x80 | (val & 0x7F));
        val >>>= 7;
    }
    parts.reverse();
    return Buffer.from(parts);
}

export function decodeUintvar(data: Buffer, offset: number): { value: number; consumed: number } {
    let val = 0;
    let i = offset;
    while (i < data.length && (i - offset) < 5) {
        const b = data[i];
        val = val * 128 + (b & 0x7F);   // not `<<`: 32-bit signed in JS
        i++;
        if (!(b & 0x80)) {
            return { value: val, consumed: i - offset };
        }
    }
    throw new Error('truncated uintvar');
}

// ── Content-type codes used when building request PDUs ─────────

const WSP_CT_TEXT_WML = 0x08;
const WSP_CT_TEXT_WMLS = 0x09;
const WSP_CT_APP_URLENC = 0x12;
const WSP_CT_APP_WMLC = 0x14;
const WSP_CT_APP_WMLSC = 0x15;
const WSP_CT_IMAGE_WBMP = 0x21;

/** Well-known header field codes (WAP-230 Table 39) used in requests. */
const WSP_HDR_USER_AGENT = 0x29;
const WSP_HDR_ACCEPT_CHARSET = 0x01;
const WSP_HDR_COOKIE = 0x42;

// ── Fetch result ───────────────────────────────────────────────

/**
 * A fetched resource, normalised across transports so the browser core does not
 * care whether it arrived over HTTP or WSP.
 */
export interface FetchResult {
    status: number;
    contentType: string;
    body: Buffer;
    headers: Record<string, string>;
    finalUrl: string;
    /**
     * Each `Set-Cookie` value separately.
     *
     * `headers['set-cookie']` keeps the comma-joined form for display, but a
     * response may set several cookies and one of them may carry an `Expires`
     * date — which itself contains ", " — so the joined string cannot be split
     * back apart reliably. Cookie storage uses this array instead.
     */
    setCookies: string[];
}

/**
 * WSP status → HTTP status. Hi nibble = class, lo = detail.
 * Special case: 0x6* maps to 500+lo, not 600. Per WAP-230-WSP Table 36.
 */
export function wspStatusToHttp(s: number): number {
    const hi = (s >> 4) & 0x0F;
    const lo = s & 0x0F;
    if (hi >= 6) { return 500 + lo; }
    return hi * 100 + lo;
}

// ── Request header encoding ────────────────────────────────────

export interface WspRequestHeaders {
    userAgent: string;
    cookie?: string;
}

/** Encode a null-terminated text value for a well-known header token. */
function pushTextHeader(out: number[], token: number, value: string): void {
    out.push(0x80 | token);
    for (let i = 0; i < value.length; i++) { out.push(value.charCodeAt(i) & 0xFF); }
    out.push(0x00);
}

/** Accept: list advertised for deck/script/image retrieval. */
function pushAcceptHeaders(out: number[], codes: number[]): void {
    for (const code of codes) {
        out.push(0x80 | WSP_HDR_ACCEPT);
        out.push(0x80 | code);
    }
}

/** Headers common to GET and POST requests. */
function commonRequestHeaders(out: number[], hdrs: WspRequestHeaders): void {
    // Accept-Charset: utf-8 (WAP-230 §8.4.2.8, short-integer MIBenum 106) —
    // a gateway may transcode to it; every other charset is decoded too
    out.push(0x80 | WSP_HDR_ACCEPT_CHARSET, 0x80 | 106);
    pushTextHeader(out, WSP_HDR_USER_AGENT, hdrs.userAgent);
    if (hdrs.cookie && hdrs.cookie.length > 0) {
        pushTextHeader(out, WSP_HDR_COOKIE, hdrs.cookie);
    }
}

// ── WSP request PDUs (WAP-230 §8.2.4) ──────────────────────────

/** `Get` PDU: [0x40] [URILen uintvar] [URI] [headers] */
export function buildWspGet(targetUrl: string, hdrs: WspRequestHeaders): Buffer {
    const urlBuf = Buffer.from(targetUrl, 'utf-8');
    const parts: number[] = [];
    pushAcceptHeaders(parts, [
        WSP_CT_APP_WMLC, WSP_CT_APP_WMLSC,
        WSP_CT_TEXT_WML, WSP_CT_TEXT_WMLS,
        WSP_CT_IMAGE_WBMP,
    ]);
    commonRequestHeaders(parts, hdrs);

    return Buffer.concat([
        Buffer.from([WSP_PDU_GET]),
        encodeUintvar(urlBuf.length),
        urlBuf,
        Buffer.from(parts),
    ]);
}

/** `Post` PDU: [0x60] [URILen] [HeadersLen] [URI] [ContentType+headers] [body] */
export function buildWspPost(targetUrl: string, postBody: string, hdrs: WspRequestHeaders): Buffer {
    const urlBuf = Buffer.from(targetUrl, 'utf-8');
    const parts: number[] = [];
    // Content-Type comes first in a Post PDU's header block.
    parts.push(0x80 | WSP_CT_APP_URLENC);
    pushAcceptHeaders(parts, [WSP_CT_APP_WMLC, WSP_CT_TEXT_WML]);
    commonRequestHeaders(parts, hdrs);

    const hdrsBuf = Buffer.from(parts);
    return Buffer.concat([
        Buffer.from([WSP_PDU_POST]),
        encodeUintvar(urlBuf.length),
        encodeUintvar(hdrsBuf.length),
        urlBuf,
        hdrsBuf,
        Buffer.from(postBody, 'utf-8'),
    ]);
}

/** `Connect` PDU: version 1.0, no capabilities, no headers. */
export function buildWspConnect(): Buffer {
    return Buffer.from([WSP_PDU_CONNECT, 0x01, 0x00, 0x00]);
}

/** Connectionless WSP datagram: [TID:1] [WSP PDU] — no WTP framing on port 9200. */
export function buildClPacket(tid: number, wspPdu: Buffer): Buffer {
    const packet = Buffer.alloc(1 + wspPdu.length);
    packet[0] = tid & 0xFF;
    wspPdu.copy(packet, 1);
    return packet;
}

// ── WTP framing (WAP-224) ──────────────────────────────────────

/** Invoke PDU carrying a WSP PDU: CON=0, GTR=1, TTR=1, TCL=2; RID set on a
 *  re-transmission. The TID goes out with bit 15 clear. */
export function buildWtpInvoke(tid: number, wspPdu: Buffer, rid = false): Buffer {
    const b0 = (WTP_PDU_INVOKE << 3) | (1 << 2) | (1 << 1) | (rid ? WTP_RID : 0);
    const result = Buffer.alloc(4 + wspPdu.length);
    tid &= ~WTP_TID_RESPONDER_BIT;
    result[0] = b0;
    result[1] = (tid >> 8) & 0xFF;
    result[2] = tid & 0xFF;
    result[3] = 0x02;  // TCL = 2 (reliable two-way transaction)
    wspPdu.copy(result, 4);
    return result;
}

/** Ack PDU: CON=0, TYPE=ACK; Tok set to answer a TID verification, RID on a
 *  re-transmission. The TID goes out with bit 15 clear. */
export function buildWtpAck(tid: number, tok = false, rid = false): Buffer {
    const buf = Buffer.alloc(3);
    tid &= ~WTP_TID_RESPONDER_BIT;
    buf[0] = (WTP_PDU_ACK << 3) | (tok ? WTP_ACK_TVE_TOK : 0) | (rid ? WTP_RID : 0);
    buf[1] = (tid >> 8) & 0xFF;
    buf[2] = tid & 0xFF;
    return buf;
}

/**
 * Decode a WTP Result PDU's header, returning the carried WSP PDU. TPIs
 * follow the fixed header while CON is set (§8.2.1): a long TPI (bit 2) has a
 * length octet, a short one its length in bits 0-1 (§8.4.1).
 */
export function parseWtpResult(msg: Buffer): { tid: number; wspData: Buffer } | null {
    if (msg.length < 3) { return null; }
    if (((msg[0] >> 3) & 0x0F) !== WTP_PDU_RESULT) { return null; }
    let off = 3;
    let con = msg[0] & 0x80;
    while (con && off < msg.length) {
        const t = msg[off];
        con = t & 0x80;
        off += (t & 0x04) ? 2 + (off + 1 < msg.length ? msg[off + 1] : 0) : 1 + (t & 0x03);
    }
    return { tid: (msg[1] << 8) | msg[2], wspData: msg.slice(Math.min(off, msg.length)) };
}

/** Decode a WTP Ack PDU: its TID, and whether it asks to verify it (Tve, §7.9.3). */
export function parseWtpAck(msg: Buffer): { tid: number; tve: boolean } | null {
    if (msg.length < 3) { return null; }
    if (((msg[0] >> 3) & 0x0F) !== WTP_PDU_ACK) { return null; }
    return { tid: (msg[1] << 8) | msg[2], tve: (msg[0] & WTP_ACK_TVE_TOK) !== 0 };
}

// ── WSP Reply PDU parser (shared by CL-GET and CO-POST) ────────

/**
 * Decode a `Reply` PDU into a transport-neutral FetchResult.
 *
 * `finalUrl` is left empty — only the caller knows which URL was requested.
 */
export function parseWspReply(wspData: Buffer): FetchResult & { rawHeaders: Buffer } {
    if (wspData[0] !== WSP_PDU_REPLY || wspData.length < 3) {
        throw new Error('Invalid WSP Reply PDU');
    }

    const httpStatus = wspStatusToHttp(wspData[1]);
    const { value: hdrsLen, consumed: hvLen } = decodeUintvar(wspData, 2);
    const hdrsStart = 2 + hvLen;
    const hdrsEnd = Math.min(hdrsStart + hdrsLen, wspData.length);   // cut at the PDU's end
    const body = Buffer.from(wspData.slice(hdrsEnd));

    let contentType = '';
    let location = '';
    const respHeaders: Record<string, string> = {};
    const setCookies: string[] = [];
    let pos = hdrsStart;

    /**
     * Value-length at pos (WAP-230 §8.4.2.2): a Short-length 0-30, or
     * Length-quote (31) and a uintvar. Moves pos past it and returns the
     * length, cut to what is left of the headers.
     */
    function valueLength(): number {
        let vl = wspData[pos++];
        if (vl === 31) {
            try {
                const u = decodeUintvar(wspData, pos);
                vl = u.value;
                pos += u.consumed;
            } catch { pos = hdrsEnd; return 0; }
        }
        return Math.min(vl, Math.max(hdrsEnd - pos, 0));
    }

    // First item is always the content-type
    if (hdrsLen > 0 && pos < hdrsEnd) {
        const ctByte = wspData[pos];
        if (ctByte & 0x80) {
            contentType = WSP_CT[ctByte & 0x7F] || 'application/octet-stream';
            pos++;
        } else if (ctByte <= 0x1F) {
            const ctLen = valueLength();
            const ctEnd = pos + ctLen;
            if (pos < ctEnd && (wspData[pos] & 0x80)) {
                contentType = WSP_CT[wspData[pos] & 0x7F] || 'application/octet-stream';
                pos++;
                // Parameters (WAP-230 §8.4.2.24): Charset (well-known 0x01)
                // carries a MIBenum, short or long integer — kept as a
                // charset= parameter so the deck is decoded in it (charset.ts)
                while (pos + 1 < ctEnd && wspData[pos] === 0x81) {
                    const v = wspData[pos + 1];
                    let mib = -1;
                    pos += 2;
                    if (v & 0x80) { mib = v & 0x7F; }
                    else if (v >= 1 && v <= 4 && pos + v <= ctEnd) {
                        mib = 0;
                        for (let k = 0; k < v; k++) { mib = mib * 256 + wspData[pos + k]; }
                        pos += v;
                    } else { break; }
                    const cs = charsetByMib(mib);
                    if (cs) { contentType += '; charset=' + cs; }
                }
            }
            pos = ctEnd;
        } else {
            const strStart = pos;
            while (pos < hdrsEnd && wspData[pos] !== 0) { pos++; }
            contentType = wspData.slice(strStart, pos).toString('ascii');
            if (pos < hdrsEnd) { pos++; }
        }
    }

    const appendSetCookie = (value: string): void => {
        setCookies.push(value);
        respHeaders['set-cookie'] = respHeaders['set-cookie']
            ? respHeaders['set-cookie'] + ', ' + value
            : value;
    };

    /** Skip a header value: short-int, short-length-prefixed, or null-terminated text. */
    const skipValue = (): void => {
        if (pos >= hdrsEnd) { return; }
        if (wspData[pos] & 0x80) { pos++; }
        else if (wspData[pos] <= 0x1F) { const vl = valueLength(); pos += vl; }
        else {
            while (pos < hdrsEnd && wspData[pos] !== 0) { pos++; }
            if (pos < hdrsEnd) { pos++; }
        }
    };

    // Scan remaining headers
    while (pos < hdrsEnd) {
        const hdr = wspData[pos];
        if (hdr & 0x80) {
            const field = hdr & 0x7F;
            pos++;
            if (field === (WSP_HDR_LOCATION & 0x7F)) {
                const strStart = pos;
                while (pos < hdrsEnd && wspData[pos] !== 0) { pos++; }
                location = wspData.slice(strStart, pos).toString('ascii');
                if (pos < hdrsEnd) { pos++; }
                respHeaders['location'] = location;
            } else if (field === (WSP_HDR_SET_COOKIE & 0x7F)) {
                if (pos < hdrsEnd && wspData[pos] <= 0x1F) {
                    const vLen = valueLength();
                    appendSetCookie(wspData.slice(pos, pos + vLen).toString('ascii'));
                    pos += vLen;
                } else {
                    const strStart = pos;
                    while (pos < hdrsEnd && wspData[pos] !== 0) { pos++; }
                    appendSetCookie(wspData.slice(strStart, pos).toString('ascii'));
                    if (pos < hdrsEnd) { pos++; }
                }
            } else {
                skipValue();
            }
        } else if (hdr >= 0x20) {
            // Literal (textual) field name, then a value.
            while (pos < hdrsEnd && wspData[pos] !== 0) { pos++; }
            if (pos < hdrsEnd) { pos++; }
            skipValue();
        } else {
            pos++;
        }
    }

    if (!contentType) { contentType = 'application/vnd.wap.wmlc'; }
    respHeaders['content-type'] = contentType;

    return {
        status: httpStatus, contentType, body, headers: respHeaders, setCookies,
        finalUrl: '', rawHeaders: wspData.slice(hdrsStart, hdrsEnd),
    };
}
