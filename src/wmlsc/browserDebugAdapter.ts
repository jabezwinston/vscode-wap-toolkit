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
 *  browserDebugSession; when the browser runs one, this adapter drives the VM
 *  step-by-step (see vmDebugAdapter.ts):
 *
 *    WAP Browser ──run()──▶ browserDebugSession ──driveRun──▶ this adapter ──stepOnce()──▶ WmlsVM
 *
 *  The WML deck and .wmls source are shown as read-only `wml-debug:` virtual
 *  documents (see debugSourceProvider.ts).
 */
import * as vscode from 'vscode';
import { WmlsVM, VMResult } from './vm';
import { mkInvalid } from './stdlib';
import type { LineMapEntry } from './compiler';
import { browserDebugSession, DebugRunRequest, VmDebugDriver } from './browserDebugSession';
import { VmDebugAdapter } from './vmDebugAdapter';

export class WmlsBrowserDebugAdapter extends VmDebugAdapter implements VmDebugDriver {
    protected readonly threadName = 'WMLScript (WAP Browser)';

    /** @param sourceColumn editor column where paused .wmls sources should be revealed. */
    constructor(private sourceColumn?: vscode.ViewColumn) {
        super();
        browserDebugSession.attachAdapter(this);
    }

    protected onStart(_request: any, response: any): void {
        this.send(response);
    }

    protected onConfigurationDone(): void {
        this.sendOutput('WMLScript debugger attached. Trigger a script in the WAP Browser to hit breakpoints.\n');
    }

    protected onEnd(): void {
        browserDebugSession.detachAdapter();
    }

    /**
     * Map a DAP `source` to a registered source URI. VS Code sets Source.path to
     * uri.toString() for non-file schemes, so for our `wml-debug:` docs that IS the
     * registry key. Falls back to matching a registered script by basename.
     */
    protected resolveSourceKey(source: any): string {
        const path: string = source?.path ?? '';
        if (path.startsWith('wml-debug:')) { return path; }
        const name: string = source?.name ?? (path ? path.substring(path.lastIndexOf('/') + 1) : '');
        for (const [uri] of browserDebugSession.listScripts()) {
            if (uri === path) { return uri; }
            if (name && uri.substring(uri.lastIndexOf('/') + 1) === name) { return uri; }
        }
        return path || name;
    }

    protected lineMapsFor(sourceKey: string): LineMapEntry[][] | undefined {
        return browserDebugSession.getScript(sourceKey)?.lineMaps;
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

            // The attach session persists for the next script/navigation — no 'terminated'.
            this.startRun({
                vm, sourceKey: req.sourceUri, lineMaps: req.lineMaps, varNames: req.varNames, funcNames: req.funcNames,
                onDone: (result) => resolve(result),
            });
        });
    }

    // ---- helpers --------------------------------------------------------

    /** Reveal the paused source line before announcing the stop, so VS Code's own
     *  stack-frame reveal lands on the right document/line. */
    protected async beforeStop(sourceUri: string, line: number): Promise<void> {
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
}
