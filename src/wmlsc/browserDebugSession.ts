/**
 *  Copyright (C) 2026 Jabez Winston
 *
 *  SPDX-License-Identifier: Apache-2.0
 *
 *  Date : 29-May-2026
 *
 *  Host-side hub connecting the WAP Browser panel to the WMLScript bytecode debug
 *  adapter. Both live in the extension host, so (unlike the preview's webview
 *  bridge) this is a plain in-process EventEmitter with direct calls + promises.
 *
 *    WapBrowserPanel ──registerScript / run()──▶ browserDebugSession ──driveRun──▶ WmlsBrowserDebugAdapter
 *           ▲ 'attached' / 'detached' events ───┘
 *
 *  The panel compiles fetched .wmls source (with debug info) and registers each
 *  module by its virtual-document URI; the adapter reads those for breakpoints and
 *  drives the VM step-by-step when the panel requests a run.
 */
import { EventEmitter } from 'events';
import type { WmlscModule } from './decoder';
import type { LineMapEntry } from './compiler';
import type { WmlsValue, LibraryContext } from './stdlib';
import type { VMResult } from './vm';

/** A compiled script registered for debugging, keyed by its `wml-debug:` URI. */
export interface RegisteredScript {
    module: WmlscModule;
    lineMaps: LineMapEntry[][];
    varNames: string[][];
}

/** A request to run a function under debugger control. */
export interface DebugRunRequest extends RegisteredScript {
    sourceUri: string;
    funcName: string;
    args: WmlsValue[];
    ctx: LibraryContext;
}

/** Implemented by the debug adapter; the hub delegates VM driving to it. */
export interface VmDebugDriver {
    driveRun(req: DebugRunRequest): Promise<VMResult>;
    /** Re-resolve pending breakpoints after a script registers. */
    refreshBreakpoints(): void;
}

class BrowserDebugSession extends EventEmitter {
    private driver?: VmDebugDriver;
    private scripts = new Map<string, RegisteredScript>();

    /** Called by the adapter when an attach session starts/ends. */
    attachAdapter(driver: VmDebugDriver): void {
        this.driver = driver;
        this.emit('attached');
    }

    detachAdapter(): void {
        if (!this.driver) { return; }
        this.driver = undefined;
        this.scripts.clear();
        this.emit('detached');
    }

    /** True while a debug session is attached (the panel runs scripts via the VM driver). */
    isDebugging(): boolean {
        return this.driver !== undefined;
    }

    /** Register/replace a compiled module + debug info for a virtual-doc URI. */
    registerScript(sourceUri: string, script: RegisteredScript): void {
        this.scripts.set(sourceUri, script);
        this.driver?.refreshBreakpoints();
    }

    getScript(sourceUri: string): RegisteredScript | undefined {
        return this.scripts.get(sourceUri);
    }

    /** All registered (uri, script) pairs — used by the adapter to resolve breakpoints. */
    listScripts(): [string, RegisteredScript][] {
        return [...this.scripts.entries()];
    }

    /**
     * Run a function under debugger control. Returns the VMResult on completion, or
     * null when there is no active driver / the script isn't registered (the caller
     * then falls back to a normal, non-debug VM run).
     */
    async run(sourceUri: string, funcName: string, args: WmlsValue[], ctx: LibraryContext): Promise<VMResult | null> {
        const script = this.scripts.get(sourceUri);
        if (!this.driver || !script) { return null; }
        return this.driver.driveRun({ sourceUri, funcName, args, ctx, ...script });
    }
}

/** Process-wide singleton (one WAP Browser panel + one debug session at a time). */
export const browserDebugSession = new BrowserDebugSession();
