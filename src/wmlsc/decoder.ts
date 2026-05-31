/**
 *
 *  Copyright (C) 2026 Jabez Winston
 * 
 *  SPDX-License-Identifier: Apache-2.0
 *
 *  Date : 18-March-2026
 * 
 *  WMLSC Bytecode Decoder — Reads compiled WMLScript (.wmlsc) files
 *  and decodes them into a structured representation or disassembly text.
 *
 *  Based on WAP-193-WMLScript specification.
 */
import {
    Opcode, ConstantType, PragmaType,
    OPCODE_INFO,
    STDLIB_FUNCTIONS, STDLIB_NARGS, StdLibrary,
    classifyOpcode, decodeMbUint32,
} from './opcodes';

// === Decoded WMLSC File Structure ===

export interface WmlscConstant {
    type: ConstantType;
    value: number | string;
}

export interface WmlscPragma {
    type: PragmaType;
    indices: number[];     // indices into constant pool
}

export interface WmlscFunctionName {
    index: number;
    name: string;
}

export interface WmlscFunction {
    numArgs: number;
    numLocals: number;
    bytecodeSize: number;
    bytecode: Uint8Array;
    name?: string;          // resolved from function name table
}

export interface WmlscModule {
    version: number;
    constants: WmlscConstant[];
    pragmas: WmlscPragma[];
    functions: WmlscFunction[];
    functionNames: WmlscFunctionName[];
}

export interface DisassembledInstruction {
    offset: number;
    bytes: number[];
    mnemonic: string;
    operands: string;
    comment?: string;
}

// === Decoder ===

export function decodeWmlsc(data: Buffer): WmlscModule {
    const decoder = new WmlscDecoder(data);
    return decoder.decode();
}

export function disassembleWmlsc(data: Buffer): string {
    const mod = decodeWmlsc(data);
    return formatDisassembly(mod);
}

class WmlscDecoder {
    private data: Buffer;
    private pos = 0;

    constructor(data: Buffer) {
        this.data = data;
    }

    decode(): WmlscModule {
        const version = this.readUint8();
        const _codeSize = this.readMbUint32();

        const constants = this.readConstantPool();
        const pragmas = this.readPragmaPool();
        const { functions, functionNames } = this.readFunctionPool();

        // Resolve function names
        for (const fn of functionNames) {
            if (fn.index < functions.length) {
                functions[fn.index].name = fn.name;
            }
        }

        return { version, constants, pragmas, functions, functionNames };
    }

    private readConstantPool(): WmlscConstant[] {
        const count = this.readMbUint16();
        // Read CharSet field (WAP-193)
        const _charset = this.readMbUint32();
        const constants: WmlscConstant[] = [];

        for (let i = 0; i < count; i++) {
            const type = this.readUint8() as ConstantType;
            let value: number | string;

            switch (type) {
                case ConstantType.INT_8:
                    value = this.readInt8();
                    break;
                case ConstantType.INT_16:
                    value = this.readInt16();
                    break;
                case ConstantType.INT_32:
                    value = this.readInt32();
                    break;
                case ConstantType.FLOAT_32:
                    value = this.readFloat32();
                    break;
                case ConstantType.UTF8_STRING: {
                    const len = this.readMbUint32();
                    value = this.data.toString('utf-8', this.pos, this.pos + len);
                    this.pos += len;
                    break;
                }
                case ConstantType.EMPTY_STRING:
                    value = '';
                    break;
                case ConstantType.EXT_STRING: {
                    const _charset = this.readMbUint32();
                    const len = this.readMbUint32();
                    value = this.data.toString('utf-8', this.pos, this.pos + len);
                    this.pos += len;
                    break;
                }
                default:
                    throw new Error(`Unknown constant type: ${type} at offset ${this.pos - 1}`);
            }

            constants.push({ type, value });
        }

        return constants;
    }

    private readPragmaPool(): WmlscPragma[] {
        const count = this.readMbUint16();
        const pragmas: WmlscPragma[] = [];

        for (let i = 0; i < count; i++) {
            const type = this.readUint8() as PragmaType;
            const indices: number[] = [];

            switch (type) {
                case PragmaType.ACCESS_DOMAIN:
                case PragmaType.ACCESS_PATH:
                    indices.push(this.readMbUint16());
                    break;
                case PragmaType.USER_AGENT_PROPERTY:
                    indices.push(this.readMbUint16());
                    indices.push(this.readMbUint16());
                    break;
                case PragmaType.USER_AGENT_PROPERTY_SCH:
                    indices.push(this.readMbUint16());
                    indices.push(this.readMbUint16());
                    indices.push(this.readMbUint16());
                    break;
            }

            pragmas.push({ type, indices });
        }

        return pragmas;
    }

    private readFunctionPool(): { functions: WmlscFunction[]; functionNames: WmlscFunctionName[] } {
        const numFunctions = this.readUint8();

        // Function name table
        const numNames = this.readUint8();
        const functionNames: WmlscFunctionName[] = [];
        for (let i = 0; i < numNames; i++) {
            const funcIndex = this.readUint8();
            const nameSize = this.readUint8();
            const name = this.data.toString('utf-8', this.pos, this.pos + nameSize);
            this.pos += nameSize;
            functionNames.push({ index: funcIndex, name });
        }

        // Function bodies
        const functions: WmlscFunction[] = [];
        for (let i = 0; i < numFunctions; i++) {
            const numArgs = this.readUint8();
            const numLocals = this.readUint8();
            const bytecodeSize = this.readMbUint32();
            const bytecode = new Uint8Array(this.data.buffer, this.data.byteOffset + this.pos, bytecodeSize);
            this.pos += bytecodeSize;
            functions.push({ numArgs, numLocals, bytecodeSize, bytecode: new Uint8Array(bytecode) });
        }

        return { functions, functionNames };
    }

    // --- Primitive readers ---

    private readUint8(): number {
        return this.data[this.pos++];
    }

    private readInt8(): number {
        const v = this.data.readInt8(this.pos);
        this.pos += 1;
        return v;
    }

    private readInt16(): number {
        const v = this.data.readInt16BE(this.pos);
        this.pos += 2;
        return v;
    }

    private readInt32(): number {
        const v = this.data.readInt32BE(this.pos);
        this.pos += 4;
        return v;
    }

    private readFloat32(): number {
        const v = this.data.readFloatBE(this.pos);
        this.pos += 4;
        return v;
    }

    private readMbUint32(): number {
        const r = decodeMbUint32(this.data, this.pos);
        this.pos += r.bytesRead;
        return r.value;
    }

    private readMbUint16(): number {
        return this.readMbUint32(); // same encoding, just smaller expected range
    }
}

// === Bytecode Verification (WAP-193 §11, WMLS-C-107) ===

/**
 * Structural integrity check of a decoded module: opcode validity, operand
 * presence, in-range constant/function indices, and in-bounds jump targets.
 * Returns a list of human-readable problems ([] ⇒ the module verifies).
 */
export function verifyModule(mod: WmlscModule): string[] {
    const errors: string[] = [];
    const nConst = mod.constants.length;
    const nFunc = mod.functions.length;

    for (let fi = 0; fi < mod.functions.length; fi++) {
        const bc = mod.functions[fi].bytecode;
        const fname = mod.functions[fi].name ?? `function_${fi}`;
        const flag = (at: number, msg: string) => errors.push(`${fname}@${at}: ${msg}`);
        let pos = 0;
        while (pos < bc.length) {
            const start = pos;
            const byte = bc[pos++];
            const info = classifyOpcode(byte);

            if (info.type === 'primary') {
                const meta = OPCODE_INFO[byte];
                if (!meta) { flag(start, `unknown opcode 0x${byte.toString(16)}`); break; }
                if (pos + meta.operandBytes > bc.length) { flag(start, `truncated operands for ${meta.name}`); break; }
                switch (byte) {
                    case Opcode.LOAD_CONST:
                        if (bc[pos] >= nConst) { flag(start, `LOAD_CONST index ${bc[pos]} ≥ ${nConst}`); }
                        break;
                    case Opcode.LOAD_CONST_W: {
                        const i = (bc[pos] << 8) | bc[pos + 1];
                        if (i >= nConst) { flag(start, `LOAD_CONST_W index ${i} ≥ ${nConst}`); }
                        break;
                    }
                    case Opcode.CALL:
                        if (bc[pos] >= nFunc) { flag(start, `CALL function ${bc[pos]} ≥ ${nFunc}`); }
                        break;
                    case Opcode.JUMP_FW: case Opcode.TJUMP_FW:
                        if (start + 2 + bc[pos] > bc.length) { flag(start, `forward jump target out of range`); }
                        break;
                    case Opcode.JUMP_FW_W: case Opcode.TJUMP_FW_W:
                        if (start + 3 + ((bc[pos] << 8) | bc[pos + 1]) > bc.length) { flag(start, `forward jump target out of range`); }
                        break;
                    case Opcode.JUMP_BW: case Opcode.TJUMP_BW:
                        if (start - bc[pos] < 0) { flag(start, `backward jump target out of range`); }
                        break;
                    case Opcode.JUMP_BW_W: case Opcode.TJUMP_BW_W:
                        if (start - ((bc[pos] << 8) | bc[pos + 1]) < 0) { flag(start, `backward jump target out of range`); }
                        break;
                }
                pos += meta.operandBytes;
            } else {
                switch (info.packedKind) {
                    case 'CALL_LIB_S':
                        if (pos + 1 > bc.length) { flag(start, `truncated CALL_LIB_S`); pos = bc.length; }
                        else { pos += 1; }
                        break;
                    case 'LOAD_CONST_S':
                        if (info.embeddedValue! >= nConst) { flag(start, `LOAD_CONST_S index ${info.embeddedValue} ≥ ${nConst}`); }
                        break;
                    case 'CALL_S':
                        if (info.embeddedValue! >= nFunc) { flag(start, `CALL_S function ${info.embeddedValue} ≥ ${nFunc}`); }
                        break;
                    case 'JUMP_FW_S': case 'TJUMP_FW_S':
                        if (start + 1 + info.embeddedValue! > bc.length) { flag(start, `forward jump target out of range`); }
                        break;
                    case 'JUMP_BW_S':
                        if (start - info.embeddedValue! < 0) { flag(start, `backward jump target out of range`); }
                        break;
                }
            }
        }
    }
    return errors;
}

// === Disassembler ===

export function disassembleBytecode(bytecode: Uint8Array, constants: WmlscConstant[]): DisassembledInstruction[] {
    const instructions: DisassembledInstruction[] = [];
    let pos = 0;

    while (pos < bytecode.length) {
        const startPos = pos;
        const byte = bytecode[pos++];
        const info = classifyOpcode(byte);
        const bytes: number[] = [byte];
        let mnemonic: string;
        let operands = '';
        let comment: string | undefined;

        if (info.type === 'primary') {
            const opInfo = OPCODE_INFO[byte];
            mnemonic = opInfo ? opInfo.name : `OP_0x${byte.toString(16).padStart(2, '0')}`;

            // Read operands based on opcode
            switch (byte) {
                case Opcode.JUMP_FW:
                case Opcode.JUMP_BW:
                case Opcode.TJUMP_FW:
                case Opcode.TJUMP_BW: {
                    // uint8 offset
                    const off = bytecode[pos++];
                    bytes.push(off);
                    operands = `${off}`;
                    break;
                }
                case Opcode.JUMP_FW_W:
                case Opcode.JUMP_BW_W:
                case Opcode.TJUMP_FW_W:
                case Opcode.TJUMP_BW_W: {
                    // uint16 offset
                    const hi = bytecode[pos++]; const lo = bytecode[pos++];
                    bytes.push(hi, lo);
                    const offset = (hi << 8) | lo;
                    operands = `${offset}`;
                    break;
                }
                case Opcode.CALL: {
                    const findex = bytecode[pos++];
                    bytes.push(findex);
                    operands = `func[${findex}]`;
                    break;
                }
                case Opcode.CALL_LIB: {
                    const findex = bytecode[pos++];
                    const lindex = bytecode[pos++];
                    bytes.push(findex, lindex);
                    const libName = STDLIB_FUNCTIONS[lindex];
                    const funcName = libName?.[findex] ?? `func${findex}`;
                    const libLabel = StdLibrary[lindex] ?? `Lib${lindex}`;
                    const nargs = STDLIB_NARGS[lindex]?.[findex] ?? 0;
                    operands = `${libLabel}.${funcName}(${nargs} args)`;
                    break;
                }
                case Opcode.CALL_LIB_W: {
                    const fhi = bytecode[pos++]; const flo = bytecode[pos++];
                    const lindex = bytecode[pos++];
                    bytes.push(fhi, flo, lindex);
                    const findex = (fhi << 8) | flo;
                    const nargs = STDLIB_NARGS[lindex]?.[findex] ?? 0;
                    operands = `Lib${lindex}.func${findex}(${nargs} args)`;
                    break;
                }
                case Opcode.CALL_URL: {
                    const urlIdx = bytecode[pos++];
                    const findex = bytecode[pos++];
                    const nargs = bytecode[pos++];
                    bytes.push(urlIdx, findex, nargs);
                    const urlStr = constants[urlIdx]?.value ?? `url[${urlIdx}]`;
                    operands = `${urlStr}#func${findex}(${nargs} args)`;
                    break;
                }
                case Opcode.CALL_URL_W: {
                    const uhi = bytecode[pos++]; const ulo = bytecode[pos++];
                    const fhi = bytecode[pos++]; const flo = bytecode[pos++];
                    const nargs = bytecode[pos++];
                    bytes.push(uhi, ulo, fhi, flo, nargs);
                    const urlIndex = (uhi << 8) | ulo;
                    const findex = (fhi << 8) | flo;
                    const urlStr = constants[urlIndex]?.value ?? `url[${urlIndex}]`;
                    operands = `${urlStr}#func${findex}(${nargs} args)`;
                    break;
                }
                case Opcode.LOAD_VAR:
                case Opcode.STORE_VAR:
                case Opcode.INCR_VAR:
                case Opcode.DECR_VAR:
                case Opcode.ADD_ASG:
                case Opcode.SUB_ASG: {
                    const vindex = bytecode[pos++];
                    bytes.push(vindex);
                    operands = `var[${vindex}]`;
                    break;
                }
                case Opcode.LOAD_CONST: {
                    const cindex = bytecode[pos++];
                    bytes.push(cindex);
                    const val = constants[cindex];
                    operands = `const[${cindex}]`;
                    if (val) { comment = formatConstant(val); }
                    break;
                }
                case Opcode.LOAD_CONST_W: {
                    const chi = bytecode[pos++]; const clo = bytecode[pos++];
                    bytes.push(chi, clo);
                    const cindex = (chi << 8) | clo;
                    const val = constants[cindex];
                    operands = `const[${cindex}]`;
                    if (val) { comment = formatConstant(val); }
                    break;
                }
                // No operands for CONST_*, INCR, DECR, UMINUS
                default:
                    break;
            }
        } else {
            // Packed instruction
            mnemonic = info.packedKind!;
            const val = info.embeddedValue!;

            switch (info.packedKind) {
                case 'LOAD_CONST_S': {
                    operands = `const[${val}]`;
                    const c = constants[val];
                    if (c) { comment = formatConstant(c); }
                    break;
                }
                case 'LOAD_VAR_S':
                case 'STORE_VAR_S':
                case 'INCR_VAR_S':
                    operands = `var[${val}]`;
                    break;
                case 'CALL_S':
                    operands = `func[${val}]`;
                    break;
                case 'CALL_LIB_S': {
                    // WAP-193: func_id packed in opcode, followed by lib_id only
                    const lindex = bytecode[pos++];
                    bytes.push(lindex);
                    const libName = STDLIB_FUNCTIONS[lindex];
                    const funcName = libName?.[val] ?? `func${val}`;
                    const libLabel = StdLibrary[lindex] ?? `Lib${lindex}`;
                    const nargs = STDLIB_NARGS[lindex]?.[val] ?? 0;
                    operands = `${libLabel}.${funcName}(${nargs} args)`;
                    break;
                }
                case 'JUMP_FW_S':
                case 'JUMP_BW_S':
                case 'TJUMP_FW_S':
                    operands = `${val}`;
                    break;
            }
        }

        instructions.push({ offset: startPos, bytes, mnemonic, operands, comment });
    }

    return instructions;
}

function formatConstant(c: WmlscConstant): string {
    switch (c.type) {
        case ConstantType.INT_8:
        case ConstantType.INT_16:
        case ConstantType.INT_32:
            return `${c.value}`;
        case ConstantType.FLOAT_32:
            return `${c.value}`;
        case ConstantType.UTF8_STRING:
        case ConstantType.EXT_STRING:
            return `"${c.value}"`;
        case ConstantType.EMPTY_STRING:
            return '""';
        default:
            return String(c.value);
    }
}

/** One bytecode offset → source-text line, for instruction-level debugging. */
export interface DisasmLineMapEntry { pc: number; line: number; }

/**
 * Disassemble a module to the same text `disassembleWmlsc()` produces, and also
 * return a per-function map from each instruction's bytecode offset to its 1-based
 * line in that text. The line numbers account for the full layout (version header,
 * constant pool, pragmas and per-function headers), so a breakpoint set on an
 * instruction line resolves to the right program counter.
 */
export function disassembleWithLineMap(mod: WmlscModule): { text: string; lineMaps: DisasmLineMapEntry[][] } {
    const lines: string[] = [];
    const lineMaps: DisasmLineMapEntry[][] = [];
    const major = (mod.version >> 4) & 0x0F;
    const minor = mod.version & 0x0F;

    lines.push(`; WMLScript Bytecode v${major}.${minor}`);
    lines.push('');

    // Constants
    if (mod.constants.length > 0) {
        lines.push('; === Constant Pool ===');
        for (let i = 0; i < mod.constants.length; i++) {
            const c = mod.constants[i];
            const typeNames = ['INT8', 'INT16', 'INT32', 'FLOAT32', 'UTF8_STRING', 'EMPTY_STRING', 'EXT_STRING'];
            lines.push(`; const[${i}] ${typeNames[c.type] ?? 'UNKNOWN'} = ${formatConstant(c)}`);
        }
        lines.push('');
    }

    // Pragmas
    if (mod.pragmas.length > 0) {
        lines.push('; === Pragmas ===');
        const pragmaNames = ['AccessDomain', 'AccessPath', 'UserAgentProperty', 'UserAgentPropertyScheme'];
        for (const p of mod.pragmas) {
            const vals = p.indices.map(idx => {
                const c = mod.constants[idx];
                return c ? formatConstant(c) : `const[${idx}]`;
            });
            lines.push(`; ${pragmaNames[p.type] ?? 'Unknown'}: ${vals.join(', ')}`);
        }
        lines.push('');
    }

    // Functions
    for (let i = 0; i < mod.functions.length; i++) {
        const fn = mod.functions[i];
        const name = fn.name ?? `function_${i}`;
        const externLabel = fn.name ? 'extern ' : '';
        lines.push(`; === ${externLabel}function ${name}(${fn.numArgs} args, ${fn.numLocals} locals) ===`);

        const map: DisasmLineMapEntry[] = [];
        const instrs = disassembleBytecode(fn.bytecode, mod.constants);
        for (const instr of instrs) {
            const hexBytes = instr.bytes.map(b => b.toString(16).padStart(2, '0')).join(' ');
            const cmtStr = instr.comment ? `  ; ${instr.comment}` : '';
            const operandStr = instr.operands ? ` ${instr.operands}` : '';
            // Record before pushing: the new line's 1-based number is lines.length + 1.
            map.push({ pc: instr.offset, line: lines.length + 1 });
            lines.push(`  ${String(instr.offset).padStart(4, '0')}  ${hexBytes.padEnd(15)} ${instr.mnemonic}${operandStr}${cmtStr}`);
        }
        lineMaps.push(map);
        lines.push('');
    }

    return { text: lines.join('\n'), lineMaps };
}

function formatDisassembly(mod: WmlscModule): string {
    return disassembleWithLineMap(mod).text;
}
