/**
 *  Copyright (C) 2026 Jabez Winston
 * 
 *  SPDX-License-Identifier: Apache-2.0
 *
 *  Date : 27-March-2026
 * 
 *  Disassemble WMLScript bytecode (.wmlsc) files into human-readable assembly format.
 */

import * as vscode from 'vscode';
import * as fs from 'fs';
import { disassembleWmlsc } from './decoder';
import { escapeHtml } from '../shared/htmlUtils';

const SCHEME = 'wmlsc-disasm';

export class WmlscDisassemblyProvider implements vscode.TextDocumentContentProvider {
    private _onDidChange = new vscode.EventEmitter<vscode.Uri>();
    readonly onDidChange = this._onDidChange.event;

    provideTextDocumentContent(uri: vscode.Uri): string {
        const filePath = uri.query;
        try {
            const data = fs.readFileSync(filePath);
            return disassembleWmlsc(Buffer.from(data));
        } catch (err: any) {
            return `; Error disassembling: ${err.message}`;
        }
    }

    refresh(uri: vscode.Uri): void {
        this._onDidChange.fire(uri);
    }

    static toDisasmUri(fileUri: vscode.Uri): vscode.Uri {
        const name = fileUri.fsPath.split('/').pop() || 'disassembly';
        return vscode.Uri.parse(`${SCHEME}:${name}?${fileUri.fsPath}`);
    }

    static get scheme(): string {
        return SCHEME;
    }
}

export class WmlscEditorProvider implements vscode.CustomReadonlyEditorProvider {
    public static readonly viewType = 'wml.wmlscDisassembly';

    constructor(private readonly context: vscode.ExtensionContext) {}

    openCustomDocument(uri: vscode.Uri): vscode.CustomDocument {
        return { uri, dispose: () => {} };
    }

    resolveCustomEditor(document: vscode.CustomDocument, webviewPanel: vscode.WebviewPanel): void {
        webviewPanel.webview.options = { enableScripts: false };

        try {
            const data = fs.readFileSync(document.uri.fsPath);
            const disasm = disassembleWmlsc(Buffer.from(data));
            webviewPanel.webview.html = this.renderHtml(disasm, document.uri);
        } catch (err: any) {
            webviewPanel.webview.html = `<!DOCTYPE html><html><body><pre>Error: ${escapeHtml(err.message)}</pre></body></html>`;
        }
    }

    private renderHtml(disasm: string, uri: vscode.Uri): string {
        const fileName = uri.fsPath.split('/').pop() || 'disassembly';
        const highlighted = this.highlight(disasm);

        return `<!DOCTYPE html>
<html>
<head>
<style>
  body {
    margin: 0;
    padding: 16px;
    font-family: var(--vscode-editor-font-family, 'Consolas, Courier New, monospace');
    font-size: var(--vscode-editor-font-size, 14px);
    line-height: var(--vscode-editor-line-height, 1.5);
    background: var(--vscode-editor-background);
    color: var(--vscode-editor-foreground);
    white-space: pre;
    tab-size: 4;
    -moz-tab-size: 4;
  }
  .comment { color: var(--vscode-editorLineNumber-foreground, #6a9955); }
  .heading { color: var(--vscode-editorLineNumber-foreground, #6a9955); font-weight: bold; }
  .address { color: var(--vscode-editorLineNumber-foreground, #858585); }
  .hexbytes { color: var(--vscode-debugTokenExpression-string, #9cdcfe); }
  .mnemonic { color: var(--vscode-symbolIcon-keywordForeground, #569cd6); font-weight: bold; }
  .operand { color: var(--vscode-debugTokenExpression-number, #b5cea8); }
  .inline-comment { color: var(--vscode-editorLineNumber-foreground, #6a9955); }
</style>
</head>
<body>${highlighted}</body>
</html>`;
    }

    private highlight(text: string): string {
        return text.split('\n').map(line => {
            // Section headers: ; === ... ===
            if (/^;\s*===/.test(line)) {
                return `<span class="heading">${escapeHtml(line)}</span>`;
            }
            // Comment lines
            if (/^;/.test(line)) {
                return `<span class="comment">${escapeHtml(line)}</span>`;
            }
            // Instruction lines: "  0000  xx xx  MNEMONIC operands  ; comment"
            const m = line.match(/^(\s+\d{4}\s+)((?:[0-9a-f]{2}\s?)+\s+)(\S+)(.*?)(\s+;.*)?$/);
            if (m) {
                const addr = `<span class="address">${escapeHtml(m[1])}</span>`;
                const hex = `<span class="hexbytes">${escapeHtml(m[2])}</span>`;
                const mnem = `<span class="mnemonic">${escapeHtml(m[3])}</span>`;
                const ops = m[4] ? `<span class="operand">${escapeHtml(m[4])}</span>` : '';
                const cmt = m[5] ? `<span class="inline-comment">${escapeHtml(m[5])}</span>` : '';
                return addr + hex + mnem + ops + cmt;
            }
            // Empty lines or other
            return escapeHtml(line);
        }).join('\n');
    }

}

export function registerWmlscDisassemblyView(context: vscode.ExtensionContext): void {
    const provider = new WmlscDisassemblyProvider();

    context.subscriptions.push(
        vscode.workspace.registerTextDocumentContentProvider(SCHEME, provider)
    );

    // Register the custom editor for .wmlsc files
    context.subscriptions.push(
        vscode.window.registerCustomEditorProvider(
            WmlscEditorProvider.viewType,
            new WmlscEditorProvider(context),
            { webviewOptions: { retainContextWhenHidden: false } }
        )
    );

    // Watch for .wmlsc file changes to refresh the disassembly
    const watcher = vscode.workspace.createFileSystemWatcher('**/*.wmlsc');
    context.subscriptions.push(
        watcher.onDidChange(uri => {
            provider.refresh(WmlscDisassemblyProvider.toDisasmUri(uri));
        })
    );
    context.subscriptions.push(watcher);
}
