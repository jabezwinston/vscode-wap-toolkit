/**
 *  Copyright (C) 2026 Jabez Winston
 *
 *  SPDX-License-Identifier: Apache-2.0
 * 
 *  Date : 09-April-2026
 *
 *  WAP Browser Panel — VS Code Webview-based WAP/WML browser
 *
 *  Features:
 *  - Address bar navigation (HTTP and WSP modes)
 *  - WML and WBXML rendering
 *  - WMLScript execution via bytecode VM (no JS transpilation)
 *  - Dialogs (alert, confirm, prompt)
 *  - Cookie support
 *  - Configurable screen size and gateway
 */

import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import * as os from 'os';
import { compileWmlsWithDebugInfo } from '../wmlsc/compiler';
import { decodeWmlsc, disassembleWithLineMap } from '../wmlsc/decoder';
import { browserDebugSession } from '../wmlsc/browserDebugSession';
import { urlToDebugUri } from './debugUri';
import { debugSourceProvider, DEBUG_SCHEME } from './debugSourceProvider';
import { NodeHttpTransport, NodeDatagramFactory } from './nodeTransport';
import { FetchResult } from '../shared/wapProtocol';
import {
    WapBrowserCore, BrowserSettings, BrowserDebugPort, BrowserPorts, DEFAULT_SETTINGS,
} from '../shared/browserCore';

const SETTINGS_KEY = 'wapBrowser.settings';

// ── User agent ───────────────────────────────────────────────────

// User-Agent advertised by the WAP browser, over both HTTP and WSP. Format:
// vscode-waptoolkit/<extension version>. The version is read from the
// extension's package.json at load (compiled to out/browser/ → ../../package.json,
// a layout preserved in a packaged .vsix), so it tracks version bumps without a
// manual edit; falls back to 0.0.0 if the file can't be read.
const USER_AGENT: string = (() => {
    try {
        const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, '..', '..', 'package.json'), 'utf8'));
        return `vscode-wap-toolkit/${pkg.version || '0.0.0'}`;
    } catch {
        return 'vscode-wap-toolkit/0.0.0';
    }
})();

// ── Browser Panel ────────────────────────────────────────────────

export class WapBrowserPanel {
    public static currentPanel: WapBrowserPanel | undefined;
    private static readonly viewType = 'wapBrowser';

    private readonly panel: vscode.WebviewPanel;
    private readonly extensionUri: vscode.Uri;
    private readonly context: vscode.ExtensionContext;
    private disposables: vscode.Disposable[] = [];
    /** All browsing logic; this class is its VS Code host. */
    private readonly core: WapBrowserCore;
    private downloads: { name: string; path: string; size: number; date: string }[] = [];
    // Editor column where debug sources (.wml/.wmls virtual docs) are revealed.
    private sourceColumn: vscode.ViewColumn = vscode.ViewColumn.One;
    // Bound hub listeners, detached on dispose.
    private readonly onDebugAttached = () => {
        // A debug session started — light up the debug button and surface the current
        // deck + its scripts so the user can place breakpoints immediately.
        this.panel.webview.postMessage({ type: 'debugState', active: true });
        if (this.core.currentWml && this.core.currentUrl) {
            void this.prepareDebugSources(this.core.currentWml, this.core.currentUrl);
        }
    };
    private readonly onDebugDetached = () => {
        this.panel.webview.postMessage({ type: 'debugState', active: false });
        debugSourceProvider.clear();
        this.closeDebugTabs();
    };

    private constructor(panel: vscode.WebviewPanel, context: vscode.ExtensionContext) {
        this.panel = panel;
        this.extensionUri = context.extensionUri;
        this.context = context;

        const ports: BrowserPorts = {
            http: new NodeHttpTransport(),
            datagram: new NodeDatagramFactory(),
            userAgent: USER_AGENT,
            post: (msg) => { this.panel.webview.postMessage(msg); },
            download: (body, contentType, url) => this.downloadFile(body, contentType, url),
            debug: this.buildDebugPort(),
        };
        this.core = new WapBrowserCore(
            ports,
            { ...DEFAULT_SETTINGS, ...context.globalState.get<BrowserSettings>(SETTINGS_KEY) },
        );

        this.panel.onDidDispose(() => this.dispose(), null, this.disposables);

        this.panel.webview.onDidReceiveMessage(
            (msg) => this.handleMessage(msg),
            null,
            this.disposables,
        );

        browserDebugSession.on('attached', this.onDebugAttached);
        browserDebugSession.on('detached', this.onDebugDetached);
    }

    public static createOrShow(context: vscode.ExtensionContext, column: vscode.ViewColumn = vscode.ViewColumn.Beside): void {
        if (WapBrowserPanel.currentPanel) {
            WapBrowserPanel.currentPanel.panel.reveal(column);
            return;
        }

        const panel = vscode.window.createWebviewPanel(
            WapBrowserPanel.viewType,
            'WAP Browser',
            column,
            {
                enableScripts: true,
                retainContextWhenHidden: true,
                localResourceRoots: [context.extensionUri],
            },
        );

        WapBrowserPanel.currentPanel = new WapBrowserPanel(panel, context);
        WapBrowserPanel.currentPanel.panel.webview.html = WapBrowserPanel.currentPanel.getHtml();
    }

    public dispose(): void {
        WapBrowserPanel.currentPanel = undefined;
        browserDebugSession.off('attached', this.onDebugAttached);
        browserDebugSession.off('detached', this.onDebugDetached);
        this.core.dispose();
        this.panel.dispose();
        while (this.disposables.length) {
            const d = this.disposables.pop();
            if (d) { d.dispose(); }
        }
    }

    // ── Message handling ─────────────────────────────────────────

    private async handleMessage(msg: any): Promise<void> {
        switch (msg.type) {
            case 'navigate':
                await this.core.navigate(msg.url, msg.postfields, msg.method, msg.referer, msg.fromDeck,
                                         msg.acceptCharset);
                break;

            case 'execWmlScript':
                await this.core.execWmlScript(msg.scriptUrl, msg.funcName, msg.args, msg.wmlVars);
                break;

            case 'debug':
                await this.startDebugSession();
                break;

            case 'proxyImage':
                await this.core.proxyImage(msg.src, msg.id);
                break;

            case 'savePage':
                await this.savePage();
                break;

            case 'clearCookies':
                await this.clearCookies();
                break;

            case 'saveImage':
                await this.saveImage(msg.src, msg.dataUri);
                break;

            case 'getDownloads':
                this.panel.webview.postMessage({ type: 'downloadsList', downloads: this.downloads });
                break;

            case 'clearDownloads':
                this.downloads = [];
                this.panel.webview.postMessage({ type: 'downloadsList', downloads: this.downloads });
                break;

            case 'openDownload':
                if (msg.path) {
                    const uri = vscode.Uri.file(msg.path);
                    vscode.commands.executeCommand('vscode.open', uri);
                }
                break;

            case 'revealDownload':
                if (msg.path) {
                    vscode.commands.executeCommand('revealFileInOS', vscode.Uri.file(msg.path));
                }
                break;

            case 'getHistory':
                this.panel.webview.postMessage({ type: 'historyList', history: this.core.history });
                break;

            case 'clearHistory':
                this.core.clearHistory();
                this.panel.webview.postMessage({ type: 'historyList', history: this.core.history });
                break;

            case 'getSettings':
                this.panel.webview.postMessage({ type: 'settingsData', settings: this.core.settings });
                break;

            case 'updateSettings':
                this.context.globalState.update(SETTINGS_KEY, this.core.updateSettings(msg.settings));
                this.panel.webview.postMessage({ type: 'settingsData', settings: this.core.settings });
                break;

            case 'dialogResult':
                // The webview answered an interactive Dialogs.* modal — resolve
                // the matching promise so the suspended VM resumes (requestDialog).
                this.core.resolveDialog(msg.requestId, msg.result);
                break;
        }
    }

    // ── Debugger integration ─────────────────────────────────────

    /**
     * The debug half of the core's host ports. Only the extension implements
     * this — the Android port runs every script on the plain VM.
     */
    private buildDebugPort(): BrowserDebugPort {
        return {
            isDebugging: () => browserDebugSession.isDebugging(),
            onDeckRendered: (wml, baseUrl) => { void this.prepareDebugSources(wml, baseUrl); },
            runScript: async (scriptUrl, funcName, args, ctx) => {
                // Register on demand (in case the deck-load scan missed it), opening
                // the .wmls source — or, when only compiled bytecode exists, its
                // disassembly. No source means the core falls back to a plain run.
                const sourceUri = await this.registerScriptForDebug(scriptUrl, true);
                if (!sourceUri) { return null; }
                return browserDebugSession.run(sourceUri, funcName, args, ctx);
            },
        };
    }

    // ── Debug source surfacing (virtual read-only docs) ──────────

    /** Stable `wml-debug:` registry key for a script URL (drops fragment, .wmlsc→.wmls). */
    private scriptKeyFor(scriptUrl: string): string {
        const noFrag = scriptUrl.split('#')[0];
        return urlToDebugUri(noFrag.replace(/\.wmlsc$/i, '.wmls'));
    }

    /**
     * When debugging, surface the deck WML and each referenced .wmls script as
     * read-only virtual documents and pre-compile the scripts (with debug info) so
     * breakpoints can be placed before a script is triggered.
     */
    private async prepareDebugSources(wmlContent: string, baseUrl: string): Promise<void> {
        if (!browserDebugSession.isDebugging()) { return; }

        // Deck markup — context/reference only (read-only, no focus). A compiled
        // .wmlc deck is shown as its decoded WML.
        const deckUri = urlToDebugUri(baseUrl.split('#')[0].replace(/\.wmlc$/i, '.wml'));
        await this.openVirtualDoc(deckUri, wmlContent, false, 'wml');

        // Pre-register each referenced script so breakpoints can be set up front.
        const refs = this.extractResourceUrls(wmlContent).filter(u => /\.wmls(c)?$/i.test(u.split('#')[0]));
        const seen = new Set<string>();
        for (const ref of refs) {
            let absUrl: string;
            try { absUrl = new URL(ref, baseUrl).toString(); } catch { continue; }
            const key = this.scriptKeyFor(absUrl);
            if (seen.has(key)) { continue; }
            seen.add(key);
            await this.registerScriptForDebug(absUrl, false);
        }
    }

    /**
     * Make a script debuggable: open its .wmls source as a read-only virtual doc and
     * register the compiled module + debug info. When no .wmls source is available
     * (compiled-only server), fall back to opening the disassembled bytecode and
     * debugging at the instruction level. Returns the registry URI, or null when the
     * script can be neither sourced nor decoded.
     */
    private async registerScriptForDebug(absScriptUrl: string, takeFocus: boolean): Promise<string | null> {
        const sourceUri = this.scriptKeyFor(absScriptUrl);
        if (browserDebugSession.getScript(sourceUri) && debugSourceProvider.has(vscode.Uri.parse(sourceUri))) {
            return sourceUri; // already prepared
        }

        // 1) Prefer real .wmls source (full source-level debugging).
        const source = await this.core.fetchSource(absScriptUrl);
        if (source != null) {
            try {
                const { bytecode, lineMaps, varNames } = compileWmlsWithDebugInfo(source);
                browserDebugSession.registerScript(sourceUri, { module: decodeWmlsc(bytecode), lineMaps, varNames });
                await this.openVirtualDoc(sourceUri, source, takeFocus);
                return sourceUri;
            } catch { /* unparseable source — try the compiled form instead */ }
        }

        // 2) Compiled-only: disassemble the bytecode and debug at the instruction level.
        const bytecode = await this.fetchCompiled(absScriptUrl);
        if (bytecode != null) {
            try {
                const module = decodeWmlsc(bytecode);
                const { text, lineMaps } = disassembleWithLineMap(module);
                browserDebugSession.registerScript(sourceUri, { module, lineMaps, varNames: [] });
                await this.openVirtualDoc(sourceUri, text, takeFocus, 'wmlsc-disasm');
                return sourceUri;
            } catch { /* not valid bytecode */ }
        }
        return null;
    }

    /** Fetch compiled WMLScript bytecode (the .wmlsc variant) for disassembly. */
    private async fetchCompiled(scriptUrl: string): Promise<Buffer | null> {
        const noFrag = scriptUrl.split('#')[0];
        const compiledUrl = /\.wmlsc$/i.test(noFrag) ? noFrag : noFrag.replace(/\.wmls$/i, '.wmlsc');
        try {
            const r = await this.core.getResource(compiledUrl);
            if (r.status === 200) { return r.body; }
        } catch { /* ignore */ }
        return null;
    }

    /** Register + open a read-only virtual document for a `wml-debug:` URI. */
    private async openVirtualDoc(uriString: string, content: string, takeFocus: boolean, language?: string): Promise<void> {
        try {
            const uri = vscode.Uri.parse(uriString);
            debugSourceProvider.register(uri, content);
            const editor = await vscode.window.showTextDocument(uri, {
                viewColumn: this.sourceColumn,
                preserveFocus: !takeFocus,
                preview: false,
            });
            if (language && editor.document.languageId !== language) {
                await vscode.languages.setTextDocumentLanguage(editor.document, language);
            }
        } catch {
            // Not openable as an editor — the provider still holds the content for the adapter.
        }
    }

    /** Close any `wml-debug:` editor tabs (on debug session end). */
    private closeDebugTabs(): void {
        try {
            const tabs = vscode.window.tabGroups.all.flatMap(g => g.tabs);
            const toClose = tabs.filter(t => {
                const input = t.input as { uri?: vscode.Uri } | undefined;
                return input?.uri?.scheme === DEBUG_SCHEME;
            });
            if (toClose.length > 0) { void vscode.window.tabGroups.close(toClose); }
        } catch {
            // tabGroups API unavailable — virtual docs are harmless and read-only.
        }
    }

    /** Start a WMLScript debug session attached to this browser's bytecode VM
     *  (triggered by the debug button in the browser chrome). */
    public async startDebugSession(): Promise<void> {
        if (browserDebugSession.isDebugging()) {
            this.panel.webview.postMessage({ type: 'status', message: 'Already debugging WMLScript.' });
            return;
        }
        // Reveal paused sources in the column next to the browser so both are visible.
        const browserCol = this.panel.viewColumn ?? vscode.ViewColumn.One;
        this.sourceColumn = browserCol === vscode.ViewColumn.One ? vscode.ViewColumn.Two : vscode.ViewColumn.One;
        const folder = vscode.workspace.workspaceFolders?.[0];
        await vscode.debug.startDebugging(folder, {
            type: 'wmlscript',
            request: 'attach',
            target: 'browser',
            name: 'Debug WAP Browser',
            sourceColumn: this.sourceColumn,
        });
    }

    // ── Clear Cookies ────────────────────────────────────────────

    private async clearCookies(): Promise<void> {
        const count = this.core.cookieJar.clear();
        this.panel.webview.postMessage({
            type: 'cookiesCleared',
            count,
        });
    }

    // ── Save Page ───────────────────────────────────────────────

    private async savePage(): Promise<void> {
        if (!this.core.currentWml || !this.core.currentUrl) {
            this.panel.webview.postMessage({ type: 'status', message: 'No page loaded' });
            return;
        }

        try {
            // Ask user for a folder to save into
            const folderUris = await vscode.window.showOpenDialog({
                canSelectFolders: true,
                canSelectFiles: false,
                canSelectMany: false,
                openLabel: 'Save Page Here',
            });
            if (!folderUris || folderUris.length === 0) { return; }
            const saveDir = folderUris[0].fsPath;

            // Derive page filename from URL
            let pageName = 'index.wml';
            try {
                const parsed = new URL(this.core.currentUrl);
                const basename = path.basename(parsed.pathname);
                if (basename && basename !== '/' && basename.length > 0) {
                    pageName = basename;
                    if (!pageName.endsWith('.wml') && !pageName.endsWith('.wmlc')) {
                        pageName += '.wml';
                    }
                    // Ensure we save as .wml (source), not .wmlc
                    if (pageName.endsWith('.wmlc')) {
                        pageName = pageName.replace(/\.wmlc$/, '.wml');
                    }
                }
            } catch { /* use default */ }

            this.panel.webview.postMessage({ type: 'status', message: 'Saving page...' });

            // Extract all resource URLs from the WML source
            const resourceUrls = this.extractResourceUrls(this.core.currentWml);

            // Fetch and save each resource, building a URL → local filename map
            const urlToLocal = new Map<string, string>();
            let savedCount = 0;

            for (const relUrl of resourceUrls) {
                let absUrl: string;
                try {
                    absUrl = new URL(relUrl, this.core.currentUrl).toString();
                } catch {
                    continue;
                }

                // Derive local filename
                let localName: string;
                try {
                    const parsed = new URL(absUrl);
                    localName = path.basename(parsed.pathname);
                    if (!localName || localName === '/') { localName = 'resource_' + savedCount; }
                } catch {
                    localName = 'resource_' + savedCount;
                }

                // Skip if already fetched (dedup)
                if (urlToLocal.has(absUrl)) { continue; }

                try {
                    let result: FetchResult = await this.core.getResource(absUrl);

                    // Mirror the script-run path's .wmls → .wmlsc fallback: a
                    // compiled-only server 404s the .wmls URL but serves .wmlsc,
                    // so retry the compiled variant so Save Page still saves it.
                    if (result.status !== 200 && absUrl.endsWith('.wmls')) {
                        const compiledUrl = absUrl + 'c';
                        const compiledResult = await this.core.getResource(compiledUrl);
                        if (compiledResult.status === 200) {
                            result = compiledResult;
                            localName = localName + 'c';  // .wmls → .wmlsc
                        }
                    }

                    if (result.status === 200) {
                        // If server returned compiled variant, adjust filename
                        const ct = result.contentType.toLowerCase();
                        if (ct.includes('application/vnd.wap.wmlscriptc') && localName.endsWith('.wmls')) {
                            localName = localName + 'c';  // .wmls → .wmlsc
                        }

                        const filePath = path.join(saveDir, localName);
                        fs.writeFileSync(filePath, result.body);
                        urlToLocal.set(absUrl, localName);
                        // Also map the original relative URL
                        urlToLocal.set(relUrl, localName);
                        savedCount++;
                    }
                } catch {
                    // Skip failed resources silently
                }
            }

            // Rewrite URLs in WML to relative paths and save
            let rewrittenWml = this.core.currentWml;
            // Sort by length descending to avoid partial replacements
            const entries = [...urlToLocal.entries()].sort((a, b) => b[0].length - a[0].length);
            for (const [originalUrl, localFile] of entries) {
                rewrittenWml = rewrittenWml.split(originalUrl).join(localFile);
            }

            const wmlPath = path.join(saveDir, pageName);
            fs.writeFileSync(wmlPath, rewrittenWml, 'utf-8');

            // Track in downloads
            const totalSize = fs.statSync(wmlPath).size;
            this.downloads.push({
                name: pageName,
                path: wmlPath,
                size: totalSize,
                date: new Date().toISOString(),
            });

            this.panel.webview.postMessage({
                type: 'status',
                message: `Saved: ${pageName} + ${savedCount} resource${savedCount !== 1 ? 's' : ''}`,
            });

        } catch (err: any) {
            this.panel.webview.postMessage({ type: 'status', message: `Save page failed: ${err.message}` });
        }
    }

    /**
     * Extract URLs of linked resources from raw WML source.
     * Finds images (.wbmp, .png, .jpg, .gif) and scripts (.wmls, .wmlsc).
     */
    private extractResourceUrls(wml: string): string[] {
        const urls = new Set<string>();

        // Image src attributes: <img src="...">
        const imgRe = /< *img\b[^>]*\bsrc\s*=\s*"([^"]+)"/gi;
        let m;
        while ((m = imgRe.exec(wml)) !== null) {
            urls.add(m[1]);
        }

        // href attributes pointing to resource files (WMLScript, images, other WML)
        // Matches: <go href="...">, <a href="...">, onenterforward="...", onenterbackward="...", ontimer="...", onpick="..."
        const hrefRe = /(?:href|onenterforward|onenterbackward|ontimer|onpick)\s*=\s*"([^"]+)"/gi;
        while ((m = hrefRe.exec(wml)) !== null) {
            const href = m[1];
            // Only collect .wmls/.wmlsc references (strip fragment for script URL)
            if (/\.wmls(?:c)?(?:#|$)/i.test(href)) {
                // Extract the script file URL (before the #fragment)
                const hashIdx = href.indexOf('#');
                const scriptUrl = hashIdx >= 0 ? href.substring(0, hashIdx) : href;
                if (scriptUrl) { urls.add(scriptUrl); }
            }
        }

        return [...urls];
    }

    // ── Save Image ──────────────────────────────────────────────

    private async saveImage(src: string, dataUri?: string): Promise<void> {
        try {
            let imageData: Buffer;
            let defaultExt = 'png';
            let mimeType = 'image/png';

            if (dataUri && dataUri.startsWith('data:')) {
                // Parse data URI
                const match = dataUri.match(/^data:([^;]+);base64,(.+)$/);
                if (match) {
                    mimeType = match[1];
                    imageData = Buffer.from(match[2], 'base64');
                    if (mimeType.includes('svg')) { defaultExt = 'svg'; }
                    else if (mimeType.includes('gif')) { defaultExt = 'gif'; }
                    else if (mimeType.includes('jpeg') || mimeType.includes('jpg')) { defaultExt = 'jpg'; }
                    else if (mimeType.includes('bmp') || mimeType.includes('wbmp')) { defaultExt = 'bmp'; }
                    else if (mimeType.includes('png')) { defaultExt = 'png'; }
                } else {
                    this.panel.webview.postMessage({ type: 'status', message: 'Invalid image data' });
                    return;
                }
            } else {
                // Fetch the image from the URL
                let resolvedSrc = src;
                if (resolvedSrc && !/^https?:\/\//i.test(resolvedSrc) && this.core.currentUrl) {
                    try { resolvedSrc = new URL(resolvedSrc, this.core.currentUrl).toString(); } catch { /* keep */ }
                }

                const result: FetchResult = await this.core.getResource(resolvedSrc);

                imageData = result.body;
                const ct = result.contentType.toLowerCase();
                if (ct.includes('wbmp') || resolvedSrc.toLowerCase().endsWith('.wbmp')) {
                    // Save raw WBMP binary
                    defaultExt = 'wbmp';
                } else if (ct.includes('gif')) { defaultExt = 'gif'; }
                else if (ct.includes('jpeg') || ct.includes('jpg')) { defaultExt = 'jpg'; }
                else if (ct.includes('png')) { defaultExt = 'png'; }
                else if (ct.includes('svg')) { defaultExt = 'svg'; }
            }

            // Derive a default filename from the URL
            let defaultName = 'image';
            try {
                const parsed = new URL(src.startsWith('data:') ? this.core.currentUrl : src);
                const basename = path.basename(parsed.pathname);
                if (basename && basename !== '/') {
                    defaultName = basename.replace(/\.[^.]+$/, '');
                }
            } catch { /* use default */ }

            const saveUri = await vscode.window.showSaveDialog({
                defaultUri: vscode.Uri.file(path.join(
                    vscode.workspace.workspaceFolders?.[0]?.uri.fsPath || os.homedir(),
                    `${defaultName}.${defaultExt}`
                )),
                filters: {
                    'Images': ['png', 'jpg', 'jpeg', 'gif', 'svg', 'bmp', 'wbmp'],
                    'All Files': ['*'],
                },
            });

            if (saveUri) {
                fs.writeFileSync(saveUri.fsPath, imageData!);
                const stat = fs.statSync(saveUri.fsPath);
                const entry = {
                    name: path.basename(saveUri.fsPath),
                    path: saveUri.fsPath,
                    size: stat.size,
                    date: new Date().toISOString(),
                };
                this.downloads.push(entry);
                this.panel.webview.postMessage({
                    type: 'imageSaved',
                    name: entry.name,
                    path: entry.path,
                });
                this.panel.webview.postMessage({ type: 'status', message: `Saved: ${entry.name}` });
            }
        } catch (err: any) {
            this.panel.webview.postMessage({ type: 'status', message: `Save failed: ${err.message}` });
        }
    }

    // ── Download File (unsupported content types) ────────────────

    private async downloadFile(body: Buffer, contentType: string, fileUrl: string): Promise<void> {
        try {
            // Derive filename and extension from URL
            let defaultName = 'download';
            let defaultExt = '';
            try {
                const parsed = new URL(fileUrl);
                const basename = path.basename(parsed.pathname);
                if (basename && basename !== '/') {
                    const dotIdx = basename.lastIndexOf('.');
                    if (dotIdx > 0) {
                        defaultName = basename.substring(0, dotIdx);
                        defaultExt = basename.substring(dotIdx + 1);
                    } else {
                        defaultName = basename;
                    }
                }
            } catch { /* use defaults */ }

            // Fallback extension from content type
            if (!defaultExt) {
                const extMap: Record<string, string> = {
                    'application/java-archive': 'jar',
                    'application/zip': 'zip',
                    'application/pdf': 'pdf',
                    'application/octet-stream': 'bin',
                    'text/plain': 'txt',
                    'text/csv': 'csv',
                };
                for (const [mime, ext] of Object.entries(extMap)) {
                    if (contentType.toLowerCase().includes(mime)) { defaultExt = ext; break; }
                }
                if (!defaultExt) { defaultExt = 'bin'; }
            }

            const saveUri = await vscode.window.showSaveDialog({
                defaultUri: vscode.Uri.file(path.join(
                    vscode.workspace.workspaceFolders?.[0]?.uri.fsPath || os.homedir(),
                    `${defaultName}.${defaultExt}`
                )),
                filters: { 'All Files': ['*'] },
            });

            if (saveUri) {
                fs.writeFileSync(saveUri.fsPath, body);
                const stat = fs.statSync(saveUri.fsPath);
                const entry = {
                    name: path.basename(saveUri.fsPath),
                    path: saveUri.fsPath,
                    size: stat.size,
                    date: new Date().toISOString(),
                };
                this.downloads.push(entry);
                this.panel.webview.postMessage({ type: 'status', message: `Downloaded: ${entry.name}` });
            }
        } catch (err: any) {
            this.panel.webview.postMessage({ type: 'status', message: `Download failed: ${err.message}` });
        }
    }

    // ── Webview HTML ─────────────────────────────────────────────

    private getHtml(): string {
        const sharedCssPath = path.join(__dirname, '..', 'shared', 'wml-elements.css');
        const cssPath = path.join(__dirname, 'browser.css');
        const engineJsPath = path.join(__dirname, '..', 'shared', 'wml-engine.js');
        const jsPath = path.join(__dirname, 'browser.js');
        const sharedCss = fs.readFileSync(sharedCssPath, 'utf-8');
        const css = sharedCss + '\n' + fs.readFileSync(cssPath, 'utf-8');
        const js = fs.readFileSync(engineJsPath, 'utf-8') + '\n' + fs.readFileSync(jsPath, 'utf-8');
        // The chrome lives in its own asset so other hosts render the same UI —
        // browser.js drives these element ids directly. See chrome.html.
        const chromeHtml = fs.readFileSync(path.join(__dirname, 'chrome.html'), 'utf-8');

        return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src http: https: data:; style-src 'unsafe-inline'; script-src 'unsafe-inline';">
  <title>WAP Browser</title>
  <style>${css}</style>
</head>
<body>
${chromeHtml}
  <script>${js}</script>
</body>
</html>`;
    }
}
