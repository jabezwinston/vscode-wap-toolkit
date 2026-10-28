/**
 *  Copyright (C) 2026 Jabez Winston
 *
 *  SPDX-License-Identifier: Apache-2.0
 *
 *  Date : 17-March-2026
 */

import * as vscode from 'vscode';
import * as http from 'http';
import * as path from 'path';
import * as fs from 'fs';
import { wmlToHtml } from './wmlToHtml';
import { transpileWmls, getWmlsRuntime } from './wmlsToJs';
import { escapeHtml } from '../shared/htmlUtils';
import { wbmpToSvg } from '../shared/wbmpUtils';

let server: http.Server | undefined;
let currentPort: number;
const DEFAULT_PREVIEW_HTTP_PORT = 2703;

export function startPreviewServer(context: vscode.ExtensionContext): string {
    const config = vscode.workspace.getConfiguration('wap');
    const port = config.get<number>('wml.preview.port', DEFAULT_PREVIEW_HTTP_PORT);
    const bindAddress = config.get<string>('bindAddress', '127.0.0.1') || '127.0.0.1';
    // A wildcard bind is still reachable via localhost; a specific address is not
    const host = (bindAddress === '0.0.0.0' || bindAddress === '::') ? 'localhost' : bindAddress;
    currentPort = port;

    if (server) {
        return `http://${host}:${port}`;
    }

    server = http.createServer((req, res) => {
        handleRequest(req, res, context);
    });

    server.listen(port, bindAddress, () => {
        vscode.window.showInformationMessage(`WML Preview Server running on port ${port}`);
    });

    server.on('error', (err: NodeJS.ErrnoException) => {
        if (err.code === 'EADDRINUSE') {
            vscode.window.showErrorMessage(`Port ${port} is already in use. Change wap.wml.preview.port in settings.`);
        }
    });

    return `http://${host}:${port}`;
}

export function stopPreviewServer(): void {
    if (server) {
        server.close();
        server = undefined;
        vscode.window.showInformationMessage('WML Preview Server stopped');
    }
}

export function isServerRunning(): boolean {
    return server !== undefined;
}

function handleRequest(req: http.IncomingMessage, res: http.ServerResponse, context: vscode.ExtensionContext): void {
    const urlPath = req.url || '/';

    // Serve static assets from media folder
    if (urlPath.startsWith('/__wml_preview__/')) {
        const assetName = urlPath.replace('/__wml_preview__/', '');
        const assetPath = path.join(context.extensionPath, 'media', assetName);
        serveStaticFile(assetPath, res);
        return;
    }

    // Find the workspace folder
    const workspaceFolders = vscode.workspace.workspaceFolders;
    if (!workspaceFolders || workspaceFolders.length === 0) {
        res.writeHead(404, { 'Content-Type': 'text/plain' });
        res.end('No workspace folder open');
        return;
    }

    // Resolve the file path relative to workspace
    const rootPath = workspaceFolders[0].uri.fsPath;
    const decodedPath = decodeURIComponent(urlPath);
    const requestedFile = path.join(rootPath, decodedPath);

    // Security: ensure the resolved path is within the workspace
    const resolvedPath = path.resolve(requestedFile);
    if (!resolvedPath.startsWith(path.resolve(rootPath))) {
        res.writeHead(403, { 'Content-Type': 'text/plain' });
        res.end('Forbidden');
        return;
    }

    // Check for directory -> list directory. do not auto-load index.wml
    let filePath = resolvedPath;
    if (fs.existsSync(filePath) && fs.statSync(filePath).isDirectory()) {
        serveDirectoryListing(filePath, decodedPath, res);
        return;
    }

    if (!fs.existsSync(filePath)) {
        res.writeHead(404, { 'Content-Type': 'text/plain' });
        res.end(`File not found: ${urlPath}`);
        return;
    }

    const ext = path.extname(filePath).toLowerCase();

    if (ext === '.wml') {
        serveWml(filePath, res, context);
    } else if (ext === '.wmls') {
        // Transpile WMLScript to JavaScript and serve for client-side execution
        try {
            const source = fs.readFileSync(filePath, 'utf-8');
            const urlPath2 = decodeURIComponent(req.url || '/');
            const js = transpileWmls(source, urlPath2);
            res.writeHead(200, { 'Content-Type': 'application/javascript; charset=utf-8' });
            res.end(js);
        } catch (err) {
            res.writeHead(500, { 'Content-Type': 'text/plain' });
            res.end(`Error transpiling WMLScript: ${err}`);
        }
    } else if (ext === '.css' || ext === '.wcss') {
        res.writeHead(200, { 'Content-Type': 'text/css' });
        res.end(fs.readFileSync(filePath, 'utf-8'));
    } else if (ext === '.wbmp') {
        serveWbmpAsSvg(filePath, res);
    } else {
        serveStaticFile(filePath, res);
    }
}

function serveWml(filePath: string, res: http.ServerResponse, context: vscode.ExtensionContext): void {
    try {
        const wmlContent = fs.readFileSync(filePath, 'utf-8');
        const config = vscode.workspace.getConfiguration('wml');
        const showFrame = config.get<boolean>('preview.phoneFrame', true);
        const html = wmlToHtml(wmlContent, filePath, showFrame);
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(html);
    } catch (err) {
        res.writeHead(500, { 'Content-Type': 'text/plain' });
        res.end(`Error rendering WML: ${err}`);
    }
}

function serveWbmpAsSvg(filePath: string, res: http.ServerResponse): void {
    try {
        const data = fs.readFileSync(filePath);
        const svg = wbmpToSvg(data);
        if (!svg) {
            res.writeHead(400, { 'Content-Type': 'text/plain' });
            res.end('Invalid WBMP');
            return;
        }
        res.writeHead(200, { 'Content-Type': 'image/svg+xml' });
        res.end(svg);
    } catch {
        res.writeHead(500, { 'Content-Type': 'text/plain' });
        res.end('Error reading WBMP file');
    }
}

function serveDirectoryListing(dirPath: string, urlPath: string, res: http.ServerResponse): void {
    try {
        const entries = fs.readdirSync(dirPath, { withFileTypes: true });
        const normalizedUrl = urlPath.endsWith('/') ? urlPath : urlPath + '/';

        // Sort: directories first, then files, alphabetical within each group
        const dirs = entries.filter(e => e.isDirectory()).sort((a, b) => a.name.localeCompare(b.name));
        const files = entries.filter(e => e.isFile()).sort((a, b) => a.name.localeCompare(b.name));

        const fileIcon = (name: string): string => {
            const ext = path.extname(name).toLowerCase();
            const icons: Record<string, string> = {
                '.wml': '📄', '.wmls': '📜', '.wcss': '🎨', '.css': '🎨',
                '.wbmp': '🖼️', '.png': '🖼️', '.gif': '🖼️', '.jpg': '🖼️',
            };
            return icons[ext] || '📎';
        };

        let rows = '';
        if (normalizedUrl !== '/') {
            const parent = path.posix.dirname(normalizedUrl.replace(/\/$/, '')) || '/';
            rows += `<tr><td>📁</td><td><a href="${encodeURI(parent)}">..</a></td><td></td></tr>\n`;
        }
        for (const d of dirs) {
            rows += `<tr><td>📁</td><td><a href="${encodeURI(normalizedUrl + d.name)}">${escapeHtml(d.name)}/</a></td><td></td></tr>\n`;
        }
        for (const f of files) {
            const stat = fs.statSync(path.join(dirPath, f.name));
            const size = formatFileSize(stat.size);
            rows += `<tr><td>${fileIcon(f.name)}</td><td><a href="${encodeURI(normalizedUrl + f.name)}">${escapeHtml(f.name)}</a></td><td>${size}</td></tr>\n`;
        }

        const html = `<!DOCTYPE html>
<html><head><meta charset="utf-8"><title>Index of ${escapeHtml(normalizedUrl)}</title>
<style>
  body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; margin: 2em; background: #1e1e2e; color: #cdd6f4; }
  h1 { font-size: 1.3em; color: #89b4fa; border-bottom: 1px solid #45475a; padding-bottom: 0.5em; }
  table { border-collapse: collapse; width: 100%; max-width: 700px; }
  td { padding: 4px 12px; }
  td:first-child { width: 1.5em; text-align: center; }
  td:last-child { text-align: right; color: #a6adc8; font-size: 0.9em; white-space: nowrap; }
  a { color: #89dceb; text-decoration: none; }
  a:hover { text-decoration: underline; }
  tr:hover { background: #313244; }
</style></head><body>
<h1>Index of ${escapeHtml(normalizedUrl)}</h1>
<table>${rows}</table>
</body></html>`;

        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(html);
    } catch {
        res.writeHead(500, { 'Content-Type': 'text/plain' });
        res.end('Error listing directory');
    }
}

function formatFileSize(bytes: number): string {
    if (bytes < 1024) { return `${bytes} B`; }
    if (bytes < 1048576) { return `${(bytes / 1024).toFixed(1)} KB`; }
    return `${(bytes / 1048576).toFixed(1)} MB`;
}

function serveStaticFile(filePath: string, res: http.ServerResponse): void {
    if (!fs.existsSync(filePath)) {
        res.writeHead(404, { 'Content-Type': 'text/plain' });
        res.end('Not found');
        return;
    }

    const ext = path.extname(filePath).toLowerCase();
    const mimeTypes: Record<string, string> = {
        '.html': 'text/html',
        '.css': 'text/css',
        '.js': 'application/javascript',
        '.png': 'image/png',
        '.gif': 'image/gif',
        '.jpg': 'image/jpeg',
        '.jpeg': 'image/jpeg',
        '.svg': 'image/svg+xml',
        '.ico': 'image/x-icon',
        '.wbmp': 'image/vnd.wap.wbmp',
    };

    const contentType = mimeTypes[ext] || 'application/octet-stream';
    res.writeHead(200, { 'Content-Type': contentType });
    res.end(fs.readFileSync(filePath));
}
