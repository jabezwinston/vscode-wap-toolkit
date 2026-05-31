/**
 *  Copyright (C) 2026 Jabez Winston
 *
 *  SPDX-License-Identifier: Apache-2.0
 *
 *  Date : 29-May-2026
 *
 *  WMLScript Preview Debug Adapter.
 *
 *  An inline DAP adapter (request: "attach") that debugs WMLScript as it runs
 *  live in the WML preview webview. It does NOT run the bytecode VM; instead it
 *  drives the in-webview __wmls._dbg controller through previewDebugBridge:
 *
 *    VS Code debug UI ──DAP──▶ this adapter ──▶ previewDebugBridge ──▶ webview
 *
 *  Source-line breakpoints are native here — the transpiler emits
 *  `await __wmls._brk(<source line>)`, so no PC↔line mapping is needed.
 */
import * as vscode from 'vscode';
import * as path from 'path';
import { previewDebugBridge } from './previewDebugBridge';
import { fsPathToScriptPath, scriptPathToFsPath } from './scriptPath';

interface DapVar { name: string; value: string; type: string; }
interface StoppedFrame { id: number; fn: string; script: string; line: number; vars: DapVar[]; }
interface StoppedPayload { paused: boolean; reason: string; stack: StoppedFrame[]; wmlVars: DapVar[]; }

const LOCALS_REF_BASE = 1000; // locals scope ref for frame i = base + i
const WMLVARS_REF = 1;        // shared "WML Variables" scope

export class WmlsPreviewDebugAdapter implements vscode.DebugAdapter {
    private sendMessageEmitter = new vscode.EventEmitter<vscode.DebugProtocolMessage>();
    readonly onDidSendMessage: vscode.Event<vscode.DebugProtocolMessage> = this.sendMessageEmitter.event;

    private seq = 1;
    private readonly root: string;

    // breakpoints keyed by registry script path, re-sent whenever the webview reloads
    private bps = new Map<string, number[]>();
    private lastStopped?: StoppedPayload;
    private varRefs = new Map<number, DapVar[]>();
    private pendingEvals = new Map<number, (result: { value: string; type: string } | undefined) => void>();
    private evalSeq = 1;
    private disposed = false;

    // bridge listeners (removed on dispose)
    private readonly onStopped = (p: StoppedPayload) => this.handleStopped(p);
    private readonly onOutput = (p: { text: string }) => this.sendOutput(p?.text ?? '');
    private readonly onReady = () => this.pushDebugState();
    private readonly onEvalResult = (p: { requestId: number; result?: { value: string; type: string } }) => {
        const cb = this.pendingEvals.get(p?.requestId);
        if (cb) { this.pendingEvals.delete(p.requestId); cb(p.result); }
    };

    /** @param sourceColumn editor column where paused .wmls sources should be revealed. */
    constructor(private sourceColumn?: vscode.ViewColumn) {
        this.root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? '';
        previewDebugBridge.on('stopped', this.onStopped);
        previewDebugBridge.on('output', this.onOutput);
        previewDebugBridge.on('ready', this.onReady);
        previewDebugBridge.on('evaluateResult', this.onEvalResult);
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
                this.pushDebugState();
                if (!previewDebugBridge.isAttached()) {
                    this.sendOutput('WMLScript debugger: open the WML preview and trigger a script to hit breakpoints.\n');
                }
                break;

            case 'threads':
                response.body = { threads: [{ id: 1, name: 'WMLScript (preview)' }] };
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
                previewDebugBridge.sendCommand('continue');
                response.body = { allThreadsContinued: true };
                this.send(response);
                break;

            case 'next':
                previewDebugBridge.sendCommand('stepOver');
                this.send(response);
                break;

            case 'stepIn':
                previewDebugBridge.sendCommand('stepIn');
                this.send(response);
                break;

            case 'stepOut':
                previewDebugBridge.sendCommand('stepOut');
                this.send(response);
                break;

            case 'pause':
                // No on-demand pause in the live preview; acknowledge so the UI stays consistent.
                this.send(response);
                break;

            case 'disconnect':
            case 'terminate':
                previewDebugBridge.sendCommand('stop');
                previewDebugBridge.sendCommand('setEnabled', { enabled: false });
                this.send(response);
                if (request.command === 'terminate') { this.sendEvent('terminated'); }
                break;

            default:
                // Unknown/optional requests: acknowledge to keep the session healthy.
                this.send(response);
                break;
        }
    }

    // ---- request handlers ----------------------------------------------

    private handleSetBreakpoints(request: any, response: any): void {
        const args = request.arguments || {};
        const fsPath: string = args.source?.path ?? '';
        const lines: number[] = (args.breakpoints || []).map((b: any) => b.line);
        const script = fsPathToScriptPath(fsPath, this.root);

        if (lines.length > 0) { this.bps.set(script, lines); }
        else { this.bps.delete(script); }

        previewDebugBridge.sendCommand('setBreakpoints', { script, lines });
        previewDebugBridge.sendCommand('setEnabled', { enabled: true });

        response.body = { breakpoints: lines.map((line) => ({ verified: true, line })) };
        this.send(response);
    }

    private handleStackTrace(response: any): void {
        const stack = this.lastStopped?.stack ?? [];
        // snapshot is outermost-first; DAP wants innermost (current) frame first.
        const frames = stack.slice().reverse().map((f) => {
            const fsPath = scriptPathToFsPath(f.script, this.root);
            return {
                id: f.id,
                name: f.fn,
                source: { name: path.basename(fsPath), path: fsPath },
                line: f.line,
                column: 1,
            };
        });
        response.body = { stackFrames: frames, totalFrames: frames.length };
        this.send(response);
    }

    private handleScopes(request: any, response: any): void {
        const frameId: number = request.arguments.frameId;
        response.body = {
            scopes: [
                { name: 'Locals', variablesReference: LOCALS_REF_BASE + frameId, expensive: false },
                { name: 'WML Variables', variablesReference: WMLVARS_REF, expensive: false },
            ],
        };
        this.send(response);
    }

    private handleVariables(request: any, response: any): void {
        const ref: number = request.arguments.variablesReference;
        const vars = this.varRefs.get(ref) ?? [];
        response.body = {
            variables: vars.map((v) => ({
                name: v.name,
                value: v.value,
                type: v.type,
                variablesReference: 0,
            })),
        };
        this.send(response);
    }

    private handleEvaluate(request: any, response: any): void {
        const args = request.arguments || {};
        if (!previewDebugBridge.isAttached()) {
            response.success = false;
            response.message = 'WML preview not attached';
            this.send(response);
            return;
        }
        const requestId = this.evalSeq++;
        let settled = false;
        const finish = (result: { value: string; type: string } | undefined) => {
            if (settled) { return; }
            settled = true;
            if (result) {
                response.body = { result: result.value, type: result.type, variablesReference: 0 };
            } else {
                response.success = false;
                response.message = 'not available';
            }
            this.send(response);
        };
        this.pendingEvals.set(requestId, finish);
        previewDebugBridge.sendCommand('evaluate', { requestId, frameId: args.frameId, expr: args.expression });
        // Fallback so the request never hangs if the webview doesn't answer.
        setTimeout(() => { this.pendingEvals.delete(requestId); finish(undefined); }, 2000);
    }

    // ---- bridge event handlers -----------------------------------------

    private async handleStopped(payload: StoppedPayload): Promise<void> {
        this.lastStopped = payload;
        this.varRefs.clear();
        for (const f of payload.stack) {
            this.varRefs.set(LOCALS_REF_BASE + f.id, f.vars || []);
        }
        this.varRefs.set(WMLVARS_REF, payload.wmlVars || []);

        // Bring the paused .wmls to the front in the source column *before*
        // announcing the stop. The preview webview is usually the active group
        // (the user clicked it to trigger the script), so this makes the source
        // column active and VS Code's own stack-frame reveal lands there instead
        // of beside the preview.
        await this.revealSource(payload);

        const reason = payload.reason === 'step' ? 'step' : 'breakpoint';
        this.sendEvent('stopped', { reason, threadId: 1, allThreadsStopped: true });
    }

    /** Open the innermost paused frame's source in the configured source column. */
    private async revealSource(payload: StoppedPayload): Promise<void> {
        const frame = payload.stack[payload.stack.length - 1];
        if (!frame || !this.root) { return; }
        const fsPath = scriptPathToFsPath(frame.script, this.root);
        try {
            await vscode.window.showTextDocument(vscode.Uri.file(fsPath), {
                viewColumn: this.sourceColumn ?? vscode.ViewColumn.One,
                preserveFocus: false,
                preview: false,
            });
        } catch {
            // file not on disk / not openable — let VS Code's default reveal handle it
        }
    }

    /** (Re)send breakpoints + enable debugging — on configurationDone and on every webview reload. */
    private pushDebugState(): void {
        for (const [script, lines] of this.bps) {
            previewDebugBridge.sendCommand('setBreakpoints', { script, lines });
        }
        previewDebugBridge.sendCommand('setEnabled', { enabled: true });
    }

    // ---- helpers --------------------------------------------------------

    private send(msg: any): void {
        this.sendMessageEmitter.fire(msg);
    }

    private sendEvent(event: string, body?: any): void {
        this.send({ type: 'event', seq: this.seq++, event, body });
    }

    private sendOutput(text: string): void {
        this.sendEvent('output', { category: 'stdout', output: text });
    }

    dispose(): void {
        if (this.disposed) { return; }
        this.disposed = true;
        previewDebugBridge.off('stopped', this.onStopped);
        previewDebugBridge.off('output', this.onOutput);
        previewDebugBridge.off('ready', this.onReady);
        previewDebugBridge.off('evaluateResult', this.onEvalResult);
        previewDebugBridge.sendCommand('setEnabled', { enabled: false });
        this.sendMessageEmitter.dispose();
    }
}
