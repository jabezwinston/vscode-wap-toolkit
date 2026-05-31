/**
 *  Copyright (C) 2026 Jabez Winston
 *
 *  SPDX-License-Identifier: Apache-2.0
 *
 *  Date : 18-March-2026
 *
 *  WML v1.3 syntax validator.
 *
 *  Schema and conformance rules are derived from the official WAP Forum
 *  WML 1.3 specification (WAP-191) and its DTD:
 *    http://www.wapforum.org/DTD/wml13.dtd
 *
 *  The validation logic (everything down to `validateWmlText`) has no runtime
 *  dependency on the `vscode` API, so it can be unit tested directly with Node.
 *  The `vscode` API is only available inside the extension host, so it is
 *  imported for types only (`import type`, fully erased at compile time) and
 *  loaded lazily via `getVscode()` in the adapter functions at the bottom.
 *  This keeps the boundary enforced: any *value* use of `vscode` outside those
 *  functions is a compile error.
 */

import type * as vscode from 'vscode';

// ---------------------------------------------------------------------------
// Diagnostics (vscode-independent)
// ---------------------------------------------------------------------------

/** Mirrors vscode.DiagnosticSeverity numeric values. */
export enum Severity {
    Error = 0,
    Warning = 1,
    Information = 2,
    Hint = 3,
}

export interface WmlDiag {
    /** 0-based line */
    line: number;
    /** 0-based column */
    col: number;
    /** length of the highlighted range on that line */
    length: number;
    message: string;
    severity: Severity;
}

// ---------------------------------------------------------------------------
// DTD Schema types
// ---------------------------------------------------------------------------

interface ElementDef {
    /** Allowed child *element* names.  `#PCDATA` means text content is OK. */
    children: string[];
    /** Minimum number of child elements (ignoring #PCDATA). 0 = optional */
    minChildren?: number;
    /** EMPTY content model – no children or text allowed */
    empty?: boolean;
    /** Attributes keyed by name */
    attributes: Record<string, AttrDef>;
}

interface AttrDef {
    required?: boolean;
    /** If set, only these literal values are allowed */
    values?: string[];
    /** Fixed value – must be exactly this */
    fixed?: string;
    /**
     * Whether this attribute is of type %vdata / %HREF / %ContentType and may
     * therefore contain variable references ($x, $(x), $(x:conv)).  Attributes
     * without this flag are CDATA/NMTOKEN/ID/enumerated and must escape a
     * literal '$' as '$$' (WAP-191 §7.5, §10.3.5; rules WML-S-64/65).
     */
    vdata?: boolean;
    /** Lexical value type for light validation (WAP-191 §8.2, §8.7). */
    type?: 'number' | 'length';
}

// ---------------------------------------------------------------------------
// Expand DTD entity groups
// ---------------------------------------------------------------------------

const EMPH = ['em', 'strong', 'b', 'i', 'u', 'big', 'small'];
const LAYOUT = ['br'];
const TEXT = ['#PCDATA', ...EMPH];
const FLOW = [...TEXT, ...LAYOUT, 'img', 'anchor', 'a', 'table'];
const TASK = ['go', 'prev', 'noop', 'refresh'];
const NAVELMTS = ['do', 'onevent'];
const FIELDS = [...FLOW, 'input', 'select', 'fieldset'];

/** Intrinsic events legal for each parent element (WAP-191 §9.10, Table 2). */
const INTRINSIC_EVENTS: Record<string, string[]> = {
    'card': ['onenterforward', 'onenterbackward', 'ontimer'],
    'template': ['onenterforward', 'onenterbackward', 'ontimer'],
    'option': ['onpick'],
};

const CORE_ATTRS: Record<string, AttrDef> = {
    'id': {},
    'class': {},
};

// Card/template intrinsic-event attributes are of type %HREF (vdata).
const CARD_EVENT_ATTRS: Record<string, AttrDef> = {
    'onenterforward': { vdata: true },
    'onenterbackward': { vdata: true },
    'ontimer': { vdata: true },
};

// Shorthand attribute descriptors.
const V: AttrDef = { vdata: true };                 // %vdata / %HREF / %ContentType
const VREQ: AttrDef = { required: true, vdata: true };
const NUM: AttrDef = { type: 'number' };
const LEN: AttrDef = { type: 'length' };
const BOOL: AttrDef = { values: ['true', 'false'] };

function attrs(...groups: Record<string, AttrDef>[]): Record<string, AttrDef> {
    return Object.assign({}, ...groups);
}

// ---------------------------------------------------------------------------
// WML 1.3 DTD element definitions
// ---------------------------------------------------------------------------

const DTD_ELEMENTS: Record<string, ElementDef> = {
    'wml': {
        children: ['head', 'template', 'card'],
        minChildren: 1,  // card+
        attributes: attrs(CORE_ATTRS, { 'xml:lang': {} }),
    },
    'head': {
        children: ['access', 'meta'],
        minChildren: 1,
        attributes: attrs(CORE_ATTRS),
    },
    'template': {
        children: [...NAVELMTS],
        attributes: attrs(CORE_ATTRS, CARD_EVENT_ATTRS),
    },
    'card': {
        children: ['onevent', 'timer', 'do', 'p', 'pre'],
        attributes: attrs(CORE_ATTRS, CARD_EVENT_ATTRS, {
            'title': V,
            'newcontext': BOOL,
            'ordered': BOOL,
            'xml:lang': {},
        }),
    },
    'do': {
        children: [...TASK],
        minChildren: 1,
        attributes: attrs(CORE_ATTRS, {
            'type': { required: true },
            'label': V,
            'name': {},
            'optional': BOOL,
            'xml:lang': {},
        }),
    },
    'onevent': {
        children: [...TASK],
        minChildren: 1,
        attributes: attrs(CORE_ATTRS, {
            'type': { required: true },
        }),
    },
    'access': {
        children: [],
        empty: true,
        attributes: attrs(CORE_ATTRS, {
            'domain': {},
            'path': {},
        }),
    },
    'meta': {
        children: [],
        empty: true,
        attributes: attrs(CORE_ATTRS, {
            'http-equiv': {},
            'name': {},
            'forua': BOOL,
            'content': { required: true },
            'scheme': {},
        }),
    },
    'go': {
        children: ['postfield', 'setvar'],
        attributes: attrs(CORE_ATTRS, {
            'href': VREQ,
            'sendreferer': BOOL,
            'method': { values: ['post', 'get'] },
            'enctype': V,
            'cache-control': { values: ['no-cache'] },
            'accept-charset': {},
        }),
    },
    'prev': {
        children: ['setvar'],
        attributes: attrs(CORE_ATTRS),
    },
    'refresh': {
        children: ['setvar'],
        attributes: attrs(CORE_ATTRS),
    },
    'noop': {
        children: [],
        empty: true,
        attributes: attrs(CORE_ATTRS),
    },
    'postfield': {
        children: [],
        empty: true,
        attributes: attrs(CORE_ATTRS, {
            'name': VREQ,
            'value': VREQ,
        }),
    },
    'setvar': {
        children: [],
        empty: true,
        attributes: attrs(CORE_ATTRS, {
            'name': VREQ,
            'value': VREQ,
        }),
    },
    'select': {
        children: ['optgroup', 'option'],
        minChildren: 1,
        attributes: attrs(CORE_ATTRS, {
            'title': V,
            'name': {},
            'value': V,
            'iname': {},
            'ivalue': V,
            'multiple': BOOL,
            'tabindex': NUM,
            'xml:lang': {},
        }),
    },
    'optgroup': {
        children: ['optgroup', 'option'],
        minChildren: 1,
        attributes: attrs(CORE_ATTRS, {
            'title': V,
            'xml:lang': {},
        }),
    },
    'option': {
        children: ['#PCDATA', 'onevent'],
        attributes: attrs(CORE_ATTRS, {
            'value': V,
            'title': V,
            'onpick': V,
            'xml:lang': {},
        }),
    },
    'input': {
        children: [],
        empty: true,
        attributes: attrs(CORE_ATTRS, {
            'name': { required: true },
            'type': { values: ['text', 'password'] },
            'value': V,
            'format': {},
            'emptyok': BOOL,
            'size': NUM,
            'maxlength': NUM,
            'tabindex': NUM,
            'title': V,
            'accesskey': V,
            'xml:lang': {},
        }),
    },
    'fieldset': {
        children: [...FIELDS, 'do'],
        attributes: attrs(CORE_ATTRS, {
            'title': V,
            'xml:lang': {},
        }),
    },
    'timer': {
        children: [],
        empty: true,
        attributes: attrs(CORE_ATTRS, {
            'name': {},
            'value': VREQ,
        }),
    },
    'img': {
        children: [],
        empty: true,
        attributes: attrs(CORE_ATTRS, {
            'alt': VREQ,
            'src': VREQ,
            'localsrc': V,
            'vspace': LEN,
            'hspace': LEN,
            'align': { values: ['top', 'middle', 'bottom'] },
            'height': LEN,
            'width': LEN,
            'xml:lang': {},
        }),
    },
    'anchor': {
        children: ['#PCDATA', 'br', 'img', 'go', 'prev', 'refresh'],
        attributes: attrs(CORE_ATTRS, {
            'title': V,
            'accesskey': V,
            'xml:lang': {},
        }),
    },
    'a': {
        children: ['#PCDATA', 'br', 'img'],
        attributes: attrs(CORE_ATTRS, {
            'href': VREQ,
            'title': V,
            'accesskey': V,
            'xml:lang': {},
        }),
    },
    'table': {
        children: ['tr'],
        minChildren: 1,
        attributes: attrs(CORE_ATTRS, {
            'title': V,
            'align': {},
            'columns': { required: true, type: 'number' },
            'xml:lang': {},
        }),
    },
    'tr': {
        children: ['td'],
        minChildren: 1,
        attributes: attrs(CORE_ATTRS),
    },
    'td': {
        children: [...TEXT, ...LAYOUT, 'img', 'anchor', 'a'],
        attributes: attrs(CORE_ATTRS, {
            'xml:lang': {},
        }),
    },
    'em': { children: [...FLOW], attributes: attrs(CORE_ATTRS, { 'xml:lang': {} }) },
    'strong': { children: [...FLOW], attributes: attrs(CORE_ATTRS, { 'xml:lang': {} }) },
    'b': { children: [...FLOW], attributes: attrs(CORE_ATTRS, { 'xml:lang': {} }) },
    'i': { children: [...FLOW], attributes: attrs(CORE_ATTRS, { 'xml:lang': {} }) },
    'u': { children: [...FLOW], attributes: attrs(CORE_ATTRS, { 'xml:lang': {} }) },
    'big': { children: [...FLOW], attributes: attrs(CORE_ATTRS, { 'xml:lang': {} }) },
    'small': { children: [...FLOW], attributes: attrs(CORE_ATTRS, { 'xml:lang': {} }) },
    'p': {
        children: [...FIELDS, 'do'],
        attributes: attrs(CORE_ATTRS, {
            'align': { values: ['left', 'right', 'center'] },
            'mode': { values: ['wrap', 'nowrap'] },
            'xml:lang': {},
        }),
    },
    'br': {
        children: [],
        empty: true,
        attributes: attrs(CORE_ATTRS),
    },
    'pre': {
        children: ['#PCDATA', 'a', 'anchor', 'do', 'u', 'br', 'i', 'b', 'em', 'strong', 'input', 'select'],
        attributes: attrs(CORE_ATTRS, {
            'xml:space': { fixed: 'preserve' },
        }),
    },
};

// ---------------------------------------------------------------------------
// WML input format mask validation (WAP WML 1.3 §11.6.3)
// ---------------------------------------------------------------------------

/**
 * Format codes:
 *   A  – uppercase letter or symbol/punct
 *   a  – lowercase letter or symbol/punct
 *   N  – numeric digit
 *   n  – numeric digit or symbol/punct
 *   X  – uppercase letter, numeric digit, or symbol/punct
 *   x  – lowercase letter, numeric digit, or symbol/punct
 *   M  – any character (default upper)
 *   m  – any character (default lower)
 *
 * Modifiers:
 *   nf – up to n chars of type f   (n is 1+ digits)
 *   *f – unlimited chars of type f
 *
 * Escape: \c – literal character c  (inserted automatically, not user-entered)
 *
 * A format string is one or more groups: ( [digits | '*'] formatCode | '\' char )
 */

const FORMAT_CODES = new Set(['A', 'a', 'N', 'n', 'X', 'x', 'M', 'm']);

export interface FormatParseResult {
    valid: boolean;
    error?: string;
    /** Whether the format requires at least one user-entered character */
    requiresInput: boolean;
    /** Maximum number of user-enterable characters (Infinity for *-wildcard) */
    maxChars: number;
}

export function parseWmlFormatMask(format: string): FormatParseResult {
    if (!format) {
        return { valid: true, requiresInput: false, maxChars: Infinity };
    }

    let i = 0;
    let hasUserChar = false;  // at least one non-escape group with count > 0
    let totalMax = 0;
    let hasUnlimited = false;

    while (i < format.length) {
        const ch = format[i];

        // Escape sequence: \c
        if (ch === '\\') {
            if (i + 1 >= format.length) {
                return { valid: false, error: `Incomplete escape sequence at end of format`, requiresInput: false, maxChars: 0 };
            }
            i += 2; // skip \c — literal chars don't count as user input
            continue;
        }

        // *f – unlimited
        if (ch === '*') {
            if (i + 1 >= format.length) {
                return { valid: false, error: `Expected format code after '*'`, requiresInput: false, maxChars: 0 };
            }
            const code = format[i + 1];
            if (!FORMAT_CODES.has(code)) {
                return { valid: false, error: `Invalid format code '${code}' after '*'. Expected one of: A, a, N, n, X, x, M, m`, requiresInput: false, maxChars: 0 };
            }
            // *f allows zero or more, so doesn't force input on its own
            hasUnlimited = true;
            i += 2;
            continue;
        }

        // [digits] f – counted group
        let count = '';
        while (i < format.length && format[i] >= '0' && format[i] <= '9') {
            count += format[i];
            i++;
        }

        if (i >= format.length) {
            if (count) {
                return { valid: false, error: `Expected format code after count '${count}'`, requiresInput: false, maxChars: 0 };
            }
            break;
        }

        const code = format[i];
        if (!FORMAT_CODES.has(code)) {
            if (count) {
                return { valid: false, error: `Invalid format code '${code}' after count '${count}'. Expected one of: A, a, N, n, X, x, M, m`, requiresInput: false, maxChars: 0 };
            }
            return { valid: false, error: `Invalid character '${code}' in format mask. Expected a format code (A, a, N, n, X, x, M, m), escape (\\), count, or '*'`, requiresInput: false, maxChars: 0 };
        }

        const n = count ? parseInt(count, 10) : 1;
        if (n > 0) {
            hasUserChar = true;
            totalMax += n;
        }
        i++;
    }

    if (hasUnlimited) {
        totalMax = Infinity;
    }

    return {
        valid: true,
        requiresInput: hasUserChar && !hasUnlimited,
        maxChars: totalMax,
    };
}

/**
 * Determine whether an <input> element allows empty input, per WML 1.3 spec:
 *
 * 1. If emptyok is explicitly set → use that value.
 * 2. If format is specified:
 *    - If all groups use '*' (e.g. "*M", "*N*x") → emptyok defaults true
 *    - If any group has a fixed count (e.g. "3N", "M*M") → emptyok defaults false
 * 3. If neither emptyok nor format is specified → emptyok defaults true
 */
export function resolveEmptyOk(emptyokAttr: string | undefined, format: string | undefined): boolean {
    if (emptyokAttr === 'true') { return true; }
    if (emptyokAttr === 'false') { return false; }
    // Not explicitly set — derive from format
    if (!format) { return true; }
    const parsed = parseWmlFormatMask(format);
    if (!parsed.valid) { return true; } // can't determine, be permissive
    return !parsed.requiresInput;
}

// ---------------------------------------------------------------------------
// Variable-reference scanning (WAP-191 §7.5, §10.3, rules WML-S-64/65)
// ---------------------------------------------------------------------------

// $name | $(name) | $(name:conv)  — conv accepted leniently as any alpha word.
const VAR_REF_RE = /^\$(?:\([A-Za-z_][A-Za-z0-9_]*(?::[A-Za-z]+)?\)|[A-Za-z_][A-Za-z0-9_]*)/;

interface DollarIssue {
    /** offset of the offending '$' within the scanned string */
    index: number;
    message: string;
}

/**
 * Scan a string (attribute value or PCDATA) for dollar-sign usage problems.
 *  - `$$` is always a legal escaped literal dollar.
 *  - When variables are allowed (vdata attribute or text), every other `$`
 *    must begin a valid `$name`/`$(name)`/`$(name:conv)` reference.
 *  - When variables are NOT allowed (CDATA/NMTOKEN/ID/enumerated attributes),
 *    any unescaped `$` is illegal and must be written as `$$`.
 */
function scanDollar(value: string, allowVars: boolean): DollarIssue[] {
    const issues: DollarIssue[] = [];
    let i = 0;
    while (i < value.length) {
        if (value[i] !== '$') { i++; continue; }
        if (value[i + 1] === '$') { i += 2; continue; } // escaped literal
        if (!allowVars) {
            issues.push({
                index: i,
                message: "Variable references ('$') are only allowed in attribute values that may contain variables; write a literal dollar sign as '$$'",
            });
            i++;
            continue;
        }
        const m = VAR_REF_RE.exec(value.slice(i));
        if (m) { i += m[0].length; continue; }
        issues.push({
            index: i,
            message: "Malformed variable reference; use $name, $(name) or $(name:conv), or write a literal dollar sign as '$$'",
        });
        i++;
    }
    return issues;
}

// ---------------------------------------------------------------------------
// Lightweight XML tokeniser + tree builder (keeps source positions)
// ---------------------------------------------------------------------------

interface TextChunk {
    value: string;
    /** absolute offset of the chunk start in the (stripped) document */
    offset: number;
}

interface XmlNode {
    tag: string;
    attributes: Record<string, string>;
    children: XmlNode[];
    hasTextContent: boolean;
    /** Significant text chunks belonging directly to this element */
    texts: TextChunk[];
    /** Line number (0-based) of the opening tag */
    line: number;
    /** Column (0-based) of the '<' that opens this tag */
    col: number;
    /** Attribute positions: name → { line, col } of the attribute name start */
    attrPositions: Record<string, { line: number; col: number }>;
}

interface ParseResult {
    root?: XmlNode;
    error?: { message: string; line: number; col: number };
    /** Whether an XML declaration / DOCTYPE prologue was present (WAP-191 §11.1) */
    hadXmlDecl: boolean;
    hadDoctype: boolean;
    posOf: (offset: number) => { line: number; col: number };
}

/** Simple well-formedness-aware tokeniser that returns a tree or an error. */
function parseWml(text: string): ParseResult {
    const hadXmlDecl = /<\?xml[^?]*\?>/i.test(text);
    const hadDoctype = /<!DOCTYPE[^>]*>/i.test(text);

    // Strip XML declaration and DOCTYPE, preserving newlines for correct line numbers
    const stripped = text
        .replace(/<\?xml[^?]*\?>/gi, (m) => m.replace(/[^\n]/g, ' '))
        .replace(/<!DOCTYPE[^>]*>/gi, (m) => m.replace(/[^\n]/g, ' '));

    // Pre-compute line start offsets
    const lineStarts: number[] = [0];
    for (let i = 0; i < stripped.length; i++) {
        if (stripped[i] === '\n') { lineStarts.push(i + 1); }
    }
    function posOf(offset: number): { line: number; col: number } {
        let lo = 0, hi = lineStarts.length - 1;
        while (lo < hi) {
            const mid = (lo + hi + 1) >> 1;
            if (lineStarts[mid] <= offset) { lo = mid; } else { hi = mid - 1; }
        }
        return { line: lo, col: offset - lineStarts[lo] };
    }

    // Tokenise using regex
    // Matches: comments, CDATA, self-closing tags, opening tags, closing tags
    const tagRe = /<!--[\s\S]*?-->|<!\[CDATA\[[\s\S]*?\]\]>|<(\/?)([\w:.-]+)((?:\s+[\w:.-]+\s*=\s*"[^"]*"|\s+[\w:.-]+\s*=\s*'[^']*')*)\s*(\/?)>/g;
    const attrRe = /([\w:.-]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g;

    const stack: XmlNode[] = [];
    let root: XmlNode | undefined;
    let match: RegExpExecArray | null;
    // Track text between tags for hasTextContent detection
    let lastTagEnd = 0;

    while ((match = tagRe.exec(stripped)) !== null) {
        // Skip comments and CDATA
        if (match[0].startsWith('<!--') || match[0].startsWith('<![CDATA[')) {
            // CDATA counts as text content
            if (match[0].startsWith('<![CDATA[') && stack.length > 0) {
                stack[stack.length - 1].hasTextContent = true;
            }
            lastTagEnd = tagRe.lastIndex;
            continue;
        }

        const isClose = match[1] === '/';
        const tagName = match[2].toLowerCase();
        const attrString = match[3] || '';
        const selfClose = match[4] === '/';
        const pos = posOf(match.index);

        // Check for text content between previous tag end and this tag start
        if (stack.length > 0) {
            const between = stripped.substring(lastTagEnd, match.index);
            if (between.trim().length > 0) {
                const top = stack[stack.length - 1];
                top.hasTextContent = true;
                top.texts.push({ value: between, offset: lastTagEnd });
            }
        }
        lastTagEnd = tagRe.lastIndex;

        if (isClose) {
            // Closing tag
            if (stack.length === 0) {
                return { error: { message: `Unexpected closing tag </${tagName}>`, ...pos }, hadXmlDecl, hadDoctype, posOf };
            }
            const top = stack[stack.length - 1];
            if (top.tag !== tagName) {
                return { error: { message: `Mismatched closing tag: expected </${top.tag}>, found </${tagName}>`, ...pos }, hadXmlDecl, hadDoctype, posOf };
            }
            stack.pop();
            continue;
        }

        // Parse attributes
        const attributes: Record<string, string> = {};
        const attrPositions: Record<string, { line: number; col: number }> = {};
        let am: RegExpExecArray | null;
        attrRe.lastIndex = 0;
        while ((am = attrRe.exec(attrString)) !== null) {
            const aName = am[1].toLowerCase();
            const aValue = am[2] ?? am[3];
            attributes[aName] = aValue;
            // Compute attribute position relative to the tag start
            const attrOffset = match.index + match[0].indexOf(am[0]);
            attrPositions[aName] = posOf(attrOffset);
        }

        const node: XmlNode = {
            tag: tagName,
            attributes,
            children: [],
            hasTextContent: false,
            texts: [],
            line: pos.line,
            col: pos.col,
            attrPositions,
        };

        if (stack.length > 0) {
            stack[stack.length - 1].children.push(node);
        } else {
            root = node;
        }

        if (!selfClose) {
            stack.push(node);
        }
    }

    // Check for text content after last tag for current stack top
    if (stack.length > 0) {
        const trailing = stripped.substring(lastTagEnd);
        if (trailing.trim().length > 0) {
            const top = stack[stack.length - 1];
            top.hasTextContent = true;
            top.texts.push({ value: trailing, offset: lastTagEnd });
        }
    }

    if (stack.length > 0) {
        const unclosed = stack[stack.length - 1];
        return { error: { message: `Unclosed element <${unclosed.tag}>`, line: unclosed.line, col: unclosed.col }, hadXmlDecl, hadDoctype, posOf };
    }

    return { root, hadXmlDecl, hadDoctype, posOf };
}

// ---------------------------------------------------------------------------
// Helpers for aggregate conformance checks
// ---------------------------------------------------------------------------

function makeDiag(line: number, col: number, length: number, message: string, severity: Severity): WmlDiag {
    return { line, col, length, message, severity };
}

/** Direct child elements with the given tag name. */
function childrenNamed(node: XmlNode, tag: string): XmlNode[] {
    return node.children.filter(c => c.tag === tag);
}

/** All descendant elements with the given tag name. */
function descendantsNamed(node: XmlNode, tag: string, stopAt: string[] = []): XmlNode[] {
    const out: XmlNode[] = [];
    for (const c of node.children) {
        if (c.tag === tag) { out.push(c); }
        if (!stopAt.includes(c.tag)) { out.push(...descendantsNamed(c, tag, stopAt)); }
    }
    return out;
}

// ---------------------------------------------------------------------------
// Validation walk
// ---------------------------------------------------------------------------

function validateNode(node: XmlNode, parentTag: string | null, diags: WmlDiag[], posOf: (o: number) => { line: number; col: number }): void {
    const def = DTD_ELEMENTS[node.tag];

    // 1) Unknown element
    if (!def) {
        diags.push(makeDiag(
            node.line, node.col, node.tag.length + 1,
            `Unknown WML element <${node.tag}>`,
            Severity.Error,
        ));
        return; // can't validate further
    }

    // 2) Check this element is allowed inside its parent
    if (parentTag) {
        const parentDef = DTD_ELEMENTS[parentTag];
        if (parentDef) {
            const allowedChildren = parentDef.children;
            if (!allowedChildren.includes(node.tag) && !allowedChildren.includes('#PCDATA')) {
                diags.push(makeDiag(
                    node.line, node.col, node.tag.length + 1,
                    `Element <${node.tag}> is not allowed as a child of <${parentTag}>`,
                    Severity.Error,
                ));
            }
        }
    }

    // 3) Required attributes
    for (const [aName, aDef] of Object.entries(def.attributes)) {
        if (aDef.required && !(aName in node.attributes)) {
            diags.push(makeDiag(
                node.line, node.col, node.tag.length + 1,
                `Element <${node.tag}> is missing required attribute "${aName}"`,
                Severity.Error,
            ));
        }
    }

    // 4) Unknown / invalid attributes
    for (const [aName, aValue] of Object.entries(node.attributes)) {
        const aDef = def.attributes[aName];
        const aPos = node.attrPositions[aName] ?? { line: node.line, col: node.col };
        if (!aDef) {
            diags.push(makeDiag(
                aPos.line, aPos.col, aName.length,
                `Unknown attribute "${aName}" on <${node.tag}>`,
                Severity.Warning,
            ));
            continue;
        }
        // Enumerated value check
        if (aDef.values && !aDef.values.includes(aValue)) {
            diags.push(makeDiag(
                aPos.line, aPos.col, aName.length + aValue.length + 3,
                `Invalid value "${aValue}" for attribute "${aName}" on <${node.tag}>. Allowed: ${aDef.values.join(', ')}`,
                Severity.Error,
            ));
        }
        // Fixed value check
        if (aDef.fixed && aValue !== aDef.fixed) {
            diags.push(makeDiag(
                aPos.line, aPos.col, aName.length + aValue.length + 3,
                `Attribute "${aName}" on <${node.tag}> must be "${aDef.fixed}"`,
                Severity.Error,
            ));
        }
        // Variable-reference placement / syntax (WML-S-64/65, §10.3.5)
        for (const issue of scanDollar(aValue, !!aDef.vdata)) {
            diags.push(makeDiag(
                aPos.line, aPos.col, aName.length + aValue.length + 3,
                `${issue.message} (in attribute "${aName}")`,
                Severity.Error,
            ));
        }
        // Lexical type checks: %number ([0-9]+) and %length ([0-9]+ | [0-9]+%)
        if (aDef.type && aValue.length > 0 && aValue.indexOf('$') < 0) {
            if (aDef.type === 'number' && !/^[0-9]+$/.test(aValue)) {
                diags.push(makeDiag(
                    aPos.line, aPos.col, aName.length + aValue.length + 3,
                    `Attribute "${aName}" on <${node.tag}> must be a non-negative integer`,
                    Severity.Error,
                ));
            } else if (aDef.type === 'length' && !/^[0-9]+%?$/.test(aValue)) {
                diags.push(makeDiag(
                    aPos.line, aPos.col, aName.length + aValue.length + 3,
                    `Attribute "${aName}" on <${node.tag}> must be a length ([0-9]+ pixels or [0-9]+% percentage)`,
                    Severity.Warning,
                ));
            }
        }
    }

    // 4b) Variable-reference syntax in PCDATA text (§10.3.5; e.g. "$10.00" is an error)
    if (def.children.includes('#PCDATA')) {
        for (const chunk of node.texts) {
            for (const issue of scanDollar(chunk.value, true)) {
                const p = posOf(chunk.offset + issue.index);
                diags.push(makeDiag(p.line, p.col, 1, issue.message, Severity.Error));
            }
        }
    }

    // 5) EMPTY element must not have children or text
    if (def.empty) {
        if (node.children.length > 0) {
            diags.push(makeDiag(
                node.line, node.col, node.tag.length + 1,
                `Element <${node.tag}> is declared EMPTY and must not have child elements`,
                Severity.Error,
            ));
        }
        if (node.hasTextContent) {
            diags.push(makeDiag(
                node.line, node.col, node.tag.length + 1,
                `Element <${node.tag}> is declared EMPTY and must not have text content`,
                Severity.Error,
            ));
        }
    }

    // 6) Elements that don't allow #PCDATA shouldn't have text
    if (!def.empty && !def.children.includes('#PCDATA') && node.hasTextContent) {
        diags.push(makeDiag(
            node.line, node.col, node.tag.length + 1,
            `Element <${node.tag}> does not allow text content`,
            Severity.Warning,
        ));
    }

    // 7) Minimum child element count (e.g. card+ requires ≥1 card in wml)
    if (def.minChildren && def.minChildren > 0) {
        const elementChildren = node.children.filter(c => def.children.includes(c.tag));
        if (elementChildren.length < def.minChildren) {
            diags.push(makeDiag(
                node.line, node.col, node.tag.length + 1,
                `Element <${node.tag}> requires at least ${def.minChildren} child element(s) (${def.children.filter(c => c !== '#PCDATA').join(', ')})`,
                Severity.Error,
            ));
        }
    }

    // 8) Root must be <wml>
    if (!parentTag && node.tag !== 'wml') {
        diags.push(makeDiag(
            node.line, node.col, node.tag.length + 1,
            `Root element must be <wml>, found <${node.tag}>`,
            Severity.Error,
        ));
    }

    // 9) <input> format mask syntax validation
    if (node.tag === 'input' && 'format' in node.attributes) {
        const fmt = node.attributes['format'];
        const fmtPos = node.attrPositions['format'] ?? { line: node.line, col: node.col };
        const parsed = parseWmlFormatMask(fmt);
        if (!parsed.valid) {
            diags.push(makeDiag(
                fmtPos.line, fmtPos.col, `format="${fmt}"`.length,
                `Invalid format mask "${fmt}": ${parsed.error}`,
                Severity.Error,
            ));
        }
    }

    // 10) <input> emptyok / format interaction
    if (node.tag === 'input') {
        const emptyokAttr = node.attributes['emptyok'];
        const formatAttr = node.attributes['format'];
        if (emptyokAttr === 'false' && formatAttr) {
            const parsed = parseWmlFormatMask(formatAttr);
            if (parsed.valid && !parsed.requiresInput) {
                const pos = node.attrPositions['emptyok'] ?? { line: node.line, col: node.col };
                diags.push(makeDiag(
                    pos.line, pos.col, `emptyok="false"`.length,
                    `emptyok="false" requires input, but format "${formatAttr}" allows empty (all groups use '*'). Consider adding a fixed-count group (e.g., M*M)`,
                    Severity.Warning,
                ));
            }
        }
        if (emptyokAttr === 'true' && formatAttr) {
            const parsed = parseWmlFormatMask(formatAttr);
            if (parsed.valid && parsed.requiresInput) {
                const pos = node.attrPositions['emptyok'] ?? { line: node.line, col: node.col };
                diags.push(makeDiag(
                    pos.line, pos.col, `emptyok="true"`.length,
                    `emptyok="true" overrides format "${formatAttr}" which would otherwise require input`,
                    Severity.Information,
                ));
            }
        }
    }

    // 11) Aggregate per-element conformance checks
    checkConformanceRules(node, diags);

    // Recurse into children
    for (const child of node.children) {
        validateNode(child, node.tag, diags, posOf);
    }
}

/**
 * Conformance rules from the WML 1.3 Static Conformance Statement that the
 * pure DTD content-model checks above do not capture.
 */
function checkConformanceRules(node: XmlNode, diags: WmlDiag[]): void {
    // WML-S-66 (§9.7): two or more <do> with the same name in a card or template.
    // An unspecified name defaults to the value of the type attribute.
    if (node.tag === 'card' || node.tag === 'template') {
        const seen = new Map<string, XmlNode>();
        const dos = node.tag === 'template'
            ? childrenNamed(node, 'do')
            : descendantsNamed(node, 'do');
        for (const d of dos) {
            const name = d.attributes['name'] ?? d.attributes['type'];
            if (name === undefined) { continue; }
            if (seen.has(name)) {
                diags.push(makeDiag(
                    d.line, d.col, d.tag.length + 1,
                    `Duplicate <do> binding "${name}" in <${node.tag}>; two <do> elements may not share the same name (an unspecified name defaults to the type)`,
                    Severity.Error,
                ));
            } else {
                seen.set(name, d);
            }
        }
    }

    // WML-S-69 (§9.10): conflicting / inapplicable event bindings.
    const legalEvents = INTRINSIC_EVENTS[node.tag];
    if (legalEvents) {
        const seenEvents = new Map<string, XmlNode>();
        for (const ev of childrenNamed(node, 'onevent')) {
            const type = ev.attributes['type'];
            if (type === undefined) { continue; }
            if (!legalEvents.includes(type)) {
                diags.push(makeDiag(
                    ev.line, ev.col, ev.tag.length + 1,
                    `<onevent type="${type}"> is not a valid intrinsic event for <${node.tag}> (allowed: ${legalEvents.join(', ')}); it will be ignored`,
                    Severity.Warning,
                ));
                continue;
            }
            if (seenEvents.has(type)) {
                diags.push(makeDiag(
                    ev.line, ev.col, ev.tag.length + 1,
                    `Conflicting event binding: <${node.tag}> already binds the "${type}" intrinsic event`,
                    Severity.Error,
                ));
            } else {
                seenEvents.set(type, ev);
            }
            // Conflict between the attribute shorthand and an <onevent> of the same type.
            if (node.attributes[type] !== undefined) {
                diags.push(makeDiag(
                    ev.line, ev.col, ev.tag.length + 1,
                    `Conflicting event binding: <${node.tag}> binds "${type}" via both the ${type}="..." attribute and an <onevent> element`,
                    Severity.Error,
                ));
            }
        }
    }

    // WML-S-67 (§11.3.2): <meta> must specify exactly one of name / http-equiv.
    if (node.tag === 'meta') {
        const hasName = 'name' in node.attributes;
        const hasHttpEquiv = 'http-equiv' in node.attributes;
        if (hasName && hasHttpEquiv) {
            diags.push(makeDiag(
                node.line, node.col, node.tag.length + 1,
                `<meta> must not specify both "name" and "http-equiv"`,
                Severity.Error,
            ));
        } else if (!hasName && !hasHttpEquiv) {
            diags.push(makeDiag(
                node.line, node.col, node.tag.length + 1,
                `<meta> must specify exactly one of "name" or "http-equiv"`,
                Severity.Error,
            ));
        }
    }

    // WML-S-68 (§11.8.5): the number of columns in a table must not be zero.
    if (node.tag === 'table' && /^0+$/.test(node.attributes['columns'] ?? '')) {
        const pos = node.attrPositions['columns'] ?? { line: node.line, col: node.col };
        diags.push(makeDiag(
            pos.line, pos.col, `columns="${node.attributes['columns']}"`.length,
            `<table> "columns" must not be zero`,
            Severity.Error,
        ));
    }

    // §9.8: it is an error to specify other than one task in an <anchor>.
    if (node.tag === 'anchor') {
        const tasks = node.children.filter(c => TASK.includes(c.tag));
        if (tasks.length !== 1) {
            diags.push(makeDiag(
                node.line, node.col, node.tag.length + 1,
                `<anchor> must contain exactly one task (go, prev or refresh); found ${tasks.length}`,
                Severity.Error,
            ));
        }
    }

    // §11.3.1: it is an error for a deck to contain more than one <access> element.
    if (node.tag === 'head') {
        const accesses = childrenNamed(node, 'access');
        for (let i = 1; i < accesses.length; i++) {
            diags.push(makeDiag(
                accesses[i].line, accesses[i].col, accesses[i].tag.length + 1,
                `A deck must not contain more than one <access> element`,
                Severity.Error,
            ));
        }
    }

    // §11.7: it is an error to have more than one <timer> element in a card.
    if (node.tag === 'card') {
        const timers = childrenNamed(node, 'timer');
        for (let i = 1; i < timers.length; i++) {
            diags.push(makeDiag(
                timers[i].line, timers[i].col, timers[i].tag.length + 1,
                `A card must not contain more than one <timer> element`,
                Severity.Error,
            ));
        }
    }
}

// ---------------------------------------------------------------------------
// Public API — pure validation (vscode-free, unit testable)
// ---------------------------------------------------------------------------

/** Validate WML source text and return vscode-independent diagnostics. */
export function validateWmlText(text: string): WmlDiag[] {
    if (!text.trim()) { return []; }

    const diags: WmlDiag[] = [];
    const { root, error, hadXmlDecl, hadDoctype, posOf } = parseWml(text);

    if (error) {
        diags.push(makeDiag(error.line, error.col, 1, `XML error: ${error.message}`, Severity.Error));
        return diags;
    }

    // §11.1: a valid WML deck must contain the document prologue (XML declaration
    // and DOCTYPE). "It is an error to omit the prologue."
    if (root) {
        if (!hadXmlDecl) {
            diags.push(makeDiag(root.line, root.col, root.tag.length + 1,
                `Missing XML declaration (<?xml version="1.0"?>); a WML deck prologue is required`,
                Severity.Warning));
        }
        if (!hadDoctype) {
            diags.push(makeDiag(root.line, root.col, root.tag.length + 1,
                `Missing DOCTYPE declaration ("-//WAPFORUM//DTD WML 1.3//EN"); a WML deck prologue is required`,
                Severity.Warning));
        }
        validateNode(root, null, diags, posOf);
    }

    return diags;
}

// ---------------------------------------------------------------------------
// VS Code adapter — loads the `vscode` API lazily (extension-host only)
// ---------------------------------------------------------------------------

/**
 * Lazily load the VS Code API.  `vscode` is not a real module on disk — it is
 * injected by the extension host at runtime — so it must not be required at
 * module load time, or the validation core could not be imported in plain Node
 * (e.g. by the test runner).
 */
function getVscode(): typeof import('vscode') {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    return require('vscode');
}

function toVsDiag(v: typeof import('vscode'), d: WmlDiag): vscode.Diagnostic {
    const severity = [
        v.DiagnosticSeverity.Error,
        v.DiagnosticSeverity.Warning,
        v.DiagnosticSeverity.Information,
        v.DiagnosticSeverity.Hint,
    ][d.severity];
    const range = new v.Range(d.line, d.col, d.line, d.col + d.length);
    const diag = new v.Diagnostic(range, d.message, severity);
    diag.source = 'WML (DTD)';
    return diag;
}

export function validateWmlDocument(document: vscode.TextDocument): vscode.Diagnostic[] {
    const v = getVscode();
    return validateWmlText(document.getText()).map(d => toVsDiag(v, d));
}

// ---------------------------------------------------------------------------
// Diagnostic provider (manages VS Code diagnostic collection + listeners)
// ---------------------------------------------------------------------------

export function activateValidation(context: vscode.ExtensionContext): void {
    const v = getVscode();
    const diagnosticCollection = v.languages.createDiagnosticCollection('wml');
    context.subscriptions.push(diagnosticCollection);

    function validate(document: vscode.TextDocument): void {
        if (document.languageId !== 'wml') { return; }
        const diags = validateWmlDocument(document);
        diagnosticCollection.set(document.uri, diags);
    }

    // Validate all already-open WML documents
    for (const doc of v.workspace.textDocuments) {
        validate(doc);
    }

    // Validate on open
    context.subscriptions.push(
        v.workspace.onDidOpenTextDocument(doc => validate(doc))
    );

    // Validate on change (with debounce)
    let debounceTimer: ReturnType<typeof setTimeout> | undefined;
    context.subscriptions.push(
        v.workspace.onDidChangeTextDocument(e => {
            if (e.document.languageId !== 'wml') { return; }
            if (debounceTimer) { clearTimeout(debounceTimer); }
            debounceTimer = setTimeout(() => validate(e.document), 500);
        })
    );

    // Validate on save
    context.subscriptions.push(
        v.workspace.onDidSaveTextDocument(doc => validate(doc))
    );

    // Clear diagnostics when document is closed
    context.subscriptions.push(
        v.workspace.onDidCloseTextDocument(doc => {
            diagnosticCollection.delete(doc.uri);
        })
    );
}
