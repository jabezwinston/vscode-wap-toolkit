/**
 *  Copyright (C) 2026 Jabez Winston
 *
 *  SPDX-License-Identifier: Apache-2.0
 *
 *  Date : 29-May-2026
 *
 *  WMLScript WAP-Browser Debug Adapter.
 *
 *  An inline DAP adapter (request: "attach", target: "browser") that debugs
 *  WMLScript as it runs on the bytecode VM inside the WAP Browser. The browser
 *  fetches + compiles scripts (with debug info) and registers them with
 *  browserDebugSession; this adapter then *drives the VM step-by-step* via
 *  WmlsVM.stepOnce(), pausing at breakpoints/steps and returning to the event loop
 *  so DAP step/continue messages can be processed:
 *
 *    VS Code debug UI ──DAP──▶ this adapter ──stepOnce()──▶ WmlsVM
 *
 *  Source breakpoints map to bytecode offsets through the compiler's PC↔line maps
 *  (see lineMap.ts); the WML deck and .wmls source are shown as read-only
 *  `wml-debug:` virtual documents (see debugSourceProvider.ts).
 */
import * as vscode from 'vscode';
import { WmlsVM, VMResult } from './vm';
import { WmlsValue, mkInvalid, toString as wmlsToString } from './stdlib';
import { WmlsType } from './opcodes';
import type { LineMapEntry } from './compiler';
import { lineToPc, pcToLine } from './lineMap';
import { browserDebugSession, DebugRunRequest, VmDebugDriver } from './browserDebugSession';

const LOCALS_REF_BASE = 1000; // locals scope ref for frame i = base + i
const STACK_REF = 1;          // shared "Operand Stack" scope

type StepMode = 'run' | 'stepIn' | 'stepOver' | 'stepOut';

interface SourceBreakpoint { id: number; line: number; }

interface ActiveRun {
    vm: WmlsVM;
    sourceUri: string;
    lineMaps: LineMapEntry[][];
    varNames: string[][];
    resolve: (r: VMResult) => void;
    bps: Set<string>; // "funcIndex:pc" breakpoint locations for this run
}

export class WmlsBrowserDebugAdapter implements vscode.DebugAdapter, VmDebugDriver {
    private sendMessageEmitter = new vscode.EventEmitter<vscode.DebugProtocolMessage>();
    readonly onDidSendMessage: vscode.Event<vscode.DebugProtocolMessage> = this.sendMessageEmitter.event;

    private seq = 1;
    private bpSeq = 1;
    private disposed = false;

    // breakpoints keyed by registry source URI (the `wml-debug:` document URI string)
    private breakpoints = new Map<string, SourceBreakpoint[]>();

    // current paused run (null between scripts / when running)
    private active: ActiveRun | null = null;
    private mode: StepMode = 'run';
    private resuming = false;     // skip a re-stop at the instruction we just resumed from
    private pausedLine = 0;       // step baseline: line we paused at
    private pausedDepth = 0;      // step baseline: call-stack depth we paused at

    /** @param sourceColumn editor column where paused .wmls sources should be revealed. */
    constructor(private sourceColumn?: vscode.ViewColumn) {
        browserDebugSession.attachAdapter(this);
    }

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
                this.send(response);
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
                this.sendOutput('WMLScript debugger attached. Trigger a script in the WAP Browser to hit breakpoints.\n');
                break;

            case 'threads':
                response.body = { threads: [{ id: 1, name: 'WMLScript (WAP Browser)' }] };
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
                // No on-demand pause: between scripts nothing runs, and a running
                // script can only pause at a breakpoint/step. Acknowledge for a
                // consistent UI.
                this.send(response);
                break;

            case 'disconnect':
            case 'terminate':
                this.terminateRun();
                browserDebugSession.detachAdapter();
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
        const sourceUri = this.resolveSourceUri(args.source);
        const reqLines: number[] = (args.breakpoints || []).map((b: any) => b.line);

        const stored: SourceBreakpoint[] = reqLines.map((line) => ({ id: this.bpSeq++, line }));
        if (stored.length > 0) { this.breakpoints.set(sourceUri, stored); }
        else { this.breakpoints.delete(sourceUri); }

        const script = browserDebugSession.getScript(sourceUri);
        response.body = {
            breakpoints: stored.map((bp) => {
                const resolved = script ? lineToPc(script.lineMaps, bp.line) : undefined;
                return { id: bp.id, verified: !!resolved, line: resolved ? resolved.line : bp.line };
            }),
        };
        this.send(response);
    }

    /**
     * Map a DAP `source` to a registered source URI. VS Code sets Source.path to
     * uri.toString() for non-file schemes, so for our `wml-debug:` docs that IS the
     * registry key. Falls back to matching a registered script by basename.
     */
    private resolveSourceUri(source: any): string {
        const path: string = source?.path ?? '';
        if (path.startsWith('wml-debug:')) { return path; }
        const name: string = source?.name ?? (path ? path.substring(path.lastIndexOf('/') + 1) : '');
        for (const [uri] of browserDebugSession.listScripts()) {
            if (uri === path) { return uri; }
            if (name && uri.substring(uri.lastIndexOf('/') + 1) === name) { return uri; }
        }
        return path || name;
    }

    /** VmDebugDriver: re-verify breakpoints after a script registers late. */
    refreshBreakpoints(): void {
        for (const [sourceUri, bps] of this.breakpoints) {
            const script = browserDebugSession.getScript(sourceUri);
            if (!script) { continue; }
            for (const bp of bps) {
                const resolved = lineToPc(script.lineMaps, bp.line);
                this.sendEvent('breakpoint', {
                    reason: 'changed',
                    breakpoint: { id: bp.id, verified: !!resolved, line: resolved ? resolved.line : bp.line },
                });
            }
        }
    }

    // ---- VM driver (VmDebugDriver) --------------------------------------

    driveRun(req: DebugRunRequest): Promise<VMResult> {
        return new Promise<VMResult>((resolve) => {
            const funcIndex = req.module.functions.findIndex((f) => f.name === req.funcName);
            if (funcIndex === -1) {
                this.sendOutput(`Function '${req.funcName}' not found in ${this.basename(req.sourceUri)}\n`, 'stderr');
                resolve({ value: mkInvalid(), output: [], steps: 0, error: `Function not found: ${req.funcName}` });
                return;
            }

            const vm = new WmlsVM(req.module, { context: req.ctx, maxSteps: 10_000_000 });
            // Stream Console/Dialogs output live to the Debug Console. (The VM
            // captures ctx by reference and reads ctx.onOutput on each call, so this
            // override takes effect.)
            req.ctx.onOutput = (text: string) => this.sendOutput(text);

            if (!vm.prepareCall(funcIndex, req.args)) {
                resolve({ value: mkInvalid(), output: [], steps: 0, error: 'Verification failed' });
                return;
            }

            // Resolve breakpoints for this source to {funcIndex:pc} locations.
            const bps = new Set<string>();
            for (const bp of this.breakpoints.get(req.sourceUri) ?? []) {
                const r = lineToPc(req.lineMaps, bp.line);
                if (r) { bps.add(`${r.funcIndex}:${r.pc}`); }
            }

            this.active = { vm, sourceUri: req.sourceUri, lineMaps: req.lineMaps, varNames: req.varNames, resolve, bps };
            this.mode = 'run';
            this.resuming = false;
            this.driveLoop();
        });
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
                    const reason = this.pauseReason(a, loc, line, depth);
                    if (reason) { this.enterPause(a, line, depth, reason); return; }
                }
                const r = a.vm.stepOnce();
                if (r.done) { this.finishRun(a, r.value ?? mkInvalid()); return; }
            }
        } catch (err: any) {
            this.finishRun(a, mkInvalid(), err?.message ?? String(err));
        }
    }

    /** Decide whether to stop before the instruction at `loc`. */
    private pauseReason(
        a: ActiveRun,
        loc: { funcIndex: number; pc: number },
        line: number,
        depth: number,
    ): 'breakpoint' | 'step' | null {
        if (this.resuming) { this.resuming = false; return null; }
        if (a.bps.has(`${loc.funcIndex}:${loc.pc}`)) { return 'breakpoint'; }
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

    private enterPause(a: ActiveRun, line: number, depth: number, reason: 'breakpoint' | 'step'): void {
        this.pausedLine = line;
        this.pausedDepth = depth;
        // Reveal the paused source line before announcing the stop, so VS Code's own
        // stack-frame reveal lands on the right document/line.
        void this.revealSource(a.sourceUri, line).then(() => {
            this.sendEvent('stopped', { reason, threadId: 1, allThreadsStopped: true });
        });
    }

    private resume(mode: StepMode): void {
        if (!this.active) { return; }
        this.mode = mode;
        this.resuming = true;
        this.driveLoop();
    }

    private finishRun(a: ActiveRun, value: WmlsValue, error?: string): void {
        if (error) {
            this.sendOutput(`Error: ${error}\n`, 'stderr');
        } else {
            this.sendOutput(`→ ${this.formatValue(value)}\n`);
        }
        this.active = null;
        this.mode = 'run';
        this.resuming = false;
        // The attach session persists for the next script/navigation — no 'terminated'.
        a.resolve({ value, output: a.vm.getOutput(), steps: 0, error });
    }

    private terminateRun(): void {
        const a = this.active;
        this.active = null;
        if (a) { a.resolve({ value: mkInvalid(), output: a.vm.getOutput(), steps: 0, error: 'terminated' }); }
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
            name: f.funcName,
            source: { name: this.basename(a.sourceUri), path: a.sourceUri },
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

    private async revealSource(sourceUri: string, line: number): Promise<void> {
        try {
            const uri = vscode.Uri.parse(sourceUri);
            const editor = await vscode.window.showTextDocument(uri, {
                viewColumn: this.sourceColumn ?? vscode.ViewColumn.One,
                preserveFocus: false,
                preview: false,
            });
            const pos = new vscode.Position(Math.max(0, line - 1), 0);
            editor.revealRange(new vscode.Range(pos, pos), vscode.TextEditorRevealType.InCenterIfOutsideViewport);
        } catch {
            // not openable — VS Code's default stack reveal will handle it
        }
    }

    private basename(uri: string): string {
        const noFrag = uri.split('#')[0];
        return noFrag.substring(noFrag.lastIndexOf('/') + 1) || noFrag;
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

    private send(msg: any): void {
        this.sendMessageEmitter.fire(msg);
    }

    private sendEvent(event: string, body?: any): void {
        this.send({ type: 'event', seq: this.seq++, event, body });
    }

    private sendOutput(text: string, category: string = 'stdout'): void {
        this.sendEvent('output', { category, output: text });
    }

    dispose(): void {
        if (this.disposed) { return; }
        this.disposed = true;
        this.terminateRun();
        browserDebugSession.detachAdapter();
        this.sendMessageEmitter.dispose();
    }
}
