/**
 *
 *  Copyright (C) 2026 Jabez Winston
 * 
 *  SPDX-License-Identifier: Apache-2.0
 *
 *  Date : 07-April-2026
 *  
 *  WBXML Decoder - Converts WBXML binary format back to WML XML
 *  Based on WAP-192-WBXML-20010725 specification
 */
import { charsetByMib, decodeText } from '../shared/charset';
import {
    END, STR_I, ENTITY, SWITCH_PAGE,
    EXT_I_0, EXT_I_1, EXT_I_2,
    EXT_T_0, EXT_T_1, EXT_T_2,
    EXT_0, EXT_1, EXT_2,
    PI, STR_T, OPAQUE,
    LITERAL, LITERAL_A, LITERAL_C, LITERAL_AC,
    TAG_HAS_CONTENT, TAG_HAS_ATTRS,
    WML_TOKEN_TAGS, WML_ATTR_START_TOKENS, WML_ATTR_VALUE_TOKENS,
} from './tokenTable';

// Reverse lookup maps
const ATTR_START_BY_TOKEN: Record<number, { name: string; value: string }> = {};
for (const [key, token] of Object.entries(WML_ATTR_START_TOKENS)) {
    const eqIdx = key.indexOf('=');
    if (eqIdx !== -1) {
        ATTR_START_BY_TOKEN[token] = { name: key.substring(0, eqIdx), value: key.substring(eqIdx + 1) };
    } else {
        ATTR_START_BY_TOKEN[token] = { name: key, value: '' };
    }
}

const ATTR_VALUE_BY_TOKEN: Record<number, string> = {};
for (const [key, token] of Object.entries(WML_ATTR_VALUE_TOKENS)) {
    ATTR_VALUE_BY_TOKEN[token] = key;
}

/**
 * Decode WBXML to WML text.  Strings are read in the document's charset
 * (§5.6 charset field), else `externalCharset` (the Content-Type's, §5.2),
 * else UTF-8.
 */
export function decodeWbxml(data: Buffer, externalCharset?: string): string {
    const decoder = new WbxmlDecoder(data, externalCharset);
    return decoder.decode();
}

class WbxmlDecoder {
    private data: Buffer;
    private pos: number = 0;
    /** String table: byte range in data (entries are byte offsets, §5.7) */
    private tableStart: number = 0;
    private tableEnd: number = 0;
    private charset: string = 'utf-8';
    private indent: number = 0;
    /**
     * Current code page of each parser state (WBXML §5.8.1). WML defines its
     * tokens on page 0 only (WML §14.1.2-3), so tokens of another page are
     * decoded as unknown ones, never as WML's page-0 tags and attributes.
     */
    private tagPage: number = 0;
    private attrPage: number = 0;

    constructor(data: Buffer, private externalCharset?: string) {
        this.data = data;
    }

    decode(): string {
        // Header
        const version = this.readByte();
        const publicId = this.readMbUint32();
        let charset: number | undefined;
        if (publicId === 0) {
            // publicid is in string table
            this.readMbUint32(); // string table index
        }
        charset = this.readMbUint32();
        this.charset = charsetByMib(charset) || this.externalCharset || 'utf-8';

        // String table
        const stLen = this.readMbUint32();
        this.tableStart = this.pos;
        this.tableEnd = Math.min(this.pos + stLen, this.data.length);
        this.pos += stLen;

        // Build XML output
        let xml = '<?xml version="1.0" encoding="UTF-8"?>\n';
        xml += '<!DOCTYPE wml PUBLIC "-//WAPFORUM//DTD WML 1.3//EN"\n';
        xml += '  "http://www.wapforum.org/DTD/wml13.dtd">\n\n';

        // decodeTag no longer appends its own trailing newline, so the document
        // gets one here rather than every element carrying one.
        xml += this.decodeBody() + '\n';

        return xml;
    }

    private decodeBody(): string {
        let result = '';

        while (this.pos < this.data.length) {
            const token = this.readByte();
            result += this.decodeToken(token);
        }

        return result;
    }

    private decodeToken(token: number): string {
        switch (token) {
            case SWITCH_PAGE:
                this.tagPage = this.readByte();
                return '';

            case END:
                this.indent--;
                return '';

            case STR_I:
                return this.escapeXml(this.readTerminatedString());

            case STR_T: {
                const offset = this.readMbUint32();
                return this.escapeXml(this.getStringTableEntry(offset));
            }

            case ENTITY: {
                const charCode = this.readMbUint32();
                return this.entityToString(charCode);
            }

            // WML 1.3 binary: EXT_x_0 = escaped, EXT_x_1 = unescaped,
            // EXT_x_2 = no transformation. Emit explicit conversions so
            // the decoded source is unambiguous in any context.
            case EXT_I_0:
            case EXT_I_1:
            case EXT_I_2: {
                const varName = this.readTerminatedString();
                if (token === EXT_I_0) { return `$(${varName}:escape)`; }
                if (token === EXT_I_1) { return `$(${varName}:unesc)`; }
                return `$${varName}`;
            }

            case EXT_T_0:
            case EXT_T_1:
            case EXT_T_2: {
                const idx = this.readMbUint32();
                const name = this.getStringTableEntry(idx);
                if (token === EXT_T_0) { return `$(${name}:escape)`; }
                if (token === EXT_T_1) { return `$(${name}:unesc)`; }
                return `$${name}`;
            }

            case EXT_0:
            case EXT_1:
            case EXT_2:
                return '';

            case PI: {
                // Processing instruction: PI attrStart *attrValue END
                // Must consume all PI data per spec section 5.8.4.4
                while (this.pos < this.data.length) {
                    const piByte = this.readByte();
                    if (piByte === END) { break; }
                }
                return '';
            }

            case OPAQUE: {
                const len = this.readMbUint32();
                this.pos += len; // skip opaque data (len is never negative)
                return '';
            }

            default:
                return this.decodeTag(token);
        }
    }

    private decodeTag(token: number): string {
        const hasAttrs = (token & TAG_HAS_ATTRS) !== 0;
        const hasContent = (token & TAG_HAS_CONTENT) !== 0;
        const tagToken = token & 0x3F;

        let tagName: string;
        if (tagToken === 0x04) {
            // LITERAL
            const offset = this.readMbUint32();
            tagName = this.getStringTableEntry(offset);
        } else {
            tagName = this.tagPage !== 0
                ? `unknown_p${this.tagPage}_${tagToken.toString(16)}`
                : WML_TOKEN_TAGS[tagToken] || `unknown_${tagToken.toString(16)}`;
        }

        // No leading indent and no trailing newline: whether this element may be
        // laid out at all is the *parent's* decision, because only the parent
        // can see whether its content is mixed. See the content branches below.
        const indentStr = '  '.repeat(this.indent);
        let result = `<${tagName}`;

        // Decode attributes
        if (hasAttrs) {
            result += this.decodeAttributes();
        }

        if (hasContent) {
            this.indent++;

            // Content parts, keeping consecutive inline tokens (STR_I, ENTITY,
            // variable refs) merged into one text part. Whether a part is text
            // or an element is recorded rather than sniffed for '<' afterwards:
            // escaped text ("&lt;") would fool that, and mixed content has to be
            // identified exactly.
            const parts: Array<{ isText: boolean; value: string }> = [];
            let textAccum = '';

            const flushText = () => {
                if (textAccum) {
                    parts.push({ isText: true, value: textAccum });
                    textAccum = '';
                }
            };

            while (this.pos < this.data.length) {
                const nextToken = this.peekByte();
                if (nextToken === END) {
                    this.readByte(); // consume END
                    this.indent--;
                    break;
                }

                // Check if next token is inline (text/entity/variable)
                if (this.isInlineToken(nextToken)) {
                    const childToken = this.readByte();
                    textAccum += this.decodeToken(childToken);
                } else {
                    flushText();
                    const childToken = this.readByte();
                    const decoded = this.decodeToken(childToken);
                    if (decoded) {
                        parts.push({ isText: false, value: decoded });
                    }
                }
            }
            flushText();

            const hasElements = parts.some((p) => !p.isText);
            const hasText = parts.some((p) => p.isText && p.value.trim() !== '');
            const childIndent = '  '.repeat(this.indent + 1);

            if (parts.length === 0 || parts.every((p) => p.isText && !p.value.trim())) {
                result += `></${tagName}>`;
            } else if (hasElements && hasText) {
                /*
                 * Mixed content. Every character between the tags came off the
                 * wire and is significant — "&nbsp;<u>fun</u>" renders
                 * differently from "&nbsp; <u>fun</u>" — so the parts go back
                 * out exactly as they arrived. Laying this out (a newline and
                 * an indent per node, each text run trimmed) both invents
                 * whitespace that was never encoded and drops whitespace that
                 * was, which changed what the deck rendered purely by being
                 * transported as WBXML.
                 */
                result += '>';
                for (const part of parts) { result += part.value; }
                result += `</${tagName}>`;
            } else if (hasElements) {
                // Element-only content: no character data to damage, so this
                // can be laid out for readability. Whitespace-only text parts
                // are the source's own indentation and are not reproduced.
                result += '>\n';
                for (const part of parts) {
                    if (part.isText) { continue; }
                    result += `${childIndent}${part.value}\n`;
                }
                result += `${indentStr}</${tagName}>`;
            } else {
                // Text-only content, verbatim for the same reason as mixed.
                result += '>';
                for (const part of parts) { result += part.value; }
                result += `</${tagName}>`;
            }
        } else {
            result += '/>';
        }

        return result;
    }

    private decodeAttributes(): string {
        let result = '';
        let currentAttrName = '';
        let currentAttrValue = '';

        while (this.pos < this.data.length) {
            const token = this.peekByte();

            if (token === END) {
                this.readByte(); // consume END
                // Flush current attribute
                if (currentAttrName) {
                    result += ` ${currentAttrName}="${this.escapeXmlAttr(currentAttrValue)}"`;
                }
                break;
            }

            this.readByte(); // consume token

            // Check global tokens first — their byte values overlap with
            // the attribute-start (0x05-0x7F) and attribute-value (0x80-0xFF)
            // ranges, so they must be matched before the range checks.
            if (token === SWITCH_PAGE) {
                this.attrPage = this.readByte();
            } else if (token === STR_I) {
                currentAttrValue += this.readTerminatedString();
            } else if (token === STR_T) {
                const offset = this.readMbUint32();
                currentAttrValue += this.getStringTableEntry(offset);
            } else if (token === ENTITY) {
                const charCode = this.readMbUint32();
                currentAttrValue += `&#${charCode};`;
            } else if (token === EXT_I_0 || token === EXT_I_1 || token === EXT_I_2) {
                const varName = this.readTerminatedString();
                if (token === EXT_I_0) { currentAttrValue += `$(${varName}:escape)`; }
                else if (token === EXT_I_1) { currentAttrValue += `$(${varName}:unesc)`; }
                else { currentAttrValue += `$(${varName}:noesc)`; }
            } else if (token === EXT_T_0 || token === EXT_T_1 || token === EXT_T_2) {
                const idx = this.readMbUint32();
                const name = this.getStringTableEntry(idx);
                if (token === EXT_T_0) { currentAttrValue += `$(${name}:escape)`; }
                else if (token === EXT_T_1) { currentAttrValue += `$(${name}:unesc)`; }
                else { currentAttrValue += `$(${name}:noesc)`; }
            } else if (token === EXT_0 || token === EXT_1 || token === EXT_2) {
                // Single-byte extension tokens, no data
            } else if (token === OPAQUE) {
                const len = this.readMbUint32();
                this.pos += len;
            } else if (token === LITERAL) {
                // LITERAL attribute start — name from string table
                if (currentAttrName) {
                    result += ` ${currentAttrName}="${this.escapeXmlAttr(currentAttrValue)}"`;
                }
                const offset = this.readMbUint32();
                currentAttrName = this.getStringTableEntry(offset);
                currentAttrValue = '';
            } else if (token >= 0x05 && token <= 0x7F) {
                // Attribute start token
                // Flush previous attribute
                if (currentAttrName) {
                    result += ` ${currentAttrName}="${this.escapeXmlAttr(currentAttrValue)}"`;
                }

                const attrInfo = this.attrPage === 0 ? ATTR_START_BY_TOKEN[token] : undefined;
                if (this.attrPage !== 0) {
                    currentAttrName = `attr_p${this.attrPage}_${token.toString(16)}`;
                    currentAttrValue = '';
                } else if (attrInfo) {
                    currentAttrName = attrInfo.name;
                    currentAttrValue = attrInfo.value;
                } else {
                    currentAttrName = `attr_${token.toString(16)}`;
                    currentAttrValue = '';
                }
            } else if (token >= 0x80 && token <= 0xFF) {
                // Attribute value token
                const value = this.attrPage === 0 ? ATTR_VALUE_BY_TOKEN[token] : undefined;
                if (value) {
                    currentAttrValue += value;
                }
            }
        }

        return result;
    }

    private readByte(): number {
        if (this.pos >= this.data.length) {
            throw new Error('Unexpected end of WBXML data');
        }
        return this.data[this.pos++];
    }

    private peekByte(): number {
        if (this.pos >= this.data.length) {
            throw new Error('Unexpected end of WBXML data');
        }
        return this.data[this.pos];
    }

    /** Returns true if the token produces inline text (string, entity, variable ref) */
    private isInlineToken(token: number): boolean {
        return token === STR_I || token === STR_T || token === ENTITY ||
            token === EXT_I_0 || token === EXT_I_1 || token === EXT_I_2 ||
            token === EXT_T_0 || token === EXT_T_1 || token === EXT_T_2;
    }

    private readMbUint32(): number {
        // Arithmetic, not `<<`: a shift is 32-bit signed in JavaScript, so a
        // length of 2^31 or more turned negative (an OPAQUE of 0xFFFFFFFA
        // stepped back onto its own token, for ever)
        let result = 0;
        let byte: number;
        do {
            byte = this.readByte();
            result = result * 128 + (byte & 0x7F);
        } while (byte & 0x80);
        return result;
    }

    private readTerminatedString(): string {
        const start = this.pos;
        while (this.pos < this.data.length && this.data[this.pos] !== 0) {
            this.pos++;
        }
        const str = decodeText(this.data, this.charset, start, this.pos);
        this.pos++; // skip null terminator
        return str;
    }

    private getStringTableEntry(offset: number): string {
        const start = this.tableStart + offset;
        let end = start;
        while (end < this.tableEnd && this.data[end] !== 0) { end++; }
        return start < this.tableEnd ? decodeText(this.data, this.charset, start, end) : '';
    }

    private static readonly NAMED_ENTITIES: Record<number, string> = {
        0x22: '&quot;', 0x27: '&apos;', 0xA0: '&nbsp;', 0xA9: '&copy;',
        0xAD: '&shy;', 0xAE: '&reg;', 0xB0: '&deg;',
    };

    private entityToString(code: number): string {
        return WbxmlDecoder.NAMED_ENTITIES[code] || `&#${code};`;
    }

    private escapeXml(str: string): string {
        return str
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;');
    }

    private escapeXmlAttr(str: string): string {
        return str
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;');
    }
}
