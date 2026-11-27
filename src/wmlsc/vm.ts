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
    Opcode, WmlsType, StdLibrary,
    classifyOpcode,
    STDLIB_NARGS,
} from './opcodes';
import {
    WmlscModule, WmlscFunction,
    decodeWmlsc, verifyModule,
} from './decoder';
import {
    WmlsValue, mkInt, mkFloat, mkString, mkBool, mkInvalid,
    unaryNum, toBool, toString as wmlsToString,
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
 * WMLScript: 12.3 Fatal Errors
 *
 * Fatal run-time error classification per WMLScript: 12.3. A fatal error aborts the
 * program and is signalled to the caller (set on VMResult.error + .errorKind),
 * whereas non-fatal errors (WMLScript: 12.4 — divide-by-zero, overflow, conversion) instead
 * yield `invalid` (FP underflow → 0.0) and let the program continue.
 */
export enum WmlsErrorKind {
    VerificationFailed = 'verification-failed',       // WMLScript: 12.3.1.1
    InvalidFunctionArguments = 'invalid-arguments',   // WMLScript: 12.3.1.3
    ExternalFunctionNotFound = 'external-not-found',  // WMLScript: 12.3.1.4 (and the local entry-point not found)
    StackUnderflow = 'stack-underflow',               // WMLScript: 12.3.1.7
    ProgrammedAbort = 'programmed-abort',             // WMLScript: 12.3.2.1 — Lang.abort()
    ExecutionLimit = 'execution-limit',               // implementation guard (outside WMLScript: 12)
    InternalError = 'internal-error',
}

/** Map a thrown VM Error message to its WMLScript: 12.3 fatal classification. */
function classifyVmError(message: string): WmlsErrorKind {
    if (/stack underflow/i.test(message)) { return WmlsErrorKind.StackUnderflow; }
    if (/execution limit/i.test(message)) { return WmlsErrorKind.ExecutionLimit; }
    if (/invalid function index/i.test(message)) { return WmlsErrorKind.InvalidFunctionArguments; }
    if (/external function not found/i.test(message)) { return WmlsErrorKind.ExternalFunctionNotFound; }
    return WmlsErrorKind.InternalError;
}

export interface VMResult {
    value: WmlsValue;
    output: string[];
    steps: number;
    error?: string;
    errorKind?: WmlsErrorKind;   // WMLScript: 12.3 classification when `error` is set (fatal)
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

/**
 * Resolver invoked by the async VM (callFunctionAsync) for an external call
 * (`Alias#f()`, CALL_URL) when the context has no synchronous onCallUrl: the
 * host loads the unit at `url` and runs `funcName`. It returns the result, or
 * throws — a failed external call is fatal (WMLScript: 12.3.1).
 */
export type ExternalResolver =
    (url: string, funcName: string, args: WmlsValue[]) => Promise<WmlsValue> | WmlsValue;

/** An external call waiting for the async driver (see ExternalResolver) */
interface ExternalSuspend { wmlsExternal: true; url: string; funcName: string; args: WmlsValue[]; }

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
    private asyncExternal = false;      // callFunctionAsync has an ExternalResolver

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
        const argErr = this.argCountError(fn, args);
        if (argErr) { return argErr; }
        this.asyncExternal = false;

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

    /** WMLScript: 12.3.1.3 Invalid Function Arguments
     *
     * A call from outside the unit passes exactly the function's arguments
     *  (WMLScript: 8.3.4, 12.3.1.3: else the call fails, fatally) */
    private argCountError(fn: WmlscFunction | undefined, args: WmlsValue[]): VMResult | null {
        if (!fn || args.length === fn.numArgs) { return null; }
        return {
            value: mkInvalid(), output: this.output, steps: 0,
            error: `${fn.name ?? 'function'} takes ${fn.numArgs} argument(s), not ${args.length}`,
            errorKind: WmlsErrorKind.InvalidFunctionArguments,
        };
    }

    /**
     * Build the VMResult after a normal run, distinguishing Lang.exit() (a clean
     * termination that returns its value) from Lang.abort() — a WMLScript: 12.3.2.1 fatal
     * Programmed Abort that must be signalled to the caller as an error.
     */
    finishResult(value: WmlsValue): VMResult {
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
    async callFunctionAsync(name: string, args: WmlsValue[], onDialog: DialogResolver,
                            onExternal?: ExternalResolver): Promise<VMResult> {
        const funcIndex = this.mod.functions.findIndex(f => f.name === name);
        if (funcIndex === -1) {
            return { value: mkInvalid(), output: this.output, steps: 0, error: `Function not found: ${name}`, errorKind: WmlsErrorKind.ExternalFunctionNotFound };
        }
        if (this.verifyErrors.length > 0) {
            return { value: mkInvalid(), output: this.output, steps: 0, error: `Verification failed: ${this.verifyErrors[0]}`, errorKind: WmlsErrorKind.VerificationFailed };
        }
        const argErr = this.argCountError(this.mod.functions[funcIndex], args);
        if (argErr) { return argErr; }
        if (!this.prepareCall(funcIndex, args)) {
            return { value: mkInvalid(), output: this.output, steps: 0, error: `Invalid function index: ${funcIndex}`, errorKind: WmlsErrorKind.InvalidFunctionArguments };
        }
        this.asyncExternal = !!onExternal;
        try {
            const value = await this.runAsync(onDialog, onExternal);
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
    private async runAsync(onDialog: DialogResolver, onExternal?: ExternalResolver): Promise<WmlsValue> {
        for (;;) {
            try {
                const r = this.stepOnce();
                if (r.done) { return r.value ?? mkString(''); }
            } catch (e) {
                const ext = e as ExternalSuspend;
                if (onExternal && ext && ext.wmlsExternal === true) {
                    this.push(await onExternal(ext.url, ext.funcName, ext.args));
                    continue;
                }
                // Shape, not prototype: instanceof does not survive an ES5
                // downlevel of a built-in subclass. See DialogSuspend.is().
                if (DialogSuspend.is(e)) {
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
            this.executePacked(info.packedKind!, info.embeddedValue!, frame);
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

    // --- Primary Opcode Execution (0x01-0x3C) ---

    // WMLScript: 10.5 Instructions
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
                // findex8 lindex16 (WMLScript: 10.5.2.5)
                const findex = bc[frame.pc++];
                const lhi = bc[frame.pc++];
                const llo = bc[frame.pc++];
                const lindex = (lhi << 8) | llo;
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
                frame.variables[idx] = this.step(frame.variables[idx], 1);
                break;
            }
            case Opcode.DECR_VAR: {
                const idx = bc[frame.pc++];
                frame.variables[idx] = this.step(frame.variables[idx], -1);
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

            case Opcode.INCR: this.push(this.step(this.pop(), 1)); break;
            case Opcode.DECR: this.push(this.step(this.pop(), -1)); break;
            case Opcode.ADD_ASG: {
                const idx = bc[frame.pc++];
                const val = this.pop();
                frame.variables[idx] = this.binop(Opcode.ADD, frame.variables[idx], val);
                break;
            }
            case Opcode.SUB_ASG: {
                const idx = bc[frame.pc++];
                const val = this.pop();
                frame.variables[idx] = this.binop(Opcode.SUB, frame.variables[idx], val);
                break;
            }
            case Opcode.UMINUS: {
                const n = unaryNum(this.pop());
                this.push(n.type === WmlsType.Float ? this.mkF(-n.value)
                    : n.type === WmlsType.Integer ? mkInt(-n.value) : n);
                break;
            }

            // === Operator opcodes (0x20-0x3C) — single-byte, no operands ===

            case Opcode.ADD: case Opcode.SUB: case Opcode.MUL: case Opcode.DIV:
            case Opcode.IDIV: case Opcode.REM:
            case Opcode.B_AND: case Opcode.B_OR: case Opcode.B_XOR:
            case Opcode.B_LSHIFT: case Opcode.B_RSSHIFT: case Opcode.B_RSZSHIFT:
            case Opcode.EQ: case Opcode.NE: case Opcode.LT:
            case Opcode.LE: case Opcode.GT: case Opcode.GE: {
                const b = this.pop(), a = this.pop();
                this.push(this.binop(opcode, a, b));
                break;
            }
            case Opcode.B_NOT:          /* ~x is x ^ -1, integers only */
                this.push(this.binop(Opcode.B_XOR, this.pop(), mkInt(-1)));
                break;

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

    // WMLScript: 10.5 Instructions
    private executePacked(kind: string, value: number, frame: CallFrame): void {
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
                frame.variables[value] = this.step(v, 1);
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

    // WMLScript:
    //  - 10.5.4 Access To Constants
    //  - 13 SUPPORT FOR INTEGER ONLY DEVICES
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
                // WMLScript: 13 SUPPORT FOR INTEGER ONLY DEVICES: integer-only devices cannot load floating-point constants.
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

    // WMLScript:
    //  - 8.4.1 Passing of Function Arguments
    //  - 8.4.4 Initialisation of Variables
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

    /** WMLScript:
     *  - 10.5.2.6 Instruction: CALL_URL urlindex findex args
     *  - 12.3.1.4 External Function Not Found
     *
     * External (cross-compilation-unit) call, WMLScript: 6.4 / WMLS-C-078: resolved by
     *  the host, by ctx.onCallUrl or callFunctionAsync's ExternalResolver.
     *  With neither the call fails, and a failed external call is fatal
     *  (WMLScript: 12.3.1.4-12.3.1.6), not invalid. */
    private doCallUrl(urlIndex: number, funcNameIndex: number, nargs: number): void {
        const args: WmlsValue[] = [];
        for (let i = 0; i < nargs; i++) { args.unshift(this.pop()); }
        const url = this.constString(urlIndex);
        const funcName = this.constString(funcNameIndex);
        if (this.ctx.onCallUrl) {
            this.push(this.ctx.onCallUrl(url, funcName, args));
            return;
        }
        if (this.asyncExternal) {
            const suspend: ExternalSuspend = { wmlsExternal: true, url, funcName, args };
            throw suspend;
        }
        throw new Error(`External function not found: ${url}#${funcName}`);
    }

    private constString(index: number): string {
        const c = this.mod.constants[index];
        return c && typeof c.value === 'string' ? c.value : '';
    }

    // WMLScript: 6.4.2.3 Library Functions
    private doCallLib(libIndex: number, funcIndex: number, nargs: number): void {
        const lib = this.stdlibs.get(libIndex);
        if (!lib) { this.push(mkInvalid()); return; }
        const func = lib[funcIndex];
        if (!func) { this.push(mkInvalid()); return; }

        const args: WmlsValue[] = [];
        for (let i = 0; i < nargs; i++) {
            args.unshift(this.pop());
        }

        // WMLScript Libraries: 6.3 Error Handling: an invalid argument makes
        // the result invalid, with no side effects — except for Lang.exit and
        // Lang.abort, String.toString (WMLScript Libraries: 7.11, 7.12, 9.15),
        // which take one, and the Console
        const takesInvalid = libIndex === StdLibrary.Console ||
            (libIndex === StdLibrary.Lang && (funcIndex === 10 || funcIndex === 11)) ||
            (libIndex === StdLibrary.String && funcIndex === 14);
        if (!takesInvalid && args.some((a) => a.type === WmlsType.Invalid)) {
            this.push(mkInvalid());
            return;
        }

        const result = func(args);
        this.push(result);
    }

    /** A float result: invalid on an integer-only device (WMLScript: 13) or when
     *  not finite in single precision (mkFloat) */
    private mkF(n: number): WmlsValue {
        return this.ctx.floatSupported === false ? mkInvalid() : mkFloat(n);
    }

    /** WMLScript: 6.9 Operator Data Type Conversion Rules
     *
     * ++ / -- by rule 5 (WMLScript: 6.9): an integer (invalid on overflow) or a float */
    private step(v: WmlsValue | undefined, d: number): WmlsValue {
        const n = unaryNum(v ?? mkString(''));
        return n.type === WmlsType.Float ? this.mkF(n.value + d)
            : n.type === WmlsType.Integer ? mkInt(n.value + d) : n;
    }

    /**
     * WMLScript:
     *  - 6.9 Operator Data Type Conversion Rules
     *  - 6.3.2 Arithmetic Operators
     *  - 6.3.5 Comparison Operators
     *  - 12.4.1.2 Integer Overflow
     *
     * The binary operators by the conversion rules of WMLScript: 6.9: an
     * invalid operand gives invalid (WMLScript: 6.3.5: comparisons too); + and the
     * comparisons work on strings when either operand is one (rule 7);
     * otherwise both operands convert to integers or floats (rule 5), the
     * integer-only operators refuse a float (rule 2, WMLScript: 6.8.3), / is always
     * a float, and an integer result that overflows is invalid (WMLScript: 12.4.1.2).
     */
    private binop(op: number, a: WmlsValue, b: WmlsValue): WmlsValue {
        if (a.type === WmlsType.Invalid || b.type === WmlsType.Invalid) { return mkInvalid(); }
        const cmp = op === Opcode.EQ || op === Opcode.NE || op === Opcode.LT ||
                    op === Opcode.LE || op === Opcode.GT || op === Opcode.GE;
        const order = (x: number | string, y: number | string): WmlsValue => {
            const c = x < y ? -1 : x > y ? 1 : 0;
            switch (op) {
                case Opcode.EQ: return mkBool(c === 0);
                case Opcode.NE: return mkBool(c !== 0);
                case Opcode.LT: return mkBool(c < 0);
                case Opcode.LE: return mkBool(c <= 0);
                case Opcode.GT: return mkBool(c > 0);
                default: return mkBool(c >= 0);
            }
        };
        if ((cmp || op === Opcode.ADD) &&
            (a.type === WmlsType.String || b.type === WmlsType.String)) {
            const sa = wmlsToString(a), sb = wmlsToString(b);
            return op === Opcode.ADD ? mkString(sa + sb) : order(sa, sb);
        }
        const na = unaryNum(a), nb = unaryNum(b);
        if (na.type === WmlsType.Invalid || nb.type === WmlsType.Invalid) { return mkInvalid(); }
        const x = na.value as number, y = nb.value as number;
        const fl = na.type === WmlsType.Float || nb.type === WmlsType.Float;
        const intOnly = op === Opcode.IDIV || op === Opcode.REM || op === Opcode.B_AND ||
                        op === Opcode.B_OR || op === Opcode.B_XOR || op === Opcode.B_LSHIFT ||
                        op === Opcode.B_RSSHIFT || op === Opcode.B_RSZSHIFT;
        if (intOnly && fl) { return mkInvalid(); }
        if (cmp) { return order(x, y); }
        if (fl || op === Opcode.DIV) {
            switch (op) {
                case Opcode.ADD: return this.mkF(x + y);
                case Opcode.SUB: return this.mkF(x - y);
                case Opcode.MUL: return this.mkF(x * y);
                default: return y === 0 ? mkInvalid() : this.mkF(x / y);
            }
        }
        switch (op) {
            case Opcode.ADD: return mkInt(x + y);
            case Opcode.SUB: return mkInt(x - y);
            case Opcode.MUL: return mkInt(x * y);
            case Opcode.IDIV: return y === 0 ? mkInvalid() : mkInt(Math.trunc(x / y));   // minInt div -1 overflows
            case Opcode.REM: return y === 0 ? mkInvalid() : mkInt(y === -1 ? 0 : x % y);
            case Opcode.B_AND: return mkInt(x & y);
            case Opcode.B_OR: return mkInt(x | y);
            case Opcode.B_XOR: return mkInt(x ^ y);
            case Opcode.B_LSHIFT: return mkInt(x << y);
            case Opcode.B_RSSHIFT: return mkInt(x >> y);
            default: return mkInt(x >>> y | 0);
        }
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
