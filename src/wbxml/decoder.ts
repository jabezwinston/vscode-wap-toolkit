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

export function decodeWbxml(data: Buffer): string {
    const decoder = new WbxmlDecoder(data);
    return decoder.decode();
}

class WbxmlDecoder {
    private data: Buffer;
    private pos: number = 0;
    private stringTable: string = '';
    private indent: number = 0;

    constructor(data: Buffer) {
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

        // String table
        const stLen = this.readMbUint32();
        if (stLen > 0) {
            this.stringTable = this.data.toString('utf-8', this.pos, this.pos + stLen);
            this.pos += stLen;
        }

        // Build XML output
        let xml = '<?xml version="1.0" encoding="UTF-8"?>\n';
        xml += '<!DOCTYPE wml PUBLIC "-//WAPFORUM//DTD WML 1.3//EN"\n';
        xml += '  "http://www.wapforum.org/DTD/wml13.dtd">\n\n';

        xml += this.decodeBody();

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
                this.readByte(); // code page
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

            case EXT_I_0:
            case EXT_I_1:
            case EXT_I_2: {
                const varName = this.readTerminatedString();
                if (token === EXT_I_0) { return `$${varName}`; }
                if (token === EXT_I_1) { return `$(${varName}:unesc)`; }
                return `$(${varName}:noesc)`;
            }

            case EXT_T_0:
            case EXT_T_1:
            case EXT_T_2: {
                const idx = this.readMbUint32();
                const name = this.getStringTableEntry(idx);
                if (token === EXT_T_0) { return `$${name}`; }
                if (token === EXT_T_1) { return `$(${name}:unesc)`; }
                return `$(${name}:noesc)`;
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
                this.pos += len; // skip opaque data
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
            tagName = WML_TOKEN_TAGS[tagToken] || `unknown_${tagToken.toString(16)}`;
        }

        const indentStr = '  '.repeat(this.indent);
        let result = `${indentStr}<${tagName}`;

        // Decode attributes
        if (hasAttrs) {
            result += this.decodeAttributes();
        }

        if (hasContent) {
            this.indent++;

            // Collect content parts, merging consecutive inline tokens
            // (STR_I, ENTITY, variable refs) into single text parts
            const parts: string[] = [];
            let hasChildElements = false;
            let textAccum = '';

            const flushText = () => {
                if (textAccum) {
                    parts.push(textAccum);
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
                        parts.push(decoded);
                        if (decoded.includes('<')) {
                            hasChildElements = true;
                        }
                    }
                }
            }
            flushText();

            const allContent = parts.join('');
            const trimmed = allContent.trim();

            if (!trimmed) {
                // Empty content
                result += `></${tagName}>\n`;
            } else if (!hasChildElements) {
                // Text-only content → inline
                result += `>${trimmed}</${tagName}>\n`;
            } else {
                // Has child elements → multi-line
                result += '>\n';
                const childIndent = '  '.repeat(this.indent + 1);
                for (const part of parts) {
                    const t = part.trim();
                    if (t && !t.includes('<')) {
                        // Text node among elements
                        result += `${childIndent}${t}\n`;
                    } else {
                        result += part;
                    }
                }
                result += `${indentStr}</${tagName}>\n`;
            }
        } else {
            result += '/>\n';
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
                this.readByte(); // consume code page number
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
                if (token === EXT_I_0) { currentAttrValue += `$${varName}`; }
                else if (token === EXT_I_1) { currentAttrValue += `$(${varName}:unesc)`; }
                else { currentAttrValue += `$(${varName}:noesc)`; }
            } else if (token === EXT_T_0 || token === EXT_T_1 || token === EXT_T_2) {
                const idx = this.readMbUint32();
                const name = this.getStringTableEntry(idx);
                if (token === EXT_T_0) { currentAttrValue += `$${name}`; }
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

                const attrInfo = ATTR_START_BY_TOKEN[token];
                if (attrInfo) {
                    currentAttrName = attrInfo.name;
                    currentAttrValue = attrInfo.value;
                } else {
                    currentAttrName = `attr_${token.toString(16)}`;
                    currentAttrValue = '';
                }
            } else if (token >= 0x80 && token <= 0xFF) {
                // Attribute value token
                const value = ATTR_VALUE_BY_TOKEN[token];
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
        let result = 0;
        let byte: number;
        do {
            byte = this.readByte();
            result = (result << 7) | (byte & 0x7F);
        } while (byte & 0x80);
        return result;
    }

    private readTerminatedString(): string {
        const start = this.pos;
        while (this.pos < this.data.length && this.data[this.pos] !== 0) {
            this.pos++;
        }
        const str = this.data.toString('utf-8', start, this.pos);
        this.pos++; // skip null terminator
        return str;
    }

    private getStringTableEntry(offset: number): string {
        const end = this.stringTable.indexOf('\0', offset);
        if (end === -1) {
            return this.stringTable.substring(offset);
        }
        return this.stringTable.substring(offset, end);
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
