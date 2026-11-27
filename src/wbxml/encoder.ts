/**
 *
 *  Copyright (C) 2026 Jabez Winston
 *
 *  SPDX-License-Identifier: Apache-2.0
 *
 *  Date : 07-April-2026
 *
 *  WBXML Encoder - Converts WML XML to WBXML binary format
 *  Based on WAP-192-WBXML-20010725 specification
 *
 *  The deck is read as XML: well-formed or refused, entities resolved
 *  (WBXML 1.3: 6.1, 6.2).  Its variable references are checked against
 *  the WML 1.3 DTD's attribute types and become EXT_I tokens (WML 1.3:
 *  14.2.1, 14.2.3.2); "$$" becomes a dollar sign.  Every element,
 *  attribute and processing instruction is written, known names as
 *  tokens and others as literals; the public identifier is the
 *  DOCTYPE's (WBXML 1.3: 5.5).  A deck it refuses throws WbxmlEncodeError.
 */
import {
    WBXML_VERSION, CHARSET_UTF8,
    END, STR_I, LITERAL, LITERAL_A, LITERAL_C, LITERAL_AC, PI,
    EXT_I_0, EXT_I_1, EXT_I_2,
    TAG_HAS_CONTENT, TAG_HAS_ATTRS, MB_UINT_MORE, MB_UINT_BITS,
    WML_TAG_TOKENS, WML_ATTR_START_TOKENS, WML_ATTR_VALUE_TOKENS,
} from './tokenTable';

/** A deck an encoder must refuse: not well-formed, or a variable
 *  reference with bad syntax or where none may be.  Told apart by its
 *  name: instanceof does not survive an ES5 downlevel of a built-in
 *  subclass (see wmlsc's DialogSuspend) */
export class WbxmlEncodeError extends Error {
    constructor(message: string) {
        super(message);
        this.name = 'WbxmlEncodeError';
    }
}

export function encodeWbxml(wmlContent: string): Buffer {
    const encoder = new WbxmlEncoder();
    return encoder.encode(wmlContent);
}

interface XmlNode {
    type: 'element' | 'text' | 'pi';
    name: string;               // element name, PI target
    text: string;               // text, PI data (entities resolved)
    attrs: [string, string][];  // in source order
    children: XmlNode[];
    pos: number;
}

// WBXML 1.3: 5.5 Document Public Identifier
//
// The WML public identifiers' numbers (WBXML 1.3: 7.2.1)
const PUBLIC_IDS: Record<string, number> = {
    '-//WAPFORUM//DTD WML 1.0//EN': 0x02,
    '-//WAPFORUM//DTD WML 1.1//EN': 0x04,
    '-//WAPFORUM//DTD WML 1.2//EN': 0x09,
    '-//WAPFORUM//DTD WML 1.3//EN': 0x0A,
};
const PUBLIC_ID_UNKNOWN = 0x01;

// WML 1.3: 14.2.3.2 Validate %vdata;
//
// The attributes the WML 1.3 DTD declares, per element: H %HREF;
// (variables; none given is escape), V %vdata; or %ContentType;
// (variables; none given is noesc), C any other type (no variables).  An
// attribute the DTD does not declare is %vdata;.
const DTD_ATTRS: Record<string, string> = {
    wml: 'Cxml:lang Cid Cclass',
    card: 'Vtitle Cnewcontext Cordered Cxml:lang Honenterforward Honenterbackward Hontimer Cid Cclass',
    do: 'Ctype Vlabel Cname Coptional Cxml:lang Cid Cclass',
    onevent: 'Ctype Cid Cclass',
    head: 'Cid Cclass',
    template: 'Honenterforward Honenterbackward Hontimer Cid Cclass',
    access: 'Cdomain Cpath Cid Cclass',
    meta: 'Chttp-equiv Cname Cforua Ccontent Cscheme Cid Cclass',
    go: 'Hhref Csendreferer Cmethod Venctype Ccache-control Caccept-charset Cid Cclass',
    prev: 'Cid Cclass',
    refresh: 'Cid Cclass',
    noop: 'Cid Cclass',
    postfield: 'Vname Vvalue Cid Cclass',
    setvar: 'Vname Vvalue Cid Cclass',
    select: 'Vtitle Cname Vvalue Ciname Vivalue Cmultiple Ctabindex Cxml:lang Cid Cclass',
    optgroup: 'Vtitle Cxml:lang Cid Cclass',
    option: 'Vvalue Vtitle Honpick Cxml:lang Cid Cclass',
    input: 'Cname Ctype Vvalue Cformat Cemptyok Csize Cmaxlength Ctabindex Vtitle Vaccesskey Cxml:lang Cid Cclass',
    fieldset: 'Vtitle Cxml:lang Cid Cclass',
    timer: 'Cname Vvalue Cid Cclass',
    img: 'Valt Hsrc Vlocalsrc Cvspace Chspace Calign Cheight Cwidth Cxml:lang Cid Cclass',
    anchor: 'Vtitle Vaccesskey Cxml:lang Cid Cclass',
    a: 'Hhref Vtitle Vaccesskey Cxml:lang Cid Cclass',
    table: 'Vtitle Calign Ccolumns Cxml:lang Cid Cclass',
    tr: 'Cid Cclass',
    td: 'Cxml:lang Cid Cclass',
    em: 'Cxml:lang Cid Cclass',
    strong: 'Cxml:lang Cid Cclass',
    b: 'Cxml:lang Cid Cclass',
    i: 'Cxml:lang Cid Cclass',
    u: 'Cxml:lang Cid Cclass',
    big: 'Cxml:lang Cid Cclass',
    small: 'Cxml:lang Cid Cclass',
    p: 'Calign Cmode Cxml:lang Cid Cclass',
    br: 'Cid Cclass',
    pre: 'Cxml:space Cid Cclass',
};

type VarCtx = 'text' | 'href' | 'vdata' | 'none';

function attrCtx(elem: string, attr: string): VarCtx {
    const list = Object.prototype.hasOwnProperty.call(DTD_ATTRS, elem) ? DTD_ATTRS[elem] : undefined;
    if (list !== undefined) {
        for (const a of list.split(' ')) {
            if (a.substring(1) === attr) {
                return a[0] === 'H' ? 'href' : a[0] === 'V' ? 'vdata' : 'none';
            }
        }
    }
    return 'vdata';
}

/** Elements whose content may be text (the DTD's #PCDATA): elsewhere text
 *  that is only white space is not content (WML 1.3: 11.8.1) */
const MIXED = ['option', 'fieldset', 'anchor', 'a', 'td', 'em', 'strong', 'b', 'i', 'u',
    'big', 'small', 'p', 'pre'];

// WML 1.3: 6.2 Character Entities
//
// The entities XML and the WML 1.3 DTD declare, and the HTML names this
// extension has always read (an extension: no WML encoder must know them)
const ENTITIES: Record<string, number> = {
    quot: 0x22, amp: 0x26, apos: 0x27, lt: 0x3C, gt: 0x3E, nbsp: 0xA0, shy: 0xAD,
    iexcl: 0xA1, cent: 0xA2, pound: 0xA3, curren: 0xA4,
    yen: 0xA5, brvbar: 0xA6, sect: 0xA7, uml: 0xA8, copy: 0xA9,
    ordf: 0xAA, laquo: 0xAB, not: 0xAC, reg: 0xAE,
    macr: 0xAF, deg: 0xB0, plusmn: 0xB1, sup2: 0xB2, sup3: 0xB3,
    acute: 0xB4, micro: 0xB5, para: 0xB6, middot: 0xB7, cedil: 0xB8,
    sup1: 0xB9, ordm: 0xBA, raquo: 0xBB, frac14: 0xBC, frac12: 0xBD,
    frac34: 0xBE, iquest: 0xBF, times: 0xD7, divide: 0xF7,
    bull: 0x2022, hellip: 0x2026, trade: 0x2122, larr: 0x2190,
    rarr: 0x2192, euro: 0x20AC,
};

const CONVS = ['escape', 'unesc', 'noesc'];       // EXT_x_0, 1, 2

function isSpace(c: string): boolean {
    return c === ' ' || c === '\t' || c === '\n' || c === '\r';
}

function nameStart(c: string): boolean {
    return /[A-Za-z_:]/.test(c) || c.charCodeAt(0) > 0x7F;
}

function nameChar(c: string): boolean {
    return nameStart(c) || /[0-9.\-]/.test(c);
}

/** A code point as a JS string (no String.fromCodePoint on a KitKat WebView) */
function fromCodePoint(cp: number): string {
    if (cp < 0x10000) { return String.fromCharCode(cp); }
    cp -= 0x10000;
    return String.fromCharCode(0xD800 + (cp >> 10), 0xDC00 + (cp & 0x3FF));
}

class WbxmlEncoder {
    private src = '';
    private pos = 0;
    private publicId: string | null = null;
    private hasDoctype = false;
    private stringTable: Map<string, number> = new Map();
    private stringTableBytes: number[] = [];

    private fail(at: number, msg: string): never {
        let line = 1;
        for (let i = 0; i < at && i < this.src.length; i++) {
            if (this.src.charCodeAt(i) === 10) { line++; }
        }
        throw new WbxmlEncodeError(`line ${line}: ${msg}`);
    }

    // WBXML 1.3:
    //  - 5.3 BNF for Document Structure
    //  - 5.4 Version Number
    //  - 5.5 Document Public Identifier
    //  - 5.6 Charset
    //  - 5.7 String Table
    encode(wml: string): Buffer {
        // a byte-order mark, and line ends as "\n" (XML 1.0: 2.11)
        this.src = wml.replace(/^﻿/, '').replace(/\r\n?/g, '\n');
        this.pos = 0;
        this.stringTable = new Map();
        this.stringTableBytes = [];
        const top = this.readDocument();

        // The public identifier: a WML one's number, another as a string in
        // the string table, none 1 ("unknown or missing")
        const known = this.publicId !== null &&
            Object.prototype.hasOwnProperty.call(PUBLIC_IDS, this.publicId);
        const pid = this.publicId === null ? PUBLIC_ID_UNKNOWN : known ? PUBLIC_IDS[this.publicId] : 0;
        const pidRef = pid === 0 ? this.tableRef(this.publicId!) : 0;

        // Encode the body (this also populates the string table)
        const bodyBytes: number[] = [];
        for (const n of top) {
            if (n.type === 'pi') { this.encodePi(n, bodyBytes); }
            else { this.encodeElement(n, bodyBytes, false); }
        }

        // Build final output: header + string table + body
        const result: number[] = [];
        result.push(WBXML_VERSION);
        this.appendMbUint32(result, pid);
        if (pid === 0) { this.appendMbUint32(result, pidRef); }
        this.appendMbUint32(result, CHARSET_UTF8);
        this.appendMbUint32(result, this.stringTableBytes.length);
        for (const b of this.stringTableBytes) { result.push(b); }
        for (const b of bodyBytes) { result.push(b); }
        return Buffer.from(result);
    }

    // ── The source: XML read into a tree ──────────────────────────

    private at(s: string): boolean {
        return this.src.startsWith(s, this.pos);
    }

    private skipSpace(): void {
        while (this.pos < this.src.length && isSpace(this.src[this.pos])) { this.pos++; }
    }

    private readName(what: string): string {
        const s = this.pos;
        if (this.pos >= this.src.length || !nameStart(this.src[this.pos])) {
            this.fail(this.pos, `${what} expected`);
        }
        while (this.pos < this.src.length && nameChar(this.src[this.pos])) { this.pos++; }
        return this.src.substring(s, this.pos);
    }

    // WML 1.3: 6.2 Character Entities
    //
    // At '&': its reference ("&#n;", "&#xh;", a named entity), as text.
    // Parsed entities must be resolved (WBXML 1.3: 6.1): any other is refused.
    private readReference(): string {
        const s = this.pos;
        const m = /^&(#[0-9]+|#x[0-9A-Fa-f]+|[A-Za-z_:][A-Za-z0-9_:.\-]*);/.exec(
            this.src.substring(s, s + 48));
        if (!m) { return this.fail(s, '\'&\' that does not start an entity reference (write &amp;)'); }
        this.pos = s + m[0].length;
        const ref = m[1];
        if (ref[0] === '#') {
            const cp = ref[1] === 'x' ? parseInt(ref.substring(2), 16) : parseInt(ref.substring(1), 10);
            if (!(cp > 0 && cp <= 0x10FFFF) || (cp >= 0xD800 && cp <= 0xDFFF)) {
                this.fail(s, `bad character reference "${m[0]}"`);
            }
            return fromCodePoint(cp);
        }
        if (!Object.prototype.hasOwnProperty.call(ENTITIES, ref)) {
            this.fail(s, `entity "${m[0]}" is not defined (WML 1.3: 6.2): write it as a character reference`);
        }
        return String.fromCharCode(ENTITIES[ref]);
    }

    /** A quoted attribute value, references resolved; literal white space
     *  characters become spaces (XML 1.0: 3.3.3) */
    private readValue(): string {
        const q = this.src[this.pos];
        if (q !== '"' && q !== '\'') { this.fail(this.pos, 'attribute value must be quoted'); }
        this.pos++;
        let v = '';
        while (this.pos < this.src.length && this.src[this.pos] !== q) {
            const c = this.src[this.pos];
            if (c === '<') { this.fail(this.pos, '\'<\' in an attribute value'); }
            if (c === '&') { v += this.readReference(); }
            else { v += isSpace(c) ? ' ' : c; this.pos++; }
        }
        if (this.pos >= this.src.length) { this.fail(this.pos, 'attribute value without its closing quote'); }
        this.pos++;
        return v;
    }

    // WBXML 1.3: 5.8.4.4 Processing Instruction
    private readPi(): XmlNode {
        const start = this.pos;
        this.pos += 2;
        const name = this.readName('processing instruction target');
        const e = this.src.indexOf('?>', this.pos);
        if (e < 0) { this.fail(start, 'processing instruction without "?>"'); }
        if (this.pos < e && !isSpace(this.src[this.pos])) {
            this.fail(this.pos, 'space expected after the processing instruction target');
        }
        this.skipSpace();
        const text = this.pos < e ? this.src.substring(this.pos, e) : '';
        this.pos = e + 2;
        return { type: 'pi', name, text, attrs: [], children: [], pos: start };
    }

    private skipComment(): void {
        const e = this.src.indexOf('-->', this.pos + 4);
        if (e < 0) { this.fail(this.pos, 'comment without "-->"'); }
        this.pos = e + 3;
    }

    // WBXML 1.3: 6.2 Document Structure Conformance
    private readElement(): XmlNode {
        const el: XmlNode = { type: 'element', name: '', text: '', attrs: [], children: [], pos: this.pos };
        this.pos++;
        el.name = this.readName('element name');
        for (;;) {
            const hadSpace = this.pos < this.src.length && isSpace(this.src[this.pos]);
            this.skipSpace();
            if (this.pos >= this.src.length) { this.fail(el.pos, `<${el.name}> is not closed`); }
            if (this.at('/>')) { this.pos += 2; return el; }
            if (this.src[this.pos] === '>') {
                this.pos++;
                this.readContent(el);
                return el;
            }
            if (!hadSpace) { this.fail(this.pos, 'space expected between attributes'); }
            const s = this.pos;
            const name = this.readName('attribute name');
            if (el.attrs.some(([k]) => k === name)) { this.fail(s, `attribute "${name}" repeated`); }
            this.skipSpace();
            if (this.src[this.pos] !== '=') { this.fail(this.pos, `'=' expected after "${name}"`); }
            this.pos++;
            this.skipSpace();
            el.attrs.push([name, this.readValue()]);
        }
    }

    private readContent(el: XmlNode): void {
        let text = '';
        let textPos = this.pos;
        const flush = () => {
            if (text) { el.children.push({ type: 'text', name: '', text, attrs: [], children: [], pos: textPos }); }
            text = '';
        };
        for (;;) {
            if (this.pos >= this.src.length) { this.fail(el.pos, `<${el.name}> is not closed`); }
            const c = this.src[this.pos];
            if (c === '<' && !this.at('<![CDATA[')) {
                if (this.at('<!--')) { this.skipComment(); continue; }
                flush();
                if (this.at('</')) {
                    const s = this.pos;
                    this.pos += 2;
                    const name = this.readName('element name');
                    this.skipSpace();
                    if (this.src[this.pos] !== '>') { this.fail(this.pos, '\'>\' expected'); }
                    this.pos++;
                    if (name !== el.name) { this.fail(s, `</${name}> does not close <${el.name}>`); }
                    return;
                }
                el.children.push(this.at('<?') ? this.readPi() : this.readElement());
                textPos = this.pos;
                continue;
            }
            if (!text) { textPos = this.pos; }
            if (c === '<') {                    // a CDATA section: as it is
                const e = this.src.indexOf(']]>', this.pos + 9);
                if (e < 0) { this.fail(this.pos, 'CDATA section without "]]>"'); }
                text += this.src.substring(this.pos + 9, e);
                this.pos = e + 3;
            } else if (c === '&') {
                text += this.readReference();
            } else if (this.at(']]>')) {
                this.fail(this.pos, '"]]>" in text (XML 1.0: 2.4): write ]]&gt;');
            } else {
                text += c;
                this.pos++;
            }
        }
    }

    /** At "<!DOCTYPE": its public identifier; an internal subset is skipped */
    private readDoctype(): void {
        this.hasDoctype = true;
        this.pos += 9;
        this.skipSpace();
        this.readName('document type name');
        this.skipSpace();
        if (this.at('PUBLIC') || this.at('SYSTEM')) {
            const pub = this.at('PUBLIC');
            this.pos += 6;
            for (let k = 0; k < (pub ? 2 : 1); k++) {
                this.skipSpace();
                const q = this.src[this.pos];
                if (q !== '"' && q !== '\'') {
                    if (k === 1) { break; }
                    this.fail(this.pos, 'quoted identifier expected in the DOCTYPE');
                }
                const e = this.src.indexOf(q, this.pos + 1);
                if (e < 0) { this.fail(this.pos, 'DOCTYPE identifier without its closing quote'); }
                if (pub && k === 0) { this.publicId = this.src.substring(this.pos + 1, e); }
                this.pos = e + 1;
            }
        }
        this.skipSpace();
        if (this.src[this.pos] === '[') {
            const e = this.src.indexOf(']', this.pos);
            if (e < 0) { this.fail(this.pos, 'DOCTYPE internal subset without \']\''); }
            this.pos = e + 1;
            this.skipSpace();
        }
        if (this.src[this.pos] !== '>') { this.fail(this.pos, '\'>\' expected at the end of the DOCTYPE'); }
        this.pos++;
    }

    // WBXML 1.3: 5.3 BNF for Document Structure
    //
    // Processing instructions, the root element, processing instructions
    private readDocument(): XmlNode[] {
        const top: XmlNode[] = [];
        let root = false;
        if (/^<\?xml[ \t\n]/.test(this.src)) {         // for the tokeniser: dropped
            const e = this.src.indexOf('?>');
            if (e < 0) { this.fail(0, 'XML declaration without "?>"'); }
            this.pos = e + 2;
        }
        for (;;) {
            this.skipSpace();
            if (this.pos >= this.src.length) { break; }
            if (this.at('<!--')) { this.skipComment(); }
            else if (/^<\?xml[ \t\n]/.test(this.src.substring(this.pos, this.pos + 6))) {
                this.fail(this.pos, 'XML declaration not at the start of the deck');
            } else if (this.at('<?')) { top.push(this.readPi()); }
            else if (this.at('<!DOCTYPE')) {
                if (root || this.hasDoctype) { this.fail(this.pos, 'DOCTYPE out of place'); }
                this.readDoctype();
            } else if (this.src[this.pos] === '<' && !root) {
                top.push(this.readElement());
                root = true;
            } else {
                this.fail(this.pos, root ? 'content after the root element' : 'content before the root element');
            }
        }
        if (!root) { this.fail(this.pos, 'no root element'); }
        return top;
    }

    // ── WBXML output ──────────────────────────────────────────────

    // WBXML 1.3: 5.8.4.1 Strings
    private strI(s: string, out: number[]): void {
        if (!s) { return; }
        out.push(STR_I);
        const bytes = Buffer.from(s, 'utf-8');
        for (let i = 0; i < bytes.length; i++) { out.push(bytes[i]); }
        out.push(0x00);
    }

    // WML 1.3: 14.3.4 Attribute Value Tokens
    //
    // Literal attribute-value text, with the value tokens it holds
    private attrText(value: string, out: number[]): void {
        let remaining = value;
        let lit = '';
        while (remaining.length > 0) {
            let bestMatch = '';
            for (const key of Object.keys(WML_ATTR_VALUE_TOKENS)) {
                if (remaining.startsWith(key) && key.length > bestMatch.length) { bestMatch = key; }
            }
            if (bestMatch) {
                this.strI(lit, out);
                lit = '';
                out.push(WML_ATTR_VALUE_TOKENS[bestMatch]);
                remaining = remaining.substring(bestMatch.length);
            } else {
                lit += remaining[0];
                remaining = remaining.substring(1);
            }
        }
        this.strI(lit, out);
    }

    // WML 1.3:
    //  - 10.3.1 Variable Substitution
    //  - 14.2.1 Encoding Variables
    //
    // Text or an attribute value (entities resolved) as strings and
    // variable tokens: "$$" is a dollar sign; "$name", "$(name)" and
    // "$(name:conv)" are EXT_I_0 (escape), EXT_I_1 (unesc) or EXT_I_2
    // (noesc), a reference without a conversion taking its context's
    // (escape in an %HREF;, noesc elsewhere).  A reference with bad syntax,
    // or any where none may be, is refused (WML 1.3: 14.2.3.2).
    private encodeValue(v: string, ctx: VarCtx, at: number, what: string, out: number[], attr: boolean): void {
        let lit = '';
        const flush = () => {
            if (attr) { this.attrText(lit, out); } else { this.strI(lit, out); }
            lit = '';
        };
        let i = 0;
        while (i < v.length) {
            if (v[i] !== '$') { lit += v[i++]; continue; }
            if (v[i + 1] === '$') { lit += '$'; i += 2; continue; }
            if (ctx === 'none') {
                this.fail(at, `a variable reference in ${what}, which may hold none (WML 1.3: 14.2.3.2): write $$ for a dollar sign`);
            }
            const m = /^\$(?:\(([A-Za-z_][A-Za-z0-9_]*)(?::([A-Za-z]*))?\)|([A-Za-z_][A-Za-z0-9_]*))/.exec(v.substring(i));
            if (!m) {
                return this.fail(at, `bad variable reference "${v.substring(i, i + 12)}" in ${what} (WML 1.3: 10.3.1): write $$ for a dollar sign`);
            }
            let conv = ctx === 'href' ? 0 : 2;
            if (m[2] !== undefined) {
                // escape, noesc, unesc; deprecated: any case, or the first letter
                const c = m[2].toLowerCase();
                conv = CONVS.findIndex((k) => c === k || c === k[0]);
                if (conv < 0) { this.fail(at, `unknown conversion "${m[2]}" in ${what} (WML 1.3: 10.3.1)`); }
            }
            flush();
            out.push([EXT_I_0, EXT_I_1, EXT_I_2][conv]);
            const name = m[1] !== undefined ? m[1] : m[3];
            for (let k = 0; k < name.length; k++) { out.push(name.charCodeAt(k)); }
            out.push(0x00);
            i += m[0].length;
        }
        flush();
    }

    // WBXML 1.3: 5.8.3 Attribute Code Space (ATTRSTART and ATTRVALUE)
    // WML 1.3: 14.3.3 Attribute Start Tokens
    //
    // The start token whose name it has and whose value prefix starts its
    // value, the longest first (a literal name when WML has none), then the
    // rest of the value
    private encodeAttribute(el: XmlNode, name: string, value: string, out: number[]): void {
        let best = -1;
        let bestPrefix = '';
        for (const key of Object.keys(WML_ATTR_START_TOKENS)) {
            const eq = key.indexOf('=');
            const kname = eq < 0 ? key : key.substring(0, eq);
            const prefix = eq < 0 ? '' : key.substring(eq + 1);
            if (kname === name && value.startsWith(prefix) && (best < 0 || prefix.length > bestPrefix.length)) {
                best = WML_ATTR_START_TOKENS[key];
                bestPrefix = prefix;
            }
        }
        if (best >= 0) {
            out.push(best);
        } else {
            out.push(LITERAL);
            this.appendMbUint32(out, this.tableRef(name));
        }
        this.encodeValue(value.substring(bestPrefix.length), attrCtx(el.name, name), el.pos,
            `<${el.name} ${name}>`, out, true);
    }

    // WBXML 1.3: 5.8.4.4 Processing Instruction
    //
    // PI, the target as an attribute start (a literal name unless it is an
    // attribute's), the data as its value, END
    private encodePi(n: XmlNode, out: number[]): void {
        out.push(PI);
        if (Object.prototype.hasOwnProperty.call(WML_ATTR_START_TOKENS, n.name)) {
            out.push(WML_ATTR_START_TOKENS[n.name]);
        } else {
            out.push(LITERAL);
            this.appendMbUint32(out, this.tableRef(n.name));
        }
        this.strI(n.text, out);
        out.push(END);
    }

    // WBXML 1.3: 6.1 Document Tokenisation
    // WML 1.3: 14.3.2 Tag Tokens
    //
    // An element: its tag (a literal name for one WML does not define),
    // attributes and content.  White space is kept in <pre> and under
    // xml:space="preserve" (WML 1.3: 11.8.1), one space elsewhere; text of
    // white space only is dropped where the element holds no text.
    private encodeElement(el: XmlNode, out: number[], preserve: boolean): void {
        if (el.name === 'pre') { preserve = true; }
        const sp = el.attrs.find(([k]) => k === 'xml:space');
        if (sp) { preserve = sp[1] === 'preserve'; }
        const mixed = MIXED.indexOf(el.name) >= 0;
        const keep = preserve;
        const content = el.children.filter((c) =>
            c.type !== 'text' || keep || mixed || /[^ \t\n\r]/.test(c.text));
        const hasAttrs = el.attrs.length > 0;
        const hasContent = content.length > 0;
        if (Object.prototype.hasOwnProperty.call(WML_TAG_TOKENS, el.name)) {
            out.push(WML_TAG_TOKENS[el.name] | (hasAttrs ? TAG_HAS_ATTRS : 0) |
                (hasContent ? TAG_HAS_CONTENT : 0));
        } else {
            // WBXML 1.3: 5.8.4.5 Literal Tag or Attribute Name
            out.push(hasAttrs ? (hasContent ? LITERAL_AC : LITERAL_A) : hasContent ? LITERAL_C : LITERAL);
            this.appendMbUint32(out, this.tableRef(el.name));
        }
        if (hasAttrs) {
            for (const [k, v] of el.attrs) { this.encodeAttribute(el, k, v, out); }
            out.push(END);
        }
        if (!hasContent) { return; }
        for (const c of content) {
            if (c.type === 'element') { this.encodeElement(c, out, preserve); }
            else if (c.type === 'pi') { this.encodePi(c, out); }
            else {
                const t = preserve ? c.text : c.text.replace(/[ \t\n\r]+/g, ' ');
                this.encodeValue(t, 'text', c.pos, 'text', out, false);
            }
        }
        out.push(END);
    }

    // WBXML 1.3: 5.7 String Table
    //
    // The byte offset of s in the string table, added once
    private tableRef(s: string): number {
        const have = this.stringTable.get(s);
        if (have !== undefined) { return have; }
        const offset = this.stringTableBytes.length;
        this.stringTable.set(s, offset);
        const bytes = Buffer.from(s, 'utf-8');
        for (let i = 0; i < bytes.length; i++) { this.stringTableBytes.push(bytes[i]); }
        this.stringTableBytes.push(0x00);
        return offset;
    }

    // WBXML 1.3: 5.1 Multi-byte Integers
    private appendMbUint32(target: number[], value: number): void {
        if (value <= MB_UINT_BITS) {
            target.push(value);
            return;
        }
        const bytes: number[] = [];
        bytes.push(value & MB_UINT_BITS);
        value >>>= 7;
        while (value > 0) {
            bytes.push((value & MB_UINT_BITS) | MB_UINT_MORE);
            value >>>= 7;
        }
        bytes.reverse();
        for (const b of bytes) { target.push(b); }
    }
}
