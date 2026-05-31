/**
 *
 *  Copyright (C) 2026 Jabez Winston
 * 
 *  SPDX-License-Identifier: Apache-2.0
 *
 *  Date : 18-March-2026
 *  
 *  WMLScript Compiler — Compiles WMLScript AST into WMLSC bytecode
 *
 *  Translates the parsed AST into the binary bytecode format defined by
 *  the WAP-193 WMLScript specification
 */
import {
    CompilationUnit, FunctionDeclaration, Statement, Expression,
    AccessControlPragma, MetaPragma,
    VariableStatement, BlockStatement, ExpressionStatement, IfStatement,
    WhileStatement, ForStatement, ReturnStatement,
    AssignmentExpression, BinaryExpression, UnaryExpression,
    UpdateExpression, CallExpression, LibraryCallExpression,
    ExternalCallExpression, ConditionalExpression,
    TypeofExpression, IsvalidExpression, CommaExpression,
} from './ast';
import {
    Opcode, ConstantType, PragmaType,
    WMLSC_VERSION_1_1, WMLSC_CHARSET_UTF8,
    STDLIB_NAME_TO_ID, STDLIB_FUNCTIONS, STDLIB_NARGS,
    PACKED_LOAD_CONST_S_BASE, PACKED_LOAD_VAR_S_BASE,
    PACKED_STORE_VAR_S_BASE, PACKED_CALL_S_BASE,
    PACKED_CALL_LIB_S_BASE, PACKED_INCR_VAR_S_BASE,
    encodeMbUint32,
} from './opcodes';
import { Parser } from './parser';

export class CompileError extends Error {
    constructor(message: string, public line: number, public column: number) {
        super(`Compile error at line ${line}, column ${column}: ${message}`);
    }
}

interface ConstantEntry {
    type: ConstantType;
    value: number | string;
}

interface FunctionInfo {
    index: number;
    name: string;
    numArgs: number;
    isExtern: boolean;
}

// Represents an unresolved jump target
interface JumpPatch {
    instrOffset: number;    // position of the jump instruction
    targetLabel: number;
    wide: boolean;          // whether to use 16-bit or can use packed
}

interface LoopContext {
    breakPatches: JumpPatch[];
    continuePatches: JumpPatch[];
    continueTarget?: number; // known backward target for continue (while loops)
}

/** Per-function map of bytecode offset → source line, recorded at statement boundaries. */
export interface LineMapEntry { pc: number; line: number; }

class FunctionCompiler {
    private code: number[] = [];
    private variables: Map<string, number> = new Map();
    private numLocals = 0;
    private numArgs: number;
    private labels: Map<number, number> = new Map(); // label -> code offset
    private nextLabel = 0;
    private jumpPatches: JumpPatch[] = [];
    private loopStack: LoopContext[] = [];
    private parent: WmlscCompiler;
    // Debug line map: each statement boundary records {current code offset, source line}.
    private lineMap: LineMapEntry[] = [];

    constructor(parent: WmlscCompiler, params: string[]) {
        this.parent = parent;
        this.numArgs = params.length;
        // Parameters are the first variables
        for (let i = 0; i < params.length; i++) {
            this.variables.set(params[i], i);
        }
        this.numLocals = 0;
    }

    compile(body: Statement): { code: Uint8Array; numArgs: number; numLocals: number; lineMap: LineMapEntry[]; varNames: string[] } {
        this.compileStatement(body);

        // Always append RETURN_ES at end of function (WAP-193 convention)
        this.emit(Opcode.RETURN_ES);

        this.resolveJumps();

        // Variable-index → name table (params first, then locals) for the debugger.
        const varNames: string[] = [];
        for (const [name, idx] of this.variables) { varNames[idx] = name; }

        return {
            code: new Uint8Array(this.code),
            numArgs: this.numArgs,
            numLocals: this.numLocals,
            lineMap: this.lineMap,
            varNames,
        };
    }

    /** Record the source line of a statement at the current bytecode offset.
     *  `pc` equals the VM's `frame.pc` when that statement begins to execute. */
    private recordLine(line: number): void {
        const pc = this.code.length;
        const last = this.lineMap[this.lineMap.length - 1];
        if (last && last.pc === pc) { return; } // no statement emitted since last record
        this.lineMap.push({ pc, line });
    }

    // --- Variable Management ---

    private getOrDeclareVar(name: string): number {
        let idx = this.variables.get(name);
        if (idx === undefined) {
            idx = this.numArgs + this.numLocals;
            this.variables.set(name, idx);
            this.numLocals++;
        }
        return idx;
    }

    private getVar(name: string): number {
        const idx = this.variables.get(name);
        if (idx === undefined) {
            throw new CompileError(`Undefined variable: ${name}`, 0, 0);
        }
        return idx;
    }

    // --- Label Management ---

    private newLabel(): number {
        return this.nextLabel++;
    }

    private markLabel(label: number): void {
        this.labels.set(label, this.code.length);
    }

    private currentOffset(): number {
        return this.code.length;
    }

    // --- Code Emission ---

    private emit(byte: number): void {
        this.code.push(byte);
    }

    private emitUint16(value: number): void {
        this.code.push((value >> 8) & 0xFF, value & 0xFF);
    }

    private emitLoadConst(index: number): void {
        if (index < 16) {
            this.emit(PACKED_LOAD_CONST_S_BASE | index);
        } else if (index < 256) {
            this.emit(Opcode.LOAD_CONST);
            this.emit(index);
        } else {
            this.emit(Opcode.LOAD_CONST_W);
            this.emitUint16(index);
        }
    }

    private emitLoadVar(index: number): void {
        if (index < 32) {
            this.emit(PACKED_LOAD_VAR_S_BASE | index);
        } else {
            this.emit(Opcode.LOAD_VAR);
            this.emit(index);
        }
    }

    private emitStoreVar(index: number): void {
        if (index < 16) {
            this.emit(PACKED_STORE_VAR_S_BASE | index);
        } else {
            this.emit(Opcode.STORE_VAR);
            this.emit(index);
        }
    }

    private emitCall(funcIndex: number): void {
        if (funcIndex < 8) {
            this.emit(PACKED_CALL_S_BASE | funcIndex);
        } else {
            this.emit(Opcode.CALL);
            this.emit(funcIndex);
        }
    }

    private emitCallLib(libIndex: number, funcIndex: number, _nargs: number): void {
        // WAP-193: CALL_LIB_S packs func_id in opcode, followed by lib_id only (no nargs)
        if (funcIndex < 8) {
            this.emit(PACKED_CALL_LIB_S_BASE | funcIndex);
            this.emit(libIndex);
        } else {
            // CALL_LIB: opcode + func_id + lib_id (no nargs)
            this.emit(Opcode.CALL_LIB);
            this.emit(funcIndex);
            this.emit(libIndex);
        }
    }

    // Emit a forward jump, returns a patch entry
    // Always uses 3-byte wide form: opcode(1) + uint16(2)
    private emitJumpForward(conditional: boolean): JumpPatch {
        const label = this.newLabel();
        const instrOffset = this.code.length;
        if (conditional) {
            this.emit(Opcode.TJUMP_FW_W);
        } else {
            this.emit(Opcode.JUMP_FW_W);
        }
        this.emitUint16(0); // placeholder offset
        const patch: JumpPatch = { instrOffset, targetLabel: label, wide: true };
        this.jumpPatches.push(patch);
        return patch;
    }

    private emitJumpBackward(targetOffset: number, conditional: boolean): void {
        // WAP-193: backward offset = current_position - target (from instruction START)
        const here = this.code.length;
        const delta = here - targetOffset;
        if (conditional) {
            this.emit(Opcode.TJUMP_BW_W);
        } else {
            this.emit(Opcode.JUMP_BW_W);
        }
        this.emitUint16(delta);
    }

    private resolveJumps(): void {
        for (const patch of this.jumpPatches) {
            const target = this.labels.get(patch.targetLabel);
            if (target === undefined) {
                throw new CompileError(`Unresolved label: ${patch.targetLabel}`, 0, 0);
            }
            // WAP-193: forward offset = target - (instrOffset + 3), i.e. from END of instruction
            const fromOffset = patch.instrOffset + 3;
            const delta = target - fromOffset;
            if (delta < 0) {
                throw new CompileError(`Forward jump resolved to negative offset`, 0, 0);
            }
            // Patch the uint16 offset
            this.code[patch.instrOffset + 1] = (delta >> 8) & 0xFF;
            this.code[patch.instrOffset + 2] = delta & 0xFF;
        }
    }

    // --- Statement Compilation ---

    private compileStatement(stmt: Statement): void {
        // Record a debug line entry for every line-bearing statement. Block/Empty
        // produce no instructions of their own, so they are not breakpoint targets.
        if (stmt.type !== 'BlockStatement' && stmt.type !== 'EmptyStatement') {
            this.recordLine(stmt.loc.line);
        }
        switch (stmt.type) {
            case 'BlockStatement':
                for (const s of stmt.body) {
                    this.compileStatement(s);
                }
                break;
            case 'VariableStatement':
                this.compileVariableStatement(stmt);
                break;
            case 'ExpressionStatement':
                this.compileExpression(stmt.expression);
                this.emit(Opcode.POP);
                break;
            case 'IfStatement':
                this.compileIfStatement(stmt);
                break;
            case 'WhileStatement':
                this.compileWhileStatement(stmt);
                break;
            case 'ForStatement':
                this.compileForStatement(stmt);
                break;
            case 'ReturnStatement':
                this.compileReturnStatement(stmt);
                break;
            case 'BreakStatement': {
                if (this.loopStack.length === 0) {
                    throw new CompileError('break outside of loop', stmt.loc.line, stmt.loc.column);
                }
                const loop = this.loopStack[this.loopStack.length - 1];
                const patch = this.emitJumpForward(false);
                loop.breakPatches.push(patch);
                break;
            }
            case 'ContinueStatement': {
                if (this.loopStack.length === 0) {
                    throw new CompileError('continue outside of loop', stmt.loc.line, stmt.loc.column);
                }
                const loop = this.loopStack[this.loopStack.length - 1];
                if (loop.continueTarget !== undefined) {
                    // While loop: jump backward directly to condition
                    this.emitJumpBackward(loop.continueTarget, false);
                } else {
                    // For loop: forward jump, patched later to update expr
                    const patch = this.emitJumpForward(false);
                    loop.continuePatches.push(patch);
                }
                break;
            }
            case 'EmptyStatement':
                break;
        }
    }

    private compileVariableStatement(stmt: VariableStatement): void {
        for (const decl of stmt.declarations) {
            const idx = this.getOrDeclareVar(decl.name);
            if (decl.init) {
                this.compileExpression(decl.init);
                this.emitStoreVar(idx);
            } else {
                // C compiler always initializes uninitialized vars to empty string
                this.emit(Opcode.CONST_ES);
                this.emitStoreVar(idx);
            }
        }
    }

    private compileIfStatement(stmt: IfStatement): void {
        this.compileExpression(stmt.test);
        // TJUMP = jump if false in WAP-193 (no NOT needed)
        const elseJump = this.emitJumpForward(true);

        this.compileStatement(stmt.consequent);

        if (stmt.alternate) {
            const endJump = this.emitJumpForward(false);
            this.markLabel(elseJump.targetLabel);
            this.compileStatement(stmt.alternate);
            this.markLabel(endJump.targetLabel);
        } else {
            this.markLabel(elseJump.targetLabel);
        }
    }

    private compileWhileStatement(stmt: WhileStatement): void {
        const loop: LoopContext = { breakPatches: [], continuePatches: [], continueTarget: undefined };
        this.loopStack.push(loop);

        const testOffset = this.currentOffset();
        loop.continueTarget = testOffset; // continue jumps backward to condition
        this.compileExpression(stmt.test);
        const exitJump = this.emitJumpForward(true);

        this.compileStatement(stmt.body);

        this.emitJumpBackward(testOffset, false);

        // Break target
        this.markLabel(exitJump.targetLabel);

        // Resolve break patches
        const breakOffset = this.currentOffset();
        for (const p of loop.breakPatches) {
            this.labels.set(p.targetLabel, breakOffset);
        }

        this.loopStack.pop();
    }

    private compileForStatement(stmt: ForStatement): void {
        const loop: LoopContext = { breakPatches: [], continuePatches: [] };
        this.loopStack.push(loop);

        // Init
        if (stmt.init) {
            if (stmt.init.type === 'VariableStatement') {
                this.compileVariableStatement(stmt.init);
            } else {
                this.compileExpression(stmt.init);
                this.emit(Opcode.POP);
            }
        }

        const testOffset = this.currentOffset();

        // Test
        if (stmt.test) {
            this.compileExpression(stmt.test);
            const exitJump = this.emitJumpForward(true);
            loop.breakPatches.push(exitJump); // will point to end
        }

        // Body
        this.compileStatement(stmt.body);

        // Continue target (update expression)
        const updateOffset = this.currentOffset();
        if (stmt.update) {
            this.compileExpression(stmt.update);
            this.emit(Opcode.POP);
        }

        this.emitJumpBackward(testOffset, false);

        // Resolve patches
        const endOffset = this.currentOffset();
        for (const p of loop.breakPatches) {
            this.labels.set(p.targetLabel, endOffset);
        }
        for (const p of loop.continuePatches) {
            this.labels.set(p.targetLabel, updateOffset);
        }

        this.loopStack.pop();
    }

    private compileReturnStatement(stmt: ReturnStatement): void {
        if (stmt.argument) {
            this.compileExpression(stmt.argument);
            this.emit(Opcode.RETURN);
        } else {
            this.emit(Opcode.RETURN_ES);
        }
    }

    // --- Expression Compilation ---

    private compileExpression(expr: Expression): void {
        switch (expr.type) {
            case 'IntegerLiteral':
                this.compileIntegerLiteral(expr.value);
                break;
            case 'FloatLiteral': {
                const idx = this.parent.addConstant(ConstantType.FLOAT_32, expr.value);
                this.emitLoadConst(idx);
                break;
            }
            case 'StringLiteral': {
                if (expr.value === '') {
                    this.emit(Opcode.CONST_ES);
                } else {
                    const idx = this.parent.addConstant(ConstantType.UTF8_STRING, expr.value);
                    this.emitLoadConst(idx);
                }
                break;
            }
            case 'BooleanLiteral':
                this.emit(expr.value ? Opcode.CONST_TRUE : Opcode.CONST_FALSE);
                break;
            case 'InvalidLiteral':
                this.emit(Opcode.CONST_INVALID);
                break;
            case 'IdentifierExpression': {
                const idx = this.getVar(expr.name);
                this.emitLoadVar(idx);
                break;
            }
            case 'AssignmentExpression':
                this.compileAssignment(expr);
                break;
            case 'BinaryExpression':
                this.compileBinaryExpression(expr);
                break;
            case 'UnaryExpression':
                this.compileUnaryExpression(expr);
                break;
            case 'TypeofExpression':
                this.compileExpression(expr.operand);
                this.emit(Opcode.TYPEOF);
                break;
            case 'IsvalidExpression':
                this.compileExpression(expr.operand);
                this.emit(Opcode.ISVALID);
                break;
            case 'UpdateExpression':
                this.compileUpdateExpression(expr);
                break;
            case 'CallExpression':
                this.compileCallExpression(expr);
                break;
            case 'LibraryCallExpression':
                this.compileLibraryCall(expr);
                break;
            case 'ExternalCallExpression':
                this.compileExternalCall(expr);
                break;
            case 'ConditionalExpression':
                this.compileConditional(expr);
                break;
            case 'CommaExpression':
                this.compileComma(expr);
                break;
            default:
                throw new CompileError(`Unknown expression type: ${(expr as Expression).type}`, 0, 0);
        }
    }

    private compileIntegerLiteral(value: number): void {
        if (value === 0) { this.emit(Opcode.CONST_0); }
        else if (value === 1) { this.emit(Opcode.CONST_1); }
        else if (value === -1) { this.emit(Opcode.CONST_M1); }
        else if (value >= -128 && value <= 127) {
            const idx = this.parent.addConstant(ConstantType.INT_8, value);
            this.emitLoadConst(idx);
        } else if (value >= -32768 && value <= 32767) {
            const idx = this.parent.addConstant(ConstantType.INT_16, value);
            this.emitLoadConst(idx);
        } else {
            const idx = this.parent.addConstant(ConstantType.INT_32, value);
            this.emitLoadConst(idx);
        }
    }

    private compileAssignment(expr: AssignmentExpression): void {
        const varIdx = this.getVar(expr.left.name);

        if (expr.operator === '=') {
            this.compileExpression(expr.right);
            this.emitStoreVar(varIdx);
            this.emitLoadVar(varIdx);
            return;
        }

        // All compound assignments decompose to: LOAD_VAR + expr + OP + DEBUG + STORE_VAR
        this.emitLoadVar(varIdx);
        this.compileExpression(expr.right);

        const opMap: Record<string, Opcode> = {
            '+=':   Opcode.ADD,
            '-=':   Opcode.SUB,
            '*=':   Opcode.MUL,
            '/=':   Opcode.DIV,
            'div=': Opcode.IDIV,
            '%=':   Opcode.REM,
            '&=':   Opcode.B_AND,
            '|=':   Opcode.B_OR,
            '^=':   Opcode.B_XOR,
            '<<=':  Opcode.B_LSHIFT,
            '>>=':  Opcode.B_RSSHIFT,
            '>>>=': Opcode.B_RSZSHIFT,
        };
        this.emit(opMap[expr.operator]);
        this.emitStoreVar(varIdx);
        this.emitLoadVar(varIdx);
    }

    private compileBinaryExpression(expr: BinaryExpression): void {
        // Short-circuit operators need special handling
        // SCAND/SCOR pop TOS, then push result+signal for TJUMP.
        // No POP between SCAND/SCOR and right operand (C compiler convention).
        if (expr.operator === '&&') {
            this.compileExpression(expr.left);
            this.emit(Opcode.SCAND);
            const skipRight = this.emitJumpForward(true);
            this.compileExpression(expr.right);
            this.markLabel(skipRight.targetLabel);
            return;
        }
        if (expr.operator === '||') {
            this.compileExpression(expr.left);
            this.emit(Opcode.SCOR);
            const skipRight = this.emitJumpForward(true);
            this.compileExpression(expr.right);
            this.markLabel(skipRight.targetLabel);
            return;
        }

        this.compileExpression(expr.left);
        this.compileExpression(expr.right);

        const opMap2: Record<string, Opcode> = {
            '+':   Opcode.ADD,
            '-':   Opcode.SUB,
            '*':   Opcode.MUL,
            '/':   Opcode.DIV,
            'div': Opcode.IDIV,
            '%':   Opcode.REM,
            '&':   Opcode.B_AND,
            '|':   Opcode.B_OR,
            '^':   Opcode.B_XOR,
            '<<':  Opcode.B_LSHIFT,
            '>>':  Opcode.B_RSSHIFT,
            '>>>': Opcode.B_RSZSHIFT,
            '==':  Opcode.EQ,
            '!=':  Opcode.NE,
            '<':   Opcode.LT,
            '<=':  Opcode.LE,
            '>':   Opcode.GT,
            '>=':  Opcode.GE,
        };

        const op = opMap2[expr.operator];
        if (op !== undefined) {
            this.emit(op);
        } else {
            throw new CompileError(`Unknown binary operator: ${expr.operator}`, expr.loc.line, expr.loc.column);
        }
    }

    private compileUnaryExpression(expr: UnaryExpression): void {
        this.compileExpression(expr.operand);
        switch (expr.operator) {
            case '-': this.emit(Opcode.UMINUS); break;
            case '+': break; // no-op
            case '~': this.emit(Opcode.B_NOT); break;
            case '!': this.emit(Opcode.NOT); break;
        }
    }

    private compileUpdateExpression(expr: UpdateExpression): void {
        const varIdx = this.getVar(expr.argument.name);

        if (expr.prefix) {
            // ++x or --x: modify then push new value
            if (expr.operator === '++') {
                if (varIdx < 8) {
                    this.emit(PACKED_INCR_VAR_S_BASE | varIdx);
                } else {
                    this.emit(Opcode.INCR_VAR);
                    this.emit(varIdx);
                }
            } else {
                this.emit(Opcode.DECR_VAR);
                this.emit(varIdx);
            }
            this.emitLoadVar(varIdx);
        } else {
            // x++ or x--: push old value, then modify
            this.emitLoadVar(varIdx);
            if (expr.operator === '++') {
                if (varIdx < 8) {
                    this.emit(PACKED_INCR_VAR_S_BASE | varIdx);
                } else {
                    this.emit(Opcode.INCR_VAR);
                    this.emit(varIdx);
                }
            } else {
                this.emit(Opcode.DECR_VAR);
                this.emit(varIdx);
            }
        }
    }

    private compileCallExpression(expr: CallExpression): void {
        // Push arguments
        for (const arg of expr.arguments) {
            this.compileExpression(arg);
        }
        const funcIdx = this.parent.getFunctionIndex(expr.callee);
        this.emitCall(funcIdx);
    }

    private compileLibraryCall(expr: LibraryCallExpression): void {
        // Push arguments
        for (const arg of expr.arguments) {
            this.compileExpression(arg);
        }

        const libId = STDLIB_NAME_TO_ID[expr.library];
        if (libId === undefined) {
            throw new CompileError(`Unknown library: ${expr.library}`, expr.loc.line, expr.loc.column);
        }

        const funcs = STDLIB_FUNCTIONS[libId];
        let funcIdx = funcs?.indexOf(expr.method) ?? -1;
        if (funcIdx === -1 && funcs) {
            // Case-insensitive fallback (e.g. substring vs subString)
            const lower = expr.method.toLowerCase();
            funcIdx = funcs.findIndex(f => f.toLowerCase() === lower);
        }
        if (funcIdx === -1) {
            throw new CompileError(`Unknown function: ${expr.library}.${expr.method}`, expr.loc.line, expr.loc.column);
        }

        const nargs = STDLIB_NARGS[libId]?.[funcIdx] ?? expr.arguments.length;
        this.emitCallLib(libId, funcIdx, nargs);
    }

    private compileExternalCall(expr: ExternalCallExpression): void {
        // Push arguments
        for (const arg of expr.arguments) {
            this.compileExpression(arg);
        }

        const funcNameIndex = this.parent.addConstant(ConstantType.UTF8_STRING, expr.functionName);
        const urlIndex = this.parent.getExternalUrlIndex(expr.scriptAlias);

        // WAP-193 §10.5.2.6: CALL_URL urlIndex funcIndex numArgs (all uint8)
        this.emit(Opcode.CALL_URL);
        this.emit(urlIndex & 0xFF);
        this.emit(funcNameIndex & 0xFF);
        this.emit(expr.arguments.length);
    }

    private compileConditional(expr: ConditionalExpression): void {
        this.compileExpression(expr.test);
        // TJUMP = jump if false in WAP-193 (no NOT needed)
        const elseJump = this.emitJumpForward(true);
        this.compileExpression(expr.consequent);
        const endJump = this.emitJumpForward(false);
        this.markLabel(elseJump.targetLabel);
        this.compileExpression(expr.alternate);
        this.markLabel(endJump.targetLabel);
    }

    private compileComma(expr: CommaExpression): void {
        for (let i = 0; i < expr.expressions.length; i++) {
            this.compileExpression(expr.expressions[i]);
            if (i < expr.expressions.length - 1) {
                this.emit(Opcode.POP);
            }
        }
    }
}

// === Main Compiler ===

export class WmlscCompiler {
    private constants: ConstantEntry[] = [];
    private constantMap = new Map<string, number>();
    private functionMap = new Map<string, number>();
    private externFunctions: string[] = [];
    private externalUrls = new Map<string, number>(); // alias -> constant index
    private pragmaEntries: number[][] = []; // pre-built pragma pool entries
    // Per-function debug info from the most recent compileModule() call.
    private lineMaps: LineMapEntry[][] = [];
    private varNames: string[][] = [];

    compile(source: string): Buffer {
        const parser = new Parser();
        const ast = parser.parse(source);
        const errors = parser.getErrors();
        if (errors.length > 0) {
            throw errors[0];
        }
        return this.compileModule(ast);
    }

    /** Compile source and also return the per-function debug info (PC↔line maps and
     *  variable-name tables) used for source-level debugging. Bytecode is identical
     *  to compile(). */
    compileWithDebugInfo(source: string): { bytecode: Buffer; lineMaps: LineMapEntry[][]; varNames: string[][] } {
        const bytecode = this.compile(source);
        return { bytecode, lineMaps: this.lineMaps, varNames: this.varNames };
    }

    compileModule(ast: CompilationUnit): Buffer {
        // Register external URLs in the constant pool
        for (const ext of ast.externalDeclarations) {
            const idx = this.addConstant(ConstantType.UTF8_STRING, ext.url);
            this.externalUrls.set(ext.alias, idx);
        }

        // Register pragma constants BEFORE compiling functions (so they're in the constant pool)
        this.buildPragmaEntries(ast);

        // First pass: register all function names and indices
        for (let i = 0; i < ast.functions.length; i++) {
            const fn = ast.functions[i];
            this.functionMap.set(fn.name, i);
            if (fn.isExtern) {
                this.externFunctions.push(fn.name);
            }
        }

        // Second pass: compile each function
        const compiledFunctions: { code: Uint8Array; numArgs: number; numLocals: number; lineMap: LineMapEntry[]; varNames: string[] }[] = [];
        for (const fn of ast.functions) {
            const fc = new FunctionCompiler(this, fn.params);
            compiledFunctions.push(fc.compile(fn.body));
        }
        // Expose per-function debug info for compileWithDebugInfo().
        this.lineMaps = compiledFunctions.map(f => f.lineMap);
        this.varNames = compiledFunctions.map(f => f.varNames);

        // Encode the bytecode module
        return this.encodeBytecodeModule(ast, compiledFunctions);
    }

    // Public API for FunctionCompiler to add constants
    addConstant(type: ConstantType, value: number | string): number {
        const key = `${type}:${value}`;
        const existing = this.constantMap.get(key);
        if (existing !== undefined) { return existing; }
        const idx = this.constants.length;
        this.constants.push({ type, value });
        this.constantMap.set(key, idx);
        return idx;
    }

    getFunctionIndex(name: string): number {
        const idx = this.functionMap.get(name);
        if (idx === undefined) {
            throw new CompileError(`Unknown function: ${name}`, 0, 0);
        }
        return idx;
    }

    getExternalUrlIndex(alias: string): number {
        const idx = this.externalUrls.get(alias);
        if (idx === undefined) {
            throw new CompileError(`Unknown external script alias: ${alias}`, 0, 0);
        }
        return idx;
    }

    // Pre-build pragma pool entries, registering all needed constants
    private buildPragmaEntries(ast: CompilationUnit): void {
        // Access control pragmas (§9.5.1.1)
        if (ast.accessControl) {
            if (ast.accessControl.domain !== undefined) {
                const domIdx = this.addConstant(ConstantType.UTF8_STRING, ast.accessControl.domain);
                this.pragmaEntries.push([PragmaType.ACCESS_DOMAIN, ...encodeMbUint32(domIdx)]);
            }
            if (ast.accessControl.path !== undefined) {
                const pathIdx = this.addConstant(ConstantType.UTF8_STRING, ast.accessControl.path);
                this.pragmaEntries.push([PragmaType.ACCESS_PATH, ...encodeMbUint32(pathIdx)]);
            }
        }
        // Meta-information pragmas (§9.5.1.2)
        for (const meta of ast.metaPragmas) {
            const nameIdx = this.addConstant(ConstantType.UTF8_STRING, meta.propertyName);
            const contentIdx = this.addConstant(ConstantType.UTF8_STRING, meta.content);
            if (meta.scheme !== undefined) {
                const schemeIdx = this.addConstant(ConstantType.UTF8_STRING, meta.scheme);
                this.pragmaEntries.push([PragmaType.USER_AGENT_PROPERTY_SCH,
                    ...encodeMbUint32(nameIdx), ...encodeMbUint32(contentIdx), ...encodeMbUint32(schemeIdx)]);
            } else {
                this.pragmaEntries.push([PragmaType.USER_AGENT_PROPERTY,
                    ...encodeMbUint32(nameIdx), ...encodeMbUint32(contentIdx)]);
            }
        }
    }

    private encodeBytecodeModule(
        ast: CompilationUnit,
        functions: { code: Uint8Array; numArgs: number; numLocals: number }[]
    ): Buffer {
        const output: number[] = [];

        // Version (WAP-193 v1.1)
        output.push(WMLSC_VERSION_1_1);

        // We'll build the rest first, then prepend CodeSize
        const body: number[] = [];

        // Constant Pool
        body.push(...encodeMbUint32(this.constants.length));
        // CharSet field (UTF-8 = 0x6A)
        body.push(...encodeMbUint32(WMLSC_CHARSET_UTF8));
        for (const c of this.constants) {
            body.push(c.type);
            switch (c.type) {
                case ConstantType.INT_8:
                    body.push(c.value as number & 0xFF);
                    break;
                case ConstantType.INT_16: {
                    const v = c.value as number;
                    body.push((v >> 8) & 0xFF, v & 0xFF);
                    break;
                }
                case ConstantType.INT_32: {
                    const v = c.value as number;
                    body.push((v >> 24) & 0xFF, (v >> 16) & 0xFF, (v >> 8) & 0xFF, v & 0xFF);
                    break;
                }
                case ConstantType.FLOAT_32: {
                    const buf = Buffer.alloc(4);
                    buf.writeFloatBE(c.value as number);
                    body.push(...buf);
                    break;
                }
                case ConstantType.UTF8_STRING: {
                    const strBytes = Buffer.from(c.value as string, 'utf-8');
                    body.push(...encodeMbUint32(strBytes.length));
                    body.push(...strBytes);
                    break;
                }
                case ConstantType.EMPTY_STRING:
                    // No value bytes
                    break;
            }
        }

        // Pragma Pool (WAP-193 §9.5) — entries pre-built by buildPragmaEntries()
        body.push(...encodeMbUint32(this.pragmaEntries.length));
        for (const entry of this.pragmaEntries) {
            body.push(...entry);
        }

        // Function Pool
        body.push(functions.length); // NumberOfFunctions

        // Function Name Table (only extern functions have names)
        const externNames = ast.functions.filter(f => f.isExtern);
        body.push(externNames.length);
        for (const fn of externNames) {
            const idx = this.functionMap.get(fn.name)!;
            const nameBytes = Buffer.from(fn.name, 'utf-8');
            body.push(idx);
            body.push(nameBytes.length);
            body.push(...nameBytes);
        }

        // Function bodies
        for (const fn of functions) {
            body.push(fn.numArgs);
            body.push(fn.numLocals);
            body.push(...encodeMbUint32(fn.code.length));
            body.push(...fn.code);
        }

        // CodeSize
        output.push(...encodeMbUint32(body.length));
        output.push(...body);

        return Buffer.from(output);
    }
}

// Convenience function
export function compileWmls(source: string): Buffer {
    const compiler = new WmlscCompiler();
    return compiler.compile(source);
}

// Convenience function — compile and also return per-function debug info (line maps + var names).
export function compileWmlsWithDebugInfo(source: string): { bytecode: Buffer; lineMaps: LineMapEntry[][]; varNames: string[][] } {
    const compiler = new WmlscCompiler();
    return compiler.compileWithDebugInfo(source);
}
