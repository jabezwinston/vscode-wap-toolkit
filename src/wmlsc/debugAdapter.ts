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
 *  `launch` runs one function of a standalone .wmls / .wmlsc file on the
 *  bytecode VM, with breakpoints, stepping, variables and the call stack
 *  (see vmDebugAdapter.ts). The factory also hands out the `attach` adapters.
 */
import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { WmlsVM } from './vm';
import { decodeWmlsc } from './decoder';
import { compileWmlsWithDebugInfo, DebugInfo } from './compiler';
import {
    WmlsValue, mkInt, mkFloat, mkString, mkBool, mkInvalid, createDefaultContext,
} from './stdlib';
import { WmlsPreviewDebugAdapter } from './previewDebugAdapter';
import { WmlsBrowserDebugAdapter } from './browserDebugAdapter';
import { VmDebugAdapter } from './vmDebugAdapter';

const DEFAULT_MAX_STEPS = 10_000_000;

/** A launch configuration's `args` entry as a WMLScript value. */
function toWmlsValue(a: unknown): WmlsValue {
    if (typeof a === 'number') { return Number.isInteger(a) ? mkInt(a) : mkFloat(a); }
    if (typeof a === 'string') { return mkString(a); }
    if (typeof a === 'boolean') { return mkBool(a); }
    return mkInvalid();
}

/** The launch program, compiled and ready to run on configurationDone. */
interface LaunchedProgram extends DebugInfo {
    vm: WmlsVM;
    sourceKey: string;
}

/**
 * The `launch` adapter. The run starts once both `launch` and
 * `configurationDone` have arrived, so every breakpoint is in place.
 */
export class WmlsDebugAdapter extends VmDebugAdapter {
    protected readonly threadName = 'WMLScript main';

    private program?: LaunchedProgram;
    private configured = false;
    private started = false;

    protected onStart(request: any, response: any): void {
        const args = request.arguments || {};
        try {
            this.program = this.load(args);
        } catch (err: any) {
            response.success = false;
            response.message = err?.message ?? String(err);
            this.send(response);
            return;
        }
        this.send(response);
        // Breakpoints set before the program was compiled can be verified now.
        this.refreshBreakpoints();
        this.maybeStart();
    }

    protected onConfigurationDone(): void {
        this.configured = true;
        this.maybeStart();
    }

    /** Compile (.wmls, with debug info) or decode (.wmlsc) the program and prepare the call. */
    private load(args: any): LaunchedProgram {
        if (!args.program) { throw new Error('No program to debug'); }
        const sourceKey = path.resolve(String(args.program));
        const data = fs.readFileSync(sourceKey);

        let debugInfo: DebugInfo = { lineMaps: [], varNames: [], funcNames: [] };
        let bytecode: Buffer;
        if (sourceKey.toLowerCase().endsWith('.wmlsc')) {
            // Compiled bytecode carries no source lines: it runs, but cannot break.
            bytecode = Buffer.from(data);
        } else {
            ({ bytecode, ...debugInfo } = compileWmlsWithDebugInfo(data.toString('utf-8')));
        }
        const mod = decodeWmlsc(bytecode);

        const funcName: string = args.function || 'main';
        const funcIndex = mod.functions.findIndex(f => f.name === funcName);
        if (funcIndex === -1) { throw new Error(`Function '${funcName}' not found`); }
        const fn = mod.functions[funcIndex];
        const funcArgs: WmlsValue[] = (args.args || []).map(toWmlsValue);
        // WMLScript: 12.3.1.3 — a call from outside the unit passes exactly the function's arguments.
        if (funcArgs.length !== fn.numArgs) {
            throw new Error(`${funcName} takes ${fn.numArgs} argument(s), not ${funcArgs.length}: set "args" in launch.json`);
        }

        const ctx = createDefaultContext();
        const vm = new WmlsVM(mod, { context: ctx, maxSteps: args.maxSteps || DEFAULT_MAX_STEPS });
        // Stream Console output live to the Debug Console (the VM reads ctx.onOutput on each call).
        ctx.onOutput = (text: string) => this.sendOutput(text);
        if (!vm.prepareCall(funcIndex, funcArgs)) {
            throw new Error(`Verification failed: ${vm.getVerifyErrors()[0] ?? 'invalid function'}`);
        }
        return { vm, sourceKey, ...debugInfo };
    }

    private maybeStart(): void {
        const p = this.program;
        if (!p || !this.configured || this.started) { return; }
        this.started = true;
        this.startRun({
            ...p,
            onDone: (result, byUser) => {
                if (byUser) { return; } // terminate/disconnect answers for itself
                this.sendEvent('exited', { exitCode: result.error ? 1 : 0 });
                this.sendEvent('terminated');
            },
        });
    }

    protected resolveSourceKey(source: any): string {
        return source?.path ? path.resolve(String(source.path)) : String(source?.name ?? '');
    }

    protected lineMapsFor(sourceKey: string): DebugInfo['lineMaps'] | undefined {
        return this.program && sourceKey === this.program.sourceKey ? this.program.lineMaps : undefined;
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
