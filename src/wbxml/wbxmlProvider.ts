/**
 *  Copyright (C) 2026 Jabez Winston
 * 
 *  SPDX-License-Identifier: Apache-2.0
 *
 *  Date : 07-April-2026
 * 
 *  Preview WBXML files in human-readable WML format.
 */

import * as vscode from 'vscode';
import * as fs from 'fs';
import { decodeWbxml } from './decoder';

export class WbxmlEditorProvider implements vscode.CustomReadonlyEditorProvider {
    public static readonly viewType = 'wml.wbxmlViewer';

    constructor(private readonly context: vscode.ExtensionContext) {}

    openCustomDocument(uri: vscode.Uri): vscode.CustomDocument {
        return { uri, dispose: () => {} };
    }

    resolveCustomEditor(document: vscode.CustomDocument, webviewPanel: vscode.WebviewPanel): void {
        webviewPanel.webview.options = { enableScripts: false };

        try {
            const data = fs.readFileSync(document.uri.fsPath);
            const wml = decodeWbxml(Buffer.from(data));
            webviewPanel.webview.html = this.renderHtml(wml, document.uri, data.length);
        } catch (err: any) {
            webviewPanel.webview.html = `<!DOCTYPE html><html><body><pre>Error decoding WBXML: ${this.escapeHtml(err.message)}</pre></body></html>`;
        }
    }

    private renderHtml(wml: string, uri: vscode.Uri, binarySize: number): string {
        const fileName = uri.fsPath.split('/').pop() || 'file';
        const highlighted = this.highlightWml(wml);

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
  }
  .header {
    padding: 8px 12px;
    margin-bottom: 12px;
    border-bottom: 1px solid var(--vscode-panel-border, #444);
    font-size: 12px;
    color: var(--vscode-descriptionForeground, #999);
  }
  .header strong { color: var(--vscode-editor-foreground); }
  .header .stat { color: var(--vscode-debugTokenExpression-number, #b5cea8); }
  pre {
    margin: 0;
    white-space: pre;
    tab-size: 2;
    -moz-tab-size: 2;
  }
  .xml-decl { color: var(--vscode-editorLineNumber-foreground, #858585); }
  .doctype { color: var(--vscode-editorLineNumber-foreground, #858585); }
  .tag { color: var(--vscode-symbolIcon-keywordForeground, #569cd6); }
  .attr-name { color: var(--vscode-debugTokenExpression-string, #9cdcfe); }
  .attr-value { color: var(--vscode-debugTokenExpression-number, #ce9178); }
  .text { color: var(--vscode-editor-foreground); }
  .entity { color: var(--vscode-debugTokenExpression-number, #b5cea8); }
  .variable { color: var(--vscode-symbolIcon-variableForeground, #dcdcaa); }
  .comment { color: var(--vscode-editorLineNumber-foreground, #6a9955); }
</style>
</head>
<body>
  <div class="header">
    <strong>${this.escapeHtml(fileName)}</strong> &mdash;
    Decompiled from WBXML
    (<span class="stat">${binarySize}</span> bytes binary &rarr;
    <span class="stat">${wml.length}</span> chars WML)
  </div>
  <pre>${highlighted}</pre>
</body>
</html>`;
    }

    private highlightWml(wml: string): string {
        // Process line by line for structure, then highlight XML syntax
        return wml.split('\n').map(line => this.highlightLine(line)).join('\n');
    }

    private highlightLine(line: string): string {
        // XML declaration
        if (/^<\?xml\b/.test(line)) {
            return `<span class="xml-decl">${this.escapeHtml(line)}</span>`;
        }
        // DOCTYPE
        if (/^<!DOCTYPE\b/.test(line) || /^\s+"http:\/\//.test(line)) {
            return `<span class="doctype">${this.escapeHtml(line)}</span>`;
        }
        // XML comment
        if (/^\s*<!--/.test(line)) {
            return `<span class="comment">${this.escapeHtml(line)}</span>`;
        }
        // Tag lines
        return this.highlightTagLine(line);
    }

    private highlightTagLine(line: string): string {
        let result = '';
        let i = 0;
        const src = line;

        while (i < src.length) {
            // Look for tags
            if (src[i] === '<') {
                const tagEnd = src.indexOf('>', i);
                if (tagEnd === -1) {
                    result += this.escapeHtml(src.substring(i));
                    break;
                }
                const tagContent = src.substring(i, tagEnd + 1);
                result += this.highlightTag(tagContent);
                i = tagEnd + 1;
            } else {
                // Text content before next tag
                const nextTag = src.indexOf('<', i);
                const textEnd = nextTag === -1 ? src.length : nextTag;
                const text = src.substring(i, textEnd);
                result += this.highlightTextContent(text);
                i = textEnd;
            }
        }

        return result;
    }

    private highlightTag(tag: string): string {
        // Closing tag: </tagname>
        const closeMatch = tag.match(/^<\/([\w:-]+)>$/);
        if (closeMatch) {
            return `<span class="tag">&lt;/${this.escapeHtml(closeMatch[1])}&gt;</span>`;
        }

        // Self-closing or opening tag with attributes
        const openMatch = tag.match(/^<([\w:-]+)(.*?)(\/?)>$/s);
        if (openMatch) {
            const tagName = openMatch[1];
            const attrsStr = openMatch[2];
            const selfClose = openMatch[3];

            let result = `<span class="tag">&lt;${this.escapeHtml(tagName)}</span>`;
            if (attrsStr.trim()) {
                result += this.highlightAttributes(attrsStr);
            }
            result += `<span class="tag">${selfClose ? '/&gt;' : '&gt;'}</span>`;
            return result;
        }

        // Fallback
        return `<span class="tag">${this.escapeHtml(tag)}</span>`;
    }

    private highlightAttributes(attrs: string): string {
        let result = '';
        // Match attribute="value" pairs, handling WML variable refs inside values
        const attrRe = /([\w:-]+)\s*=\s*"([^"]*)"/g;
        let lastIndex = 0;
        let m: RegExpExecArray | null;

        while ((m = attrRe.exec(attrs)) !== null) {
            // Any whitespace before this attribute
            if (m.index > lastIndex) {
                result += this.escapeHtml(attrs.substring(lastIndex, m.index));
            }
            result += ` <span class="attr-name">${this.escapeHtml(m[1])}</span>=`;
            result += `<span class="attr-value">&quot;${this.highlightTextContent(m[2])}&quot;</span>`;
            lastIndex = m.index + m[0].length;
        }

        // Any remaining text
        if (lastIndex < attrs.length) {
            result += this.escapeHtml(attrs.substring(lastIndex));
        }

        return result;
    }

    private highlightTextContent(text: string): string {
        // Highlight WML variable references $(...) and XML entities &#nnn;
        return this.escapeHtml(text)
            .replace(/\$\(([^)]+)\)/g, '<span class="variable">$($1)</span>')
            .replace(/&amp;#(\d+);/g, '<span class="entity">&amp;#$1;</span>');
    }

    private escapeHtml(s: string): string {
        return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
    }
}
