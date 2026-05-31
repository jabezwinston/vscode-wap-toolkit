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
 */
import {
    WBXML_VERSION, WML_PUBLIC_ID, CHARSET_UTF8,
    END, STR_I, ENTITY,
    TAG_HAS_CONTENT, TAG_HAS_ATTRS,
    WML_TAG_TOKENS, WML_ATTR_START_TOKENS, WML_ATTR_VALUE_TOKENS,
} from './tokenTable';

interface XmlNode {
    type: 'element' | 'text' | 'comment' | 'pi' | 'cdata';
    name?: string;
    attributes?: Record<string, string>;
    children?: XmlNode[];
    text?: string;
}

export function encodeWbxml(wmlContent: string): Buffer {
    const encoder = new WbxmlEncoder();
    return encoder.encode(wmlContent);
}

class WbxmlEncoder {
    private stringTable: Map<string, number> = new Map();
    private stringTableBytes: number[] = [];

    encode(wml: string): Buffer {
        // Strip XML declaration and DOCTYPE
        const bodyStart = wml.indexOf('<wml');
        if (bodyStart === -1) {
            throw new Error('No <wml> element found');
        }
        const xmlBody = wml.substring(bodyStart);

        // Parse the XML into a simple tree
        const root = this.parseXml(xmlBody);
        if (!root) {
            throw new Error('Failed to parse WML content');
        }

        // Reset state
        this.stringTable = new Map();
        this.stringTableBytes = [];

        // Encode the body (this also populates the string table)
        const bodyBytes: number[] = [];
        this.encodeNode(root, bodyBytes);

        // Build final output: header + string table + body
        const result: number[] = [];
        result.push(WBXML_VERSION);
        this.appendMbUint32(result, WML_PUBLIC_ID);
        this.appendMbUint32(result, CHARSET_UTF8);
        this.appendMbUint32(result, this.stringTableBytes.length);
        result.push(...this.stringTableBytes);
        result.push(...bodyBytes);

        return Buffer.from(result);
    }

    private encodeNode(node: XmlNode, out: number[]): void {
        if (node.type === 'text') {
            if (node.text) {
                this.encodeText(node.text, out);
            }
            return;
        }

        if (node.type === 'comment' || node.type === 'pi') {
            return; // Skip comments and PIs in WBXML
        }

        if (node.type === 'cdata') {
            if (node.text) {
                this.encodeInlineString(node.text, out);
            }
            return;
        }

        if (!node.name) { return; }

        const tagName = node.name.toLowerCase();
        const tagToken = WML_TAG_TOKENS[tagName];

        if (tagToken === undefined) {
            // Unknown tag - use LITERAL
            this.encodeLiteralTag(node, out);
            return;
        }

        const hasAttrs = node.attributes && Object.keys(node.attributes).length > 0;
        const hasContent = node.children && node.children.length > 0;

        let tokenByte = tagToken;
        if (hasContent) { tokenByte |= TAG_HAS_CONTENT; }
        if (hasAttrs) { tokenByte |= TAG_HAS_ATTRS; }

        out.push(tokenByte);

        // Encode attributes
        if (hasAttrs && node.attributes) {
            this.encodeAttributes(node.attributes, out);
            out.push(END); // End of attributes
        }

        // Encode children
        if (hasContent && node.children) {
            for (const child of node.children) {
                this.encodeNode(child, out);
            }
            out.push(END); // End of content
        }
    }

    private encodeAttributes(attrs: Record<string, string>, out: number[]): void {
        for (const [name, value] of Object.entries(attrs)) {
            // Try combined attr=value token first
            const combined = `${name}=${value}`;
            if (WML_ATTR_START_TOKENS[combined] !== undefined) {
                out.push(WML_ATTR_START_TOKENS[combined]);
                continue;
            }

            // Try attr start with prefix match — pick the longest matching prefix
            let matched = false;
            let bestPrefixKey = '';
            let bestPrefixToken = -1;
            for (const [key, token] of Object.entries(WML_ATTR_START_TOKENS)) {
                if (key.includes('=') && key.startsWith(name + '=')) {
                    const prefix = key.substring(name.length + 1);
                    if (value.startsWith(prefix) && key.length > bestPrefixKey.length) {
                        bestPrefixKey = key;
                        bestPrefixToken = token;
                    }
                }
            }

            if (bestPrefixToken !== -1) {
                const prefix = bestPrefixKey.substring(name.length + 1);
                out.push(bestPrefixToken);
                const remainder = value.substring(prefix.length);
                if (remainder.length > 0) {
                    this.encodeAttrValue(remainder, out);
                }
                matched = true;
            }

            if (!matched) {
                // Use attr name token + value
                if (WML_ATTR_START_TOKENS[name] !== undefined) {
                    out.push(WML_ATTR_START_TOKENS[name]);
                    if (value.length > 0) {
                        this.encodeAttrValue(value, out);
                    }
                } else {
                    // Unknown attribute - use inline string
                    out.push(0x04); // LITERAL
                    this.addToStringTable(name, out);
                    if (value.length > 0) {
                        this.encodeInlineString(value, out);
                    }
                }
            }
        }
    }

    private encodeAttrValue(value: string, out: number[]): void {
        // Try to find matching value tokens
        let remaining = value;
        while (remaining.length > 0) {
            let bestMatch = '';
            let bestToken = -1;
            for (const [key, token] of Object.entries(WML_ATTR_VALUE_TOKENS)) {
                if (remaining.startsWith(key) && key.length > bestMatch.length) {
                    bestMatch = key;
                    bestToken = token;
                }
            }

            if (bestToken !== -1) {
                out.push(bestToken);
                remaining = remaining.substring(bestMatch.length);
            } else {
                // Output text until next possible token match
                let end = 1;
                while (end < remaining.length) {
                    let foundToken = false;
                    for (const key of Object.keys(WML_ATTR_VALUE_TOKENS)) {
                        if (remaining.substring(end).startsWith(key)) {
                            foundToken = true;
                            break;
                        }
                    }
                    if (foundToken) { break; }
                    end++;
                }
                this.encodeInlineString(remaining.substring(0, end), out);
                remaining = remaining.substring(end);
            }
        }
    }

    private encodeText(text: string, out: number[]): void {
        // Handle WML variables: $var or $(var:escape)
        const parts = text.split(/(\$\([A-Za-z_][A-Za-z0-9_]*(?::(?:escape|noesc|unesc))?\)|\$[A-Za-z_][A-Za-z0-9_]*)/);

        for (const part of parts) {
            if (!part) { continue; }
            if (part.startsWith('$(')) {
                // Variable with parens: $(name:escape)
                const match = part.match(/^\$\(([A-Za-z_][A-Za-z0-9_]*)(?::(escape|noesc|unesc))?\)$/);
                if (match) {
                    const varName = match[1];
                    const escType = match[2];
                    // EXT_I_0 = escaped, EXT_I_1 = unescaped, EXT_I_2 = no-escaping
                    if (escType === 'unesc') {
                        this.encodeVariableRef(varName, 0x41, out); // EXT_I_1
                    } else if (escType === 'noesc') {
                        this.encodeVariableRef(varName, 0x42, out); // EXT_I_2
                    } else {
                        this.encodeVariableRef(varName, 0x40, out); // EXT_I_0 (default: escape)
                    }
                }
            } else if (part.startsWith('$') && part.length > 1) {
                // Simple variable: $name
                const varName = part.substring(1);
                this.encodeVariableRef(varName, 0x40, out); // EXT_I_0
            } else {
                // Plain text - encode as-is (preserve whitespace)
                if (part) {
                    this.encodeInlineString(part, out);
                }
            }
        }
    }

    private encodeVariableRef(name: string, extToken: number, out: number[]): void {
        out.push(extToken);
        // Write variable name as null-terminated string
        for (let i = 0; i < name.length; i++) {
            out.push(name.charCodeAt(i));
        }
        out.push(0x00); // null terminator
    }

    // HTML/WML named entity → Unicode code point mapping
    private static readonly HTML_ENTITIES: Record<string, number> = {
        nbsp: 0xA0, iexcl: 0xA1, cent: 0xA2, pound: 0xA3, curren: 0xA4,
        yen: 0xA5, brvbar: 0xA6, sect: 0xA7, uml: 0xA8, copy: 0xA9,
        ordf: 0xAA, laquo: 0xAB, not: 0xAC, shy: 0xAD, reg: 0xAE,
        macr: 0xAF, deg: 0xB0, plusmn: 0xB1, sup2: 0xB2, sup3: 0xB3,
        acute: 0xB4, micro: 0xB5, para: 0xB6, middot: 0xB7, cedil: 0xB8,
        sup1: 0xB9, ordm: 0xBA, raquo: 0xBB, frac14: 0xBC, frac12: 0xBD,
        frac34: 0xBE, iquest: 0xBF, times: 0xD7, divide: 0xF7,
        // Common symbols
        bull: 0x2022, hellip: 0x2026, trade: 0x2122, larr: 0x2190,
        rarr: 0x2192, euro: 0x20AC,
    };

    private encodeInlineString(str: string, out: number[]): void {
        // Split around entity references so we can handle them individually.
        const entityRe = /(&amp;|&lt;|&gt;|&quot;|&apos;|&([a-zA-Z]+);|&#(\d+);|&#x([0-9a-fA-F]+);)/g;
        let lastIndex = 0;
        let match: RegExpExecArray | null;
        const segments: { text?: string; entity?: number }[] = [];

        while ((match = entityRe.exec(str)) !== null) {
            if (match.index > lastIndex) {
                segments.push({ text: str.substring(lastIndex, match.index) });
            }
            const ent = match[0];
            if (ent === '&amp;') { segments.push({ text: '&' }); }
            else if (ent === '&lt;') { segments.push({ text: '<' }); }
            else if (ent === '&gt;') { segments.push({ text: '>' }); }
            else if (ent === '&quot;') { segments.push({ entity: 0x22 }); }
            else if (ent === '&apos;') { segments.push({ entity: 0x27 }); }
            else if (match[2]) {
                const code = WbxmlEncoder.HTML_ENTITIES[match[2]];
                if (code !== undefined) {
                    segments.push({ entity: code });
                } else {
                    // Unknown named entity — pass through as literal text
                    segments.push({ text: ent });
                }
            }
            else if (match[3]) { segments.push({ entity: parseInt(match[3], 10) }); }
            else if (match[4]) { segments.push({ entity: parseInt(match[4], 16) }); }
            lastIndex = match.index + match[0].length;
        }
        if (lastIndex < str.length) {
            segments.push({ text: str.substring(lastIndex) });
        }

        // Now emit: runs of plain text as STR_I, entities as ENTITY tokens
        let textBuf = '';
        const flushText = () => {
            if (!textBuf) { return; }
            out.push(STR_I);
            for (let i = 0; i < textBuf.length; i++) {
                const code = textBuf.charCodeAt(i);
                if (code <= 0x7F) {
                    out.push(code);
                } else {
                    const buf = Buffer.from(textBuf.charAt(i), 'utf-8');
                    for (const b of buf) { out.push(b); }
                }
            }
            out.push(0x00);
            textBuf = '';
        };

        for (const seg of segments) {
            if (seg.entity !== undefined) {
                flushText();
                out.push(ENTITY);
                this.appendMbUint32(out, seg.entity);
            } else if (seg.text !== undefined) {
                textBuf += seg.text;
            }
        }
        flushText();
    }

    private addToStringTable(str: string, out: number[]): void {
        if (!this.stringTable.has(str)) {
            const offset = this.stringTableBytes.length;
            this.stringTable.set(str, offset);
            for (let i = 0; i < str.length; i++) {
                this.stringTableBytes.push(str.charCodeAt(i));
            }
            this.stringTableBytes.push(0x00);
        }
        this.appendMbUint32(out, this.stringTable.get(str)!);
    }

    private encodeLiteralTag(node: XmlNode, out: number[]): void {
        const hasAttrs = node.attributes && Object.keys(node.attributes).length > 0;
        const hasContent = node.children && node.children.length > 0;

        let tokenByte = 0x04; // LITERAL
        if (hasContent) { tokenByte = 0x44; } // LITERAL_C
        if (hasAttrs) { tokenByte = hasContent ? 0xC4 : 0x84; } // LITERAL_AC or LITERAL_A

        out.push(tokenByte);
        this.addToStringTable(node.name!, out);

        if (hasAttrs && node.attributes) {
            this.encodeAttributes(node.attributes, out);
            out.push(END);
        }

        if (hasContent && node.children) {
            for (const child of node.children) {
                this.encodeNode(child, out);
            }
            out.push(END);
        }
    }

    private appendMbUint32(target: number[], value: number): void {
        if (value <= 0x7F) {
            target.push(value);
            return;
        }
        const bytes: number[] = [];
        bytes.push(value & 0x7F);
        value >>= 7;
        while (value > 0) {
            bytes.push((value & 0x7F) | 0x80);
            value >>= 7;
        }
        bytes.reverse();
        target.push(...bytes);
    }

    /** Simple XML parser - parses WML XML into a node tree */
    private parseXml(xml: string): XmlNode | null {
        let pos = 0;

        function skipWhitespace(): void {
            while (pos < xml.length && /\s/.test(xml[pos])) { pos++; }
        }

        function parseNode(): XmlNode | null {
            skipWhitespace();
            if (pos >= xml.length) { return null; }

            if (xml.startsWith('<!--', pos)) {
                // Comment
                const end = xml.indexOf('-->', pos);
                if (end === -1) { pos = xml.length; return null; }
                pos = end + 3;
                return { type: 'comment' };
            }

            if (xml.startsWith('<![CDATA[', pos)) {
                const end = xml.indexOf(']]>', pos);
                if (end === -1) { pos = xml.length; return null; }
                const text = xml.substring(pos + 9, end);
                pos = end + 3;
                return { type: 'cdata', text };
            }

            if (xml[pos] === '<' && xml[pos + 1] !== '/') {
                return parseElement();
            }

            // Text node
            const start = pos;
            while (pos < xml.length && xml[pos] !== '<') { pos++; }
            const text = xml.substring(start, pos);
            if (text.trim().length === 0 && text.indexOf('\n') !== -1) {
                return null; // Skip pure whitespace
            }
            return { type: 'text', text };
        }

        function parseElement(): XmlNode | null {
            if (xml[pos] !== '<') { return null; }
            pos++; // skip <

            // Read tag name
            const nameStart = pos;
            while (pos < xml.length && !/[\s/>]/.test(xml[pos])) { pos++; }
            const name = xml.substring(nameStart, pos);
            if (!name) { return null; }

            // Read attributes
            const attributes: Record<string, string> = {};
            skipWhitespace();
            while (pos < xml.length && xml[pos] !== '>' && xml[pos] !== '/') {
                const attrStart = pos;
                while (pos < xml.length && !/[\s=/>]/.test(xml[pos])) { pos++; }
                const attrName = xml.substring(attrStart, pos);
                if (!attrName) { break; }

                skipWhitespace();
                if (xml[pos] === '=') {
                    pos++; // skip =
                    skipWhitespace();
                    const quote = xml[pos];
                    if (quote === '"' || quote === "'") {
                        pos++; // skip opening quote
                        const valStart = pos;
                        while (pos < xml.length && xml[pos] !== quote) { pos++; }
                        attributes[attrName] = xml.substring(valStart, pos);
                        pos++; // skip closing quote
                    }
                } else {
                    attributes[attrName] = attrName; // boolean attribute
                }
                skipWhitespace();
            }

            // Self-closing?
            if (xml[pos] === '/') {
                pos++; // skip /
                if (xml[pos] === '>') { pos++; }
                return { type: 'element', name, attributes, children: [] };
            }

            pos++; // skip >

            // Parse children
            const children: XmlNode[] = [];
            while (pos < xml.length) {
                skipWhitespace();
                if (xml.startsWith('</', pos)) {
                    // Closing tag
                    pos += 2;
                    while (pos < xml.length && xml[pos] !== '>') { pos++; }
                    pos++; // skip >
                    break;
                }
                const child = parseNode();
                if (child) {
                    children.push(child);
                }
            }

            return { type: 'element', name, attributes, children };
        }

        return parseNode();
    }
}
