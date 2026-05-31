/**
 *  Copyright (C) 2026 Jabez Winston
 *
 *  SPDX-License-Identifier: Apache-2.0
 *
 *  Shared WAP protocol constants and codecs (WSP, WTP, UintVar).
 *  Reference: WAP-230-WSP, WAP-224-WTP
 */

// ── WTP PDU types ──────────────────────────────────────────────

export const WTP_PDU_INVOKE = 0x01;
export const WTP_PDU_RESULT = 0x02;
export const WTP_PDU_ACK = 0x03;

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
        val = (val << 7) | (b & 0x7F);
        i++;
        if (!(b & 0x80)) {
            return { value: val, consumed: i - offset };
        }
    }
    throw new Error('truncated uintvar');
}
