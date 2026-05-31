/**
 *
 *  Copyright (C) 2026 Jabez Winston
 * 
 *  SPDX-License-Identifier: Apache-2.0
 *
 *  Date : 17-March-2026
 *  
 *  WML 1.3 WBXML Token Table
 *  Based on WAP-192-WBXML and WAP-191-WML specifications
 */

// WBXML Global Tokens
export const WBXML_VERSION = 0x03;  // WBXML 1.3
export const WML_PUBLIC_ID = 0x0A;  // WML 1.3 (Table 5: "-//WAPFORUM//DTD WML 1.3//EN")
export const CHARSET_UTF8 = 0x6A;  // UTF-8

// Global tokens
export const SWITCH_PAGE = 0x00;
export const END = 0x01;
export const ENTITY = 0x02;
export const STR_I = 0x03;
export const LITERAL = 0x04;
export const EXT_I_0 = 0x40;
export const EXT_I_1 = 0x41;
export const EXT_I_2 = 0x42;
export const PI = 0x43;
export const LITERAL_C = 0x44;
export const EXT_T_0 = 0x80;
export const EXT_T_1 = 0x81;
export const EXT_T_2 = 0x82;
export const STR_T = 0x83;
export const LITERAL_A = 0x84;
export const EXT_0 = 0xC0;
export const EXT_1 = 0xC1;
export const EXT_2 = 0xC2;
export const OPAQUE = 0xC3;
export const LITERAL_AC = 0xC4;

// Tag token flags
export const TAG_HAS_CONTENT = 0x40;
export const TAG_HAS_ATTRS = 0x80;

// WML 1.3 Tag Tokens (Code Page 0)
export const WML_TAG_TOKENS: Record<string, number> = {
    'a':          0x1C,
    'anchor':     0x22,
    'access':     0x23,
    'b':          0x24,
    'big':        0x25,
    'br':         0x26,
    'card':       0x27,
    'do':         0x28,
    'em':         0x29,
    'fieldset':   0x2A,
    'go':         0x2B,
    'head':       0x2C,
    'i':          0x2D,
    'img':        0x2E,
    'input':      0x2F,
    'meta':       0x30,
    'noop':       0x31,
    'p':          0x20,
    'postfield':  0x21,
    'prev':       0x32,
    'onevent':    0x33,
    'optgroup':   0x34,
    'option':     0x35,
    'refresh':    0x36,
    'select':     0x37,
    'setvar':     0x3E,
    'small':      0x38,
    'strong':     0x39,
    'table':      0x1F,
    'td':         0x1D,
    'template':   0x3B,
    'timer':      0x3C,
    'tr':         0x1E,
    'u':          0x3D,
    'wml':        0x3F,
    'pre':        0x1B,
};

// Reverse mapping: token -> tag name
export const WML_TOKEN_TAGS: Record<number, string> = {};
for (const [name, token] of Object.entries(WML_TAG_TOKENS)) {
    WML_TOKEN_TAGS[token] = name;
}

// WML 1.3 Attribute Start Tokens (Code Page 0)
export const WML_ATTR_START_TOKENS: Record<string, number> = {
    'accept-charset':       0x05,
    'align=bottom':         0x06,
    'align=center':         0x07,
    'align=left':           0x08,
    'align=middle':         0x09,
    'align=right':          0x0A,
    'align=top':            0x0B,
    'alt':                  0x0C,
    'class':                0x54,
    'columns':              0x53,
    'content':              0x0D,
    'domain':               0x0F,
    'emptyok=false':        0x10,
    'emptyok=true':         0x11,
    'format':               0x12,
    'forua=false':          0x56,
    'forua=true':           0x57,
    'height':               0x13,
    'href':                 0x4A,
    'href=http://':         0x4B,
    'href=https://':        0x4C,
    'hspace':               0x14,
    'http-equiv':           0x5A,
    'http-equiv=Content-Type':  0x5B,
    'http-equiv=Expires':       0x5D,
    'id':                   0x55,
    'ivalue':               0x15,
    'iname':                0x16,
    'label':                0x18,
    'localsrc':             0x19,
    'maxlength':            0x1A,
    'method=get':           0x1B,
    'method=post':          0x1C,
    'mode=nowrap':          0x1D,
    'mode=wrap':            0x1E,
    'multiple=false':       0x1F,
    'multiple=true':        0x20,
    'name':                 0x21,
    'newcontext=false':     0x22,
    'newcontext=true':      0x23,
    'onenterbackward':      0x25,
    'onenterforward':       0x26,
    'onpick':               0x24,
    'ontimer':              0x27,
    'optional=false':       0x28,
    'optional=true':        0x29,
    'path':                 0x2A,
    'scheme':               0x2E,
    'sendreferer=false':    0x2F,
    'sendreferer=true':     0x30,
    'size':                 0x31,
    'src':                  0x32,
    'src=http://':          0x58,
    'src=https://':         0x59,
    'ordered=false':        0x33,
    'ordered=true':         0x34,
    'tabindex':             0x35,
    'title':                0x36,
    'type':                 0x37,
    'type=accept':          0x38,
    'type=delete':          0x39,
    'type=help':            0x3A,
    'type=password':        0x3B,
    'type=onenterbackward': 0x3C,
    'type=onenterforward':  0x3D,
    'type=ontimer':         0x3E,
    'type=options':         0x45,
    'type=prev':            0x46,
    'type=reset':           0x47,
    'type=text':            0x48,
    'type=vnd.':            0x49,
    'value':                0x4D,
    'vspace':               0x4E,
    'width':                0x4F,
    'xml:lang':             0x50,
    'accesskey':            0x5E,
    'cache-control=no-cache': 0x60,
    'cache-control':        0x5F,
};

// Attribute Value Tokens
export const WML_ATTR_VALUE_TOKENS: Record<string, number> = {
    '.com/':        0x85,
    '.edu/':        0x86,
    '.net/':        0x87,
    '.org/':        0x88,
    'accept':       0x89,
    'bottom':       0x8A,
    'clear':        0x8B,
    'delete':       0x8C,
    'help':         0x8D,
    'http://':      0x8E,
    'http://www.':  0x8F,
    'https://':     0x90,
    'https://www.': 0x91,
    'middle':       0x93,
    'nowrap':       0x94,
    'onenterbackward': 0x96,
    'onenterforward':  0x97,
    'onpick':       0x95,
    'ontimer':      0x98,
    'options':      0x99,
    'password':     0x9A,
    'reset':        0x9B,
    'text':         0x9D,
    'top':          0x9E,
    'unknown':      0x9F,
    'wrap':         0xA0,
    'www.':         0xA1,
};
