/**
 *
 *  Copyright (C) 2026 Jabez Winston
 * 
 *  SPDX-License-Identifier: Apache-2.0
 *
 *  Date : 18-March-2026
 * 
 *  WMLScript Bytecode (WMLSC) Opcode Definitions
 *  Based on WAP-193 (WMLScript 1.1) standard bytecode encoding.
 *
 *  The bytecode uses a variable-length encoding:
 *    - Primary opcodes (0x01-0x1F): explicit operands follow
 *    - Operator opcodes (0x20-0x3C): single-byte stack-based operators
 *    - Packed opcodes (0x40-0xFF): small operand encoded in opcode byte
 */

// === WMLSC File Format Constants ===
export const WMLSC_VERSION_1_1 = 0x01;   // WAP-193 version 1.1

// Character set constant for UTF-8
export const WMLSC_CHARSET_UTF8 = 0x6A;

// Constant pool entry types
export enum ConstantType {
    INT_8           = 0,
    INT_16          = 1,
    INT_32          = 2,
    FLOAT_32        = 3,
    UTF8_STRING     = 4,
    EMPTY_STRING    = 5,
    EXT_STRING      = 6,
}

// Pragma types
export enum PragmaType {
    ACCESS_DOMAIN           = 0,
    ACCESS_PATH             = 1,
    USER_AGENT_PROPERTY     = 2,
    USER_AGENT_PROPERTY_SCH = 3,
}

// === Primary Opcodes (0x01-0x1F) and Operator Opcodes (0x20-0x3C) ===
export const enum Opcode {
    // Jump instructions
    JUMP_FW         = 0x01,     // uint8 offset
    JUMP_FW_W       = 0x02,     // uint16 offset
    JUMP_BW         = 0x03,     // uint8 offset
    JUMP_BW_W       = 0x04,     // uint16 offset
    TJUMP_FW        = 0x05,     // uint8 offset (pop, jump if false)
    TJUMP_FW_W      = 0x06,     // uint16 offset (pop, jump if false)
    TJUMP_BW        = 0x07,     // uint8 offset (pop, jump if false)
    TJUMP_BW_W      = 0x08,     // uint16 offset (pop, jump if false)

    // Function calls
    CALL            = 0x09,     // uint8 func_index
    CALL_LIB        = 0x0A,     // uint8 func_index, uint8 lib_index (nargs from stdlib table)
    CALL_LIB_W      = 0x0B,     // uint16 func_index, uint8 lib_index (nargs from stdlib table)
    CALL_URL        = 0x0C,     // uint8 url_index, uint8 func_index, uint8 nargs
    CALL_URL_W      = 0x0D,     // uint16 url_index, uint16 func_index, uint8 nargs

    // Variable access
    LOAD_VAR        = 0x0E,     // uint8 var_index
    STORE_VAR       = 0x0F,     // uint8 var_index
    INCR_VAR        = 0x10,     // uint8 var_index (++var, push new value)
    DECR_VAR        = 0x11,     // uint8 var_index (--var, push new value)

    // Constant access
    LOAD_CONST      = 0x12,     // uint8 const_pool_index
    LOAD_CONST_W    = 0x13,     // uint16 const_pool_index

    // Constant literals (no operands)
    CONST_0         = 0x14,     // push integer 0
    CONST_1         = 0x15,     // push integer 1
    CONST_M1        = 0x16,     // push integer -1
    CONST_ES        = 0x17,     // push empty string ""
    CONST_INVALID   = 0x18,     // push invalid value
    CONST_TRUE      = 0x19,     // push boolean true
    CONST_FALSE     = 0x1A,     // push boolean false

    // Increment/decrement stack top
    INCR            = 0x1B,     // pop a, push a + 1
    DECR            = 0x1C,     // pop a, push a - 1

    // Compound assignment
    ADD_ASG         = 0x1D,     // uint8 var_index: var += pop
    SUB_ASG         = 0x1E,     // uint8 var_index: var -= pop

    // Unary minus
    UMINUS          = 0x1F,     // pop a, push -a

    // === Operator Opcodes (0x20-0x3C) — single-byte, no operands ===

    // Arithmetic (pop b, pop a, push result)
    ADD             = 0x20,     // a + b
    SUB             = 0x21,     // a - b
    MUL             = 0x22,     // a * b
    DIV             = 0x23,     // a / b (float division)
    IDIV            = 0x24,     // a div b (integer division)
    REM             = 0x25,     // a % b

    // Bitwise (pop b, pop a, push result — except B_NOT which is unary)
    B_AND           = 0x26,     // a & b
    B_OR            = 0x27,     // a | b
    B_XOR           = 0x28,     // a ^ b
    B_NOT           = 0x29,     // ~a (unary)
    B_LSHIFT        = 0x2A,     // a << b
    B_RSSHIFT       = 0x2B,     // a >> b (signed)
    B_RSZSHIFT      = 0x2C,     // a >>> b (unsigned)

    // Comparison (pop b, pop a, push boolean)
    EQ              = 0x2D,     // a == b
    LE              = 0x2E,     // a <= b
    LT              = 0x2F,     // a < b
    GE              = 0x30,     // a >= b
    GT              = 0x31,     // a > b
    NE              = 0x32,     // a != b

    // Logical
    NOT             = 0x33,     // !a (unary)
    SCAND           = 0x34,     // short-circuit AND
    SCOR            = 0x35,     // short-circuit OR
    TOBOOL          = 0x36,     // convert to boolean

    // Stack
    POP             = 0x37,     // discard top

    // Type
    TYPEOF          = 0x38,     // push type of top (0=int, 1=float, 2=string, 3=bool, 4=invalid)
    ISVALID         = 0x39,     // push whether top is not invalid

    // Control
    RETURN          = 0x3A,     // return top of stack
    RETURN_ES       = 0x3B,     // return empty string
    DEBUG           = 0x3C,     // debugger breakpoint
}

// === Packed Opcode Ranges ===
// The high bits encode the instruction type, low bits encode a small operand.
export const PACKED_STORE_VAR_S_BASE   = 0x40;  // 0x40-0x4F: var_index = opcode & 0x0F
export const PACKED_STORE_VAR_S_MASK   = 0x0F;

export const PACKED_LOAD_CONST_S_BASE  = 0x50;  // 0x50-0x5F: const_index = opcode & 0x0F
export const PACKED_LOAD_CONST_S_MASK  = 0x0F;

export const PACKED_CALL_S_BASE        = 0x60;  // 0x60-0x67: func_index = opcode & 0x07
export const PACKED_CALL_S_MASK        = 0x07;

export const PACKED_CALL_LIB_S_BASE    = 0x68;  // 0x68-0x6F: func_index = opcode & 0x07
export const PACKED_CALL_LIB_S_MASK    = 0x07;  // followed by uint8 lib_index only

export const PACKED_INCR_VAR_S_BASE    = 0x70;  // 0x70-0x77: var_index = opcode & 0x07
export const PACKED_INCR_VAR_S_MASK    = 0x07;

export const PACKED_JUMP_FW_S_BASE     = 0x80;  // 0x80-0x9F: offset = opcode & 0x1F
export const PACKED_JUMP_FW_S_MASK     = 0x1F;

export const PACKED_JUMP_BW_S_BASE     = 0xA0;  // 0xA0-0xBF: offset = opcode & 0x1F
export const PACKED_JUMP_BW_S_MASK     = 0x1F;

export const PACKED_TJUMP_FW_S_BASE    = 0xC0;  // 0xC0-0xDF: offset = opcode & 0x1F
export const PACKED_TJUMP_FW_S_MASK    = 0x1F;

export const PACKED_LOAD_VAR_S_BASE    = 0xE0;  // 0xE0-0xFF: var_index = opcode & 0x1F
export const PACKED_LOAD_VAR_S_MASK    = 0x1F;

// === Standard Library IDs ===
export enum StdLibrary {
    Lang        = 0,
    Float       = 1,
    String      = 2,
    URL         = 3,
    WMLBrowser  = 4,
    Dialogs     = 5,
    Console     = 6,    // Non-standard debug extension
}

// Standard library function names (library_id -> [function_names])
export const STDLIB_FUNCTIONS: Record<number, string[]> = {
    [StdLibrary.Lang]:       ['abs', 'min', 'max', 'parseInt', 'parseFloat', 'isInt', 'isFloat', 'maxInt', 'minInt', 'float', 'exit', 'abort', 'random', 'seed', 'characterSet'],
    [StdLibrary.Float]:      ['int', 'floor', 'ceil', 'pow', 'round', 'sqrt', 'maxFloat', 'minFloat'],
    [StdLibrary.String]:     ['length', 'isEmpty', 'charAt', 'subString', 'find', 'replace', 'elements', 'elementAt', 'removeAt', 'replaceAt', 'insertAt', 'squeeze', 'trim', 'compare', 'toString', 'format'],
    [StdLibrary.URL]:        ['isValid', 'getScheme', 'getHost', 'getPort', 'getPath', 'getParameters', 'getQuery', 'getFragment', 'getBase', 'getReferer', 'resolve', 'escapeString', 'unescapeString', 'loadString'],
    [StdLibrary.WMLBrowser]: ['getVar', 'setVar', 'go', 'prev', 'newContext', 'getCurrentCard', 'refresh'],
    [StdLibrary.Dialogs]:    ['prompt', 'confirm', 'alert'],
    [StdLibrary.Console]:    ['print', 'println'],
};

// Number of arguments for each stdlib function (WAP-194 signatures).
// NOTE: the VM derives the operand-pop count from this table, so the arities
// MUST match the library signatures exactly or the operand stack corrupts.
export const STDLIB_NARGS: Record<number, number[]> = {
    [StdLibrary.Lang]:       [1, 2, 2, 1, 1, 1, 1, 0, 0, 0, 1, 1, 1, 1, 0],
    [StdLibrary.Float]:      [1, 1, 1, 2, 1, 1, 0, 0],
    // length isEmpty charAt subString find replace elements elementAt removeAt replaceAt insertAt squeeze trim compare toString format
    [StdLibrary.String]:     [1, 1, 2, 3, 2, 3, 2, 3, 3, 4, 4, 1, 1, 2, 1, 2],
    [StdLibrary.URL]:        [1, 1, 1, 1, 1, 1, 1, 1, 0, 0, 2, 1, 1, 2],
    [StdLibrary.WMLBrowser]: [1, 2, 1, 0, 0, 0, 0],
    // prompt confirm(message,ok,cancel) alert
    [StdLibrary.Dialogs]:    [2, 3, 1],
    [StdLibrary.Console]:    [1, 1],
};

// Library name to ID mapping
export const STDLIB_NAME_TO_ID: Record<string, number> = {
    'Lang':        StdLibrary.Lang,
    'Float':       StdLibrary.Float,
    'String':      StdLibrary.String,
    'URL':         StdLibrary.URL,
    'WMLBrowser':  StdLibrary.WMLBrowser,
    'Dialogs':     StdLibrary.Dialogs,
    'Console':     StdLibrary.Console,
};

// === WMLScript Type IDs (returned by typeof) ===
export enum WmlsType {
    Integer = 0,
    Float   = 1,
    String  = 2,
    Boolean = 3,
    Invalid = 4,
}

// === Instruction Metadata ===
export interface InstructionInfo {
    name: string;
    operandBytes: number;   // fixed operand bytes (0 for no-operand instructions)
    description: string;
}

// Opcode name lookup for disassembly
export const OPCODE_INFO: Record<number, InstructionInfo> = {
    // Primary opcodes (0x01-0x1F)
    [Opcode.JUMP_FW]:       { name: 'JUMP_FW',       operandBytes: 1, description: 'Jump forward uint8 offset' },
    [Opcode.JUMP_FW_W]:     { name: 'JUMP_FW_W',     operandBytes: 2, description: 'Jump forward uint16 offset' },
    [Opcode.JUMP_BW]:       { name: 'JUMP_BW',       operandBytes: 1, description: 'Jump backward uint8 offset' },
    [Opcode.JUMP_BW_W]:     { name: 'JUMP_BW_W',     operandBytes: 2, description: 'Jump backward uint16 offset' },
    [Opcode.TJUMP_FW]:      { name: 'TJUMP_FW',      operandBytes: 1, description: 'Test-jump forward uint8 offset' },
    [Opcode.TJUMP_FW_W]:    { name: 'TJUMP_FW_W',    operandBytes: 2, description: 'Test-jump forward uint16 offset' },
    [Opcode.TJUMP_BW]:      { name: 'TJUMP_BW',      operandBytes: 1, description: 'Test-jump backward uint8 offset' },
    [Opcode.TJUMP_BW_W]:    { name: 'TJUMP_BW_W',    operandBytes: 2, description: 'Test-jump backward uint16 offset' },
    [Opcode.CALL]:          { name: 'CALL',           operandBytes: 1, description: 'Call local function' },
    [Opcode.CALL_LIB]:      { name: 'CALL_LIB',      operandBytes: 2, description: 'Call library function (func_id, lib_id)' },
    [Opcode.CALL_LIB_W]:    { name: 'CALL_LIB_W',    operandBytes: 3, description: 'Call library function (wide func_id, lib_id)' },
    [Opcode.CALL_URL]:      { name: 'CALL_URL',       operandBytes: 3, description: 'Call external URL function' },
    [Opcode.CALL_URL_W]:    { name: 'CALL_URL_W',     operandBytes: 5, description: 'Call external URL function (wide)' },
    [Opcode.LOAD_VAR]:      { name: 'LOAD_VAR',      operandBytes: 1, description: 'Load variable' },
    [Opcode.STORE_VAR]:     { name: 'STORE_VAR',     operandBytes: 1, description: 'Store variable' },
    [Opcode.INCR_VAR]:      { name: 'INCR_VAR',      operandBytes: 1, description: 'Increment variable' },
    [Opcode.DECR_VAR]:      { name: 'DECR_VAR',      operandBytes: 1, description: 'Decrement variable' },
    [Opcode.LOAD_CONST]:    { name: 'LOAD_CONST',    operandBytes: 1, description: 'Load constant' },
    [Opcode.LOAD_CONST_W]:  { name: 'LOAD_CONST_W',  operandBytes: 2, description: 'Load constant (wide)' },
    [Opcode.CONST_0]:       { name: 'CONST_0',       operandBytes: 0, description: 'Push 0' },
    [Opcode.CONST_1]:       { name: 'CONST_1',       operandBytes: 0, description: 'Push 1' },
    [Opcode.CONST_M1]:      { name: 'CONST_M1',      operandBytes: 0, description: 'Push -1' },
    [Opcode.CONST_ES]:      { name: 'CONST_ES',      operandBytes: 0, description: 'Push empty string' },
    [Opcode.CONST_INVALID]: { name: 'CONST_INVALID', operandBytes: 0, description: 'Push invalid' },
    [Opcode.CONST_TRUE]:    { name: 'CONST_TRUE',    operandBytes: 0, description: 'Push true' },
    [Opcode.CONST_FALSE]:   { name: 'CONST_FALSE',   operandBytes: 0, description: 'Push false' },
    [Opcode.INCR]:          { name: 'INCR',          operandBytes: 0, description: 'Increment top' },
    [Opcode.DECR]:          { name: 'DECR',          operandBytes: 0, description: 'Decrement top' },
    [Opcode.ADD_ASG]:       { name: 'ADD_ASG',       operandBytes: 1, description: 'Add-assign to variable' },
    [Opcode.SUB_ASG]:       { name: 'SUB_ASG',       operandBytes: 1, description: 'Sub-assign to variable' },
    [Opcode.UMINUS]:        { name: 'UMINUS',        operandBytes: 0, description: 'Unary minus' },

    // Operator opcodes (0x20-0x3C) — single-byte, no operands
    [Opcode.ADD]:           { name: 'ADD',        operandBytes: 0, description: 'Add' },
    [Opcode.SUB]:           { name: 'SUB',        operandBytes: 0, description: 'Subtract' },
    [Opcode.MUL]:           { name: 'MUL',        operandBytes: 0, description: 'Multiply' },
    [Opcode.DIV]:           { name: 'DIV',        operandBytes: 0, description: 'Divide (float)' },
    [Opcode.IDIV]:          { name: 'IDIV',       operandBytes: 0, description: 'Divide (integer)' },
    [Opcode.REM]:           { name: 'REM',        operandBytes: 0, description: 'Remainder' },
    [Opcode.B_AND]:         { name: 'B_AND',      operandBytes: 0, description: 'Bitwise AND' },
    [Opcode.B_OR]:          { name: 'B_OR',       operandBytes: 0, description: 'Bitwise OR' },
    [Opcode.B_XOR]:         { name: 'B_XOR',      operandBytes: 0, description: 'Bitwise XOR' },
    [Opcode.B_NOT]:         { name: 'B_NOT',      operandBytes: 0, description: 'Bitwise NOT' },
    [Opcode.B_LSHIFT]:      { name: 'B_LSHIFT',   operandBytes: 0, description: 'Left shift' },
    [Opcode.B_RSSHIFT]:     { name: 'B_RSSHIFT',  operandBytes: 0, description: 'Right shift (signed)' },
    [Opcode.B_RSZSHIFT]:    { name: 'B_RSZSHIFT', operandBytes: 0, description: 'Right shift (unsigned)' },
    [Opcode.EQ]:            { name: 'EQ',         operandBytes: 0, description: 'Equal' },
    [Opcode.LE]:            { name: 'LE',         operandBytes: 0, description: 'Less or equal' },
    [Opcode.LT]:            { name: 'LT',         operandBytes: 0, description: 'Less than' },
    [Opcode.GE]:            { name: 'GE',         operandBytes: 0, description: 'Greater or equal' },
    [Opcode.GT]:            { name: 'GT',         operandBytes: 0, description: 'Greater than' },
    [Opcode.NE]:            { name: 'NE',         operandBytes: 0, description: 'Not equal' },
    [Opcode.NOT]:           { name: 'NOT',        operandBytes: 0, description: 'Logical NOT' },
    [Opcode.SCAND]:         { name: 'SCAND',      operandBytes: 0, description: 'Short-circuit AND' },
    [Opcode.SCOR]:          { name: 'SCOR',       operandBytes: 0, description: 'Short-circuit OR' },
    [Opcode.TOBOOL]:        { name: 'TOBOOL',     operandBytes: 0, description: 'Convert to boolean' },
    [Opcode.POP]:           { name: 'POP',        operandBytes: 0, description: 'Pop top' },
    [Opcode.TYPEOF]:        { name: 'TYPEOF',     operandBytes: 0, description: 'Type of value' },
    [Opcode.ISVALID]:       { name: 'ISVALID',    operandBytes: 0, description: 'Is valid value' },
    [Opcode.RETURN]:        { name: 'RETURN',     operandBytes: 0, description: 'Return value' },
    [Opcode.RETURN_ES]:     { name: 'RETURN_ES',  operandBytes: 0, description: 'Return empty string' },
    [Opcode.DEBUG]:         { name: 'DEBUG',      operandBytes: 0, description: 'Debug break' },
};

// Helper to classify an opcode byte into its type
export function classifyOpcode(byte: number): {
    type: 'primary' | 'packed';
    packedKind?: string;
    embeddedValue?: number;
} {
    // 0x01-0x3C: primary opcodes (includes operators 0x20-0x3C)
    if (byte >= 0x01 && byte <= 0x3C) {
        return { type: 'primary' };
    }
    // 0x00 and 0x3D-0x3F: reserved/unused — treat as primary
    if (byte <= 0x3F) {
        return { type: 'primary' };
    }
    if (byte >= PACKED_STORE_VAR_S_BASE && byte <= 0x4F) {
        return { type: 'packed', packedKind: 'STORE_VAR_S', embeddedValue: byte & PACKED_STORE_VAR_S_MASK };
    }
    if (byte >= PACKED_LOAD_CONST_S_BASE && byte <= 0x5F) {
        return { type: 'packed', packedKind: 'LOAD_CONST_S', embeddedValue: byte & PACKED_LOAD_CONST_S_MASK };
    }
    if (byte >= PACKED_CALL_S_BASE && byte <= 0x67) {
        return { type: 'packed', packedKind: 'CALL_S', embeddedValue: byte & PACKED_CALL_S_MASK };
    }
    if (byte >= PACKED_CALL_LIB_S_BASE && byte <= 0x6F) {
        return { type: 'packed', packedKind: 'CALL_LIB_S', embeddedValue: byte & PACKED_CALL_LIB_S_MASK };
    }
    if (byte >= PACKED_INCR_VAR_S_BASE && byte <= 0x77) {
        return { type: 'packed', packedKind: 'INCR_VAR_S', embeddedValue: byte & PACKED_INCR_VAR_S_MASK };
    }
    if (byte >= 0x78 && byte <= 0x7F) {
        // Reserved range — treat as primary
        return { type: 'primary' };
    }
    if (byte >= PACKED_JUMP_FW_S_BASE && byte <= 0x9F) {
        return { type: 'packed', packedKind: 'JUMP_FW_S', embeddedValue: byte & PACKED_JUMP_FW_S_MASK };
    }
    if (byte >= PACKED_JUMP_BW_S_BASE && byte <= 0xBF) {
        return { type: 'packed', packedKind: 'JUMP_BW_S', embeddedValue: byte & PACKED_JUMP_BW_S_MASK };
    }
    if (byte >= PACKED_TJUMP_FW_S_BASE && byte <= 0xDF) {
        return { type: 'packed', packedKind: 'TJUMP_FW_S', embeddedValue: byte & PACKED_TJUMP_FW_S_MASK };
    }
    // 0xE0-0xFF
    return { type: 'packed', packedKind: 'LOAD_VAR_S', embeddedValue: byte & PACKED_LOAD_VAR_S_MASK };
}

// Multi-byte unsigned integer encoding/decoding (same as WBXML mb_u_int32)
export function encodeMbUint32(value: number): number[] {
    if (value === 0) { return [0]; }
    const bytes: number[] = [];
    let v = value;
    while (v > 0) {
        bytes.unshift(v & 0x7F);
        v = v >>> 7;
    }
    for (let i = 0; i < bytes.length - 1; i++) {
        bytes[i] |= 0x80; // continuation bit
    }
    return bytes;
}

export function decodeMbUint32(data: Buffer | Uint8Array, offset: number): { value: number; bytesRead: number } {
    let value = 0;
    let pos = offset;
    let byte: number;
    do {
        byte = data[pos++];
        value = (value << 7) | (byte & 0x7F);
    } while ((byte & 0x80) !== 0 && pos < data.length);
    return { value, bytesRead: pos - offset };
}
