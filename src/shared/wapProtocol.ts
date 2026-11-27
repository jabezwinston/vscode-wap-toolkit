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

/** TID: the initiator sends it with bit 15 clear, the responder with it set (WTP: 7.8.1). */
export const WTP_TID_RESPONDER_BIT = 0x8000;
/** Byte-0 flags: RID marks a re-transmission (WTP: 8.2.6); in an Ack, Tve asks
 *  "is this transaction yours?" and from the initiator Tok answers it. */
export const WTP_RID = 0x01;
export const WTP_ACK_TVE_TOK = 0x04;

/** WTP:
 *  - 8.2.1 Continue Flag (CON)
 *  - 8.2.2 Group Trailer (GTR) and Transmission Trailer (TTR) Flag
 *  - 8.2.4 PDU Type
 *  - 8.3 Fixed Header Structure
 *
 * Byte 0 of every PDU: CON, the 4-bit type, then the flags; byte 3 of an
 * Invoke ends in the class.  The fixed header of a Result or an Ack is
 * WTP_HDR_LEN bytes. */
export const WTP_CON = 0x80;
export const WTP_TYPE_SHIFT = 3;
export const WTP_TYPE_MASK = 0x0F;
export const WTP_GTR = 0x04;
export const WTP_TTR = 0x02;
export const WTP_CLASS_2 = 0x02;
export const WTP_CLASS_MASK = 0x03;
export const WTP_HDR_LEN = 3;
export const WTP_INVOKE_HDR_LEN = 4;

/** WTP: 8.4.1 General
 *
 * A TPI's first byte: CON, then a long TPI (bit 2) has a length octet,
 * a short one its length in bits 0-1. */
export const WTP_TPI_LONG = 0x04;
export const WTP_TPI_LEN_MASK = 0x03;

// ── WSP PDU types ──────────────────────────────────────────────

export const WSP_PDU_CONNECT = 0x01;
export const WSP_PDU_CONNECT_REPLY = 0x02;
export const WSP_PDU_REPLY = 0x04;
export const WSP_PDU_DISCONNECT = 0x05;
export const WSP_PDU_GET = 0x40;
export const WSP_PDU_POST = 0x60;

/** WSP: 8.2.2.1 Connect
 *
 * Version: major << 4 | minor, 1.0. */
export const WSP_VERSION = 0x10;

/** WSP: 8.1.2 Variable Length Unsigned Integers
 *
 * 7 bits per byte, the top bit set on all but the last; a 32-bit value
 * takes at most 5. */
export const WSP_UINTVAR_MORE = 0x80;
export const WSP_UINTVAR_BITS = 0x7F;
export const WSP_UINTVAR_MAX = 5;

/** WSP: 8.4.2.1 Basic rules
 *
 * The first byte of a value: 0-30 a Short-length, 31 the Length-quote
 * before a uintvar length, 32-127 the start of a text (127 the Quote of a
 * Text-string), 128-255 a Short-integer (the value in its low 7 bits). */
export const WSP_SHORT_LEN_MAX = 30;
export const WSP_LENGTH_QUOTE = 31;
export const WSP_TEXT_MIN = 32;
export const WSP_QUOTE = 127;
export const WSP_SHORT_INT = 0x80;
export const WSP_SHORT_INT_BITS = 0x7F;

/** WSP: 8.4.2.4 Parameter
 *
 * Well-known parameter tokens (WSP Table 38): Charset, and those of
 * Set-Cookie (Domain and Path again in encoding 1.4, as a Text-value). */
export const WSP_PARAM_CHARSET = 0x01;
export const WSP_PARAM_DOMAIN = 0x0D;
export const WSP_PARAM_MAX_AGE = 0x0E;
export const WSP_PARAM_PATH = 0x0F;
export const WSP_PARAM_SECURE = 0x10;
export const WSP_PARAM_DOMAIN_14 = 0x1C;
export const WSP_PARAM_PATH_14 = 0x1D;

/** WSP: 8.4.2.15 Cache-control field: No-cache */
export const WSP_CC_NO_CACHE = 0x00;

/** UTF-8's MIBenum (IANA Character Sets) */
export const MIB_UTF8 = 106;

// ── WSP well-known content-type codes (WSP Table 40) ───────────

export const WSP_CT: Record<number, string> = {
    0x02: 'text/html',
    0x03: 'text/plain',
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

// ── WSP well-known header field codes (WSP Table 39) ───────────

export const WSP_HDR_ACCEPT = 0x00;
export const WSP_HDR_CONTENT_LENGTH = 0x0D;
export const WSP_HDR_CONTENT_RANGE = 0x10;
export const WSP_HDR_LOCATION = 0x1C;
export const WSP_HDR_RANGE = 0x23;
export const WSP_HDR_SET_COOKIE = 0x41;

/** WSP: 8.4.2.42 Range field: Byte-range, a first and a last byte position */
export const WSP_BYTE_RANGE = 0x80;

// ── UintVar encoding/decoding ──────────────────────────────────

// WSP: 8.1.2 Variable Length Unsigned Integers
export function encodeUintvar(val: number): Buffer {
    if (val === 0) { return Buffer.from([0x00]); }
    const parts: number[] = [];
    parts.push(val & WSP_UINTVAR_BITS);
    val >>>= 7;
    while (val > 0) {
        parts.push(WSP_UINTVAR_MORE | (val & WSP_UINTVAR_BITS));
        val >>>= 7;
    }
    parts.reverse();
    return Buffer.from(parts);
}

// WSP: 8.1.2 Variable Length Unsigned Integers
export function decodeUintvar(data: Buffer, offset: number): { value: number; consumed: number } {
    let val = 0;
    let i = offset;
    while (i < data.length && (i - offset) < WSP_UINTVAR_MAX) {
        const b = data[i];
        val = val * 128 + (b & WSP_UINTVAR_BITS);   // not `<<`: 32-bit signed in JS
        i++;
        if (!(b & WSP_UINTVAR_MORE)) {
            return { value: val, consumed: i - offset };
        }
    }
    throw new Error('truncated uintvar');
}

// ── Byte ranges (a text file read a window at a time) ──────────

/** A byte range asked for: the first byte, and the last (none: to the end). */
export interface ByteRange { first: number; last?: number }

/**
 * WSP:
 *  - 8.2.3.1 Get
 *  - 8.4.1.2 Field values
 *  - 8.4.2.42 Range field
 *
 * The Range of a WSP Get PDU (wap-browser-c asks for a text page's windows
 * this way): its headers follow the URI, each a well-known name
 * (Short-integer) or a Token-text one, then its value; Range-value is
 * Value-length, Byte-range, First-byte-pos and an optional Last-byte-pos
 * (uintvars). undefined when there is none.
 */
export function wspGetRange(pdu: Buffer): ByteRange | undefined {
    try {
        const uri = decodeUintvar(pdu, 1);
        let pos = 1 + uri.consumed + uri.value;
        while (pos < pdu.length) {
            let name = -1;
            if (pdu[pos] & WSP_SHORT_INT) { name = pdu[pos++] & WSP_SHORT_INT_BITS; }
            else { pos = pdu.indexOf(0, pos) + 1; if (pos === 0) { return undefined; } }
            const v = pdu[pos];
            let start = pos + 1, end: number;
            if (v & WSP_SHORT_INT) { start = pos; end = pos + 1; }
            else if (v <= WSP_SHORT_LEN_MAX) { end = start + v; }
            else if (v === WSP_LENGTH_QUOTE) {
                const l = decodeUintvar(pdu, start);
                start += l.consumed; end = start + l.value;
            } else {
                start = pos; end = pdu.indexOf(0, pos);
                if (end < 0) { return undefined; }
                end++;
            }
            if (name === WSP_HDR_RANGE && pdu[start] === WSP_BYTE_RANGE) {
                const f = decodeUintvar(pdu, start + 1);
                const at = start + 1 + f.consumed;
                return at < end ? { first: f.value, last: decodeUintvar(pdu, at).value }
                                : { first: f.value };
            }
            pos = end;
        }
    } catch { /* a truncated value: no range */ }
    return undefined;
}

/** RFC 9110: 14.1.2 Byte Ranges: `Range: bytes=first-[last]`, undefined otherwise. */
export function httpRange(h: string | undefined): ByteRange | undefined {
    const m = /^bytes=(\d+)-(\d*)$/.exec((h || '').trim());
    return m ? { first: Number(m[1]), last: m[2] ? Number(m[2]) : undefined } : undefined;
}

/**
 * RFC 9110:
 *  - 14.2 Range
 *  - 15.3.7 206 Partial Content
 *  - 15.5.17 416 Range Not Satisfiable
 *
 * A whole file cut to the range asked for: 206 with its bytes there, 416
 * when it starts past the end, 200 with all of it when none was asked.
 * `size` is the file's length either way (Content-Range / Content-Length).
 */
export function cutRange(body: Buffer, range?: ByteRange): { status: number; body: Buffer; size: number; first: number } {
    const size = body.length;
    if (!range) { return { status: 200, body, size, first: 0 }; }
    if (range.first >= size) { return { status: 416, body: Buffer.alloc(0), size, first: 0 }; }
    const last = range.last === undefined || range.last >= size ? size - 1 : range.last;
    return { status: 206, body: body.subarray(range.first, last + 1), size, first: range.first };
}

/**
 * WSP:
 *  - 8.4.2.1 Basic rules
 *  - 8.4.2.20 Content length field
 *  - 8.4.2.23 Content range field
 *
 * A reply's length headers, for cutRange's result: Content-Range
 * (First-byte-pos, Entity-length; uintvars, the first 0 for a 416) on a
 * 206 or 416, Content-Length (an Integer-value) on a 200.
 */
export function wspLengthHeaders(r: { status: number; size: number; first: number }): Buffer {
    if (r.status === 206 || r.status === 416) {
        const v = Buffer.concat([encodeUintvar(r.first), encodeUintvar(r.size)]);
        return Buffer.concat([Buffer.from([WSP_SHORT_INT | WSP_HDR_CONTENT_RANGE, v.length]), v]);
    }
    if (r.size < WSP_SHORT_INT) {
        return Buffer.from([WSP_SHORT_INT | WSP_HDR_CONTENT_LENGTH, WSP_SHORT_INT | r.size]);
    }
    const n: number[] = [];
    for (let v = r.size; v > 0; v = Math.floor(v / 256)) { n.unshift(v % 256); }
    return Buffer.from([WSP_SHORT_INT | WSP_HDR_CONTENT_LENGTH, n.length, ...n]);
}

// ── Content-type codes used when building request PDUs ─────────

const WSP_CT_TEXT_PLAIN = 0x03;
const WSP_CT_TEXT_WML = 0x08;
const WSP_CT_TEXT_WMLS = 0x09;
const WSP_CT_APP_URLENC = 0x12;
const WSP_CT_APP_WMLC = 0x14;
const WSP_CT_APP_WMLSC = 0x15;
const WSP_CT_IMAGE_WBMP = 0x21;

/** What a request accepts (WSP: 8.4.2.7): every type the browser reads, as
 * over HTTP (WAP_ACCEPT in httpClient.ts; wap-browser-c bugs.md #256) */
const WSP_ACCEPT = [
    WSP_CT_APP_WMLC, WSP_CT_APP_WMLSC,
    WSP_CT_TEXT_WML, WSP_CT_TEXT_WMLS,
    WSP_CT_IMAGE_WBMP, WSP_CT_TEXT_PLAIN,
];

/** Well-known header field codes (WSP Table 39) used in requests. */
const WSP_HDR_USER_AGENT = 0x29;
const WSP_HDR_ACCEPT_CHARSET = 0x01;
const WSP_HDR_CACHE_CONTROL = 0x08;
const WSP_HDR_REFERER = 0x24;

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
 * WSP: 8.2.3.3 Reply
 *
 * WSP status → HTTP status, WSP Table 36 (Status Code Assignments): the
 * high nibble is the class (1xx-3xx: 0x1*-0x3*), the low nibble the
 * detail, except that the 4xx run on past 0x4F (416 = 0x50, 417 = 0x51)
 * and the 5xx start at 0x60.
 */
export function wspStatusToHttp(s: number): number {
    if (s >= 0x60) { return 500 + s - 0x60; }
    if (s >= 0x40) { return 400 + s - 0x40; }
    return (s >> 4) * 100 + (s & 0x0F);
}

// ── Request header encoding ────────────────────────────────────

export interface WspRequestHeaders {
    userAgent: string;
    cookie?: string;
    /** sendreferer (WML 1.3: 9.5.1) */
    referer?: string;
    /** Cache-Control: no-cache (WML 1.3: 9.5.1) */
    noCache?: boolean;
    /** A POST body's charset as a MIBenum, in its Content-Type (WML 1.3: 9.5.1); UTF-8 if none */
    contentCharsetMib?: number;
}

/** Encode a null-terminated text value for a well-known header token. */
function pushTextHeader(out: number[], token: number, value: string): void {
    out.push(WSP_SHORT_INT | token);
    for (let i = 0; i < value.length; i++) { out.push(value.charCodeAt(i) & 0xFF); }
    out.push(0x00);
}

/** WSP: 8.4.2.6 Header
 *
 * An Application-header: the field name as Token-text, then its value as
 * a Text-string, each null-terminated. */
function pushAppHeader(out: number[], name: string, value: string): void {
    for (const s of [name, value]) {
        for (let i = 0; i < s.length; i++) { out.push(s.charCodeAt(i) & 0xFF); }
        out.push(0x00);
    }
}

/** WSP:
 *  - 8.4.2.7 Accept field
 *  - 8.4.2.8 Accept charset field
 *
 * Accept: list advertised for deck/script/image retrieval. */
function pushAcceptHeaders(out: number[], codes: number[]): void {
    for (const code of codes) {
        out.push(WSP_SHORT_INT | WSP_HDR_ACCEPT);
        out.push(WSP_SHORT_INT | code);
    }
}

/** WSP:
 *  - 8.4.1.1 Field name
 *  - 8.4.1.2 Field values
 *  - 8.4.2.15 Cache-control field
 *  - 8.4.2.43 Referer field
 *  - 8.4.2.48 User agent field
 *
 * Headers common to GET and POST requests. */
function commonRequestHeaders(out: number[], hdrs: WspRequestHeaders): void {
    // Accept-Charset: utf-8 (WSP: 8.4.2.8, its MIBenum a short-integer) —
    // a gateway may transcode to it; every other charset is decoded too
    out.push(WSP_SHORT_INT | WSP_HDR_ACCEPT_CHARSET, WSP_SHORT_INT | MIB_UTF8);
    pushTextHeader(out, WSP_HDR_USER_AGENT, hdrs.userAgent);
    // Cookie is a field name of encoding version 1.3 and the gateway's
    // version is not known, so it goes as text (8.4.1.1), and its value then
    // is the HTTP text (8.4.1.2). After the well-known name (0xC2) only the
    // binary value of WSP 8.4.2.69 would do.
    if (hdrs.cookie && hdrs.cookie.length > 0) {
        pushAppHeader(out, 'Cookie', hdrs.cookie);
    }
    // Referer; Cache-Control: No-cache
    if (hdrs.referer) { pushTextHeader(out, WSP_HDR_REFERER, hdrs.referer); }
    if (hdrs.noCache) { out.push(WSP_SHORT_INT | WSP_HDR_CACHE_CONTROL, WSP_SHORT_INT | WSP_CC_NO_CACHE); }
}

// ── WSP request PDUs (WSP: 8.2.3) ──────────────────────────

/** WSP: 8.2.3.1 Get
 *
 * `Get` PDU: [0x40] [URILen uintvar] [URI] [headers] */
export function buildWspGet(targetUrl: string, hdrs: WspRequestHeaders): Buffer {
    const urlBuf = Buffer.from(targetUrl, 'utf-8');
    const parts: number[] = [];
    pushAcceptHeaders(parts, WSP_ACCEPT);
    commonRequestHeaders(parts, hdrs);

    return Buffer.concat([
        Buffer.from([WSP_PDU_GET]),
        encodeUintvar(urlBuf.length),
        urlBuf,
        Buffer.from(parts),
    ]);
}

/** WSP:
 *  - 8.2.3.2 Post
 *  - 8.4.2.24 Content type field
 *
 * `Post` PDU: [0x60] [URILen] [HeadersLen] [URI] [ContentType+headers] [body] */
export function buildWspPost(targetUrl: string, postBody: string, hdrs: WspRequestHeaders): Buffer {
    const urlBuf = Buffer.from(targetUrl, 'utf-8');
    const parts: number[] = [];
    // Content-Type comes first in a Post PDU's header block: urlencoded,
    // with the body's charset (WML 1.3: 9.5.1), the general form —
    // Value-length, the type, the Charset parameter (0x01), the MIBenum as
    // an Integer-value (WSP: 8.4.2.24, 8.4.2.8)
    const mib = hdrs.contentCharsetMib || MIB_UTF8;
    const cs = mib < WSP_SHORT_INT ? [WSP_SHORT_INT | mib] : [2, (mib >> 8) & 0xFF, mib & 0xFF];
    parts.push(2 + cs.length, WSP_SHORT_INT | WSP_CT_APP_URLENC,
        WSP_SHORT_INT | WSP_PARAM_CHARSET, ...cs);
    pushAcceptHeaders(parts, WSP_ACCEPT);
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

/** WSP:
 *  - 8.2.2.1 Connect
 *  - 8.3 Capability Encoding
 *
 * `Connect` PDU: version 1.0, no capabilities, no headers. */
export function buildWspConnect(): Buffer {
    return Buffer.from([WSP_PDU_CONNECT, WSP_VERSION, 0x00, 0x00]);
}

/** WSP:
 *  - 7.2 Connectionless WSP
 *  - 8.2.1 PDU Common Fields
 *
 * Connectionless WSP datagram: [TID:1] [WSP PDU] — no WTP framing on port 9200. */
export function buildClPacket(tid: number, wspPdu: Buffer): Buffer {
    const packet = Buffer.alloc(1 + wspPdu.length);
    packet[0] = tid & 0xFF;
    wspPdu.copy(packet, 1);
    return packet;
}

// ── WTP framing (WAP-224) ──────────────────────────────────────

/** WTP: 8.3.1 Invoke PDU
 *
 * Invoke PDU carrying a WSP PDU: CON=0, GTR=1, TTR=1, TCL=2; RID set on a
 *  re-transmission. The TID goes out with bit 15 clear. */
export function buildWtpInvoke(tid: number, wspPdu: Buffer, rid = false): Buffer {
    const b0 = (WTP_PDU_INVOKE << WTP_TYPE_SHIFT) | WTP_GTR | WTP_TTR | (rid ? WTP_RID : 0);
    const result = Buffer.alloc(WTP_INVOKE_HDR_LEN + wspPdu.length);
    tid &= ~WTP_TID_RESPONDER_BIT;
    result[0] = b0;
    result[1] = (tid >> 8) & 0xFF;
    result[2] = tid & 0xFF;
    result[3] = WTP_CLASS_2;  // reliable two-way transaction
    wspPdu.copy(result, WTP_INVOKE_HDR_LEN);
    return result;
}

/** WTP:
 *  - 8.3.3 Acknowledgement PDU
 *  - 7.9.2 Protocol Data Units
 *
 * Ack PDU: CON=0, TYPE=ACK; Tok set to answer a TID verification, RID on a
 *  re-transmission. The TID goes out with bit 15 clear. */
export function buildWtpAck(tid: number, tok = false, rid = false): Buffer {
    const buf = Buffer.alloc(WTP_HDR_LEN);
    tid &= ~WTP_TID_RESPONDER_BIT;
    buf[0] = (WTP_PDU_ACK << WTP_TYPE_SHIFT) | (tok ? WTP_ACK_TVE_TOK : 0) | (rid ? WTP_RID : 0);
    buf[1] = (tid >> 8) & 0xFF;
    buf[2] = tid & 0xFF;
    return buf;
}

/**
 * WTP:
 *  - 8.3.2 Result PDU
 *  - 8.4.1 General
 *
 * Decode a WTP Result PDU's header, returning the carried WSP PDU. TPIs
 * follow the fixed header while CON is set (WTP: 8.2.1): a long TPI (bit 2) has a
 * length octet, a short one its length in bits 0-1 (WTP: 8.4.1).
 */
export function parseWtpResult(msg: Buffer): { tid: number; wspData: Buffer } | null {
    if (msg.length < WTP_HDR_LEN) { return null; }
    if (((msg[0] >> WTP_TYPE_SHIFT) & WTP_TYPE_MASK) !== WTP_PDU_RESULT) { return null; }
    let off = WTP_HDR_LEN;
    let con = msg[0] & WTP_CON;
    while (con && off < msg.length) {
        const t = msg[off];
        con = t & WTP_CON;
        off += (t & WTP_TPI_LONG) ? 2 + (off + 1 < msg.length ? msg[off + 1] : 0)
            : 1 + (t & WTP_TPI_LEN_MASK);
    }
    return { tid: (msg[1] << 8) | msg[2], wspData: msg.slice(Math.min(off, msg.length)) };
}

/** WTP:
 *  - 8.3.3 Acknowledgement PDU
 *  - 7.9.3 Procedure
 *
 * Decode a WTP Ack PDU: its TID, and whether it asks to verify it (Tve, WTP: 7.9.3). */
export function parseWtpAck(msg: Buffer): { tid: number; tve: boolean } | null {
    if (msg.length < WTP_HDR_LEN) { return null; }
    if (((msg[0] >> WTP_TYPE_SHIFT) & WTP_TYPE_MASK) !== WTP_PDU_ACK) { return null; }
    return { tid: (msg[1] << 8) | msg[2], tve: (msg[0] & WTP_ACK_TVE_TOK) !== 0 };
}

// ── WSP Set-Cookie value ────────────────────────────────────────

/**
 * WSP:
 *  - 8.4.2.68 Set-Cookie field
 *  - 8.4.2.4 Parameter
 *  - 8.4.2.3 Parameter Values
 *
 * The Set-Cookie-value in b[pos, end), after its Value-length:
 * Cookie-version Cookie-name Cookie-val *Parameter. Returned as the text
 * form the cookie jar reads ("sid=1; Domain=x.com; Path=/; Max-Age=60;
 * Secure"), or '' when it has no name. Table 38's Domain (0x0D, 1.4: 0x1C),
 * Path (0x0F, 1.4: 0x1D), Max-Age (0x0E) and Secure (0x10) become those
 * attributes. An Untyped-parameter (a name with no token, such as Expires)
 * is kept as text, and the other well-known parameters are dropped.
 */
/** A Quoted-string's '"' */
const DQUOTE = 0x22;

export function wspSetCookieText(b: Buffer, pos: number, end: number): string {
    end = Math.min(end, b.length);

    /** An Integer-value: a Short-integer, or a Long-integer (Short-length
     *  1-30, then that many octets, big-endian) */
    const integer = (): number => {
        const v = b[pos++];
        if (v & WSP_SHORT_INT) { return v & WSP_SHORT_INT_BITS; }
        let n = 0;
        for (let k = 0; k < v; k++) { n = n * 256 + (pos < end ? b[pos++] : 0); }
        return n;
    };

    /** A value: an Integer-value as digits, else text up to its
     *  End-of-string. quote is the octet before the text that is not part
     *  of it: a Text-string's Quote (127), a Quoted-string's '"' (34).
     *  No-value is ''. */
    const value = (quote: number): string => {
        if (pos >= end) { return ''; }
        const v = b[pos];
        if ((v & WSP_SHORT_INT) || (v >= 1 && v <= WSP_SHORT_LEN_MAX)) { return String(integer()); }
        if (v === WSP_LENGTH_QUOTE) {       // not a cookie value
            try {
                const u = decodeUintvar(b, pos + 1);
                pos += 1 + u.consumed + u.value;
            } catch { pos = end; }
            return '';
        }
        if (v === quote) { pos++; }
        const start = pos;
        while (pos < end && b[pos] !== 0) { pos++; }
        const s = b.toString('latin1', start, pos);
        if (pos < end) { pos++; }
        return s;
    };

    value(WSP_QUOTE);                       // Cookie-version
    const name = value(WSP_QUOTE);          // Cookie-name, a Text-string
    const val = value(WSP_QUOTE);           // Cookie-val, a Text-string
    if (!name) { return ''; }
    let text = `${name}=${val}`;

    while (pos < end) {
        const v = b[pos];
        if ((v & WSP_SHORT_INT) || (v >= 1 && v <= WSP_SHORT_LEN_MAX)) {
            // Typed-parameter: Well-known-parameter-token Typed-value.
            // Encoding 1.4's Domain and Path are a Text-value, whose text
            // may be a Quoted-string; the deprecated ones a Text-string.
            const token = integer();
            const pv = value(token === WSP_PARAM_DOMAIN_14 || token === WSP_PARAM_PATH_14
                ? DQUOTE : WSP_QUOTE);
            if (token === WSP_PARAM_DOMAIN || token === WSP_PARAM_DOMAIN_14) { text += '; Domain=' + pv; }
            else if (token === WSP_PARAM_PATH || token === WSP_PARAM_PATH_14) { text += '; Path=' + pv; }
            else if (token === WSP_PARAM_MAX_AGE) { text += '; Max-Age=' + pv; }
            else if (token === WSP_PARAM_SECURE) { text += '; Secure'; }
        } else if (v >= WSP_TEXT_MIN) {
            // Untyped-parameter: Token-text Untyped-value
            const key = value(DQUOTE);
            const pv = value(DQUOTE);
            text += '; ' + key + (pv ? '=' + pv : '');
        } else {
            break;                          // not a parameter
        }
    }
    return text;
}

// ── WSP Reply PDU parser (shared by CL-GET and CO-POST) ────────

/**
 * WSP:
 *  - 8.2.3.3 Reply
 *  - 8.4 Header Encoding
 *
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
     * WSP: 8.4.2.2 Length
     *
     * Value-length at pos (WSP: 8.4.2.2): a Short-length 0-30, or
     * Length-quote (31) and a uintvar. Moves pos past it and returns the
     * length, cut to what is left before end (the headers' end).
     */
    function valueLength(end = hdrsEnd): number {
        let vl = wspData[pos++];
        if (vl === WSP_LENGTH_QUOTE) {
            try {
                const u = decodeUintvar(wspData, pos);
                vl = u.value;
                pos += u.consumed;
            } catch { pos = end; return 0; }
        }
        return Math.min(vl, Math.max(end - pos, 0));
    }

    /**
     * WSP: 8.4.1.2 Field values
     *
     * Skip a value of any encoding: a Short-integer, Value-length and its
     * octets, or text to its NUL; never past end (the headers' end).
     */
    function skipValue(end = hdrsEnd): void {
        if (pos >= end) { return; }
        if (wspData[pos] & WSP_SHORT_INT) { pos++; }
        else if (wspData[pos] <= WSP_LENGTH_QUOTE) { const vl = valueLength(end); pos += vl; }
        else {
            while (pos < end && wspData[pos] !== 0) { pos++; }
            if (pos < end) { pos++; }
        }
    }

    // WSP: 8.4.2.24 Content type field
    //
    // First item is always the content-type: a Constrained-media
    // (Short-integer or Extension-Media), or the Content-general-form,
    // Value-length Media-type, whose media is a Well-known-media (an
    // Integer-value) or Extension-Media, then its Parameters. We send no
    // Encoding-version, so a type past encoding 1.2 comes as
    // Extension-Media (WSP: 8.4.2.70 Encoding-Version field).
    if (hdrsLen > 0 && pos < hdrsEnd) {
        const general = wspData[pos] <= WSP_LENGTH_QUOTE;
        let ctEnd = hdrsEnd;
        if (general) { const ctLen = valueLength(); ctEnd = pos + ctLen; }
        // The media: a Short-integer, a Long-integer Well-known-media
        // (past 127: none we know), or Extension-Media, handed on as the
        // Content-Type header (with any parameters a text one carries)
        const ms = pos;
        skipValue(ctEnd);
        if (pos > ms) {
            const m = wspData[ms];
            if (m & WSP_SHORT_INT) { contentType = WSP_CT[m & WSP_SHORT_INT_BITS] || 'application/octet-stream'; }
            else if (m < WSP_TEXT_MIN) { contentType = 'application/octet-stream'; }
            else if (wspData[pos - 1] === 0) { contentType = wspData.toString('latin1', ms, pos - 1); }
        }
        // WSP: 8.4.2.4 Parameter
        //
        // Each is a Typed-parameter (an Integer-value token, then its
        // value) or an Untyped-parameter (Token-text, then its value).
        // Charset (WSP_PARAM_CHARSET) is a Well-known-charset: a MIBenum, kept as
        // a charset= parameter so the deck is decoded in it (charset.ts),
        // or Any-charset (0x80), which names none. A charset sent as text
        // has no MIBenum, so is none we decode. The rest are skipped.
        while (general && pos < ctEnd) {
            const tok = wspData[pos];
            skipValue(ctEnd);
            const v = pos;
            skipValue(ctEnd);
            if (tok === (WSP_SHORT_INT | WSP_PARAM_CHARSET) && pos > v) {
                let mib = -1;
                if (wspData[v] & WSP_SHORT_INT) { mib = wspData[v] & WSP_SHORT_INT_BITS; }
                else if (wspData[v] >= 1 && wspData[v] <= 4 && pos === v + 1 + wspData[v]) {
                    mib = 0;
                    for (let k = v + 1; k < pos; k++) { mib = mib * 256 + wspData[k]; }
                }
                const cs = charsetByMib(mib);
                if (cs) { contentType += '; charset=' + cs; }
            }
        }
    }

    const appendSetCookie = (value: string): void => {
        setCookies.push(value);
        respHeaders['set-cookie'] = respHeaders['set-cookie']
            ? respHeaders['set-cookie'] + ', ' + value
            : value;
    };

    // Scan remaining headers
    while (pos < hdrsEnd) {
        const hdr = wspData[pos];
        if (hdr & WSP_SHORT_INT) {
            const field = hdr & WSP_SHORT_INT_BITS;
            pos++;
            if (field === WSP_HDR_LOCATION) {
                const strStart = pos;
                while (pos < hdrsEnd && wspData[pos] !== 0) { pos++; }
                location = wspData.slice(strStart, pos).toString('ascii');
                if (pos < hdrsEnd) { pos++; }
                respHeaders['location'] = location;
            } else if (field === WSP_HDR_SET_COOKIE) {
                if (pos < hdrsEnd && wspData[pos] <= WSP_LENGTH_QUOTE) {
                    const vLen = valueLength();
                    const cookie = wspSetCookieText(wspData, pos, pos + vLen);
                    if (cookie) { appendSetCookie(cookie); }
                    pos += vLen;
                } else {
                    // Text, which WSP: 8.4.1.2 does not allow after a
                    // well-known field name: taken as the text form
                    const strStart = pos;
                    while (pos < hdrsEnd && wspData[pos] !== 0) { pos++; }
                    appendSetCookie(wspData.slice(strStart, pos).toString('ascii'));
                    if (pos < hdrsEnd) { pos++; }
                }
            } else {
                skipValue();
            }
        } else if (hdr >= WSP_TEXT_MIN) {
            // Application-header (WSP: 8.4.2.6): Token-text, then its
            // value. Set-Cookie, a field name of encoding version 1.3, comes
            // so to a client whose version the server does not know
            // (WSP: 8.4.1.1 Field name), and its value is then the HTTP
            // text (WSP: 8.4.1.2 Field values), as over HTTP. Names are
            // case-insensitive.
            const nameStart = pos;
            while (pos < hdrsEnd && wspData[pos] !== 0) { pos++; }
            const name = wspData.toString('latin1', nameStart, pos).toLowerCase();
            if (pos < hdrsEnd) { pos++; }
            const v = pos;
            skipValue();
            if (name === 'set-cookie' && pos > v && wspData[pos - 1] === 0 &&
                wspData[v] >= WSP_TEXT_MIN && wspData[v] < WSP_SHORT_INT) {
                // a Text-string, past its Quote if it has one
                appendSetCookie(wspData.toString('latin1', wspData[v] === WSP_QUOTE ? v + 1 : v, pos - 1));
            }
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
