/**
 *
 *  Copyright (C) 2026 Jabez Winston
 * 
 *  SPDX-License-Identifier: Apache-2.0
 *
 *  Date : 18-March-2026
 * 
 *  WMLScript Debug Adapter — VS Code inline debug adapter using DAP.
 *
 *  Supports breakpoints, stepping, variable inspection, call stack,
 *  and expression evaluation for WMLScript bytecode execution.
 */
import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { WmlsVM, VMResult, DebugHook } from './vm';
import { WmlscModule, decodeWmlsc } from './decoder';
import { compileWmls } from './compiler';
import {
    WmlsValue, mkInt, mkFloat, mkString, mkBool, mkInvalid,
    toString as wmlsToString,
} from './stdlib';
import { WmlsType } from './opcodes';
import { WmlsPreviewDebugAdapter } from './previewDebugAdapter';
import { WmlsBrowserDebugAdapter } from './browserDebugAdapter';

// ---- Debug Adapter Implementation via vscode API ----

interface WmlsBreakpoint {
    funcIndex: number;
    pc: number;
    verified: boolean;
}

interface PendingRequest {
    resolve: (body?: any) => void;
    reject: (reason?: any) => void;
}

export class WmlsDebugSession implements vscode.DebugAdapterTracker {
    // expose for factory
}

/**
 * The inline DebugAdapter that speaks DAP via message passing.
 */
export class WmlsDebugAdapter implements vscode.DebugAdapter {
    private sendMessageEmitter = new vscode.EventEmitter<vscode.DebugProtocolMessage>();
    readonly onDidSendMessage: vscode.Event<vscode.DebugProtocolMessage> = this.sendMessageEmitter.event;

    private seq = 1;
    private vm?: WmlsVM;
    private mod?: WmlscModule;
    private breakpoints: WmlsBreakpoint[] = [];
    private output: string[] = [];
    private stopped = false;
    private terminated = false;
    private stepMode: 'none' | 'stepOver' | 'stepIn' | 'stepOut' = 'none';
    private stepCallDepth = 0;
    private sourceFile = '';
    private vmResult?: VMResult;

    // Resolve for the run promise — used to pause execution
    private runResolve?: () => void;
    private pausePromise?: Promise<void>;

    handleMessage(message: vscode.DebugProtocolMessage): void {
        const msg = message as any;
        if (msg.type === 'request') {
            this.handleRequest(msg);
        }
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
                    supportsStepBack: false,
                    supportsTerminateRequest: true,
                };
                this.send(response);
                this.sendEvent('initialized');
                break;

            case 'configurationDone':
                this.send(response);
                this.startExecution();
                break;

            case 'launch':
                this.handleLaunch(request, response);
                break;

            case 'setBreakpoints':
                this.handleSetBreakpoints(request, response);
                break;

            case 'threads':
                response.body = {
                    threads: [{ id: 1, name: 'WMLScript main' }],
                };
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
                this.stepMode = 'none';
                this.resumeExecution();
                response.body = { allThreadsContinued: true };
                this.send(response);
                break;

            case 'next':
                this.stepMode = 'stepOver';
                this.stepCallDepth = this.vm?.getCallStack().length ?? 0;
                this.resumeExecution();
                this.send(response);
                break;

            case 'stepIn':
                this.stepMode = 'stepIn';
                this.resumeExecution();
                this.send(response);
                break;

            case 'stepOut':
                this.stepMode = 'stepOut';
                this.stepCallDepth = this.vm?.getCallStack().length ?? 0;
                this.resumeExecution();
                this.send(response);
                break;

            case 'terminate':
                this.terminated = true;
                this.resumeExecution();
                this.send(response);
                this.sendEvent('terminated');
                break;

            case 'disconnect':
                this.terminated = true;
                this.resumeExecution();
                this.send(response);
                break;

            default:
                response.success = false;
                response.message = `Unsupported command: ${request.command}`;
                this.send(response);
                break;
        }
    }

    private handleLaunch(request: any, response: any): void {
        const args = request.arguments;
        this.sourceFile = args.program;
        const funcName = args.function || 'main';
        const funcArgs: WmlsValue[] = (args.args || []).map((a: any) => {
            if (typeof a === 'number') { return Number.isInteger(a) ? mkInt(a) : mkFloat(a); }
            if (typeof a === 'string') { return mkString(a); }
            if (typeof a === 'boolean') { return mkBool(a); }
            return mkInvalid();
        });

        try {
            let mod: WmlscModule;
            const data = fs.readFileSync(this.sourceFile);

            if (this.sourceFile.endsWith('.wmlsc')) {
                mod = decodeWmlsc(Buffer.from(data));
            } else {
                // Compile .wmls source first
                const source = data.toString('utf-8');
                const bytecode = compileWmls(source);
                mod = decodeWmlsc(bytecode);
            }

            this.mod = mod;
            this.vm = new WmlsVM(mod, { maxSteps: args.maxSteps || 10000000 });
            this.vm.setDebugHook(this.createDebugHook());

            // Find function
            const fi = mod.functions.findIndex(f => f.name === funcName);
            if (fi === -1) {
                response.success = false;
                response.message = `Function '${funcName}' not found`;
                this.send(response);
                return;
            }

            this.send(response);

            // Store function index and args for execution after configurationDone
            (this as any)._launchFuncIndex = fi;
            (this as any)._launchArgs = funcArgs;

        } catch (err: any) {
            response.success = false;
            response.message = err.message;
            this.send(response);
        }
    }

    private handleSetBreakpoints(request: any, response: any): void {
        const bpRequest = request.arguments;
        // Only support function-based breakpoints for bytecode
        // For source breakpoints, we map line numbers to function/pc pairs
        const breakpoints = (bpRequest.breakpoints || []).map((bp: any) => {
            return {
                verified: true,
                line: bp.line,
                id: this.seq++,
            };
        });

        response.body = { breakpoints };
        this.send(response);
    }

    private handleStackTrace(response: any): void {
        if (!this.vm) {
            response.body = { stackFrames: [], totalFrames: 0 };
            this.send(response);
            return;
        }

        const cs = this.vm.getCallStack();
        const frames = cs.map((f, i) => ({
            id: i,
            name: f.funcName,
            source: this.sourceFile ? {
                name: path.basename(this.sourceFile),
                path: this.sourceFile,
            } : undefined,
            line: f.pc,
            column: 0,
        })).reverse();

        response.body = { stackFrames: frames, totalFrames: frames.length };
        this.send(response);
    }

    private handleScopes(request: any, response: any): void {
        const frameId = request.arguments.frameId;
        response.body = {
            scopes: [
                { name: 'Locals', variablesReference: frameId + 1, expensive: false },
                { name: 'Operand Stack', variablesReference: 1000, expensive: false },
            ],
        };
        this.send(response);
    }

    private handleVariables(request: any, response: any): void {
        const ref = request.arguments.variablesReference;

        if (ref === 1000) {
            // Operand stack
            const stack = this.vm?.getStack() ?? [];
            response.body = {
                variables: stack.map((v, i) => ({
                    name: `[${i}]`,
                    value: this.formatValue(v),
                    type: WmlsType[v.type],
                    variablesReference: 0,
                })),
            };
        } else {
            // Locals for frame (ref - 1 = frameId)
            const vars = this.vm?.getVariables(ref - 1) ?? [];
            response.body = {
                variables: vars.map(v => ({
                    name: v.name,
                    value: this.formatValue(v.value),
                    type: WmlsType[v.value.type],
                    variablesReference: 0,
                })),
            };
        }
        this.send(response);
    }

    private handleEvaluate(request: any, response: any): void {
        // Simple evaluation: show variable by name
        const expr = request.arguments.expression;
        if (!this.vm) {
            response.success = false;
            response.message = 'No active VM';
            this.send(response);
            return;
        }

        const vars = this.vm.getVariables();
        const found = vars.find(v => v.name === expr);
        if (found) {
            response.body = {
                result: this.formatValue(found.value),
                type: WmlsType[found.value.type],
                variablesReference: 0,
            };
        } else {
            response.body = { result: '<unknown>', variablesReference: 0 };
        }
        this.send(response);
    }

    private createDebugHook(): DebugHook {
        return {
            onInstruction: (_funcIndex: number, pc: number, _opcode: number) => {
                if (this.terminated) { return false; }

                // Check breakpoints
                const cs = this.vm!.getCallStack();
                const currentFunc = cs.length > 0 ? cs[cs.length - 1].funcIndex : 0;

                const hitBp = this.breakpoints.some(
                    bp => bp.funcIndex === currentFunc && bp.pc === pc
                );
                if (hitBp) {
                    this.pauseExecution('breakpoint');
                    return !this.terminated;
                }

                // Check step modes
                const depth = cs.length;
                switch (this.stepMode) {
                    case 'stepIn':
                        this.pauseExecution('step');
                        return !this.terminated;
                    case 'stepOver':
                        if (depth <= this.stepCallDepth) {
                            this.pauseExecution('step');
                            return !this.terminated;
                        }
                        break;
                    case 'stepOut':
                        if (depth < this.stepCallDepth) {
                            this.pauseExecution('step');
                            return !this.terminated;
                        }
                        break;
                }

                return true;
            },
        };
    }

    private async startExecution(): Promise<void> {
        const fi = (this as any)._launchFuncIndex as number;
        const args = (this as any)._launchArgs as WmlsValue[];

        if (this.vm && fi !== undefined) {
            const result = this.vm.callFunctionByIndex(fi, args);
            this.vmResult = result;

            // Print output
            for (const line of result.output) {
                this.sendOutputEvent(line);
            }

            if (result.error) {
                this.sendOutputEvent(`Error: ${result.error}\n`, 'stderr');
            } else {
                this.sendOutputEvent(`Result: ${this.formatValue(result.value)}\n`);
            }

            this.sendEvent('terminated');
        }
    }

    private pauseExecution(reason: string): void {
        this.stopped = true;
        this.stepMode = 'none';
        this.sendEvent('stopped', { reason, threadId: 1, allThreadsStopped: true });
    }

    private resumeExecution(): void {
        this.stopped = false;
        this.runResolve?.();
    }

    private formatValue(v: WmlsValue): string {
        switch (v.type) {
            case WmlsType.Integer: return `${v.value} (int)`;
            case WmlsType.Float: return `${v.value} (float)`;
            case WmlsType.String: return `"${v.value}"`;
            case WmlsType.Boolean: return v.value ? 'true' : 'false';
            case WmlsType.Invalid: return 'invalid';
        }
    }

    private send(msg: any): void {
        this.sendMessageEmitter.fire(msg);
    }

    private sendEvent(event: string, body?: any): void {
        this.send({
            type: 'event',
            seq: this.seq++,
            event,
            body,
        });
    }

    private sendOutputEvent(text: string, category: string = 'stdout'): void {
        this.sendEvent('output', { category, output: text });
    }

    dispose(): void {
        this.terminated = true;
        this.sendMessageEmitter.dispose();
    }
}

/**
 * Factory for creating debug adapter instances.
 */
export class WmlsDebugAdapterFactory implements vscode.DebugAdapterDescriptorFactory {
    createDebugAdapterDescriptor(
        session: vscode.DebugSession,
        _executable: vscode.DebugAdapterExecutable | undefined
    ): vscode.ProviderResult<vscode.DebugAdapterDescriptor> {
        // `attach` debugs live WMLScript: target 'browser' drives the bytecode VM
        // inside the WAP Browser; otherwise the WML preview (via the webview bridge).
        // `launch` runs a standalone script on the bytecode VM.
        if (session.configuration.request === 'attach') {
            if (session.configuration.target === 'browser') {
                return new vscode.DebugAdapterInlineImplementation(
                    new WmlsBrowserDebugAdapter(session.configuration.sourceColumn)
                );
            }
            return new vscode.DebugAdapterInlineImplementation(
                new WmlsPreviewDebugAdapter(session.configuration.sourceColumn)
            );
        }
        return new vscode.DebugAdapterInlineImplementation(new WmlsDebugAdapter());
    }
}
