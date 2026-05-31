/**
 *  Copyright (C) 2026 Jabez Winston
 *
 *  SPDX-License-Identifier: Apache-2.0
 *
 *  Date : 29-May-2026
 *
 *  Read-only virtual documents for WAP Browser debugging.
 *
 *  Decks and scripts fetched by the browser are not workspace files, so to place
 *  breakpoints and reveal the paused line we surface their source through this
 *  TextDocumentContentProvider under the `wml-debug` scheme (see debugUri.ts). The
 *  documents are inherently read-only and are dropped when the debug session ends.
 */
import * as vscode from 'vscode';
import { DEBUG_SCHEME } from './debugUri';

export class WmlDebugSourceProvider implements vscode.TextDocumentContentProvider {
    private readonly contents = new Map<string, string>();
    private readonly _onDidChange = new vscode.EventEmitter<vscode.Uri>();
    readonly onDidChange = this._onDidChange.event;

    provideTextDocumentContent(uri: vscode.Uri): string {
        return this.contents.get(uri.toString()) ?? '';
    }

    /** Register or replace the source text of a virtual document, notifying VS Code
     *  so an already-open editor refreshes. */
    register(uri: vscode.Uri, content: string): void {
        const key = uri.toString();
        const had = this.contents.has(key);
        const prev = this.contents.get(key);
        this.contents.set(key, content);
        if (had && prev !== content) { this._onDidChange.fire(uri); }
    }

    has(uri: vscode.Uri): boolean { return this.contents.has(uri.toString()); }

    /** Drop all virtual documents (called when the debug session ends). */
    clear(): void { this.contents.clear(); }

    dispose(): void { this._onDidChange.dispose(); }
}

/** Process-wide singleton, registered once for the `wml-debug` scheme in extension.ts. */
export const debugSourceProvider = new WmlDebugSourceProvider();

export { DEBUG_SCHEME };
