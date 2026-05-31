/**
 *  Copyright (C) 2026 Jabez Winston
 * 
 *  SPDX-License-Identifier: Apache-2.0
 *
 *  Date : 17-March-2026
 * 
 *  VS Code Extension Entry Point
 *  Initializes the extension, registers commands, providers, and status bar items.
 */

import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { startPreviewServer, stopPreviewServer, isServerRunning } from './wmlRender/previewServer';
import { WmlPreviewPanel } from './wmlRender/previewPanel';
import { encodeWbxml } from './wbxml/encoder';
import { decodeWbxml } from './wbxml/decoder';
import { WbmpEditorProvider } from './wbmp/wbmpProvider';
import { WbxmlEditorProvider } from './wbxml/wbxmlProvider';
import { WmlCompletionProvider, WmlScriptCompletionProvider } from './completionProvider';
import { activateValidation } from './wmlValidator';
import { activateWmlsValidation, publishWmlsDiagnostics, reportWmlsCompileError } from './wmlsc/validator';
import { compileWmls } from './wmlsc/compiler';
import { decodeWmlsc, disassembleWmlsc } from './wmlsc/decoder';
import { WmlsVM } from './wmlsc/vm';
import { mkString } from './wmlsc/stdlib';
import { WmlsDebugAdapterFactory } from './wmlsc/debugAdapter';
import { registerWmlscDisassemblyView } from './wmlsc/disassemblyProvider';
import { startWapServer, stopWapServer, isWapServerRunning } from './wapServer';
import { convertImageToWbmp } from './wbmp/imageToWbmp';
import { WapBrowserPanel } from './browser/browserPanel';
import { debugSourceProvider, DEBUG_SCHEME } from './browser/debugSourceProvider';
import { registerFormatters } from './formatProvider';

export function activate(context: vscode.ExtensionContext) {
    // --- DTD-based Validation ---
    activateValidation(context);

    // --- WMLScript Source Validation ---
    activateWmlsValidation(context);

    // --- WMLSC Disassembly View ---
    registerWmlscDisassemblyView(context);

    // --- Document Formatters (WML → HTML, WMLScript → JavaScript) ---
    registerFormatters(context);

    // --- Completion Providers ---
    context.subscriptions.push(
        vscode.languages.registerCompletionItemProvider(
            { language: 'wml', scheme: 'file' },
            new WmlCompletionProvider(),
            '<', ' ', '$'
        ),
        vscode.languages.registerCompletionItemProvider(
            { language: 'wmlscript', scheme: 'file' },
            new WmlScriptCompletionProvider(),
            '.'
        )
    );

    // --- WBMP Custom Editor ---
    context.subscriptions.push(
        vscode.window.registerCustomEditorProvider(
            WbmpEditorProvider.viewType,
            new WbmpEditorProvider(context),
            { webviewOptions: { retainContextWhenHidden: true } }
        )
    );

    // --- WBXML/WMLC Decompiled Viewer ---
    context.subscriptions.push(
        vscode.window.registerCustomEditorProvider(
            WbxmlEditorProvider.viewType,
            new WbxmlEditorProvider(context),
            { webviewOptions: { retainContextWhenHidden: false } }
        )
    );

    // --- Server Status Bar Buttons ---
    async function checkWmlFilesExist(): Promise<boolean> {
        const wmlFiles = await vscode.workspace.findFiles('**/*.{wml,wmlc}', undefined, 1);
        return wmlFiles.length > 0;
    }

    function createServerStatusBar(
        priority: number,
        command: string,
        isRunning: () => boolean,
        labels: { icon: string; running: string; stopped: string; tooltipRunning: string; tooltipStopped: string },
    ): { item: vscode.StatusBarItem; update: () => void; updateVisibility: () => Promise<void> } {
        const item = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, priority);
        item.command = command;
        const update = () => {
            if (isRunning()) {
                item.text = `$(debug-stop) ${labels.running}`;
                item.tooltip = labels.tooltipRunning;
            } else {
                item.text = `$(${labels.icon}) ${labels.stopped}`;
                item.tooltip = labels.tooltipStopped;
            }
        };
        const updateVisibility = async () => {
            if (await checkWmlFilesExist()) { update(); item.show(); } else { item.hide(); }
        };
        return { item, update, updateVisibility };
    }

    // Status-bar button: open the WAP Browser in a split editor. Shown only
    // when the workspace contains WML files, matching the other toolkit buttons.
    // (The WML preview server is still toggleable via the "Toggle WML Server"
    // command in the Command Palette.)
    const browserBar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
    browserBar.command = 'wml.openBrowser';
    browserBar.text = '$(globe) WAP browser';
    const updateBrowserBarVisibility = async () => {
        if (await checkWmlFilesExist()) { browserBar.show(); } else { browserBar.hide(); }
    };

    const wapBar = createServerStatusBar(99, 'wml.toggleWapServer', isWapServerRunning, {
        icon: 'broadcast',
        running: 'Stop WAP Server',
        stopped: 'Start WAP Server',
        tooltipRunning: 'Stop the WAP server (WSP UDP + HTTP)',
        get tooltipStopped() {
            const config = vscode.workspace.getConfiguration('wap');
            const wspPort = config.get<number>('wspPort', 9200);
            const wspCoPort = config.get<number>('wspCoPort', 9201);
            const httpPort = config.get<number>('httpPort', 3003);
            return `Start the WAP server (WSP UDP :${wspPort}/:${wspCoPort}, HTTP :${httpPort})`;
        },
    });

    updateBrowserBarVisibility();
    wapBar.updateVisibility();

    const fileWatcher = vscode.workspace.createFileSystemWatcher('**/*.{wml,wmlc}');
    fileWatcher.onDidCreate(() => { updateBrowserBarVisibility(); wapBar.updateVisibility(); });
    fileWatcher.onDidDelete(() => { updateBrowserBarVisibility(); wapBar.updateVisibility(); });
    context.subscriptions.push(fileWatcher, browserBar, wapBar.item);

    context.subscriptions.push(
        vscode.commands.registerCommand('wml.toggleServer', () => {
            if (isServerRunning()) {
                stopPreviewServer();
            } else {
                const baseUrl = startPreviewServer(context);
                vscode.env.openExternal(vscode.Uri.parse(baseUrl));
            }
        })
    );

    context.subscriptions.push(
        vscode.commands.registerCommand('wml.toggleWapServer', () => {
            if (isWapServerRunning()) {
                stopWapServer();
            } else {
                startWapServer();
            }
            wapBar.update();
        })
    );

    // --- Preview WML in Side Panel ---
    context.subscriptions.push(
        vscode.commands.registerCommand('wml.previewWmlSidePanel', () => {
            const editor = vscode.window.activeTextEditor;
            if (!editor || editor.document.languageId !== 'wml') {
                vscode.window.showWarningMessage('Open a .wml file to preview');
                return;
            }
            WmlPreviewPanel.createOrShow(context.extensionUri, editor.document.uri);
        })
    );

    // --- Convert WML to WBXML ---
    context.subscriptions.push(
        vscode.commands.registerCommand('wml.convertToWbxml', async (uri?: vscode.Uri) => {
            const fileUri = uri || vscode.window.activeTextEditor?.document.uri;
            if (!fileUri) {
                vscode.window.showWarningMessage('No WML file selected');
                return;
            }

            try {
                const wmlContent = fs.readFileSync(fileUri.fsPath, 'utf-8');
                const wbxmlBuffer = encodeWbxml(wmlContent);

                const outPath = fileUri.fsPath.replace(/\.wml$/i, '.wmlc');
                fs.writeFileSync(outPath, wbxmlBuffer);
                vscode.window.showInformationMessage(`WMLC saved: ${path.basename(outPath)} (${wbxmlBuffer.length} bytes)`);
            } catch (err: any) {
                vscode.window.showErrorMessage(`WMLC encoding failed: ${err.message}`);
            }
        })
    );

    // --- Convert WBXML/WMLC to WML ---
    context.subscriptions.push(
        vscode.commands.registerCommand('wml.convertFromWbxml', async (uri?: vscode.Uri) => {
            const fileUri = uri || vscode.window.activeTextEditor?.document.uri;
            if (!fileUri) {
                vscode.window.showWarningMessage('No WBXML or WMLC file selected');
                return;
            }

            try {
                const wbxmlData = fs.readFileSync(fileUri.fsPath);
                const wmlContent = decodeWbxml(wbxmlData);

                const outPath = fileUri.fsPath.replace(/\.(?:wbxml|wmlc)$/i, '.wml');
                fs.writeFileSync(outPath, wmlContent, 'utf-8');
                vscode.window.showInformationMessage(`WML saved: ${path.basename(outPath)}`);

                const doc = await vscode.workspace.openTextDocument(outPath);
                await vscode.window.showTextDocument(doc);
            } catch (err: any) {
                vscode.window.showErrorMessage(`WBXML decoding failed: ${err.message}`);
            }
        })
    );

    // --- Stop Preview Server ---
    context.subscriptions.push(
        vscode.commands.registerCommand('wml.stopPreviewServer', () => {
            stopPreviewServer();
        })
    );

    // --- Compile WMLScript to WMLSC ---
    context.subscriptions.push(
        vscode.commands.registerCommand('wml.compileWmls', async (uri?: vscode.Uri) => {
            const fileUri = uri || vscode.window.activeTextEditor?.document.uri;
            if (!fileUri) {
                vscode.window.showWarningMessage('No WMLScript file selected');
                return;
            }

            let source: string;
            try {
                source = fs.readFileSync(fileUri.fsPath, 'utf-8');
            } catch (err: any) {
                vscode.window.showErrorMessage(`Cannot read file: ${err.message}`);
                return;
            }

            try {
                const bytecode = compileWmls(source);
                const outPath = fileUri.fsPath.replace(/\.wmls$/i, '.wmlsc');
                fs.writeFileSync(outPath, bytecode);
                // Refresh diagnostics (clears any stale compile error from the Problems panel).
                publishWmlsDiagnostics(fileUri, source);
                vscode.window.showInformationMessage(
                    `WMLSC saved: ${path.basename(outPath)} (${bytecode.length} bytes)`
                );
            } catch (err: any) {
                // Surface the error in the Problems panel (clickable → navigates to the line).
                reportWmlsCompileError(fileUri, source, err);
                vscode.commands.executeCommand('workbench.actions.view.problems');
                vscode.window.showErrorMessage(`WMLScript compilation failed — see Problems: ${err.message}`);
            }
        })
    );

    // --- Disassemble WMLSC ---
    context.subscriptions.push(
        vscode.commands.registerCommand('wml.disassembleWmlsc', async (uri?: vscode.Uri) => {
            const fileUri = uri || vscode.window.activeTextEditor?.document.uri;
            if (!fileUri) {
                vscode.window.showWarningMessage('No WMLSC file selected');
                return;
            }

            try {
                const data = fs.readFileSync(fileUri.fsPath);
                const text = disassembleWmlsc(Buffer.from(data));

                const doc = await vscode.workspace.openTextDocument({
                    content: text,
                    language: 'plaintext',
                });
                await vscode.window.showTextDocument(doc);
            } catch (err: any) {
                vscode.window.showErrorMessage(`WMLSC disassembly failed: ${err.message}`);
            }
        })
    );

    // --- Run WMLScript ---
    context.subscriptions.push(
        vscode.commands.registerCommand('wml.runWmls', async (uri?: vscode.Uri) => {
            const fileUri = uri || vscode.window.activeTextEditor?.document.uri;
            if (!fileUri) {
                vscode.window.showWarningMessage('No WMLScript file selected');
                return;
            }

            const funcName = await vscode.window.showInputBox({
                prompt: 'Enter function name to execute',
                value: 'main',
            });
            if (!funcName) { return; }

            try {
                const data = fs.readFileSync(fileUri.fsPath);
                let mod;
                if (fileUri.fsPath.endsWith('.wmlsc')) {
                    mod = decodeWmlsc(Buffer.from(data));
                } else {
                    const source = data.toString('utf-8');
                    try {
                        mod = decodeWmlsc(compileWmls(source));
                        publishWmlsDiagnostics(fileUri, source);
                    } catch (compileErr: any) {
                        reportWmlsCompileError(fileUri, source, compileErr);
                        vscode.commands.executeCommand('workbench.actions.view.problems');
                        vscode.window.showErrorMessage(`WMLScript compilation failed — see Problems: ${compileErr.message}`);
                        return;
                    }
                }

                const vm = new WmlsVM(mod);
                const result = vm.callFunction(funcName, []);

                const channel = vscode.window.createOutputChannel('WMLScript');
                channel.show(true);
                for (const line of result.output) {
                    channel.appendLine(line);
                }
                if (result.error) {
                    channel.appendLine(`Error: ${result.error}`);
                } else {
                    channel.appendLine(`Result: ${JSON.stringify(result.value)}`);
                }
                channel.appendLine(`(${result.steps} steps executed)`);
            } catch (err: any) {
                vscode.window.showErrorMessage(`WMLScript execution failed: ${err.message}`);
            }
        })
    );

    // --- Convert Image (PNG/JPG/BMP) to WBMP ---
    context.subscriptions.push(
        vscode.commands.registerCommand('wml.convertToWbmp', async (uri?: vscode.Uri) => {
            const fileUri = uri || vscode.window.activeTextEditor?.document.uri;
            if (!fileUri) {
                vscode.window.showWarningMessage('No image file selected');
                return;
            }

            try {
                const result = convertImageToWbmp(fileUri.fsPath);
                const outPath = fileUri.fsPath.replace(/\.(png|jpe?g|bmp|otb)$/i, '.wbmp');
                fs.writeFileSync(outPath, result.buffer);

                let msg = `WBMP saved: ${path.basename(outPath)} (${result.width}\u00D7${result.height}, ${result.buffer.length} bytes)`;
                if (result.scaled) {
                    msg += ` \u2014 scaled down from ${result.originalWidth}\u00D7${result.originalHeight}`;
                }
                vscode.window.showInformationMessage(msg);
            } catch (err: any) {
                vscode.window.showErrorMessage(`Image to WBMP conversion failed: ${err.message}`);
            }
        })
    );

    // --- WMLScript Debug Adapter ---
    context.subscriptions.push(
        vscode.debug.registerDebugAdapterDescriptorFactory('wmlscript', new WmlsDebugAdapterFactory())
    );

    // Read-only virtual documents that surface fetched deck/script source for
    // WAP Browser debugging (breakpoints + paused-line reveal).
    context.subscriptions.push(
        vscode.workspace.registerTextDocumentContentProvider(DEBUG_SCHEME, debugSourceProvider),
        debugSourceProvider,
    );

    // --- Debug WMLScript in the WML Preview ---
    // Opens the side-panel preview for the active .wml deck and starts an
    // `attach` debug session bridged to that preview, so WMLScript can be
    // debugged live (breakpoints, stepping, variables) via VS Code's debug UI.
    context.subscriptions.push(
        vscode.commands.registerCommand('wml.debugWmlPreview', async () => {
            const editor = vscode.window.activeTextEditor;
            if (!editor || editor.document.languageId !== 'wml') {
                vscode.window.showWarningMessage('Open a .wml deck to debug its WMLScript in the preview');
                return;
            }
            const wmlUri = editor.document.uri;
            const srcColumn = editor.viewColumn ?? vscode.ViewColumn.One;

            // Open the preview beside the source WITHOUT stealing focus, so the
            // source editor group stays the active text-editor group.
            WmlPreviewPanel.createOrShow(context.extensionUri, wmlUri, true);

            // Pre-open the .wmls files referenced by the deck in the source column.
            // The debugger reveals an already-open editor in its own group, so this
            // makes breakpoints surface next to the source rather than beside the
            // preview webview.
            const refs = new Set<string>();
            const refRe = /["']([^"']*\.wmls)(?:#[^"']*)?["']/gi;
            let m: RegExpExecArray | null;
            while ((m = refRe.exec(editor.document.getText())) !== null) {
                refs.add(m[1]);
            }
            const deckDir = path.dirname(wmlUri.fsPath);
            for (const ref of refs) {
                const scriptPath = path.resolve(deckDir, ref);
                if (!fs.existsSync(scriptPath)) { continue; }
                try {
                    const doc = await vscode.workspace.openTextDocument(scriptPath);
                    await vscode.window.showTextDocument(doc, { viewColumn: srcColumn, preserveFocus: true });
                } catch {
                    // ignore scripts that fail to open
                }
            }

            const folder = vscode.workspace.getWorkspaceFolder(wmlUri)
                ?? vscode.workspace.workspaceFolders?.[0];
            await vscode.debug.startDebugging(folder, {
                type: 'wmlscript',
                request: 'attach',
                name: 'Debug WML Preview',
                // Column where the adapter should reveal paused .wmls sources, so
                // they appear next to the deck source rather than beside the preview.
                sourceColumn: srcColumn,
            });
        })
    );

    // --- WAP Browser ---
    // (WMLScript debugging is started from the debug button in the browser chrome,
    // which posts a 'debug' message handled by WapBrowserPanel.)
    context.subscriptions.push(
        vscode.commands.registerCommand('wml.openBrowser', () => {
            WapBrowserPanel.createOrShow(context);
        })
    );

    // --- Debug WAP Browser ---
    // Opens (or reveals) the WAP Browser and starts the same `attach` debug
    // session that the browser chrome's debug button triggers, so WMLScript
    // running in the browser can be debugged from the command palette / keybinding.
    context.subscriptions.push(
        vscode.commands.registerCommand('wml.debugWapBrowser', async () => {
            WapBrowserPanel.createOrShow(context);
            const panel = WapBrowserPanel.currentPanel;
            if (!panel) {
                vscode.window.showErrorMessage('WAP Browser could not be opened.');
                return;
            }
            await panel.startDebugSession();
        })
    );
}

export function deactivate() {
    stopPreviewServer();
    stopWapServer();
}
