/**
 *
 *  Copyright (C) 2026 Jabez Winston
 * 
 *  SPDX-License-Identifier: Apache-2.0
 *
 *  Date : 18-March-2026
 * 
 *  WMLScript Virtual Machine — Executes WMLSC bytecode
 *
 *  A stack-based interpreter that executes the bytecode instruction set
 *  defined in the WAP-193-WMLScript specification.
 */
import {
    Opcode, WmlsType,
    classifyOpcode, decodeMbUint32,
    STDLIB_NARGS,
} from './opcodes';
import {
    WmlscModule, WmlscFunction, WmlscConstant,
    decodeWmlsc, verifyModule,
} from './decoder';
import {
    WmlsValue, mkInt, mkFloat, mkString, mkBool, mkInvalid,
    toNumber, toInteger, toFloat, toBool, toString as wmlsToString,
    getStdLibFunctions, LibraryContext, createDefaultContext,
    DialogSuspend, DialogRequest,
} from './stdlib';
import { ConstantType } from './opcodes';

export interface VMOptions {
    maxSteps?: number;          // max instructions to prevent infinite loops
    context?: LibraryContext;
    verify?: boolean;           // run the bytecode integrity check before executing (default true)
}

/**
 * Fatal run-time error classification per WAP-193 §12.3. A fatal error aborts the
 * program and is signalled to the caller (set on VMResult.error + .errorKind),
 * whereas non-fatal errors (§12.4 — divide-by-zero, overflow, conversion) instead
 * yield `invalid` (FP underflow → 0.0) and let the program continue.
 */
export enum WmlsErrorKind {
    VerificationFailed = 'verification-failed',       // §12.3.1.1
    InvalidFunctionArguments = 'invalid-arguments',   // §12.3.1.3
    ExternalFunctionNotFound = 'external-not-found',  // §12.3.1.4 (and the local entry-point not found)
    StackUnderflow = 'stack-underflow',               // §12.3.1.7
    ProgrammedAbort = 'programmed-abort',             // §12.3.2.1 — Lang.abort()
    ExecutionLimit = 'execution-limit',               // implementation guard (outside §12)
    InternalError = 'internal-error',
}

/** Map a thrown VM Error message to its §12.3 fatal classification. */
function classifyVmError(message: string): WmlsErrorKind {
    if (/stack underflow/i.test(message)) { return WmlsErrorKind.StackUnderflow; }
    if (/execution limit/i.test(message)) { return WmlsErrorKind.ExecutionLimit; }
    if (/invalid function index/i.test(message)) { return WmlsErrorKind.InvalidFunctionArguments; }
    return WmlsErrorKind.InternalError;
}

export interface VMResult {
    value: WmlsValue;
    output: string[];
    steps: number;
    error?: string;
    errorKind?: WmlsErrorKind;   // §12.3 classification when `error` is set (fatal)
}

// Debug event callback
export interface DebugHook {
    onInstruction?(funcIndex: number, pc: number, opcode: number): boolean; // return false to pause
    onBreakpoint?(funcIndex: number, pc: number): void;
}

/**
 * Resolver invoked by the async VM (callFunctionAsync) to fulfil an interactive
 * Dialogs.* call: given the request it returns (or resolves to) the user's
 * response — a string for prompt, a boolean for confirm, ignored for alert.
 */
export type DialogResolver =
    (req: DialogRequest) => Promise<string | boolean | null | undefined> | string | boolean | null | undefined;

/** Coerce an onDialog response into the WMLScript value the Dialogs.* call yields. */
function coerceDialogResult(req: DialogRequest, resp: string | boolean | null | undefined): WmlsValue {
    if (req.type === 'confirm') { return mkBool(resp === true || resp === 'true'); }
    if (req.type === 'alert') { return mkString(''); }
    // prompt: OK → entered string; Cancel (null/undefined) → the supplied default.
    if (resp === null || resp === undefined) { return mkString(req.def ?? ''); }
    return mkString(String(resp));
}

interface CallFrame {
    funcIndex: number;
    fn: WmlscFunction;
    pc: number;
    variables: WmlsValue[];
    returnAddress: { funcIndex: number; pc: number } | null;
}

export class WmlsVM {
    private mod: WmlscModule;
    private stack: WmlsValue[] = [];
    private callStack: CallFrame[] = [];
    private ctx: LibraryContext;
    private stdlibs: Map<number, ((args: WmlsValue[]) => WmlsValue)[]>;
    private output: string[] = [];
    private maxSteps: number;
    private steps = 0;
    private debugHook?: DebugHook;
    private verifyErrors: string[] = [];

    constructor(mod: WmlscModule, options?: VMOptions) {
        this.mod = mod;
        this.maxSteps = options?.maxSteps ?? 1000000;
        this.ctx = options?.context ?? createDefaultContext();
        this.ctx.onOutput = (text: string) => this.output.push(text);
        this.stdlibs = getStdLibFunctions(this.ctx);
        // WMLS-C-107: integrity check before any execution.
        this.verifyErrors = options?.verify === false ? [] : verifyModule(mod);
    }

    /** Bytecode-verification problems found at construction ([] ⇒ verified). */
    getVerifyErrors(): string[] {
        return this.verifyErrors;
    }

    setDebugHook(hook: DebugHook): void {
        this.debugHook = hook;
    }

    // Execute a named extern function
    callFunction(name: string, args: WmlsValue[]): VMResult {
        const funcIndex = this.mod.functions.findIndex(f => f.name === name);
        if (funcIndex === -1) {
            return { value: mkInvalid(), output: this.output, steps: 0, error: `Function not found: ${name}`, errorKind: WmlsErrorKind.ExternalFunctionNotFound };
        }
        return this.callFunctionByIndex(funcIndex, args);
    }

    callFunctionByIndex(funcIndex: number, args: WmlsValue[]): VMResult {
        if (this.verifyErrors.length > 0) {
            return { value: mkInvalid(), output: this.output, steps: 0, error: `Verification failed: ${this.verifyErrors[0]}`, errorKind: WmlsErrorKind.VerificationFailed };
        }
        const fn = this.mod.functions[funcIndex];
        if (!fn) {
            return { value: mkInvalid(), output: this.output, steps: 0, error: `Invalid function index: ${funcIndex}`, errorKind: WmlsErrorKind.InvalidFunctionArguments };
        }

        // Set up initial call frame
        const variables: WmlsValue[] = new Array(fn.numArgs + fn.numLocals);
        for (let i = 0; i < fn.numArgs; i++) {
            variables[i] = args[i] ?? mkString('');
        }
        for (let i = fn.numArgs; i < variables.length; i++) {
            variables[i] = mkString('');
        }

        this.callStack = [{ funcIndex, fn, pc: 0, variables, returnAddress: null }];
        this.stack = [];
        this.steps = 0;

        try {
            const value = this.run();
            return this.finishResult(value);
        } catch (err: any) {
            return { value: mkInvalid(), output: this.output, steps: this.steps, error: err.message, errorKind: classifyVmError(err.message) };
        }
    }

    /**
     * Build the VMResult after a normal run, distinguishing Lang.exit() (a clean
     * termination that returns its value) from Lang.abort() — a §12.3.2.1 fatal
     * Programmed Abort that must be signalled to the caller as an error.
     */
    private finishResult(value: WmlsValue): VMResult {
        if (this.ctx.aborted) {
            const reason = this.ctx.exitResult ? wmlsToString(this.ctx.exitResult) : '';
            return {
                value: mkInvalid(), output: this.output, steps: this.steps,
                error: `Programmed abort${reason ? ': ' + reason : ''}`,
                errorKind: WmlsErrorKind.ProgrammedAbort,
            };
        }
        return { value, output: this.output, steps: this.steps };
    }

    /**
     * Execute a named extern function with support for interactive Dialogs.
     * Identical to callFunction, except that when a Dialogs.* call suspends the
     * VM (ctx.interactiveDialogs must be set), `onDialog` is awaited to obtain
     * the user's response, which is then fed back as the call's result before
     * execution resumes. Without interactiveDialogs this behaves like a normal
     * run (no suspension), so it is always safe to use.
     */
    async callFunctionAsync(name: string, args: WmlsValue[], onDialog: DialogResolver): Promise<VMResult> {
        const funcIndex = this.mod.functions.findIndex(f => f.name === name);
        if (funcIndex === -1) {
            return { value: mkInvalid(), output: this.output, steps: 0, error: `Function not found: ${name}`, errorKind: WmlsErrorKind.ExternalFunctionNotFound };
        }
        if (this.verifyErrors.length > 0) {
            return { value: mkInvalid(), output: this.output, steps: 0, error: `Verification failed: ${this.verifyErrors[0]}`, errorKind: WmlsErrorKind.VerificationFailed };
        }
        if (!this.prepareCall(funcIndex, args)) {
            return { value: mkInvalid(), output: this.output, steps: 0, error: `Invalid function index: ${funcIndex}`, errorKind: WmlsErrorKind.InvalidFunctionArguments };
        }
        try {
            const value = await this.runAsync(onDialog);
            return this.finishResult(value);
        } catch (err: any) {
            return { value: mkInvalid(), output: this.output, steps: this.steps, error: err.message, errorKind: classifyVmError(err.message) };
        }
    }

    /**
     * Drain stepOnce() like run(), but when a Dialogs.* call throws DialogSuspend
     * the args are already popped and pc is past the CALL_LIB (see doCallLib): we
     * await the user's response, push the coerced result, and resume stepping.
     */
    private async runAsync(onDialog: DialogResolver): Promise<WmlsValue> {
        for (;;) {
            try {
                const r = this.stepOnce();
                if (r.done) { return r.value ?? mkString(''); }
            } catch (e) {
                if (e instanceof DialogSuspend) {
                    const resp = await onDialog(e.request);
                    this.push(coerceDialogResult(e.request, resp));
                    continue;
                }
                throw e;
            }
        }
    }

    // Execute from bytecode buffer
    static executeFromBytecode(data: Buffer, functionName: string, args: WmlsValue[], options?: VMOptions): VMResult {
        const mod = decodeWmlsc(data);
        const vm = new WmlsVM(mod, options);
        return vm.callFunction(functionName, args);
    }

    private run(): WmlsValue {
        for (;;) {
            const r = this.stepOnce();
            if (r.done) { return r.value ?? mkString(''); }
        }
    }

    /**
     * Execute exactly one VM instruction (or one bookkeeping transition such as a
     * frame pop), operating purely on instance state (`callStack`/`stack`/`steps`/
     * `frame.pc`). Returns `{ done: true, value }` when execution has finished.
     *
     * This is the resumable primitive that the source-level debugger drives: it can
     * inspect `getCurrentLocation()` between steps and stop at a breakpoint without
     * blocking the event loop. `run()` simply drains it, so non-debug execution is
     * byte-for-byte identical to the previous single-loop implementation.
     */
    stepOnce(): { done: boolean; value?: WmlsValue } {
        if (this.callStack.length === 0) {
            return { done: true, value: this.stack.length > 0 ? this.pop() : mkString('') };
        }

        if (this.steps++ > this.maxSteps) {
            throw new Error(`Execution limit exceeded (${this.maxSteps} steps)`);
        }

        if (this.ctx.aborted) {
            return { done: true, value: this.ctx.exitResult ?? mkInvalid() };
        }

        if (this.ctx.exitResult !== undefined && !this.ctx.aborted) {
            return { done: true, value: this.ctx.exitResult };
        }

        const frame = this.callStack[this.callStack.length - 1];
        const bytecode = frame.fn.bytecode;

        if (frame.pc >= bytecode.length) {
            // Implicit return empty string
            this.callStack.pop();
            if (this.callStack.length === 0) {
                return { done: true, value: mkString('') };
            }
            this.push(mkString(''));
            return { done: false };
        }

        const byte = bytecode[frame.pc++];
        const info = classifyOpcode(byte);

        if (info.type === 'primary') {
            this.executePrimary(byte, frame);
        } else {
            this.executePacked(byte, info.packedKind!, info.embeddedValue!, frame);
        }
        return { done: false };
    }

    /** Set up a call frame for `funcIndex` with `args` without executing — lets a
     *  debugger drive execution via stepOnce(). Returns false if the index is invalid. */
    prepareCall(funcIndex: number, args: WmlsValue[]): boolean {
        if (this.verifyErrors.length > 0) { return false; }
        const fn = this.mod.functions[funcIndex];
        if (!fn) { return false; }
        const variables: WmlsValue[] = new Array(fn.numArgs + fn.numLocals);
        for (let i = 0; i < fn.numArgs; i++) {
            variables[i] = args[i] ?? mkString('');
        }
        for (let i = fn.numArgs; i < variables.length; i++) {
            variables[i] = mkString('');
        }
        this.callStack = [{ funcIndex, fn, pc: 0, variables, returnAddress: null }];
        this.stack = [];
        this.steps = 0;
        return true;
    }

    /** Current top-frame location (function index + program counter), or null when idle. */
    getCurrentLocation(): { funcIndex: number; pc: number } | null {
        const frame = this.callStack[this.callStack.length - 1];
        return frame ? { funcIndex: frame.funcIndex, pc: frame.pc } : null;
    }

    /** Output accumulated so far (Console.print, etc.). */
    getOutput(): string[] { return this.output; }

    /** Find a function index by its (extern) name, or -1. */
    findFunction(name: string): number {
        return this.mod.functions.findIndex(f => f.name === name);
    }

    // --- Stack Operations ---

    private push(val: WmlsValue): void { this.stack.push(val); }

    private pop(): WmlsValue {
        if (this.stack.length === 0) { throw new Error('Stack underflow'); }
        return this.stack.pop()!;
    }

    private peek(): WmlsValue {
        if (this.stack.length === 0) { throw new Error('Stack underflow'); }
        return this.stack[this.stack.length - 1];
    }

    // --- Primary Opcode Execution (0x01-0x3C) ---

    private executePrimary(opcode: number, frame: CallFrame): void {
        const bc = frame.fn.bytecode;

        switch (opcode) {
            case Opcode.JUMP_FW: {
                const offset = bc[frame.pc++];
                frame.pc += offset;
                break;
            }
            case Opcode.JUMP_FW_W: {
                const offset = (bc[frame.pc] << 8) | bc[frame.pc + 1];
                frame.pc += 2;
                frame.pc += offset;
                break;
            }
            case Opcode.JUMP_BW: {
                const instrAddr = frame.pc - 1;
                const offset = bc[frame.pc++];
                frame.pc = instrAddr - offset;
                break;
            }
            case Opcode.JUMP_BW_W: {
                const instrAddr = frame.pc - 1;
                const offset = (bc[frame.pc] << 8) | bc[frame.pc + 1];
                frame.pc += 2;
                frame.pc = instrAddr - offset;
                break;
            }
            case Opcode.TJUMP_FW: {
                const offset = bc[frame.pc++];
                const v = this.pop();
                if (!toBool(v)) { frame.pc += offset; }
                break;
            }
            case Opcode.TJUMP_FW_W: {
                const offset = (bc[frame.pc] << 8) | bc[frame.pc + 1];
                frame.pc += 2;
                const v = this.pop();
                if (!toBool(v)) { frame.pc += offset; }
                break;
            }
            case Opcode.TJUMP_BW: {
                const instrAddr = frame.pc - 1;
                const offset = bc[frame.pc++];
                const v = this.pop();
                if (!toBool(v)) { frame.pc = instrAddr - offset; }
                break;
            }
            case Opcode.TJUMP_BW_W: {
                const instrAddr = frame.pc - 1;
                const offset = (bc[frame.pc] << 8) | bc[frame.pc + 1];
                frame.pc += 2;
                const v = this.pop();
                if (!toBool(v)) { frame.pc = instrAddr - offset; }
                break;
            }
            case Opcode.CALL: {
                const findex = bc[frame.pc++];
                this.doCall(findex, frame);
                break;
            }
            case Opcode.CALL_LIB: {
                const findex = bc[frame.pc++];
                const lindex = bc[frame.pc++];
                const nargs = STDLIB_NARGS[lindex]?.[findex] ?? 0;
                this.doCallLib(lindex, findex, nargs);
                break;
            }
            case Opcode.CALL_LIB_W: {
                const fhi = bc[frame.pc++];
                const flo = bc[frame.pc++];
                const lindex = bc[frame.pc++];
                const findex = (fhi << 8) | flo;
                const nargs = STDLIB_NARGS[lindex]?.[findex] ?? 0;
                this.doCallLib(lindex, findex, nargs);
                break;
            }
            case Opcode.CALL_URL: {
                const urlIdx = bc[frame.pc++];
                const fnIdx = bc[frame.pc++];
                const nargs = bc[frame.pc++];
                this.doCallUrl(urlIdx, fnIdx, nargs);
                break;
            }
            case Opcode.CALL_URL_W: {
                const urlIdx = (bc[frame.pc] << 8) | bc[frame.pc + 1];
                const fnIdx = (bc[frame.pc + 2] << 8) | bc[frame.pc + 3];
                frame.pc += 4;
                const nargs = bc[frame.pc++];
                this.doCallUrl(urlIdx, fnIdx, nargs);
                break;
            }

            case Opcode.LOAD_VAR: {
                const idx = bc[frame.pc++];
                this.push(frame.variables[idx] ?? mkString(''));
                break;
            }
            case Opcode.STORE_VAR: {
                const idx = bc[frame.pc++];
                frame.variables[idx] = this.pop();
                break;
            }
            case Opcode.INCR_VAR: {
                const idx = bc[frame.pc++];
                const v = frame.variables[idx];
                const n = toNumber(v);
                frame.variables[idx] = n !== null ? mkInt((n + 1) | 0) : mkInvalid();
                break;
            }
            case Opcode.DECR_VAR: {
                const idx = bc[frame.pc++];
                const v = frame.variables[idx];
                const n = toNumber(v);
                frame.variables[idx] = n !== null ? mkInt((n - 1) | 0) : mkInvalid();
                break;
            }
            case Opcode.LOAD_CONST: {
                const idx = bc[frame.pc++];
                this.pushConstant(idx);
                break;
            }
            case Opcode.LOAD_CONST_W: {
                const idx = (bc[frame.pc] << 8) | bc[frame.pc + 1];
                frame.pc += 2;
                this.pushConstant(idx);
                break;
            }
            case Opcode.CONST_0: this.push(mkInt(0)); break;
            case Opcode.CONST_1: this.push(mkInt(1)); break;
            case Opcode.CONST_M1: this.push(mkInt(-1)); break;
            case Opcode.CONST_ES: this.push(mkString('')); break;
            case Opcode.CONST_INVALID: this.push(mkInvalid()); break;
            case Opcode.CONST_TRUE: this.push(mkBool(true)); break;
            case Opcode.CONST_FALSE: this.push(mkBool(false)); break;

            case Opcode.INCR: {
                const v = this.pop();
                const n = toNumber(v);
                this.push(n !== null ? mkInt((n + 1) | 0) : mkInvalid());
                break;
            }
            case Opcode.DECR: {
                const v = this.pop();
                const n = toNumber(v);
                this.push(n !== null ? mkInt((n - 1) | 0) : mkInvalid());
                break;
            }
            case Opcode.ADD_ASG: {
                const idx = bc[frame.pc++];
                const val = this.pop();
                const current = frame.variables[idx];
                frame.variables[idx] = this.addValues(current, val);
                break;
            }
            case Opcode.SUB_ASG: {
                const idx = bc[frame.pc++];
                const val = this.pop();
                const current = frame.variables[idx];
                const a = toNumber(current), b = toNumber(val);
                frame.variables[idx] = (a !== null && b !== null) ? this.numResult(a - b) : mkInvalid();
                break;
            }
            case Opcode.UMINUS: {
                const v = this.pop();
                const n = toNumber(v);
                if (n === null) { this.push(mkInvalid()); }
                else if (v.type === WmlsType.Float) { this.push(mkFloat(-n)); }
                else { this.push(mkInt(-n)); }
                break;
            }

            // === Operator opcodes (0x20-0x3C) — single-byte, no operands ===

            case Opcode.ADD: {
                const b = this.pop(), a = this.pop();
                this.push(this.addValues(a, b));
                break;
            }
            case Opcode.SUB: this.binaryArith((a, b) => a - b); break;
            case Opcode.MUL: this.binaryArith((a, b) => a * b); break;
            case Opcode.DIV: this.binaryArith((a, b) => b === 0 ? NaN : a / b); break;
            case Opcode.IDIV: {
                const b = this.pop(), a = this.pop();
                const an = toInteger(a), bn = toInteger(b);
                this.push(an !== null && bn !== null && bn !== 0 ? mkInt(Math.trunc(an / bn)) : mkInvalid());
                break;
            }
            case Opcode.REM: {
                const b = this.pop(), a = this.pop();
                const an = toInteger(a), bn = toInteger(b);
                this.push(an !== null && bn !== null && bn !== 0 ? mkInt(an % bn) : mkInvalid());
                break;
            }
            case Opcode.B_AND: this.binaryBitwise((a, b) => a & b); break;
            case Opcode.B_OR:  this.binaryBitwise((a, b) => a | b); break;
            case Opcode.B_XOR: this.binaryBitwise((a, b) => a ^ b); break;
            case Opcode.B_NOT: {
                const v = this.pop();
                const n = toInteger(v);
                this.push(n !== null ? mkInt(~n) : mkInvalid());
                break;
            }
            case Opcode.B_LSHIFT:   this.binaryBitwise((a, b) => a << b); break;
            case Opcode.B_RSSHIFT:  this.binaryBitwise((a, b) => a >> b); break;
            case Opcode.B_RSZSHIFT: this.binaryBitwise((a, b) => a >>> b); break;

            case Opcode.EQ: this.comparison((a, b) => a === b); break;
            case Opcode.NE: this.comparison((a, b) => a !== b); break;
            case Opcode.LT: this.comparison((a, b) => a < b); break;
            case Opcode.LE: this.comparison((a, b) => a <= b); break;
            case Opcode.GT: this.comparison((a, b) => a > b); break;
            case Opcode.GE: this.comparison((a, b) => a >= b); break;

            case Opcode.NOT: {
                const v = this.pop();
                const b = toBool(v);
                this.push(b !== null ? mkBool(!b) : mkInvalid());
                break;
            }
            case Opcode.SCAND: {
                const v = this.pop();
                const b = toBool(v);
                // SCAND per WAP-193 / C compiler:
                // false  → push false (result), push false (TJUMP signal → will jump)
                // true   → push true (TJUMP signal → won't jump, gets popped by TJUMP)
                // invalid→ push invalid (result), push false (TJUMP signal → will jump)
                if (b === false) {
                    this.push(mkBool(false));
                    this.push(mkBool(false));
                } else if (b === null) {
                    this.push(mkInvalid());
                    this.push(mkBool(false));
                } else {
                    this.push(mkBool(true));
                }
                break;
            }
            case Opcode.SCOR: {
                const v = this.pop();
                const b = toBool(v);
                // SCOR per WAP-193 / C compiler:
                // false  → push true (TJUMP signal → won't jump)
                // true   → push true (result), push false (TJUMP signal → will jump)
                // invalid→ push invalid (result), push false (TJUMP signal → will jump)
                if (b === true) {
                    this.push(mkBool(true));
                    this.push(mkBool(false));
                } else if (b === null) {
                    this.push(mkInvalid());
                    this.push(mkBool(false));
                } else {
                    this.push(mkBool(true));
                }
                break;
            }
            case Opcode.TOBOOL: {
                const v = this.pop();
                const b = toBool(v);
                this.push(b !== null ? mkBool(b) : mkInvalid());
                break;
            }
            case Opcode.POP:
                this.pop();
                break;

            case Opcode.TYPEOF: {
                const v = this.pop();
                this.push(mkInt(v.type));
                break;
            }
            case Opcode.ISVALID: {
                const v = this.pop();
                this.push(mkBool(v.type !== WmlsType.Invalid));
                break;
            }
            case Opcode.RETURN: {
                const retVal = this.pop();
                this.callStack.pop();
                if (this.callStack.length === 0) {
                    this.push(retVal);
                } else {
                    this.push(retVal);
                }
                break;
            }
            case Opcode.RETURN_ES: {
                this.callStack.pop();
                if (this.callStack.length > 0) {
                    this.push(mkString(''));
                } else {
                    this.push(mkString(''));
                }
                break;
            }
            case Opcode.DEBUG:
                this.debugHook?.onBreakpoint?.(
                    this.callStack[this.callStack.length - 1]?.funcIndex ?? 0,
                    this.callStack[this.callStack.length - 1]?.pc ?? 0
                );
                break;
        }
    }

    // --- Packed Opcode Execution ---

    private executePacked(byte: number, kind: string, value: number, frame: CallFrame): void {
        switch (kind) {
            case 'LOAD_CONST_S':
                this.pushConstant(value);
                break;
            case 'LOAD_VAR_S':
                this.push(frame.variables[value] ?? mkString(''));
                break;
            case 'STORE_VAR_S':
                frame.variables[value] = this.pop();
                break;
            case 'CALL_S':
                this.doCall(value, frame);
                break;
            case 'CALL_LIB_S': {
                // value = func_id (packed), read 1 byte for lib_id, lookup nargs
                const lindex = frame.fn.bytecode[frame.pc++];
                const nargs = STDLIB_NARGS[lindex]?.[value] ?? 0;
                this.doCallLib(lindex, value, nargs);
                break;
            }
            case 'INCR_VAR_S': {
                const v = frame.variables[value];
                const n = toNumber(v);
                frame.variables[value] = n !== null ? mkInt((n + 1) | 0) : mkInvalid();
                break;
            }
            case 'JUMP_FW_S':
                frame.pc += value;
                break;
            case 'JUMP_BW_S':
                frame.pc = (frame.pc - 1) - value;
                break;
            case 'TJUMP_FW_S': {
                const v = this.pop();
                if (!toBool(v)) { frame.pc += value; }
                break;
            }
        }
    }

    // --- Helpers ---

    private pushConstant(index: number): void {
        const c = this.mod.constants[index];
        if (!c) { this.push(mkInvalid()); return; }
        switch (c.type) {
            case ConstantType.INT_8:
            case ConstantType.INT_16:
            case ConstantType.INT_32:
                this.push(mkInt(c.value as number));
                break;
            case ConstantType.FLOAT_32:
                // §13: integer-only devices cannot load floating-point constants.
                this.push(this.ctx.floatSupported === false ? mkInvalid() : mkFloat(c.value as number));
                break;
            case ConstantType.UTF8_STRING:
            case ConstantType.EXT_STRING:
                this.push(mkString(c.value as string));
                break;
            case ConstantType.EMPTY_STRING:
                this.push(mkString(''));
                break;
        }
    }

    private doCall(funcIndex: number, currentFrame: CallFrame): void {
        const fn = this.mod.functions[funcIndex];
        if (!fn) { throw new Error(`Invalid function index: ${funcIndex}`); }

        const args: WmlsValue[] = [];
        for (let i = 0; i < fn.numArgs; i++) {
            args.unshift(this.pop());
        }

        const variables: WmlsValue[] = new Array(fn.numArgs + fn.numLocals);
        for (let i = 0; i < fn.numArgs; i++) {
            variables[i] = args[i];
        }
        for (let i = fn.numArgs; i < variables.length; i++) {
            variables[i] = mkString('');
        }

        this.callStack.push({
            funcIndex,
            fn,
            pc: 0,
            variables,
            returnAddress: { funcIndex: currentFrame.funcIndex, pc: currentFrame.pc },
        });
    }

    /** External (cross-compilation-unit) call. Resolved by the host via ctx.onCallUrl;
     *  absent ⇒ invalid (the preview transpiler provides full cross-unit calls). §6.4 / WMLS-C-078. */
    private doCallUrl(urlIndex: number, funcNameIndex: number, nargs: number): void {
        const args: WmlsValue[] = [];
        for (let i = 0; i < nargs; i++) { args.unshift(this.pop()); }
        const url = this.constString(urlIndex);
        const funcName = this.constString(funcNameIndex);
        this.push(this.ctx.onCallUrl ? this.ctx.onCallUrl(url, funcName, args) : mkInvalid());
    }

    private constString(index: number): string {
        const c = this.mod.constants[index];
        return c && typeof c.value === 'string' ? c.value : '';
    }

    private doCallLib(libIndex: number, funcIndex: number, nargs: number): void {
        const lib = this.stdlibs.get(libIndex);
        if (!lib) { this.push(mkInvalid()); return; }
        const func = lib[funcIndex];
        if (!func) { this.push(mkInvalid()); return; }

        const args: WmlsValue[] = [];
        for (let i = 0; i < nargs; i++) {
            args.unshift(this.pop());
        }

        const result = func(args);
        this.push(result);
    }

    private addValues(a: WmlsValue, b: WmlsValue): WmlsValue {
        // String concatenation takes precedence
        if (a.type === WmlsType.String || b.type === WmlsType.String) {
            return mkString(wmlsToString(a) + wmlsToString(b));
        }
        const an = toNumber(a), bn = toNumber(b);
        if (an === null || bn === null) { return mkInvalid(); }
        return this.numResult(an + bn);
    }

    private binaryArith(op: (a: number, b: number) => number): void {
        const b = this.pop(), a = this.pop();
        const an = toNumber(a), bn = toNumber(b);
        if (an === null || bn === null) { this.push(mkInvalid()); return; }
        const result = op(an, bn);
        if (!isFinite(result)) { this.push(mkInvalid()); return; }
        this.push(this.numResult(result));
    }

    private binaryBitwise(op: (a: number, b: number) => number): void {
        const b = this.pop(), a = this.pop();
        const an = toInteger(a), bn = toInteger(b);
        this.push(an !== null && bn !== null ? mkInt(op(an, bn)) : mkInvalid());
    }

    private comparison(op: (a: number | string, b: number | string) => boolean): void {
        const b = this.pop(), a = this.pop();
        // String comparison
        if (a.type === WmlsType.String && b.type === WmlsType.String) {
            this.push(mkBool(op(a.value, b.value)));
            return;
        }
        const an = toNumber(a), bn = toNumber(b);
        if (an === null || bn === null) {
            // Invalid comparisons
            if (a.type === WmlsType.Invalid || b.type === WmlsType.Invalid) {
                this.push(mkInvalid());
            } else {
                this.push(mkBool(false));
            }
            return;
        }
        this.push(mkBool(op(an, bn)));
    }

    private numResult(n: number): WmlsValue {
        if (Number.isInteger(n) && n >= -2147483648 && n <= 2147483647) {
            return mkInt(n);
        }
        // §13: integer-only devices yield invalid for non-integer results.
        return this.ctx.floatSupported === false ? mkInvalid() : mkFloat(n);
    }

    // --- Public introspection for debugger ---

    getCallStack(): { funcIndex: number; funcName: string; pc: number }[] {
        return this.callStack.map(f => ({
            funcIndex: f.funcIndex,
            funcName: f.fn.name ?? `function_${f.funcIndex}`,
            pc: f.pc,
        }));
    }

    getVariables(frameIndex?: number): { name: string; value: WmlsValue }[] {
        const idx = frameIndex ?? this.callStack.length - 1;
        const frame = this.callStack[idx];
        if (!frame) { return []; }
        return frame.variables.map((v, i) => ({ name: `var_${i}`, value: v }));
    }

    getStack(): WmlsValue[] {
        return [...this.stack];
    }
}
