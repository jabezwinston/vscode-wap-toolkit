/**
 *  Copyright (C) 2026 Jabez Winston
 * 
 *  SPDX-License-Identifier: Apache-2.0
 *
 *  Date : 17-March-2026
 * 
 *  WML to HTML converter for preview rendering
 */

import * as path from 'path';
import * as fs from 'fs';
import { transpileWmls, getExternalDeps, getWmlsRuntime } from './wmlsToJs';
import { escapeHtml, renderCards } from '../wmlTransform';
import { wbmpToDataUri } from '../shared/wbmpUtils';

/**
 * Convert WML content to an HTML page that renders like a WAP browser.
 * Supports: cards, navigation, forms, tables, text formatting, variables, timers.
 */
export function wmlToHtml(wmlContent: string, filePath: string, showPhoneFrame: boolean): string {
    const fileName = path.basename(filePath);
    const dirName = path.dirname(filePath);

    // Workspace-relative directory of this deck, used as the base for resolving
    // .wmls references. Must mirror the registry-key construction in
    // getEmbeddedWmlScripts so client-side calls resolve in BOTH the HTTP-server
    // preview and the side-panel webview (where window.location is not the
    // workspace path). See executeWmlScript() in preview.js.
    const deckRoot = getWorkspaceRoot() || dirName;
    const deckRel = '/' + path.relative(deckRoot, filePath).split(path.sep).join('/');
    const deckDir = deckRel.substring(0, deckRel.lastIndexOf('/') + 1);

    // Extract WCSS stylesheet reference
    const stylesheetMatch = wmlContent.match(/<\?xml-stylesheet[^?]*href="([^"]+)"[^?]*\?>/);
    const wcssHref = stylesheetMatch ? stylesheetMatch[1] : null;

    // Image resolver for local preview: resolve relative paths against dirName
    const resolveImage = (src: string) => resolveImageSrc(src, dirName);

    const { parts: cardHtmlParts, cards } = renderCards(wmlContent, resolveImage);

    const phoneFrameStart = showPhoneFrame ? `
    <div class="wap-phone-frame">
      <div class="phone-header">
        <span class="phone-signal">&#9679;&#9679;&#9679;&#9675;&#9675;</span>
        <span class="phone-title" id="card-title">${cards.length > 0 ? escapeHtml(cards[0].title) : 'WML'}</span>
        <span class="phone-battery">&#9608;&#9608;&#9608;</span>
      </div>
      <div class="phone-screen">` : '<div class="wml-content">';

    const phoneFrameEnd = showPhoneFrame ? `
      </div>
      <div class="phone-softkeys">
        <div class="softkey-menu-overlay" id="softkey-overlay"></div>
        <div class="softkey-menu" id="softkey-menu"></div>
        <button class="softkey softkey-left" id="softkey-left" onclick="wmlSoftkeyLeft()"></button>
        <button class="softkey softkey-right" id="softkey-right" onclick="wmlSoftkeyRight()">Back</button>
      </div>
    </div>` : '</div>';

    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=320">
  <title>${escapeHtml(fileName)} - WML Preview</title>
  <style>${getPreviewCSS()}</style>
  ${wcssHref ? `<link rel="stylesheet" href="${escapeHtml(wcssHref)}">` : ''}
</head>
<body>
  <div class="preview-toolbar">
    <span class="toolbar-title">WML Preview: ${escapeHtml(fileName)}</span>
    <span class="toolbar-info">${cards.length} card(s)</span>
  </div>
  ${phoneFrameStart}
    ${cardHtmlParts.join('\n    ')}
  ${phoneFrameEnd}
  <!-- Modal for WMLScript Dialogs (alert/confirm/prompt) — driven by wmlShowDialog -->
  <div class="dialog-overlay" id="dialog-overlay">
    <div class="dialog-box">
      <div class="dialog-message" id="dialog-message"></div>
      <input class="dialog-input" id="dialog-input" type="text" />
      <div class="dialog-buttons">
        <button class="dialog-btn" id="dialog-cancel">Cancel</button>
        <button class="dialog-btn primary" id="dialog-ok">OK</button>
      </div>
    </div>
  </div>
  <script>window.__wmlDeckBase = ${JSON.stringify(deckDir)};</script>
  <script>${getWmlsRuntime()}</script>
  <script>${getPreviewJS()}</script>
  <script>${getDebuggerBridgeJS()}</script>
  ${getEmbeddedWmlScripts(wmlContent, dirName)}
</body>
</html>`;
}

/**
 * Resolve an image src for the preview.
 * WBMP images are converted to inline SVG data URIs since browsers don't support WBMP.
 * Other images are converted to base64 data URIs for webview compatibility.
 */
function resolveImageSrc(src: string, dirName: string): string {
    if (!src) { return ''; }

    // Don't touch absolute URLs
    if (src.startsWith('http://') || src.startsWith('https://') || src.startsWith('data:')) {
        return escapeHtml(src);
    }

    const absPath = path.resolve(dirName, src);

    if (!fs.existsSync(absPath)) {
        return escapeHtml(src);
    }

    const ext = path.extname(absPath).toLowerCase();

    if (ext === '.wbmp') {
        return wbmpFileToDataUri(absPath);
    }

    // For standard image formats, embed as base64 data URI
    const mimeTypes: Record<string, string> = {
        '.png': 'image/png',
        '.jpg': 'image/jpeg',
        '.jpeg': 'image/jpeg',
        '.gif': 'image/gif',
        '.svg': 'image/svg+xml',
        '.bmp': 'image/bmp',
        '.ico': 'image/x-icon',
    };
    const mime = mimeTypes[ext] || 'application/octet-stream';
    try {
        const data = fs.readFileSync(absPath);
        return `data:${mime};base64,${data.toString('base64')}`;
    } catch {
        return escapeHtml(src);
    }
}

/** Read a WBMP file and return an inline SVG data URI */
function wbmpFileToDataUri(absPath: string): string {
    try {
        const data = fs.readFileSync(absPath);
        return wbmpToDataUri(data);
    } catch {
        return '';
    }
}

function getPreviewCSS(): string {
    const shared = fs.readFileSync(path.join(__dirname, '..', 'shared', 'wml-elements.css'), 'utf-8');
    const specific = fs.readFileSync(path.join(__dirname, 'preview.css'), 'utf-8');
    return shared + '\n' + specific;
}

function getPreviewJS(): string {
    const engineJs = fs.readFileSync(path.join(__dirname, '..', 'shared', 'wml-engine.js'), 'utf-8');
    const previewJs = fs.readFileSync(path.join(__dirname, 'preview.js'), 'utf-8');
    return engineJs + '\n' + previewJs;
}

/**
 * The WMLScript debug bridge. Connects the in-page __wmls._dbg controller to
 * the VS Code debug adapter when running inside the VS Code webview; a no-op in
 * a plain browser. Must load after the runtime + preview scripts.
 */
function getDebuggerBridgeJS(): string {
    return fs.readFileSync(path.join(__dirname, 'wmlsDebugBridge.js'), 'utf-8');
}

/**
 * Scan WML source for .wmls references, transpile them, and return
 * `<script>` tags with the transpiled JavaScript.
 * Also recursively includes scripts referenced via `use url` pragmas.
 */
function getEmbeddedWmlScripts(wmlContent: string, dirName: string): string {
    // Collect unique .wmls file references from the WML source
    const refs = new Set<string>();
    const hrefRe = /["']([^"']*\.wmls)(?:#[^"']*)?["']/gi;
    let m: RegExpExecArray | null;
    while ((m = hrefRe.exec(wmlContent)) !== null) {
        refs.add(m[1]);
    }
    if (refs.size === 0) return '';

    // Resolve file paths and transpile, collecting dependencies
    const transpiled = new Map<string, string>(); // urlPath → JS code
    const processScript = (relativePath: string) => {
        const filePath = path.resolve(dirName, relativePath);
        if (!fs.existsSync(filePath)) return;
        // Use the relative URL path as the registry key
        const urlPath = '/' + path.relative(
            getWorkspaceRoot() || dirName, filePath
        ).split(path.sep).join('/');
        if (transpiled.has(urlPath)) return;

        try {
            const source = fs.readFileSync(filePath, 'utf-8');
            transpiled.set(urlPath, transpileWmls(source, urlPath));

            // Process external dependencies (use url pragmas)
            const deps = getExternalDeps(source, urlPath);
            for (const dep of deps) {
                // Resolve dep relative to the script's directory
                const depRelative = path.relative(
                    getWorkspaceRoot() || dirName,
                    path.resolve(path.dirname(filePath), dep.replace(/^\//, ''))
                );
                processScript(depRelative);
            }
        } catch {
            // Skip scripts that fail to transpile
        }
    };

    for (const ref of refs) {
        processScript(ref);
    }

    if (transpiled.size === 0) return '';

    const scripts = Array.from(transpiled.values());
    return `<script>\n${scripts.join('\n')}\n</script>`;
}

function getWorkspaceRoot(): string | undefined {
    // Best-effort workspace root detection for URL path construction
    try {
        // eslint-disable-next-line @typescript-eslint/no-var-requires
        const vscode = require('vscode');
        const folders = vscode.workspace?.workspaceFolders;
        if (folders && folders.length > 0) return folders[0].uri.fsPath;
    } catch {
        // vscode module not available (e.g. tests) — fall through
    }
    return undefined;
}
