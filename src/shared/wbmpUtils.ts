/**
 *  Copyright (C) 2026 Jabez Winston
 *
 *  SPDX-License-Identifier: Apache-2.0
 *
 *  Shared WBMP (Wireless Bitmap) parsing and SVG conversion.
 */

/** Read a multi-byte integer from a WBMP buffer (variable-length encoding). */
function readMultiByte(buf: Buffer, p: { offset: number }): number {
    let result = 0;
    let byte: number;
    do {
        if (p.offset >= buf.length) { return -1; }
        byte = buf[p.offset++];
        result = (result << 7) | (byte & 0x7F);
    } while (byte & 0x80);
    return result;
}

/**
 * Convert a WBMP image buffer to an inline SVG data URI.
 * Returns an empty string if the buffer is not a valid Type 0 WBMP.
 */
export function wbmpToDataUri(data: Buffer): string {
    const pos = { offset: 0 };

    const type = readMultiByte(data, pos);
    if (type !== 0) { return ''; }
    const fixHeader = readMultiByte(data, pos);
    if (fixHeader !== 0) { return ''; }
    const width = readMultiByte(data, pos);
    const height = readMultiByte(data, pos);
    if (width <= 0 || height <= 0 || width > 10000 || height > 10000) { return ''; }

    const rowBytes = Math.ceil(width / 8);
    if (pos.offset + rowBytes * height > data.length) { return ''; }

    let rects = '';
    for (let y = 0; y < height; y++) {
        for (let x = 0; x < width; x++) {
            const byteIdx = pos.offset + y * rowBytes + Math.floor(x / 8);
            const bitIdx = 7 - (x % 8);
            const isWhite = (data[byteIdx] & (1 << bitIdx)) !== 0;
            if (!isWhite) {
                rects += `<rect x="${x}" y="${y}" width="1" height="1"/>`;
            }
        }
    }

    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" shape-rendering="crispEdges"><rect width="${width}" height="${height}" fill="white"/><g fill="black">${rects}</g></svg>`;
    return `data:image/svg+xml;base64,${Buffer.from(svg).toString('base64')}`;
}

/**
 * Convert a WBMP image buffer to a raw SVG string (not base64-encoded).
 * Returns null if the buffer is not a valid Type 0 WBMP.
 */
export function wbmpToSvg(data: Buffer): string | null {
    const pos = { offset: 0 };

    const type = readMultiByte(data, pos);
    if (type !== 0) { return null; }
    const fixHeader = readMultiByte(data, pos);
    if (fixHeader !== 0) { return null; }
    const width = readMultiByte(data, pos);
    const height = readMultiByte(data, pos);
    if (width <= 0 || height <= 0 || width > 10000 || height > 10000) { return null; }

    const rowBytes = Math.ceil(width / 8);
    if (pos.offset + rowBytes * height > data.length) { return null; }

    let rects = '';
    for (let y = 0; y < height; y++) {
        for (let x = 0; x < width; x++) {
            const byteIdx = pos.offset + y * rowBytes + Math.floor(x / 8);
            const bitIdx = 7 - (x % 8);
            const isWhite = (data[byteIdx] & (1 << bitIdx)) !== 0;
            if (!isWhite) {
                rects += `<rect x="${x}" y="${y}" width="1" height="1"/>`;
            }
        }
    }

    return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" shape-rendering="crispEdges"><rect width="${width}" height="${height}" fill="white"/><g fill="black">${rects}</g></svg>`;
}
