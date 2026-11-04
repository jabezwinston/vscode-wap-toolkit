/**
 *
 *  Copyright (C) 2026 Jabez Winston
 * 
 *  SPDX-License-Identifier: Apache-2.0
 *
 *  Date : 18-March-2026
 * 
 *  WMLScript Standard Library Implementation
 *  Implements the six standard libraries defined in WAP-194-WMLScriptLibraries.
 *
 *  Each function receives a WmlsValue[] and returns a WmlsValue.
 *  The VM calls these via CALL_LIB instructions.
 */
import { StdLibrary, WmlsType } from './opcodes';

// WMLScript value representation
export type WmlsValue =
    | { type: WmlsType.Integer; value: number }
    | { type: WmlsType.Float; value: number }
    | { type: WmlsType.String; value: string }
    | { type: WmlsType.Boolean; value: boolean }
    | { type: WmlsType.Invalid };

const INT_MIN = -2147483648, INT_MAX = 2147483647;
const F32 = new Float32Array(1);

/** n in single precision (Math.fround, which the Android app's KitKat
 *  WebView lacks) */
export function fround(n: number): number {
    F32[0] = n;
    return F32[0];
}

/** WMLScript:
 *  - 12.4.1.2 Integer Overflow
 *  - 12.4.3.1 Integer Too Large
 *
 * An integer: n truncated, invalid past 32 bits (WMLScript: 12.4.1.2, 12.4.3.1) */
export function mkInt(n: number): WmlsValue {
    const t = Math.trunc(n);
    return t >= INT_MIN && t <= INT_MAX ? { type: WmlsType.Integer, value: t | 0 } : mkInvalid();
}
/** WMLScript: 6.2.7.2 Floating-point Size
 *
 * A float: n rounded to single precision (WMLScript: 6.2.7.2), invalid when not
 *  finite there (overflow, WMLScript: 12.4.1.3); an underflow is 0 (WMLScript: 12.4.1.4) */
export function mkFloat(n: number): WmlsValue {
    const f = fround(n);
    return isFinite(f) ? { type: WmlsType.Float, value: f } : mkInvalid();
}
export function mkString(s: string): WmlsValue { return { type: WmlsType.String, value: s }; }
export function mkBool(b: boolean): WmlsValue { return { type: WmlsType.Boolean, value: b }; }
export function mkInvalid(): WmlsValue { return { type: WmlsType.Invalid }; }

const NUM_STR = /^[ \t\n\v\f\r]*([+-]?(?:[0-9]+\.?[0-9]*|\.[0-9]+)(?:[eE][+-]?[0-9]+)?)[ \t\n\v\f\r]*$/;

/** WMLScript: 7.4 Numeric String Grammar
 *
 * A string as a number by the numeric literal grammar (WMLScript: 7.4): an integer,
 *  a float (an integer past 32 bits reads as one), or invalid */
export function strNum(s: string): WmlsValue {
    const m = NUM_STR.exec(s);
    if (!m) { return mkInvalid(); }
    const v = Number(m[1]);
    return /[.eE]/.test(m[1]) || v < INT_MIN || v > INT_MAX ? mkFloat(v) : mkInt(v);
}

/** WMLScript: 6.9 Operator Data Type Conversion Rules
 *
 * Integer or floating-point (unary), conversion rule 5 (WMLScript: 6.9) */
export function unaryNum(v: WmlsValue): WmlsValue {
    switch (v.type) {
        case WmlsType.Integer:
        case WmlsType.Float: return v;
        case WmlsType.Boolean: return mkInt(v.value ? 1 : 0);
        case WmlsType.String: return strNum(v.value);
        default: return mkInvalid();
    }
}

// Convert WmlsValue to number for arithmetic (rule 5; null for invalid)
export function toNumber(v: WmlsValue): number | null {
    const n = unaryNum(v);
    return n.type === WmlsType.Invalid ? null : (n.value as number);
}

// WMLScript: 6.8.3 Conversions to Integer
export function toInteger(v: WmlsValue): number | null {
    const n = toNumber(v);
    return n !== null ? Math.trunc(n) : null;
}

// WMLScript: 6.8.5 Conversions to Boolean
export function toBool(v: WmlsValue): boolean | null {
    switch (v.type) {
        case WmlsType.Boolean: return v.value;
        case WmlsType.Integer: return v.value !== 0;
        case WmlsType.Float: return v.value !== 0;
        case WmlsType.String: return v.value.length > 0;
        default: return null;
    }
}

// WMLScript: 6.8.2 Conversions to String
export function toString(v: WmlsValue): string {
    switch (v.type) {
        case WmlsType.Integer: return String(v.value);
        case WmlsType.Float: return fmtFloat(v.value);
        case WmlsType.String: return v.value;
        case WmlsType.Boolean: return v.value ? 'true' : 'false';
        case WmlsType.Invalid: return 'invalid';
    }
}

/** C's %.*g */
function fmtG(x: number, p: number): string {
    if (x === 0) { return 1 / x < 0 ? '-0' : '0'; }
    const [mant, ex] = x.toExponential(p - 1).split('e');
    const e = Number(ex);
    if (e < -4 || e >= p) {
        const m = mant.includes('.') ? mant.replace(/\.?0+$/, '') : mant;
        return m + 'e' + (e < 0 ? '-' : '+') + String(Math.abs(e)).padStart(2, '0');
    }
    const s = x.toFixed(p - 1 - e);
    return s.includes('.') ? s.replace(/\.?0+$/, '') : s;
}

/** A float as the shortest %g form (6 to 9 digits) that reads back as the
 *  same single-precision value: WMLScript: 6.8.2, the string equals the float
 *  ("0.5", "16777216", "0.33333334") — as wap-browser-c */
export function fmtFloat(f: number): string {
    for (let p = 6; ; p++) {
        const s = fmtG(f, p);
        if (p >= 9 || fround(Number(s)) === f) { return s; }
    }
}

// ── Spec helpers (WAP-194 WMLScript Standard Libraries) ──────────────

/** Float.int() semantics — truncate toward zero; null if not a number. */
function floatInt(v: WmlsValue): number | null {
    const n = toNumber(v);
    return n !== null ? Math.trunc(n) : null;
}

/** WMLScript Libraries:
 *  - 7.2 min
 *  - 7.3 max
 *
 * Preserve the *selected* operand's numeric type for Lang.min/max (WMLScript Libraries: 7.2-7.3). */
function asNumberValue(v: WmlsValue, n: number): WmlsValue {
    if (v.type === WmlsType.Integer || v.type === WmlsType.Float) { return v; }
    return Number.isInteger(n) ? mkInt(n) : mkFloat(n);
}

/** WMLScript Libraries:
 *  - 7.13 random
 *  - 7.14 seed
 *
 * Deterministic Park–Miller LCG so Lang.seed() yields repeatable sequences. */
function rngNext(ctx: LibraryContext): number {
    if (ctx.rngState === undefined || ctx.rngState === null) { return Math.random(); }
    ctx.rngState = (ctx.rngState * 16807) % 2147483647;
    return (ctx.rngState - 1) / 2147483646;
}

interface UrlParts { scheme: string; host: string; port: string; path: string; query: string; fragment: string; }

/** RFC2396 URL split — never throws, supports relative URLs (not resolved). */
function parseUrlParts(u: string): UrlParts {
    const m = /^(?:([a-zA-Z][a-zA-Z0-9+.-]*):)?(?:\/\/([^/?#]*))?([^?#]*)(?:\?([^#]*))?(?:#(.*))?$/.exec(u) ?? [];
    const scheme = m[1] ?? '';
    const authority = m[2];               // contents between "//" and the path
    const path = m[3] ?? '';
    const query = m[4] ?? '';
    const fragment = m[5] ?? '';
    let host = '', port = '';
    if (authority !== undefined) {
        const at = authority.indexOf('@');
        const hostport = at >= 0 ? authority.slice(at + 1) : authority;
        const colon = hostport.lastIndexOf(':');
        if (colon >= 0 && /^[0-9]*$/.test(hostport.slice(colon + 1))) {
            host = hostport.slice(0, colon);
            port = hostport.slice(colon + 1);
        } else {
            host = hostport;
        }
    }
    return { scheme, host, port, path, query, fragment };
}

/** WMLScript Libraries: 10.1 isValid
 *
 * Basic URL syntax validity (absolute or relative) per RFC2396 (WMLScript Libraries: 10.1). */
function isValidUrl(u: string): boolean {
    // Reject control chars, spaces, non-ASCII and the "unwise"/delimiter set when unescaped.
    return !/[\x00-\x20\x7f-￿<>"{}|\\^`]/.test(u);
}

/** Strip per-segment ";" parameters from a path (WMLScript Libraries: 10.5 getPath). */
function stripPathParams(path: string): string {
    return path.split('/').map((seg) => { const i = seg.indexOf(';'); return i >= 0 ? seg.slice(0, i) : seg; }).join('/');
}

/** Parameters of the last path segment (WMLScript Libraries: 10.6 getParameters). */
function lastSegmentParams(path: string): string {
    const segs = path.split('/');
    const last = segs[segs.length - 1];
    const i = last.indexOf(';');
    return i >= 0 ? last.slice(i + 1) : '';
}

const URL_SAFE = /[A-Za-z0-9\-_.!~*'()]/;

/** WMLScript Libraries: 10.12 escapeString
 *
 * URL.escapeString (WMLScript Libraries: 10.12) — lowercase %xx for everything outside the unreserved set. */
function escapeUrlString(s: string): string | null {
    let out = '';
    for (let i = 0; i < s.length; i++) {
        const code = s.charCodeAt(i);
        if (code > 0xFF) { return null; }   // > U+00FF → invalid
        out += URL_SAFE.test(s[i]) ? s[i] : '%' + code.toString(16).padStart(2, '0');
    }
    return out;
}

/** WMLScript Libraries: 10.13 unescapeString
 *
 * URL.unescapeString (WMLScript Libraries: 10.13) — replace %xx; invalid if input has non-US-ASCII chars. */
function unescapeUrlString(s: string): string | null {
    if (/[^\x00-\x7f]/.test(s)) { return null; }
    return s.replace(/%([0-9a-fA-F]{2})/g, (_m, h) => String.fromCharCode(parseInt(h, 16)));
}

/** Leading signed-integer parse for String.format %d (per parseInt grammar). */
function intForFormat(v: WmlsValue): number | null {
    if (v.type === WmlsType.String) {
        const m = /^[+-]?[0-9]+/.exec(v.value.trim());
        return m ? parseInt(m[0], 10) : null;
    }
    const n = toNumber(v);
    return n !== null ? Math.trunc(n) : null;
}

function floatForFormat(v: WmlsValue): number | null {
    if (v.type === WmlsType.String) { const n = Number(v.value.trim()); return isNaN(n) ? null : n; }
    return toNumber(v);
}

function padLeft(s: string, width: number | undefined): string {
    return (width !== undefined && s.length < width) ? ' '.repeat(width - s.length) + s : s;
}

/** WMLScript Libraries: 9.16 format
 *
 * String.format (WMLScript Libraries: 9.16) — single printf-style specifier %[width][.prec]{d,f,s}; %% literal. */
function wmlsFormat(fmt: string, value: WmlsValue): WmlsValue {
    let result = '';
    let firstDone = false;
    let i = 0;
    while (i < fmt.length) {
        if (fmt[i] !== '%') { result += fmt[i++]; continue; }
        if (fmt[i + 1] === '%') { result += '%'; i += 2; continue; }
        const m = /^%([0-9]+)?(?:\.([0-9]+))?([dfs])/.exec(fmt.slice(i));
        if (!m) { return mkInvalid(); }   // illegal format specifier
        i += m[0].length;
        if (firstDone) { continue; }      // subsequent specifiers → empty string
        const width = m[1] !== undefined ? parseInt(m[1], 10) : undefined;
        const prec = m[2] !== undefined ? parseInt(m[2], 10) : undefined;
        const tok = renderFormatSpec(m[3], width, prec, value);
        if (tok === null) { return mkInvalid(); }
        result += tok;
        firstDone = true;
    }
    return mkString(result);
}

function renderFormatSpec(type: string, width: number | undefined, prec: number | undefined, value: WmlsValue): string | null {
    if (type === 'd') {
        const n = intForFormat(value);
        if (n === null) { return null; }
        const precision = prec ?? 1;
        const abs = Math.abs(n);
        let digits: string;
        if (precision === 0 && n === 0) { digits = ''; }
        else { digits = String(abs); if (digits.length < precision) { digits = '0'.repeat(precision - digits.length) + digits; } }
        return padLeft((n < 0 ? '-' : '') + digits, width);
    }
    if (type === 'f') {
        const x = floatForFormat(value);
        if (x === null) { return null; }
        return padLeft(x.toFixed(prec ?? 6), width);
    }
    // type === 's'
    let str = toString(value);
    if (prec !== undefined) { str = str.slice(0, prec); }
    if (width !== undefined && !(prec !== undefined && width > prec)) { str = padLeft(str, width); }
    return str;
}

export type StdLibFunction = (args: WmlsValue[]) => WmlsValue;
export type OutputCallback = (text: string) => void;

// Context for library functions that need external system interaction
export interface LibraryContext {
    // WMLBrowser context
    wmlVariables: Map<string, string>;
    wmlVars: Record<string, string>;    // plain-object alias used by preview
    currentCard: string;                // the current card's absolute URL (deck#card), '' if none
    onOutput?: OutputCallback;

    // WMLBrowser callbacks for external integration
    onSetVar?: (name: string, value: string) => void;
    onGo?: (url: string) => void;
    onRefresh?: () => void;
    onPrev?: () => void;
    onNewContext?: () => void;

    // Control flow
    exitResult?: WmlsValue;
    aborted?: boolean;

    // Interactive Dialogs (WMLScript Libraries: 12): when true, Dialogs.* suspend the VM by throwing
    // DialogSuspend so an async driver can present a real modal and resume with
    // the user's response. When false (default — headless runs, tests, debug),
    // they log the message via onOutput and return the WAP-194 default value.
    interactiveDialogs?: boolean;

    // Lang.seed/random — Park–Miller LCG state (undefined ⇒ use Math.random)
    rngState?: number | null;

    // URL.getBase / URL.getReferer context (WMLScript Libraries: 10.9-10.10)
    baseUrl?: string;
    refererUrl?: string;

    // External (URL) function-call resolver — Alias#func() / CALL_URL (WMLScript: 6.4 / WMLS-C-078..082)
    onCallUrl?: (url: string, funcName: string, args: WmlsValue[]) => WmlsValue;

    // Synchronous content provider for URL.loadString (WMLScript Libraries: 10.14). The interpreter
    // cannot itself block on a network fetch, so a host may supply already-fetched
    // content here; absent ⇒ loadString returns invalid. Returning null/undefined
    // signals the resource could not be loaded (also ⇒ invalid).
    onLoadString?: (url: string, contentType: string) => string | null | undefined;

    // Integer-only-device support (WMLScript: 13): when false the Float library returns invalid (WMLSSL-046)
    floatSupported?: boolean;
}

export function createDefaultContext(): LibraryContext {
    return {
        wmlVariables: new Map(),
        wmlVars: {},
        currentCard: '',
    };
}

// === Lang Library (0) ===
// WMLScript Libraries: 7 LANG
function langLib(ctx: LibraryContext): StdLibFunction[] {
    return [
        // 0: abs(value) — integer→integer, floating-point→floating-point (WMLScript Libraries: 7.1)
        (args) => {
            const v = args[0];
            const n = toNumber(v);
            if (n === null) { return mkInvalid(); }
            if (v.type === WmlsType.Float) { return mkFloat(Math.abs(n)); }
            if (v.type === WmlsType.Integer) { return mkInt(Math.abs(n)); }
            return Number.isInteger(n) ? mkInt(Math.abs(n)) : mkFloat(Math.abs(n));
        },
        // 1: min(a, b) — returns the selected operand's value AND type; ties select the first (WMLScript Libraries: 7.2)
        (args) => {
            const a = args[0], b = args[1];
            const an = toNumber(a), bn = toNumber(b);
            if (an === null || bn === null) { return mkInvalid(); }
            return bn < an ? asNumberValue(b, bn) : asNumberValue(a, an);
        },
        // 2: max(a, b) — returns the selected operand's value AND type; ties select the first (WMLScript Libraries: 7.3)
        (args) => {
            const a = args[0], b = args[1];
            const an = toNumber(a), bn = toNumber(b);
            if (an === null || bn === null) { return mkInvalid(); }
            return bn > an ? asNumberValue(b, bn) : asNumberValue(a, an);
        },
        // 3: parseInt(str)
        (args) => {
            const s = toString(args[0]).trim();
            const n = parseInt(s, 10);
            return isNaN(n) ? mkInvalid() : mkInt(n);
        },
        // 4: parseFloat(str)
        (args) => {
            const s = toString(args[0]).trim();
            const n = parseFloat(s);
            return isNaN(n) ? mkInvalid() : mkFloat(n);
        },
        // 5: isInt(value)
        (args) => {
            const arg = args[0];
            if (arg.type === WmlsType.Invalid) return mkInvalid();

            if (arg.type === WmlsType.Integer) return mkBool(true);
            if (arg.type === WmlsType.Float) return mkBool(Number.isInteger(arg.value));
            if (arg.type === WmlsType.String) {
                const s = arg.value.trim();
                if (s.length === 0) return mkBool(false);
                const n = Number(s);
                return mkBool(!isNaN(n) && Number.isInteger(n));
            }

            return mkBool(false);
        },
        // 6: isFloat(value)
        (args) => {
            const arg = args[0];
            if (arg.type === WmlsType.Invalid) return mkInvalid();

            if (arg.type === WmlsType.Integer) return mkBool(true);
            if (arg.type === WmlsType.Float) return mkBool(true);
            if (arg.type === WmlsType.String) {
                const s = arg.value.trim();
                if (s.length === 0) return mkBool(false);
                const n = Number(s);
                return mkBool(!isNaN(n));
            }

            return mkBool(false);
        },
        // 7: maxInt()
        () => mkInt(2147483647),
        // 8: minInt()
        () => mkInt(-2147483648),
        // 9: float() — returns true if floats are supported (WMLScript Libraries: 7.10)
        () => mkBool(ctx.floatSupported !== false),
        // 10: exit(value)
        (args) => {
            ctx.exitResult = args[0];
            return mkInvalid();
        },
        // 11: abort(reason)
        (args) => {
            ctx.aborted = true;
            ctx.exitResult = args[0];
            return mkInvalid();
        },
        // 12: random(n) — 0..n inclusive; n<0 → invalid; n==0 → 0; float→Float.int (WMLScript Libraries: 7.13)
        (args) => {
            const n = floatInt(args[0]);
            if (n === null || n < 0) { return mkInvalid(); }
            if (n === 0) { return mkInt(0); }
            return mkInt(Math.floor(rngNext(ctx) * (n + 1)));
        },
        // 13: seed(value) — seed≥0 ⇒ repeatable; <0 ⇒ random; non-numeric ⇒ invalid, seed unchanged (WMLScript Libraries: 7.14)
        (args) => {
            const n = floatInt(args[0]);
            if (n === null) { return mkInvalid(); }
            ctx.rngState = n >= 0
                ? (n % 2147483646) + 1
                : Math.floor(Math.random() * 2147483646) + 1;
            return mkString('');
        },
        // 14: characterSet() WMLScript Libraries: 7.15 — the native charset: strings hold any
        // Unicode character, as UTF-8 (MIBenum 106) in wap-browser-c
        () => mkInt(106),
    ];
}

// === Float Library (1) ===
// WMLScript Libraries: 8 FLOAT
// WMLScript: 13 SUPPORT FOR INTEGER ONLY DEVICES
function floatLib(ctx: LibraryContext): StdLibFunction[] {
    const fns: StdLibFunction[] = [
        // 0: int(value)
        (args) => {
            const n = toNumber(args[0]);
            return n !== null ? mkInt(Math.trunc(n)) : mkInvalid();
        },
        // 1: floor(value)
        (args) => {
            const n = toNumber(args[0]);
            return n !== null ? mkInt(Math.floor(n)) : mkInvalid();
        },
        // 2: ceil(value)
        (args) => {
            const n = toNumber(args[0]);
            return n !== null ? mkInt(Math.ceil(n)) : mkInvalid();
        },
        // 3: pow(base, exp)
        (args) => {
            const base = toNumber(args[0]), exp = toNumber(args[1]);
            if (base === null || exp === null) { return mkInvalid(); }
            return mkFloat(Math.pow(base, exp));
        },
        // 4: round(value)
        (args) => {
            const n = toNumber(args[0]);
            return n !== null ? mkInt(Math.round(n)) : mkInvalid();
        },
        // 5: sqrt(value)
        (args) => {
            const n = toNumber(args[0]);
            if (n === null || n < 0) { return mkInvalid(); }
            return mkFloat(Math.sqrt(n));
        },
        // 6: maxFloat()
        () => mkFloat(3.4028235e+38),
        // 7: minFloat()
        () => mkFloat(1.17549435e-38),
    ];
    // WMLScript: 13 SUPPORT FOR INTEGER ONLY DEVICES / WMLSSL-046: on integer-only devices every Float function returns invalid.
    return fns.map((f) => (args: WmlsValue[]) => ctx.floatSupported === false ? mkInvalid() : f(args));
}

// === String Library (2) ===
// WMLScript Libraries: 9 STRING
function stringLib(_ctx: LibraryContext): StdLibFunction[] {
    return [
        // 0: length(str)
        (args) => mkInt(toString(args[0]).length),
        // 1: isEmpty(str)
        (args) => mkBool(toString(args[0]).length === 0),
        // 2: charAt(str, index)
        (args) => {
            const s = toString(args[0]);
            const i = toInteger(args[1]);
            if (i === null || i < 0 || i >= s.length) { return mkString(''); }
            return mkString(s[i]);
        },
        // 3: subString(str, start, length)
        (args) => {
            const s = toString(args[0]);
            const start = toInteger(args[1]);
            const len = toInteger(args[2]);
            if (start === null || len === null) { return mkInvalid(); }
            const st = Math.max(0, Math.min(start, s.length));
            const ln = Math.max(0, len);
            return mkString(s.substring(st, st + ln));
        },
        // 4: find(str, substr)
        (args) => {
            const s = toString(args[0]);
            const sub = toString(args[1]);
            return mkInt(s.indexOf(sub));
        },
        // 5: replace(str, old, new)
        (args) => {
            const s = toString(args[0]);
            const old = toString(args[1]);
            const repl = toString(args[2]);
            return mkString(s.split(old).join(repl));
        },
        // 6: elements(str, separator) — only the FIRST char of separator is used (WMLScript Libraries: 9.7)
        (args) => {
            const s = toString(args[0]);
            const sep = toString(args[1]);
            if (sep.length === 0) { return mkInvalid(); }
            return mkInt(s.split(sep[0]).length);
        },
        // 7: elementAt(str, index, separator) — clamp index; empty string → "" (WMLScript Libraries: 9.8)
        (args) => {
            const s = toString(args[0]);
            const idx = floatInt(args[1]);
            const sep = toString(args[2] ?? mkString(','));
            if (idx === null || sep.length === 0) { return mkInvalid(); }
            if (s.length === 0) { return mkString(''); }
            const parts = s.split(sep[0]);
            const i = idx < 0 ? 0 : idx >= parts.length ? parts.length - 1 : idx;
            return mkString(parts[i]);
        },
        // 8: removeAt(str, index, separator) — clamp index; empty string → "" (WMLScript Libraries: 9.9)
        (args) => {
            const s = toString(args[0]);
            const idx = floatInt(args[1]);
            const sep = toString(args[2] ?? mkString(','));
            if (idx === null || sep.length === 0) { return mkInvalid(); }
            if (s.length === 0) { return mkString(''); }
            const parts = s.split(sep[0]);
            const i = idx < 0 ? 0 : idx >= parts.length ? parts.length - 1 : idx;
            parts.splice(i, 1);
            return mkString(parts.join(sep[0]));
        },
        // 9: replaceAt(str, element, index, separator) — clamp index; empty string → element (WMLScript Libraries: 9.10)
        (args) => {
            const s = toString(args[0]);
            const elem = toString(args[1]);
            const idx = floatInt(args[2]);
            const sep = toString(args[3] ?? mkString(','));
            if (idx === null || sep.length === 0) { return mkInvalid(); }
            if (s.length === 0) { return mkString(elem); }
            const parts = s.split(sep[0]);
            const i = idx < 0 ? 0 : idx >= parts.length ? parts.length - 1 : idx;
            parts[i] = elem;
            return mkString(parts.join(sep[0]));
        },
        // 10: insertAt(str, element, index, separator) — index<0→0, >count→append; empty→element (WMLScript Libraries: 9.11)
        (args) => {
            const s = toString(args[0]);
            const elem = toString(args[1]);
            const idx = floatInt(args[2]);
            const sep = toString(args[3] ?? mkString(','));
            if (idx === null || sep.length === 0) { return mkInvalid(); }
            if (s.length === 0) { return mkString(elem); }
            const parts = s.split(sep[0]);
            const i = idx < 0 ? 0 : idx > parts.length ? parts.length : idx;
            parts.splice(i, 0, elem);
            return mkString(parts.join(sep[0]));
        },
        // 11: squeeze(str)
        (args) => {
            const s = toString(args[0]);
            return mkString(s.replace(/\s+/g, ' '));
        },
        // 12: trim(str)
        (args) => mkString(toString(args[0]).trim()),
        // 13: compare(str1, str2)
        (args) => {
            const a = toString(args[0]), b = toString(args[1]);
            return mkInt(a < b ? -1 : a > b ? 1 : 0);
        },
        // 14: toString(value)
        (args) => mkString(toString(args[0])),
        // 15: format(format, value) — printf-style %[width][.precision]{d,f,s}; %% literal (WMLScript Libraries: 9.16)
        (args) => wmlsFormat(toString(args[0]), args[1] ?? mkString('')),
    ];
}

// === URL Library (3) — RFC2396 parsing; absolute AND relative URLs (not resolved) ===
// WMLScript Libraries: 10 URL
function urlLib(ctx: LibraryContext): StdLibFunction[] {
    return [
        // 0: isValid(url) (WMLScript Libraries: 10.1)
        (args) => mkBool(isValidUrl(toString(args[0]))),
        // 1: getScheme(url) (WMLScript Libraries: 10.2)
        (args) => {
            const s = toString(args[0]);
            return isValidUrl(s) ? mkString(parseUrlParts(s).scheme) : mkInvalid();
        },
        // 2: getHost(url) (WMLScript Libraries: 10.3)
        (args) => {
            const s = toString(args[0]);
            return isValidUrl(s) ? mkString(parseUrlParts(s).host) : mkInvalid();
        },
        // 3: getPort(url) (WMLScript Libraries: 10.4)
        (args) => {
            const s = toString(args[0]);
            return isValidUrl(s) ? mkString(parseUrlParts(s).port) : mkInvalid();
        },
        // 4: getPath(url) — segment ";" parameters removed (WMLScript Libraries: 10.5)
        (args) => {
            const s = toString(args[0]);
            return isValidUrl(s) ? mkString(stripPathParams(parseUrlParts(s).path)) : mkInvalid();
        },
        // 5: getParameters(url) — params of the LAST path segment (WMLScript Libraries: 10.6)
        (args) => {
            const s = toString(args[0]);
            return isValidUrl(s) ? mkString(lastSegmentParams(parseUrlParts(s).path)) : mkInvalid();
        },
        // 6: getQuery(url) — without the leading '?' (WMLScript Libraries: 10.7)
        (args) => {
            const s = toString(args[0]);
            return isValidUrl(s) ? mkString(parseUrlParts(s).query) : mkInvalid();
        },
        // 7: getFragment(url) (WMLScript Libraries: 10.8)
        (args) => {
            const s = toString(args[0]);
            return isValidUrl(s) ? mkString(parseUrlParts(s).fragment) : mkInvalid();
        },
        // 8: getBase() — absolute URL (without fragment) of the current unit (WMLScript Libraries: 10.9)
        () => {
            const base = ctx.baseUrl ?? '';
            const h = base.indexOf('#');
            return mkString(h >= 0 ? base.slice(0, h) : base);
        },
        // 9: getReferer() — relative to the unit (WMLScript Libraries: 10.10)
        () => mkString(relativeToUnit(ctx.refererUrl ?? '', ctx.baseUrl ?? '')),
        // 10: resolve(baseUrl, embeddedUrl) per RFC2396 (WMLScript Libraries: 10.11)
        (args) => {
            try { return mkString(new URL(toString(args[1]), toString(args[0])).toString()); }
            catch { return mkInvalid(); }
        },
        // 11: escapeString(str) — lowercase %xx for non-unreserved chars (WMLScript Libraries: 10.12)
        (args) => {
            const r = escapeUrlString(toString(args[0]));
            return r === null ? mkInvalid() : mkString(r);
        },
        // 12: unescapeString(str) (WMLScript Libraries: 10.13)
        (args) => {
            const r = unescapeUrlString(toString(args[0]));
            return r === null ? mkInvalid() : mkString(r);
        },
        // 13: loadString(url, contentType) — WMLScript Libraries: 10.14. The interpreter cannot block
        // on a network fetch, so a host may provide content synchronously via
        // ctx.onLoadString; absent (or content unavailable / bad type) ⇒ invalid.
        (args) => {
            const url = toString(args[0]);
            const ct = toString(args[1] ?? mkString(''));
            if (!/^text\/\S+$/.test(ct)) { return mkInvalid(); }   // erroneous content type
            if (!isValidUrl(url)) { return mkInvalid(); }
            const body = ctx.onLoadString?.(url, ct);
            return body === undefined || body === null ? mkInvalid() : mkString(body);
        },
    ];
}

// === WMLBrowser Library (4) ===

/** A variable name as WML allows it (WML 1.3: 10.3.1) */
const WML_VAR_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

/**
 * WMLScript Libraries:
 *  - 10.10 getReferer
 *  - 11.6 getCurrentCard
 *
 * `abs` relative to the unit at `base` (WMLScript Libraries: 10.10, 11.6): the name
 * alone when it is in the unit's directory, else `abs` itself, as
 * wap-browser-c does
 */
export function relativeToUnit(abs: string, base: string): string {
    const dir = base.slice(0, base.lastIndexOf('/') + 1);
    if (!dir || !abs.startsWith(dir)) { return abs; }
    const rest = abs.slice(dir.length);
    return rest.split(/[?#]/)[0].includes('/') ? abs : rest;
}

// WMLScript Libraries: 11 WMLBROWSER
function wmlBrowserLib(ctx: LibraryContext): StdLibFunction[] {
    // Not invoked by a WML browser (no navigation hooks): every function
    // is invalid (WMLScript Libraries: 11)
    const lib: StdLibFunction[] = [
        // 0: getVar(name) — "" when not set; invalid for a name WML does not allow
        (args) => {
            const name = toString(args[0]);
            if (!WML_VAR_NAME.test(name)) { return mkInvalid(); }
            // Check plain-object vars first, then Map
            const val = ctx.wmlVars[name] ?? ctx.wmlVariables.get(name);
            return val !== undefined ? mkString(val) : mkString('');
        },
        // 1: setVar(name, value)
        (args) => {
            const name = toString(args[0]);
            if (!WML_VAR_NAME.test(name)) { return mkInvalid(); }
            const value = toString(args[1]);
            ctx.wmlVariables.set(name, value);
            ctx.wmlVars[name] = value;
            ctx.onSetVar?.(name, value);
            return mkBool(true);
        },
        // 2: go(url) — the last go() or prev() stays in effect; go("") cancels (WMLScript Libraries: 11.3)
        (args) => {
            ctx.onGo?.(toString(args[0]));
            return mkString('');
        },
        // 3: prev()
        () => {
            ctx.onPrev?.();
            return mkString('');
        },
        // 4: newContext() — the variables and the history; a previous or
        // later prev() has no effect, a go() stays (WMLScript Libraries: 11.5)
        () => {
            ctx.wmlVariables.clear();
            for (const key of Object.keys(ctx.wmlVars)) {
                delete ctx.wmlVars[key];
            }
            ctx.onNewContext?.();
            return mkString('');
        },
        // 5: getCurrentCard() — relative to the unit; invalid with no card (WMLScript Libraries: 11.6)
        () => ctx.currentCard ? mkString(relativeToUnit(ctx.currentCard, ctx.baseUrl ?? ''))
            : mkInvalid(),
        // 6: refresh()
        () => {
            ctx.onRefresh?.();
            return mkString('');
        },
    ];
    return lib.map((fn) => (args: WmlsValue[]) => ctx.onGo ? fn(args) : mkInvalid());
}

// === Dialogs Library (5) ===

/** A pending interactive dialog, carried out of the VM by DialogSuspend. */
export interface DialogRequest {
    type: 'prompt' | 'confirm' | 'alert';
    message: string;
    def?: string;          // prompt: default/initial input
    okLabel?: string;      // confirm: label for the true/OK button
    cancelLabel?: string;  // confirm: label for the false/Cancel button
}

/**
 * Thrown by a Dialogs.* function when ctx.interactiveDialogs is set, to suspend
 * the VM at the library call. An async driver (WmlsVM.runAsync) catches it,
 * presents the modal, and resumes by pushing the user's (coerced) response.
 */
export class DialogSuspend extends Error {
    constructor(public readonly request: DialogRequest) {
        super('WMLScript dialog requires interactive execution');
        this.name = 'DialogSuspend';
    }

    /**
     * Recognise a suspend without relying on its prototype.
     *
     * Subclassing a built-in does not survive an ES5 downlevel: the emitted
     * `_super.call(this, ...) || this` keeps the *fresh* Error that Error()
     * returns rather than `this`, so the instance's prototype is
     * Error.prototype and `instanceof DialogSuspend` is false. This compiles to
     * ES2020 for the extension, where that is a non-issue, but a consumer
     * targeting ES5 — the Android browser does, its WebView floor being
     * Chromium 30 — silently lost every Dialogs.* call: the suspend escaped
     * runAsync and surfaced as the error meant to be impossible to see,
     * "WMLScript dialog requires interactive execution".
     *
     * Matching on shape holds under either target.
     */
    static is(e: unknown): e is DialogSuspend {
        if (e instanceof DialogSuspend) { return true; }
        const candidate = e as { name?: unknown; request?: unknown } | null | undefined;
        return !!candidate && candidate.name === 'DialogSuspend'
            && typeof candidate.request === 'object' && candidate.request !== null;
    }
}

// WMLScript Libraries: 12 DIALOGS
function dialogsLib(ctx: LibraryContext): StdLibFunction[] {
    return [
        // 0: prompt(message, default)
        (args) => {
            if (ctx.interactiveDialogs) {
                throw new DialogSuspend({
                    type: 'prompt',
                    message: toString(args[0]),
                    def: args[1] !== undefined ? toString(args[1]) : '',
                });
            }
            ctx.onOutput?.(`[PROMPT] ${toString(args[0])}`);
            return args[1] ?? mkString('');
        },
        // 1: confirm(message, ok, cancel)
        (args) => {
            if (ctx.interactiveDialogs) {
                throw new DialogSuspend({
                    type: 'confirm',
                    message: toString(args[0]),
                    okLabel: args[1] !== undefined ? toString(args[1]) : 'OK',
                    cancelLabel: args[2] !== undefined ? toString(args[2]) : 'Cancel',
                });
            }
            ctx.onOutput?.(`[CONFIRM] ${toString(args[0])}`);
            return mkBool(true);
        },
        // 2: alert(message)
        (args) => {
            if (ctx.interactiveDialogs) {
                throw new DialogSuspend({ type: 'alert', message: toString(args[0]) });
            }
            ctx.onOutput?.(`[ALERT] ${toString(args[0])}`);
            return mkString('');
        },
    ];
}

// === Console Library (6) — Non-standard debug ===
function consoleLib(ctx: LibraryContext): StdLibFunction[] {
    return [
        // 0: print(value)
        (args) => {
            ctx.onOutput?.(toString(args[0]));
            return mkString('');
        },
        // 1: println(value)
        (args) => {
            ctx.onOutput?.(toString(args[0]) + '\n');
            return mkString('');
        },
    ];
}

// === Library Registry ===
export function getStdLibFunctions(ctx: LibraryContext): Map<number, StdLibFunction[]> {
    const libs = new Map<number, StdLibFunction[]>();
    libs.set(StdLibrary.Lang, langLib(ctx));
    libs.set(StdLibrary.Float, floatLib(ctx));
    libs.set(StdLibrary.String, stringLib(ctx));
    libs.set(StdLibrary.URL, urlLib(ctx));
    libs.set(StdLibrary.WMLBrowser, wmlBrowserLib(ctx));
    libs.set(StdLibrary.Dialogs, dialogsLib(ctx));
    libs.set(StdLibrary.Console, consoleLib(ctx));
    return libs;
}
