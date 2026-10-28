/**
 *  Copyright (C) 2026 Jabez Winston
 *
 *  SPDX-License-Identifier: Apache-2.0
 *
 *  Character encodings of decks, scripts and the text sent back.
 *
 *  WML 1.3 §6.1 (WML-C-05): every character of an encoding the user agent
 *  recognises maps to Unicode.  A deck's encoding comes from, in order: a
 *  byte-order mark, the charset of the Content-Type, the XML declaration,
 *  else UTF-8 (WBXML: its charset field, §5.6; WMLScript bytecode: its
 *  constant pool's, WAP-193 §9.1.3).  Text sent to a server is encoded in
 *  the deck's charset or a <go accept-charset> (§9.5.1).
 *
 *  Mirrors wap-browser-c src/wap/charset.c.  ES5 only (the Android port runs
 *  this on a KitKat WebView): byte loops and String.fromCharCode, with
 *  TextDecoder used, where the host has one, for the East Asian charsets
 *  that have no table here (each character is '?' without it).
 */

import { CODE_PAGES } from './charsetTables';

/** Canonical names used here (the preferred MIME names). */
const ALIASES: { [key: string]: string } = {
    utf8: 'utf-8', unicode11utf8: 'utf-8',
    iso88591: 'iso-8859-1', latin1: 'iso-8859-1', l1: 'iso-8859-1',
    windows1252: 'iso-8859-1', cp1252: 'iso-8859-1', xcp1252: 'iso-8859-1',
    usascii: 'iso-8859-1', ascii: 'iso-8859-1', isoir100: 'iso-8859-1',
    cp819: 'iso-8859-1', ibm819: 'iso-8859-1',
    utf16: 'utf-16', utf16be: 'utf-16be', utf16le: 'utf-16le',
    iso10646ucs2: 'utf-16be', ucs2: 'utf-16be',
    utf32: 'utf-32be', utf32be: 'utf-32be', utf32le: 'utf-32le',
    iso10646ucs4: 'utf-32be', ucs4: 'utf-32be',
    shiftjis: 'shift_jis', sjis: 'shift_jis', xsjis: 'shift_jis', mskanji: 'shift_jis',
    windows31j: 'shift_jis', cp932: 'shift_jis',
    eucjp: 'euc-jp', xeucjp: 'euc-jp', iso2022jp: 'iso-2022-jp',
    gb2312: 'gb18030', gbk: 'gb18030', gb18030: 'gb18030', cp936: 'gb18030',
    euccn: 'gb18030', xgbk: 'gb18030',
    big5: 'big5', big5hkscs: 'big5', cp950: 'big5',
    euckr: 'euc-kr', ksc56011987: 'euc-kr', cp949: 'euc-kr', uhc: 'euc-kr',
    latin2: 'iso-8859-2', latin3: 'iso-8859-3', latin4: 'iso-8859-4',
    cyrillic: 'iso-8859-5', arabic: 'iso-8859-6', greek: 'iso-8859-7',
    greek8: 'iso-8859-7', hebrew: 'iso-8859-8', latin5: 'iso-8859-9',
    latin6: 'iso-8859-10', tis620: 'iso-8859-11', latin7: 'iso-8859-13',
    latin8: 'iso-8859-14', latin9: 'iso-8859-15', latin10: 'iso-8859-16',
    win1251: 'windows-1251', koi8ru: 'koi8-u',
};

const MIBS: { [mib: number]: string } = {
    3: 'iso-8859-1', 4: 'iso-8859-1', 2252: 'iso-8859-1', 106: 'utf-8',
    1013: 'utf-16be', 1014: 'utf-16le', 1015: 'utf-16', 1000: 'utf-16be',
    1001: 'utf-32be', 1017: 'utf-32be', 1018: 'utf-32be', 1019: 'utf-32le',
    17: 'shift_jis', 2024: 'shift_jis', 18: 'euc-jp', 39: 'iso-2022-jp',
    2025: 'gb18030', 113: 'gb18030', 114: 'gb18030', 2026: 'big5', 2101: 'big5',
    38: 'euc-kr', 36: 'euc-kr',
    5: 'iso-8859-2', 6: 'iso-8859-3', 7: 'iso-8859-4', 8: 'iso-8859-5',
    9: 'iso-8859-6', 10: 'iso-8859-7', 11: 'iso-8859-8', 12: 'iso-8859-9',
    13: 'iso-8859-10', 2259: 'iso-8859-11', 109: 'iso-8859-13', 110: 'iso-8859-14',
    111: 'iso-8859-15', 112: 'iso-8859-16', 2250: 'windows-1250',
    2251: 'windows-1251', 2253: 'windows-1253', 2254: 'windows-1254',
    2255: 'windows-1255', 2256: 'windows-1256', 2257: 'windows-1257',
    2258: 'windows-1258', 2084: 'koi8-r', 2088: 'koi8-u',
};

const CJK = ['shift_jis', 'euc-jp', 'gb18030', 'big5', 'euc-kr'];

/** Windows-1252 code points of the C1 bytes 0x80-0x9F (0: undefined). */
const CP1252_C1 = [
    0x20AC, 0, 0x201A, 0x0192, 0x201E, 0x2026, 0x2020, 0x2021,
    0x02C6, 0x2030, 0x0160, 0x2039, 0x0152, 0, 0x017D, 0,
    0, 0x2018, 0x2019, 0x201C, 0x201D, 0x2022, 0x2013, 0x2014,
    0x02DC, 0x2122, 0x0161, 0x203A, 0x0153, 0, 0x017E, 0x0178,
];

/** Canonical charset of an IANA name or alias, '' if not recognised. */
export function charsetByName(name: string): string {
    const key = String(name || '').toLowerCase().replace(/[^a-z0-9]/g, '');
    if (!key) { return ''; }
    if (Object.prototype.hasOwnProperty.call(ALIASES, key)) { return ALIASES[key]; }
    let m = /^iso8859(\d+)$/.exec(key);
    if (m && CODE_PAGES['iso-8859-' + m[1]]) { return 'iso-8859-' + m[1]; }
    m = /^(?:windows|cp|xcp)(125\d)$/.exec(key);
    if (m && CODE_PAGES['windows-' + m[1]]) { return 'windows-' + m[1]; }
    if (key === 'koi8r') { return 'koi8-r'; }
    if (key === 'koi8u') { return 'koi8-u'; }
    return '';
}

/** Canonical charset of an IANA MIBenum (WBXML, WSP, WMLScript), '' if none. */
export function charsetByMib(mib: number): string {
    return Object.prototype.hasOwnProperty.call(MIBS, mib) ? MIBS[mib] : '';
}

/** The charset parameter of a Content-Type value, '' if absent or unknown. */
export function charsetFromContentType(ct: string): string {
    const m = /;\s*charset\s*=\s*["']?([^;"'\s]+)/i.exec(String(ct || ''));
    return m ? charsetByName(m[1]) : '';
}

// ── Decoding ─────────────────────────────────────────────────────────

type Bytes = ArrayLike<number>;

function fromCodePoint(cp: number): string {
    if (cp < 0x10000) { return String.fromCharCode(cp); }
    cp -= 0x10000;
    return String.fromCharCode(0xD800 + (cp >> 10), 0xDC00 + (cp & 0x3FF));
}

/** Decode one UTF-8 sequence at b[i]; returns [code point, length], or
 *  [byte, 1] when it is not valid UTF-8 (the byte is read as ISO-8859-1). */
function utf8At(b: Bytes, i: number, end: number): [number, number] {
    const c0 = b[i];
    if (c0 < 0x80) { return [c0, 1]; }
    const cont = (k: number) => i + k < end && (b[i + k] & 0xC0) === 0x80;
    if (c0 >= 0xC2 && c0 <= 0xDF && cont(1)) {
        return [((c0 & 0x1F) << 6) | (b[i + 1] & 0x3F), 2];
    }
    if ((c0 & 0xF0) === 0xE0 && cont(1) && cont(2)) {
        const v = ((c0 & 0x0F) << 12) | ((b[i + 1] & 0x3F) << 6) | (b[i + 2] & 0x3F);
        if (v >= 0x800 && (v < 0xD800 || v > 0xDFFF)) { return [v, 3]; }
    }
    if (c0 >= 0xF0 && c0 <= 0xF4 && cont(1) && cont(2) && cont(3)) {
        const v = ((c0 & 0x07) << 18) | ((b[i + 1] & 0x3F) << 12) |
                  ((b[i + 2] & 0x3F) << 6) | (b[i + 3] & 0x3F);
        if (v >= 0x10000 && v <= 0x10FFFF) { return [v, 4]; }
    }
    return [c0, 1];
}

/** C1 code points read as Windows-1252 (WHATWG does the same for latin1). */
function c1(cp: number): number {
    return cp >= 0x80 && cp < 0xA0 && CP1252_C1[cp - 0x80] ? CP1252_C1[cp - 0x80] : cp;
}

/** Bytes an East Asian charset takes for the character at b[i]. */
function cjkLen(cs: string, b: Bytes, i: number, end: number): number {
    const c0 = b[i], c1b = i + 1 < end ? b[i + 1] : 0;
    switch (cs) {
        case 'shift_jis':
            if (c0 >= 0xA1 && c0 <= 0xDF) { return 1; }
            return ((c0 >= 0x81 && c0 <= 0x9F) || (c0 >= 0xE0 && c0 <= 0xFC)) &&
                   c1b >= 0x40 && c1b !== 0x7F && c1b <= 0xFC ? 2 : 1;
        case 'euc-jp':
            if (c0 === 0x8F) { return i + 2 < end && c1b >= 0xA1 && b[i + 2] >= 0xA1 ? 3 : 1; }
            return (c0 === 0x8E || c0 >= 0xA1) && c1b >= 0xA1 ? 2 : 1;
        case 'gb18030':
            if (c0 < 0x81 || c0 === 0xFF) { return 1; }
            if (c1b >= 0x30 && c1b <= 0x39) {
                return i + 3 < end && b[i + 2] >= 0x81 && b[i + 3] >= 0x30 && b[i + 3] <= 0x39 ? 4 : 1;
            }
            return c1b >= 0x40 && c1b !== 0x7F && c1b !== 0xFF ? 2 : 1;
        default:                                     // big5, euc-kr (UHC)
            return c0 >= 0x81 && c0 !== 0xFF && c1b >= 0x41 && c1b !== 0xFF ? 2 : 1;
    }
}

/** A TextDecoder for the label, if the host has one that knows it. */
function hostDecoder(cs: string): { decode(b: Uint8Array): string } | null {
    const TD = (typeof globalThis !== 'undefined' ? (globalThis as any).TextDecoder : undefined);
    if (!TD) { return null; }
    try { return new TD(cs); } catch { return null; }
}

/**
 * Decode bytes [start, end) of text in charset `cs` (an ASCII-compatible
 * one, or UTF-16/UTF-32).  '' and 'utf-8' read UTF-8 with a byte that is not
 * a valid sequence taken as ISO-8859-1, as period WAP browsers did.
 */
export function decodeText(b: Bytes, cs: string, start?: number, end?: number): string {
    let i = start || 0;
    const e = end === undefined ? b.length : end;
    let out = '';
    const page = CODE_PAGES[cs];
    if (cs === 'utf-16be' || cs === 'utf-16le' || cs === 'utf-16' ||
        cs === 'utf-32be' || cs === 'utf-32le') {
        const unit = cs.indexOf('32') >= 0 ? 4 : 2, big = cs.indexOf('le') < 0;
        for (; i + unit <= e; i += unit) {
            let v = 0;
            for (let k = 0; k < unit; k++) { v = v * 256 + b[i + (big ? k : unit - 1 - k)]; }
            if (unit === 4) { out += v > 0 && v <= 0x10FFFF && (v < 0xD800 || v > 0xDFFF) ? fromCodePoint(v) : '?'; }
            else { out += String.fromCharCode(v); }       // surrogate pairs pass through
        }
        return out;
    }
    if (CJK.indexOf(cs) >= 0 || cs === 'iso-2022-jp') {
        const td = hostDecoder(cs === 'gb18030' ? 'gb18030' : cs);
        if (td) { return td.decode(toUint8(b, i, e)); }
    }
    let chunk = '';
    while (i < e) {
        const c0 = b[i];
        let cp: number, n = 1;
        if (c0 < 0x80) {
            cp = c0;
        } else if (page) {
            cp = c0 < page.first ? c0 : page.map[c0 - page.first];
            if (!cp) { cp = 0x3F; }                  // undefined byte: '?'
        } else if (cs === 'iso-8859-1') {
            cp = c1(c0);
        } else if (CJK.indexOf(cs) >= 0) {
            n = cjkLen(cs, b, i, e);
            cp = cs === 'shift_jis' && n === 1 && c0 >= 0xA1 && c0 <= 0xDF ? 0xFF61 + (c0 - 0xA1) : 0x3F;
        } else {
            const r = utf8At(b, i, e);
            cp = r[1] === 1 ? c1(r[0]) : r[0];
            n = r[1];
        }
        chunk += fromCodePoint(cp);
        if (chunk.length > 4096) { out += chunk; chunk = ''; }
        i += n;
    }
    return out + chunk;
}

function toUint8(b: Bytes, start: number, end: number): Uint8Array {
    const u = new Uint8Array(end - start);
    for (let k = start; k < end; k++) { u[k - start] = b[k]; }
    return u;
}

// ── Decks ────────────────────────────────────────────────────────────

let defaultCharset = '';

/**
 * Charset of decks that name none and are not UTF-8 ("windows-1251",
 * "koi8-r", ...), as a phone set up for that language would read them;
 * '' guesses instead (Cyrillic windows-1251 / KOI8-R, else ISO-8859-1).
 * Returns false for an unknown name.
 */
export function setDefaultCharset(name: string): boolean {
    const cs = charsetByName(name);
    if (name && !cs) { return false; }
    defaultCharset = cs;
    return true;
}

/** The encoding pseudo-attribute of an XML declaration at the start, '' if none. */
function xmlDeclCharset(b: Bytes): string {
    let head = '';
    for (let i = 0; i < b.length && i < 200; i++) {
        const c = b[i];
        if (c === 0x3E) { break; }                         // '>'
        head += String.fromCharCode(c);
    }
    const m = /^\s*<\?xml\s[^?]*?encoding\s*=\s*["']([^"']+)["']/.exec(head);
    return m ? charsetByName(m[1]) : '';
}

/**
 * The charset of a deck that names none (WML 1.3 §6.1 leaves this error
 * case to the user agent): valid UTF-8, or UTF-8 with a few stray bytes,
 * is UTF-8; otherwise the default (setDefaultCharset), else a guess: high
 * bytes mostly in whole-word runs are Cyrillic — windows-1251 when lower
 * case falls in 0xE0-0xFF, KOI8-R when in 0xC0-0xDF — anything else
 * ISO-8859-1.
 */
export function undeclaredCharset(b: Bytes): string {
    let valid = 0, bad = 0;
    for (let i = 0; i < b.length;) {
        if (b[i] < 0x80) { i++; continue; }
        const r = utf8At(b, i, b.length);
        if (r[1] > 1) { valid++; } else { bad++; }
        i += r[1];
    }
    if (!bad || valid > bad) { return 'utf-8'; }
    if (defaultCharset) { return defaultCharset; }
    let high = 0, inRuns = 0, run = 0, top = 0, mid = 0;
    for (let i = 0; i <= b.length; i++) {
        const c = i < b.length ? b[i] : 0;
        if (c >= 0x80) {
            high++; run++;
            if (c >= 0xE0) { top++; } else if (c >= 0xC0) { mid++; }
            continue;
        }
        if (run >= 3) { inRuns += run; }
        run = 0;
    }
    if (inRuns * 2 > high) { return top >= mid ? 'windows-1251' : 'koi8-r'; }
    return 'iso-8859-1';
}

/**
 * Decode a text deck (or WMLScript source, which has no XML declaration):
 * a byte-order mark, then `headerCharset` (from the Content-Type), then the
 * XML declaration, else the undeclared rule.  Returns the text and the
 * charset it was read in — the default for text sent back (§9.5.1).
 */
export function decodeDeck(b: Bytes, headerCharset?: string): { text: string; charset: string } {
    const n = b.length;
    let cs = '', skip = 0;
    if (n >= 4 && b[0] === 0 && b[1] === 0 && b[2] === 0xFE && b[3] === 0xFF) { cs = 'utf-32be'; skip = 4; }
    else if (n >= 4 && b[0] === 0xFF && b[1] === 0xFE && b[2] === 0 && b[3] === 0) { cs = 'utf-32le'; skip = 4; }
    else if (n >= 2 && b[0] === 0xFE && b[1] === 0xFF) { cs = 'utf-16be'; skip = 2; }
    else if (n >= 2 && b[0] === 0xFF && b[1] === 0xFE) { cs = 'utf-16le'; skip = 2; }
    else if (n >= 3 && b[0] === 0xEF && b[1] === 0xBB && b[2] === 0xBF) { cs = 'utf-8'; skip = 3; }
    else if (n >= 4 && !b[0] && !b[1] && !b[2] && b[3] === 0x3C) { cs = 'utf-32be'; }
    else if (n >= 4 && b[0] === 0x3C && !b[1] && !b[2] && !b[3]) { cs = 'utf-32le'; }
    else if (n >= 4 && !b[0] && b[1] === 0x3C && !b[2] && b[3] === 0x3F) { cs = 'utf-16be'; }
    else if (n >= 4 && b[0] === 0x3C && !b[1] && b[2] === 0x3F && !b[3]) { cs = 'utf-16le'; }
    if (cs) {
        // a wide deck's text goes back as UTF-8, like a UTF-8 one's
        return { text: decodeText(b, cs, skip), charset: 'utf-8' };
    }
    cs = headerCharset || xmlDeclCharset(b) || undeclaredCharset(b);
    if (cs === 'utf-16') { cs = 'utf-16be'; }
    const text = decodeText(b, cs);
    const wide = cs.indexOf('utf-16') === 0 || cs.indexOf('utf-32') === 0;
    return { text, charset: wide ? 'utf-8' : cs };
}

// ── Encoding text sent to servers ────────────────────────────────────

/** Bytes of code point cp in charset cs, or null when cs lacks it.
 *  UTF-8 for '' / utf-8 / UTF-16 / UTF-32; East Asian charsets: ASCII only. */
export function encodeChar(cp: number, cs: string): number[] | null {
    if (cp < 0x80) { return [cp]; }
    const page = CODE_PAGES[cs];
    if (page) {
        if (cp < page.first) { return [cp]; }
        const k = page.map.indexOf(cp);
        return k >= 0 ? [k + page.first] : null;
    }
    if (cs === 'iso-8859-1') {
        if (cp >= 0xA0 && cp <= 0xFF) { return [cp]; }
        const k = CP1252_C1.indexOf(cp);
        return k >= 0 ? [k + 0x80] : null;
    }
    if (CJK.indexOf(cs) >= 0 || cs === 'iso-2022-jp') { return null; }
    if (cp < 0x800) { return [0xC0 | (cp >> 6), 0x80 | (cp & 0x3F)]; }
    if (cp < 0x10000) { return [0xE0 | (cp >> 12), 0x80 | ((cp >> 6) & 0x3F), 0x80 | (cp & 0x3F)]; }
    return [0xF0 | (cp >> 18), 0x80 | ((cp >> 12) & 0x3F), 0x80 | ((cp >> 6) & 0x3F), 0x80 | (cp & 0x3F)];
}

/**
 * Percent-encode s in charset cs: the RFC 2396 unreserved set as is, every
 * other byte %xx (lower case, as escapeUrlString), a character cs lacks as
 * '?' (%3f); `form`: application/x-www-form-urlencoded (space '+').
 */
export function percentEncode(s: string, cs: string, form?: boolean): string {
    let out = '';
    for (let i = 0; i < s.length; i++) {
        let cp = s.charCodeAt(i);
        if (cp >= 0xD800 && cp <= 0xDBFF && i + 1 < s.length) {
            const lo = s.charCodeAt(i + 1);
            if (lo >= 0xDC00 && lo <= 0xDFFF) { cp = 0x10000 + ((cp - 0xD800) << 10) + (lo - 0xDC00); i++; }
        }
        const ch = s.charAt(i);
        if (cp < 0x80 && /[A-Za-z0-9\-_.!~*'()]/.test(ch)) { out += ch; continue; }
        if (form && cp === 0x20) { out += '+'; continue; }
        const bytes = encodeChar(cp, cs) || [0x3F];
        for (let k = 0; k < bytes.length; k++) {
            out += '%' + (bytes[k] < 16 ? '0' : '') + bytes[k].toString(16);
        }
    }
    return out;
}

/** Code point -> byte map of a single-byte charset (for the webview's
 *  escape conversion), null for UTF-8 and the East Asian charsets. */
export function charsetByteMap(cs: string): { [cp: number]: number } | null {
    const map: { [cp: number]: number } = {};
    const page = CODE_PAGES[cs];
    if (page) {
        for (let k = 0; k < page.map.length; k++) { if (page.map[k]) { map[page.map[k]] = k + page.first; } }
        for (let k = 0x80; k < page.first; k++) { map[k] = k; }
        return map;
    }
    if (cs === 'iso-8859-1') {
        for (let k = 0xA0; k <= 0xFF; k++) { map[k] = k; }
        for (let k = 0; k < 32; k++) { if (CP1252_C1[k]) { map[CP1252_C1[k]] = k + 0x80; } }
        return map;
    }
    return null;
}
