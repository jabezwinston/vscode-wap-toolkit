/**
 *  Copyright (C) 2026 Jabez Winston
 *
 *  SPDX-License-Identifier: Apache-2.0
 *
 *  Date : 29-May-2026
 *
 *  Preview debug bridge — an in-extension hub connecting the WML preview
 *  webview to the WMLScript DAP debug adapter.
 *
 *  The WmlPreviewPanel registers its webview here; the WmlsPreviewDebugAdapter
 *  subscribes to events and sends step/breakpoint commands. Messages travel
 *  over the webview postMessage channel as `{ type: 'wmlsDbg', ... }`.
 */
import * as vscode from 'vscode';
import { EventEmitter } from 'events';

/** Events emitted toward subscribers (the debug adapter): the webview's `ev` name. */
export type WmlsBridgeEvent =
    | 'attached' | 'detached'
    | 'ready' | 'stopped' | 'continued' | 'output' | 'evaluateResult' | 'terminated';

class PreviewDebugBridge extends EventEmitter {
    private webview?: vscode.Webview;
    private sub?: vscode.Disposable;

    /** Called by WmlPreviewPanel when its webview is created. */
    attachWebview(webview: vscode.Webview): void {
        this.detachWebview();
        this.webview = webview;
        this.sub = webview.onDidReceiveMessage((msg) => {
            if (!msg || msg.type !== 'wmlsDbg' || !msg.ev) { return; }
            this.emit(msg.ev, msg.payload);
        });
        this.emit('attached');
    }

    detachWebview(): void {
        this.sub?.dispose();
        this.sub = undefined;
        if (this.webview) {
            this.webview = undefined;
            this.emit('detached');
        }
    }

    isAttached(): boolean {
        return this.webview !== undefined;
    }

    /** Send a command to the webview's __wmls._dbg controller. */
    sendCommand(cmd: string, args?: unknown): void {
        this.webview?.postMessage({ type: 'wmlsDbg', cmd, args });
    }
}

/** Process-wide singleton (one WML preview panel exists at a time). */
export const previewDebugBridge = new PreviewDebugBridge();
