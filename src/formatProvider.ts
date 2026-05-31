/**
 *  Copyright (C) 2026 Jabez Winston
 *
 *  SPDX-License-Identifier: Apache-2.0
 *
 *  Date : 29-May-2026
 *
 *  Document & range formatters for WML and WMLScript.
 *
 *  WML is an XML/HTML dialect and WMLScript a JavaScript dialect, so rather
 *  than re-implement pretty-printing we delegate to VS Code's built-in
 *  formatters: the source is copied verbatim into a throwaway temp file of the
 *  proxy language (opened by URI, never shown) and formatted there. Because the
 *  proxy holds identical text, the returned edits' positions line up with the
 *  original document and apply to it directly — so only the current file is
 *  touched and no extra editor tab appears.
 */

import * as vscode from 'vscode';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

/** Format all/part of `document` via the built-in formatter for `proxyExt`. */
async function formatViaProxy(
    document: vscode.TextDocument,
    proxyExt: string,
    command: string,
    ...args: unknown[]
): Promise<vscode.TextEdit[]> {
    const tmpFile = path.join(os.tmpdir(), `wap-fmt-${process.pid}-${Date.now()}.${proxyExt}`);
    fs.writeFileSync(tmpFile, document.getText());
    try {
        const proxy = await vscode.workspace.openTextDocument(vscode.Uri.file(tmpFile));
        const edits = await vscode.commands.executeCommand<vscode.TextEdit[]>(
            command, proxy.uri, ...args,
        );
        return edits ?? [];
    } finally {
        fs.unlink(tmpFile, () => { /* best-effort cleanup */ });
    }
}

export function registerFormatters(context: vscode.ExtensionContext): void {
    const langs: Array<{ id: string; ext: string }> = [
        { id: 'wml', ext: 'html' },
        { id: 'wmlscript', ext: 'js' },
    ];
    for (const { id, ext } of langs) {
        context.subscriptions.push(
            vscode.languages.registerDocumentFormattingEditProvider(id, {
                provideDocumentFormattingEdits: (doc, options) =>
                    formatViaProxy(doc, ext, 'vscode.executeFormatDocumentProvider', options),
            }),
            vscode.languages.registerDocumentRangeFormattingEditProvider(id, {
                provideDocumentRangeFormattingEdits: (doc, range, options) =>
                    formatViaProxy(doc, ext, 'vscode.executeFormatRangeProvider', range, options),
            }),
        );
    }
}
