/**
 *  Copyright (C) 2026 Jabez Winston
 * 
 *  SPDX-License-Identifier: Apache-2.0
 *
 *  Date : 17-March-2026
 */

import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { wmlToHtml } from './wmlToHtml';
import { previewDebugBridge } from '../wmlsc/previewDebugBridge';

export class WmlPreviewPanel {
    public static currentPanel: WmlPreviewPanel | undefined;
    private static readonly viewType = 'wmlPreview';

    private readonly panel: vscode.WebviewPanel;
    private readonly extensionUri: vscode.Uri;
    private disposables: vscode.Disposable[] = [];
    private currentDocument: vscode.Uri | undefined;
    // Stack of decks visited via cross-deck navigation, for cross-deck Back.
    private deckHistory: vscode.Uri[] = [];

    private constructor(panel: vscode.WebviewPanel, extensionUri: vscode.Uri) {
        this.panel = panel;
        this.extensionUri = extensionUri;

        // Bridge the preview webview to the WMLScript debug adapter. The webview's
        // wmlsDebugBridge.js posts a 'ready' event on (re)load, so this single
        // attach survives auto-refresh reloads.
        previewDebugBridge.attachWebview(this.panel.webview);

        // Cross-deck navigation: VS Code webviews block window.location, so the
        // in-page engine posts a 'wmlNavigate' message instead of navigating.
        // Load the target deck here and re-render. (Debug 'wmlsDbg' messages are
        // handled separately by previewDebugBridge.)
        this.panel.webview.onDidReceiveMessage((msg) => {
            if (msg && msg.type === 'wmlNavigate') {
                this.navigateTo(String(msg.href || ''));
            } else if (msg && msg.type === 'wmlNavigateBack') {
                this.navigateBack();
            }
        }, null, this.disposables);

        this.panel.onDidDispose(() => this.dispose(), null, this.disposables);

        // Listen for document changes
        vscode.workspace.onDidSaveTextDocument((doc) => {
            const config = vscode.workspace.getConfiguration('wml');
            if (config.get<boolean>('preview.autoRefresh', true) && this.currentDocument) {
                if (doc.uri.fsPath === this.currentDocument.fsPath) {
                    this.update();
                }
            }
        }, null, this.disposables);
    }

    public static createOrShow(extensionUri: vscode.Uri, documentUri: vscode.Uri, preserveFocus = false): void {
        const column = vscode.ViewColumn.Beside;

        if (WmlPreviewPanel.currentPanel) {
            WmlPreviewPanel.currentPanel.currentDocument = documentUri;
            WmlPreviewPanel.currentPanel.deckHistory = [];  // new browsing session
            WmlPreviewPanel.currentPanel.panel.reveal(column, preserveFocus);
            WmlPreviewPanel.currentPanel.update();
            return;
        }

        const panel = vscode.window.createWebviewPanel(
            WmlPreviewPanel.viewType,
            'WML Preview',
            // preserveFocus keeps the source editor active so the debugger reveals
            // .wmls breakpoints next to the source, not beside the preview.
            { viewColumn: column, preserveFocus },
            {
                enableScripts: true,
                localResourceRoots: [extensionUri],
                retainContextWhenHidden: true,
            }
        );

        WmlPreviewPanel.currentPanel = new WmlPreviewPanel(panel, extensionUri);
        WmlPreviewPanel.currentPanel.currentDocument = documentUri;
        WmlPreviewPanel.currentPanel.update();
    }

    public update(): void {
        if (!this.currentDocument) {
            return;
        }

        try {
            const content = fs.readFileSync(this.currentDocument.fsPath, 'utf-8');
            const config = vscode.workspace.getConfiguration('wml');
            const showFrame = config.get<boolean>('preview.phoneFrame', true);
            const html = wmlToHtml(content, this.currentDocument.fsPath, showFrame);
            this.panel.webview.html = html;
        } catch (err) {
            this.panel.webview.html = `<html><body><h3>Error previewing WML</h3><pre>${err}</pre></body></html>`;
        }
    }

    /**
     * Navigate the preview to another deck. `href` is resolved relative to the
     * directory of the currently previewed document. A `#card` fragment is
     * dropped (the whole deck is rendered; intra-deck card jumps are handled
     * client-side). http(s) links open in the external browser.
     */
    private navigateTo(href: string): void {
        if (!href || !this.currentDocument) {
            return;
        }

        if (/^https?:\/\//i.test(href)) {
            vscode.env.openExternal(vscode.Uri.parse(href));
            return;
        }

        // Strip query string and card fragment to get the file path.
        const filePart = href.replace(/[?#].*$/, '');
        if (!filePart) {
            // Same deck (only a fragment/query) — just refresh.
            this.update();
            return;
        }

        const baseDir = path.dirname(this.currentDocument.fsPath);
        const target = path.resolve(baseDir, decodeURIComponent(filePart));
        if (fs.existsSync(target) && fs.statSync(target).isFile()) {
            if (target !== this.currentDocument.fsPath) {
                this.deckHistory.push(this.currentDocument);  // remember where we came from
            }
            this.currentDocument = vscode.Uri.file(target);
            this.update();
        } else {
            vscode.window.showWarningMessage(`WML Preview: cannot open '${filePart}' (file not found)`);
        }
    }

    /**
     * Cross-deck Back: return to the previously-visited deck. Fired by the
     * in-page engine only once the current deck's own card history is exhausted,
     * so intra-deck Back stays client-side. The deck re-opens at its first card.
     */
    private navigateBack(): void {
        const prev = this.deckHistory.pop();
        if (prev) {
            this.currentDocument = prev;
            this.update();
        }
    }

    public dispose(): void {
        WmlPreviewPanel.currentPanel = undefined;
        previewDebugBridge.detachWebview();
        this.panel.dispose();
        while (this.disposables.length) {
            const d = this.disposables.pop();
            if (d) {
                d.dispose();
            }
        }
    }
}
