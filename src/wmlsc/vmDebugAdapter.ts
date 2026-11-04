/**
 *  Copyright (C) 2026 Jabez Winston
 *
 *  SPDX-License-Identifier: Apache-2.0
 *
 *  Date : 04-November-2026
 *
 *  Shared core of the inline DAP adapters that debug WMLScript on the bytecode VM
 *  (launch: a standalone script; attach/browser: scripts the WAP Browser runs).
 *
 *  The VM is driven one instruction at a time with WmlsVM.stepOnce(). Before each
 *  instruction the current location is checked against the breakpoints and the
 *  step mode; on a stop the loop simply returns, so the extension host's event loop
 *  is free to deliver the next DAP request (continue/next/stepIn/stepOut), which
 *  resumes the loop where it left off:
 *
 *    VS Code debug UI ──DAP──▶ adapter ──stepOnce()──▶ WmlsVM
 *
 *  Source breakpoints map to bytecode offsets through the compiler's PC↔line maps
 *  (see lineMap.ts). Subclasses supply where scripts come from and how a run ends.
 */
import * as vscode from 'vscode';
import { WmlsVM, VMResult } from './vm';
import { WmlsValue, mkInvalid, toString as wmlsToString } from './stdlib';
import { WmlsType } from './opcodes';
import type { DebugInfo, LineMapEntry } from './compiler';
import { lineToPc, pcToLine } from './lineMap';

const LOCALS_REF_BASE = 1000; // locals scope ref for frame i = base + i
const STACK_REF = 1;          // shared "Operand Stack" scope

type StepMode = 'run' | 'stepIn' | 'stepOver' | 'stepOut';

interface SourceBreakpoint { id: number; line: number; }

/** A script to run under the debugger (see startRun). */
export interface DebugRun extends DebugInfo {
    vm: WmlsVM;
    /** Breakpoint key of the script's source, also the stack frames' Source.path. */
    sourceKey: string;
    /** Called once when the run ends; `byUser` when ended by terminate/disconnect. */
    onDone: (result: VMResult, byUser: boolean) => void;
}

export abstract class VmDebugAdapter implements vscode.DebugAdapter {
    private sendMessageEmitter = new vscode.EventEmitter<vscode.DebugProtocolMessage>();
    readonly onDidSendMessage: vscode.Event<vscode.DebugProtocolMessage> = this.sendMessageEmitter.event;

    private seq = 1;
    private bpSeq = 1;
    private disposed = false;

    // breakpoints keyed by sourceKey (see resolveSourceKey)
    private breakpoints = new Map<string, SourceBreakpoint[]>();

    // current run (null between scripts), paused or not
    private active: DebugRun | null = null;
    private bps = new Set<string>(); // "funcIndex:pc" breakpoint locations of the active run
    private mode: StepMode = 'run';
    private resuming = false;     // skip a re-stop at the instruction we just resumed from
    private pausedLine = 0;       // step baseline: line we paused at
    private pausedDepth = 0;      // step baseline: call-stack depth we paused at

    /** Name of the single thread shown in the Call Stack view. */
    protected abstract readonly threadName: string;

    /** Handle `launch` / `attach`; must send `response`. */
    protected abstract onStart(request: any, response: any): void;

    /** Map a DAP `source` to the key its breakpoints are stored under. */
    protected abstract resolveSourceKey(source: any): string;

    /** PC↔line maps of the script known by `sourceKey`, if one is loaded. */
    protected abstract lineMapsFor(sourceKey: string): LineMapEntry[][] | undefined;

    /** After `configurationDone` has been answered (breakpoints are all set). */
    protected onConfigurationDone(): void { /* nothing by default */ }

    /** On `terminate` / `disconnect`, after the active run has been ended. */
    protected onEnd(): void { /* nothing by default */ }

    /** Before a `stopped` event is sent: e.g. reveal the source. */
    protected beforeStop(_sourceKey: string, _line: number): Promise<void> { return Promise.resolve(); }

    // ---- DAP plumbing ---------------------------------------------------

    handleMessage(message: vscode.DebugProtocolMessage): void {
        const msg = message as any;
        if (msg.type === 'request') { this.handleRequest(msg); }
    }

    private handleRequest(request: any): void {
        const response: any = {
            type: 'response',
            request_seq: request.seq,
            seq: this.seq++,
            command: request.command,
            success: true,
        };

        switch (request.command) {
            case 'initialize':
                response.body = {
                    supportsConfigurationDoneRequest: true,
                    supportsEvaluateForHovers: true,
                    supportsTerminateRequest: true,
                };
                this.send(response);
                this.sendEvent('initialized');
                break;

            case 'launch':
            case 'attach':
                this.onStart(request, response);
                break;

            case 'setBreakpoints':
                this.handleSetBreakpoints(request, response);
                break;

            case 'setExceptionBreakpoints':
                response.body = { breakpoints: [] };
                this.send(response);
                break;

            case 'configurationDone':
                this.send(response);
                this.onConfigurationDone();
                break;

            case 'threads':
                response.body = { threads: [{ id: 1, name: this.threadName }] };
                this.send(response);
                break;

            case 'stackTrace':
                this.handleStackTrace(response);
                break;

            case 'scopes':
                this.handleScopes(request, response);
                break;

            case 'variables':
                this.handleVariables(request, response);
                break;

            case 'evaluate':
                this.handleEvaluate(request, response);
                break;

            case 'continue':
                response.body = { allThreadsContinued: true };
                this.send(response);
                this.resume('run');
                break;

            case 'next':
                this.send(response);
                this.resume('stepOver');
                break;

            case 'stepIn':
                this.send(response);
                this.resume('stepIn');
                break;

            case 'stepOut':
                this.send(response);
                this.resume('stepOut');
                break;

            case 'pause':
                // No on-demand pause: the VM runs synchronously between stops, so
                // a running script can only pause at a breakpoint/step. Acknowledge
                // for a consistent UI.
                this.send(response);
                break;

            case 'disconnect':
            case 'terminate':
                this.terminateRun();
                this.onEnd();
                this.send(response);
                if (request.command === 'terminate') { this.sendEvent('terminated'); }
                break;

            default:
                this.send(response);
                break;
        }
    }

    // ---- breakpoints ----------------------------------------------------

    private handleSetBreakpoints(request: any, response: any): void {
        const args = request.arguments || {};
        const sourceKey = this.resolveSourceKey(args.source);
        const reqLines: number[] = (args.breakpoints || []).map((b: any) => b.line);

        const stored: SourceBreakpoint[] = reqLines.map((line) => ({ id: this.bpSeq++, line }));
        if (stored.length > 0) { this.breakpoints.set(sourceKey, stored); }
        else { this.breakpoints.delete(sourceKey); }

        // Breakpoints set or cleared while a run is paused apply to the rest of it.
        if (this.active && this.active.sourceKey === sourceKey) { this.resolveRunBreakpoints(this.active); }

        const lineMaps = this.lineMapsFor(sourceKey);
        response.body = { breakpoints: stored.map((bp) => this.breakpointStatus(bp, lineMaps)) };
        this.send(response);
    }

    /** The "funcIndex:pc" locations of `run`'s source breakpoints. */
    private resolveRunBreakpoints(run: DebugRun): void {
        this.bps = new Set<string>();
        for (const bp of this.breakpoints.get(run.sourceKey) ?? []) {
            const r = lineToPc(run.lineMaps, bp.line);
            if (r) { this.bps.add(`${r.funcIndex}:${r.pc}`); }
        }
    }

    private breakpointStatus(bp: SourceBreakpoint, lineMaps: LineMapEntry[][] | undefined): object {
        const resolved = lineMaps ? lineToPc(lineMaps, bp.line) : undefined;
        return { id: bp.id, verified: !!resolved, line: resolved ? resolved.line : bp.line };
    }

    /** Re-verify breakpoints once a script's line maps become known. */
    refreshBreakpoints(): void {
        for (const [sourceKey, bps] of this.breakpoints) {
            const lineMaps = this.lineMapsFor(sourceKey);
            if (!lineMaps) { continue; }
            for (const bp of bps) {
                this.sendEvent('breakpoint', { reason: 'changed', breakpoint: this.breakpointStatus(bp, lineMaps) });
            }
        }
    }

    // ---- VM driver ------------------------------------------------------

    /**
     * Run `run.vm` (already set up with prepareCall) under debugger control. It stops
     * at breakpoints and steps, and calls `run.onDone` when the script ends.
     */
    protected startRun(run: DebugRun): void {
        this.resolveRunBreakpoints(run);
        this.active = run;
        this.mode = 'run';
        this.resuming = false;
        this.driveLoop();
    }

    /** Run the VM synchronously until a pause condition or completion. */
    private driveLoop(): void {
        const a = this.active;
        if (!a) { return; }
        try {
            for (;;) {
                const loc = a.vm.getCurrentLocation();
                if (loc) {
                    const line = pcToLine(a.lineMaps, loc.funcIndex, loc.pc);
                    const depth = a.vm.getCallStack().length;
                    const reason = this.pauseReason(loc, line, depth);
                    if (reason) { this.enterPause(a, line, depth, reason); return; }
                }
                const r = a.vm.stepOnce();
                if (r.done) { this.finishRun(a, a.vm.finishResult(r.value ?? mkInvalid())); return; }
            }
        } catch (err: any) {
            const error = err?.message ?? String(err);
            this.finishRun(a, { value: mkInvalid(), output: a.vm.getOutput(), steps: 0, error });
        }
    }

    /** Decide whether to stop before the instruction at `loc`. */
    private pauseReason(loc: { funcIndex: number; pc: number }, line: number, depth: number): 'breakpoint' | 'step' | null {
        if (this.resuming) { this.resuming = false; return null; }
        if (this.bps.has(`${loc.funcIndex}:${loc.pc}`)) { return 'breakpoint'; }
        switch (this.mode) {
            case 'run':
                return null;
            case 'stepIn':
                return (line !== this.pausedLine || depth !== this.pausedDepth) ? 'step' : null;
            case 'stepOver':
                return (depth < this.pausedDepth || (depth === this.pausedDepth && line !== this.pausedLine)) ? 'step' : null;
            case 'stepOut':
                return (depth < this.pausedDepth) ? 'step' : null;
        }
        return null;
    }

    private enterPause(a: DebugRun, line: number, depth: number, reason: 'breakpoint' | 'step'): void {
        this.pausedLine = line;
        this.pausedDepth = depth;
        void this.beforeStop(a.sourceKey, line).then(() => {
            this.sendEvent('stopped', { reason, threadId: 1, allThreadsStopped: true });
        });
    }

    private resume(mode: StepMode): void {
        if (!this.active) { return; }
        this.mode = mode;
        this.resuming = true;
        this.driveLoop();
    }

    private finishRun(a: DebugRun, result: VMResult): void {
        if (result.error) {
            this.sendOutput(`Error: ${result.error}\n`, 'stderr');
        } else {
            this.sendOutput(`→ ${this.formatValue(result.value)}\n`);
        }
        this.active = null;
        this.mode = 'run';
        this.resuming = false;
        a.onDone(result, false);
    }

    private terminateRun(): void {
        const a = this.active;
        this.active = null;
        if (a) { a.onDone({ value: mkInvalid(), output: a.vm.getOutput(), steps: 0, error: 'terminated' }, true); }
    }

    // ---- inspection -----------------------------------------------------

    private handleStackTrace(response: any): void {
        const a = this.active;
        if (!a) {
            response.body = { stackFrames: [], totalFrames: 0 };
            this.send(response);
            return;
        }
        const cs = a.vm.getCallStack(); // index 0 = outermost
        const frames = cs.map((f, i) => ({
            id: i,
            name: a.funcNames[f.funcIndex] || f.funcName,
            source: { name: this.basename(a.sourceKey), path: a.sourceKey },
            line: pcToLine(a.lineMaps, f.funcIndex, f.pc),
            column: 1,
        })).reverse(); // DAP wants innermost first
        response.body = { stackFrames: frames, totalFrames: frames.length };
        this.send(response);
    }

    private handleScopes(request: any, response: any): void {
        const frameId: number = request.arguments.frameId;
        response.body = {
            scopes: [
                { name: 'Locals', variablesReference: LOCALS_REF_BASE + frameId, expensive: false },
                { name: 'Operand Stack', variablesReference: STACK_REF, expensive: false },
            ],
        };
        this.send(response);
    }

    private handleVariables(request: any, response: any): void {
        const ref: number = request.arguments.variablesReference;
        const a = this.active;
        let variables: any[] = [];
        if (a) {
            if (ref === STACK_REF) {
                variables = a.vm.getStack().map((v, i) => ({
                    name: `[${i}]`, value: this.formatValue(v), type: WmlsType[v.type], variablesReference: 0,
                }));
            } else {
                const frameId = ref - LOCALS_REF_BASE;
                const cs = a.vm.getCallStack();
                const funcIndex = cs[frameId]?.funcIndex ?? 0;
                const names = a.varNames[funcIndex] ?? [];
                variables = a.vm.getVariables(frameId).map((v, i) => ({
                    name: names[i] ?? `var_${i}`,
                    value: this.formatValue(v.value),
                    type: WmlsType[v.value.type],
                    variablesReference: 0,
                }));
            }
        }
        response.body = { variables };
        this.send(response);
    }

    private handleEvaluate(request: any, response: any): void {
        const args = request.arguments || {};
        const expr = String(args.expression ?? '').trim();
        const a = this.active;
        const frameId: number = args.frameId ?? (a ? a.vm.getCallStack().length - 1 : 0);
        if (a && expr) {
            const cs = a.vm.getCallStack();
            const funcIndex = cs[frameId]?.funcIndex ?? 0;
            const names = a.varNames[funcIndex] ?? [];
            const idx = names.indexOf(expr);
            if (idx >= 0) {
                const vars = a.vm.getVariables(frameId);
                if (vars[idx]) {
                    response.body = { result: this.formatValue(vars[idx].value), type: WmlsType[vars[idx].value.type], variablesReference: 0 };
                    this.send(response);
                    return;
                }
            }
        }
        response.success = false;
        response.message = 'not available';
        this.send(response);
    }

    // ---- helpers --------------------------------------------------------

    protected basename(key: string): string {
        const noFrag = key.split('#')[0];
        return noFrag.split(/[\\/]/).pop() || noFrag;
    }

    private formatValue(v: WmlsValue): string {
        switch (v.type) {
            case WmlsType.Integer: return `${v.value} (int)`;
            case WmlsType.Float: return `${v.value} (float)`;
            case WmlsType.String: return `"${v.value}"`;
            case WmlsType.Boolean: return v.value ? 'true' : 'false';
            case WmlsType.Invalid: return 'invalid';
            default: return wmlsToString(v);
        }
    }

    protected send(msg: any): void {
        this.sendMessageEmitter.fire(msg);
    }

    protected sendEvent(event: string, body?: any): void {
        this.send({ type: 'event', seq: this.seq++, event, body });
    }

    protected sendOutput(text: string, category: string = 'stdout'): void {
        this.sendEvent('output', { category, output: text });
    }

    dispose(): void {
        if (this.disposed) { return; }
        this.disposed = true;
        this.terminateRun();
        this.onEnd();
        this.sendMessageEmitter.dispose();
    }
}
