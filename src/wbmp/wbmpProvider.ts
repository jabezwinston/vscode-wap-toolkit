/**
 *  Copyright (C) 2026 Jabez Winston
 * 
 *  SPDX-License-Identifier: Apache-2.0
 * 
 *  WBMP previewer
 * 
 *  Date : 17-March-2026
 */

import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { viewerHtml } from '../shared/viewerChrome';

/**
 * WBMP (Wireless Bitmap) Image Viewer
 * WBMP Format: Type (multi-byte) | FixHeader (multi-byte) | Width (multi-byte) | Height (multi-byte) | Pixel data
 * Each pixel is 1 bit: 1=white, 0=black
 */
export class WbmpEditorProvider implements vscode.CustomReadonlyEditorProvider {
    public static readonly viewType = 'wml.wbmpViewer';


    openCustomDocument(uri: vscode.Uri): vscode.CustomDocument {
        return { uri, dispose: () => {} };
    }

    resolveCustomEditor(document: vscode.CustomDocument, webviewPanel: vscode.WebviewPanel): void {
        webviewPanel.webview.options = { enableScripts: true };

        try {
            const data = fs.readFileSync(document.uri.fsPath);
            const parsed = parseWbmp(data);

            if (parsed) {
                webviewPanel.webview.html = this.getHtml(parsed, document.uri);

                webviewPanel.webview.onDidReceiveMessage(msg => {
                    if (msg.type === 'resize' && parsed) {
                        this.handleResize(parsed, msg.newWidth, msg.newHeight, document.uri, webviewPanel);
                    }
                });
            } else {
                webviewPanel.webview.html = '<html><body><p>Invalid WBMP file</p></body></html>';
            }
        } catch (err) {
            webviewPanel.webview.html = `<html><body><p>Error reading WBMP: ${err}</p></body></html>`;
        }
    }

    private handleResize(image: WbmpImage, newWidth: number, newHeight: number, uri: vscode.Uri, panel: vscode.WebviewPanel): void {
        newWidth = Math.max(1, Math.min(10000, Math.round(newWidth)));
        newHeight = Math.max(1, Math.min(10000, Math.round(newHeight)));

        const resized = resizeWbmpImage(image, newWidth, newHeight);
        const wbmpBuf = encodeWbmpFromImage(resized);

        const dir = path.dirname(uri.fsPath);
        const ext = path.extname(uri.fsPath);
        const base = path.basename(uri.fsPath, ext);
        const outPath = path.join(dir, `${base}_${newWidth}x${newHeight}${ext}`);

        fs.writeFileSync(outPath, wbmpBuf);
        vscode.window.showInformationMessage(
            `Resized WBMP saved: ${path.basename(outPath)} (${newWidth}\u00D7${newHeight}, ${wbmpBuf.length} bytes)`
        );

        // Refresh the panel with resized image
        panel.webview.html = this.getHtml(resized, vscode.Uri.file(outPath));
    }

    private getHtml(image: WbmpImage, uri: vscode.Uri): string {
        const fileName = uri.fsPath.split('/').pop() || 'image.wbmp';
        // Generate SVG from pixel data for crisp rendering
        let svgPixels = '';
        for (let y = 0; y < image.height; y++) {
            for (let x = 0; x < image.width; x++) {
                if (!image.pixels[y * image.width + x]) {
                    // Black pixel
                    svgPixels += `<rect x="${x}" y="${y}" width="1" height="1" fill="black"/>`;
                }
            }
        }

        const scale = Math.max(1, Math.min(8, Math.floor(400 / Math.max(image.width, image.height))));
        const displayWidth = image.width * scale;
        const displayHeight = image.height * scale;

        return viewerHtml({
            fileName,
            facts: [`${image.width} × ${image.height}`, 'WBMP Type 0', `${image.dataSize} bytes`],
            actions: `
    <button onclick="zoom(-1)" title="Zoom out">−</button>
    <span class="zoom-level" id="zoomLevel">${scale * 100}%</span>
    <button onclick="zoom(1)" title="Zoom in">+</button>
    <button onclick="invert()">Invert</button>
    <button class="primary" onclick="showResizeModal()">Resize…</button>`,
            body: `
  <div class="image-stage">
    <div class="image-container">
      <svg xmlns="http://www.w3.org/2000/svg" width="${displayWidth}" height="${displayHeight}"
           viewBox="0 0 ${image.width} ${image.height}" shape-rendering="crispEdges">
        <rect width="${image.width}" height="${image.height}" fill="white"/>
        ${svgPixels}
      </svg>
    </div>
  </div>
  <div class="resize-modal" id="resizeModal">
    <div class="resize-modal-content">
      <div class="row">
        <label>Width <input type="number" id="resW" value="${image.width}" min="1" max="10000"></label>
        <label>Height <input type="number" id="resH" value="${image.height}" min="1" max="10000"></label>
      </div>
      <label class="row"><input type="checkbox" id="keepAspect" checked> Keep aspect ratio</label>
      <div class="row actions">
        <button onclick="hideResizeModal()">Cancel</button>
        <button class="primary" onclick="doResize()">Resize &amp; save</button>
      </div>
    </div>
  </div>`,
            css: `
  .zoom-level { min-width: 48px; text-align: center; font-size: 12px; }
  .image-stage { display: flex; justify-content: center; padding: 24px; }
  .image-container { line-height: 0; border: 1px solid var(--vscode-panel-border, #444); image-rendering: pixelated; }
  .resize-modal {
    display: none; position: fixed; top: 0; left: 0; width: 100%; height: 100%;
    background: rgba(0,0,0,0.5); z-index: 10; align-items: center; justify-content: center;
  }
  .resize-modal.visible { display: flex; }
  .resize-modal-content {
    background: var(--vscode-editorWidget-background, #252526); border: 1px solid var(--vscode-editorWidget-border, #454545);
    border-radius: 8px; padding: 16px; display: flex; flex-direction: column; gap: 12px;
  }
  .row { display: flex; align-items: center; gap: 8px; font-size: 12px; }
  .row.actions { justify-content: flex-end; }
  .row input[type="number"] {
    width: 72px; margin-left: 4px; background: var(--vscode-input-background, #3c3c3c); color: var(--vscode-input-foreground, #ccc);
    border: 1px solid var(--vscode-input-border, transparent); padding: 4px 6px; border-radius: 4px; font: inherit;
  }`,
            script: `
    const vscode = acquireVsCodeApi();
    let currentScale = ${scale};
    const origW = ${image.width}, origH = ${image.height};

    const resW = document.getElementById('resW');
    const resH = document.getElementById('resH');
    const keepAspect = document.getElementById('keepAspect');
    const resizeModal = document.getElementById('resizeModal');
    const aspect = origW / origH;

    resW.addEventListener('input', () => {
      if (keepAspect.checked) {
        resH.value = Math.max(1, Math.round(parseInt(resW.value) / aspect));
      }
    });
    resH.addEventListener('input', () => {
      if (keepAspect.checked) {
        resW.value = Math.max(1, Math.round(parseInt(resH.value) * aspect));
      }
    });

    function showResizeModal() {
      resW.value = origW;
      resH.value = origH;
      resizeModal.classList.add('visible');
    }
    function hideResizeModal() {
      resizeModal.classList.remove('visible');
    }

    function doResize() {
      const w = parseInt(resW.value);
      const h = parseInt(resH.value);
      if (!w || !h || w < 1 || h < 1 || w > 10000 || h > 10000) { return; }
      hideResizeModal();
      vscode.postMessage({ type: 'resize', newWidth: w, newHeight: h });
    }

    function zoom(dir) {
      currentScale = Math.max(1, Math.min(16, currentScale + dir));
      const svg = document.querySelector('svg');
      svg.setAttribute('width', origW * currentScale);
      svg.setAttribute('height', origH * currentScale);
      document.getElementById('zoomLevel').textContent = (currentScale * 100) + '%';
    }
    function invert() {
      document.querySelectorAll('svg rect').forEach(r => {
        const fill = r.getAttribute('fill');
        r.setAttribute('fill', fill === 'white' ? 'black' : (fill === 'black' ? 'white' : fill));
      });
    }`,
        });
    }
}

interface WbmpImage {
    width: number;
    height: number;
    pixels: boolean[]; // true = white, false = black
    dataSize: number;
}

// WAE Media Types: 4.3.1 Multi-byte Integer Format
function readMultiByte(data: Buffer, pos: { offset: number }): number {
    let result = 0;
    let byte: number;
    do {
        if (pos.offset >= data.length) { return -1; }
        byte = data[pos.offset++];
        result = (result << 7) | (byte & 0x7F);
    } while (byte & 0x80);
    return result;
}

// WAE Media Types:
//  - 4.4 Header Data Structure
//  - 4.5.1 WBMP Type 0: B/W, Uncompressed Bitmap
function parseWbmp(data: Buffer): WbmpImage | null {
    const pos = { offset: 0 };

    // Type (must be 0 for Type 0 WBMP)
    const type = readMultiByte(data, pos);
    if (type !== 0) { return null; }

    // Fixed header (extension header byte, must be 0)
    const fixHeader = readMultiByte(data, pos);
    if (fixHeader !== 0) { return null; }

    // Width and Height
    const width = readMultiByte(data, pos);
    const height = readMultiByte(data, pos);

    if (width <= 0 || height <= 0 || width > 10000 || height > 10000) { return null; }

    // Pixel data: each row is ceil(width/8) bytes
    const rowBytes = Math.ceil(width / 8);
    const expectedDataLen = rowBytes * height;

    if (pos.offset + expectedDataLen > data.length) { return null; }

    const pixels: boolean[] = [];
    for (let y = 0; y < height; y++) {
        for (let x = 0; x < width; x++) {
            const byteIdx = pos.offset + y * rowBytes + Math.floor(x / 8);
            const bitIdx = 7 - (x % 8);
            const isWhite = (data[byteIdx] & (1 << bitIdx)) !== 0;
            pixels.push(isWhite);
        }
    }

    return { width, height, pixels, dataSize: data.length };
}

function resizeWbmpImage(src: WbmpImage, newWidth: number, newHeight: number): WbmpImage {
    const pixels: boolean[] = [];
    const xRatio = src.width / newWidth;
    const yRatio = src.height / newHeight;

    for (let y = 0; y < newHeight; y++) {
        for (let x = 0; x < newWidth; x++) {
            // Area averaging: count white vs black in the source region
            const x0 = Math.floor(x * xRatio);
            const x1 = Math.min(Math.ceil((x + 1) * xRatio), src.width);
            const y0 = Math.floor(y * yRatio);
            const y1 = Math.min(Math.ceil((y + 1) * yRatio), src.height);

            let whiteCount = 0, total = 0;
            for (let sy = y0; sy < y1; sy++) {
                for (let sx = x0; sx < x1; sx++) {
                    if (src.pixels[sy * src.width + sx]) { whiteCount++; }
                    total++;
                }
            }
            pixels.push(whiteCount >= total / 2);
        }
    }

    return { width: newWidth, height: newHeight, pixels, dataSize: 0 };
}

// WAE Media Types: 4.3.1 Multi-byte Integer Format
function writeMultiByteEnc(value: number): number[] {
    if (value === 0) { return [0]; }
    const bytes: number[] = [];
    let v = value;
    while (v > 0) {
        bytes.unshift(v & 0x7F);
        v >>= 7;
    }
    for (let i = 0; i < bytes.length - 1; i++) {
        bytes[i] |= 0x80;
    }
    return bytes;
}

// WAE Media Types:
//  - 4.4 Header Data Structure
//  - 4.5.1 WBMP Type 0: B/W, Uncompressed Bitmap
function encodeWbmpFromImage(image: WbmpImage): Buffer {
    const parts: number[] = [];
    parts.push(0); // Type 0
    parts.push(0); // Fix header
    parts.push(...writeMultiByteEnc(image.width));
    parts.push(...writeMultiByteEnc(image.height));

    const rowBytes = Math.ceil(image.width / 8);
    for (let y = 0; y < image.height; y++) {
        for (let byteIdx = 0; byteIdx < rowBytes; byteIdx++) {
            let byte = 0;
            for (let bit = 0; bit < 8; bit++) {
                const x = byteIdx * 8 + bit;
                if (x < image.width && image.pixels[y * image.width + x]) {
                    byte |= (1 << (7 - bit));
                }
            }
            parts.push(byte);
        }
    }

    return Buffer.from(parts);
}
