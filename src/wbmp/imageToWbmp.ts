/**
 *  Copyright (C) 2026 Jabez Winston
 * 
 *  SPDX-License-Identifier: Apache-2.0
 * 
 *  Converts various image formats (PNG, JPEG, BMP, OTB) to WBMP format for WML use.
 * 
 *  Date : 03-April-2026
 */

import * as fs from 'fs';
import * as path from 'path';
import * as zlib from 'zlib';

const MAX_DIMENSION = 128;

interface RawImage {
    width: number;
    height: number;
    data: Buffer; // RGBA, 4 bytes per pixel
}

// ===== BMP Decoder =====

function decodeBmp(buf: Buffer): RawImage {
    if (buf.length < 54 || buf[0] !== 0x42 || buf[1] !== 0x4D) {
        throw new Error('Invalid BMP file');
    }

    const pixelDataOffset = buf.readUInt32LE(10);
    const infoHeaderSize = buf.readUInt32LE(14);
    const width = buf.readInt32LE(18);
    let height = buf.readInt32LE(22);
    const bitsPerPixel = buf.readUInt16LE(28);
    const compression = buf.readUInt32LE(30);

    if (compression !== 0 && compression !== 3) {
        throw new Error(`Unsupported BMP compression type: ${compression}`);
    }

    const topDown = height < 0;
    height = Math.abs(height);

    if (width <= 0 || height <= 0) {
        throw new Error('Invalid BMP dimensions');
    }

    // Read palette for indexed images
    let palette: number[][] | null = null;
    if (bitsPerPixel <= 8) {
        const numColors = buf.readUInt32LE(46) || (1 << bitsPerPixel);
        palette = [];
        const paletteOffset = 14 + infoHeaderSize;
        for (let i = 0; i < numColors; i++) {
            const off = paletteOffset + i * 4;
            palette.push([buf[off + 2], buf[off + 1], buf[off], 255]); // BMP stores BGR
        }
    }

    const data = Buffer.alloc(width * height * 4);
    const rawRowBytes = Math.ceil(width * bitsPerPixel / 8);
    const paddedRowBytes = (rawRowBytes + 3) & ~3;

    for (let y = 0; y < height; y++) {
        const srcRow = topDown ? y : (height - 1 - y);
        const rowOffset = pixelDataOffset + srcRow * paddedRowBytes;

        for (let x = 0; x < width; x++) {
            const dstIdx = (y * width + x) * 4;

            if (bitsPerPixel === 32) {
                const srcIdx = rowOffset + x * 4;
                data[dstIdx] = buf[srcIdx + 2];
                data[dstIdx + 1] = buf[srcIdx + 1];
                data[dstIdx + 2] = buf[srcIdx];
                data[dstIdx + 3] = buf[srcIdx + 3];
            } else if (bitsPerPixel === 24) {
                const srcIdx = rowOffset + x * 3;
                data[dstIdx] = buf[srcIdx + 2];
                data[dstIdx + 1] = buf[srcIdx + 1];
                data[dstIdx + 2] = buf[srcIdx];
                data[dstIdx + 3] = 255;
            } else if (bitsPerPixel === 8 && palette) {
                const palIdx = buf[rowOffset + x];
                const color = palette[palIdx];
                data[dstIdx] = color[0];
                data[dstIdx + 1] = color[1];
                data[dstIdx + 2] = color[2];
                data[dstIdx + 3] = color[3];
            } else if (bitsPerPixel === 4 && palette) {
                const byteVal = buf[rowOffset + Math.floor(x / 2)];
                const palIdx = (x % 2 === 0) ? (byteVal >> 4) : (byteVal & 0x0F);
                const color = palette[palIdx];
                data[dstIdx] = color[0];
                data[dstIdx + 1] = color[1];
                data[dstIdx + 2] = color[2];
                data[dstIdx + 3] = color[3];
            } else if (bitsPerPixel === 1 && palette) {
                const byteVal = buf[rowOffset + Math.floor(x / 8)];
                const palIdx = (byteVal >> (7 - (x % 8))) & 1;
                const color = palette[palIdx];
                data[dstIdx] = color[0];
                data[dstIdx + 1] = color[1];
                data[dstIdx + 2] = color[2];
                data[dstIdx + 3] = color[3];
            }
        }
    }

    return { width, height, data };
}

// ===== PNG Decoder =====

function paethPredictor(a: number, b: number, c: number): number {
    const p = a + b - c;
    const pa = Math.abs(p - a);
    const pb = Math.abs(p - b);
    const pc = Math.abs(p - c);
    if (pa <= pb && pa <= pc) { return a; }
    if (pb <= pc) { return b; }
    return c;
}

function decodePng(buf: Buffer): RawImage {
    const signature = [137, 80, 78, 71, 13, 10, 26, 10];
    for (let i = 0; i < 8; i++) {
        if (buf[i] !== signature[i]) {
            throw new Error('Invalid PNG file');
        }
    }

    let offset = 8;
    let width = 0, height = 0, bitDepth = 0, colorType = 0;
    const idatChunks: Buffer[] = [];
    let palette: number[][] | null = null;

    while (offset < buf.length) {
        const chunkLen = buf.readUInt32BE(offset);
        const chunkType = buf.toString('ascii', offset + 4, offset + 8);
        const chunkData = buf.slice(offset + 8, offset + 8 + chunkLen);
        offset += 12 + chunkLen; // 4 len + 4 type + data + 4 crc

        if (chunkType === 'IHDR') {
            width = chunkData.readUInt32BE(0);
            height = chunkData.readUInt32BE(4);
            bitDepth = chunkData[8];
            colorType = chunkData[9];
            if (chunkData[12] !== 0) {
                throw new Error('Interlaced PNGs are not supported');
            }
        } else if (chunkType === 'PLTE') {
            palette = [];
            for (let i = 0; i < chunkData.length; i += 3) {
                palette.push([chunkData[i], chunkData[i + 1], chunkData[i + 2], 255]);
            }
        } else if (chunkType === 'tRNS') {
            if (palette && colorType === 3) {
                for (let i = 0; i < chunkData.length && i < palette.length; i++) {
                    palette[i][3] = chunkData[i];
                }
            }
        } else if (chunkType === 'IDAT') {
            idatChunks.push(chunkData);
        } else if (chunkType === 'IEND') {
            break;
        }
    }

    if (width === 0 || height === 0) {
        throw new Error('PNG missing IHDR chunk');
    }

    const compressed = Buffer.concat(idatChunks);
    const decompressed = zlib.inflateSync(compressed);

    let channels: number;
    switch (colorType) {
        case 0: channels = 1; break;
        case 2: channels = 3; break;
        case 3: channels = 1; break;
        case 4: channels = 2; break;
        case 6: channels = 4; break;
        default: throw new Error(`Unsupported PNG color type: ${colorType}`);
    }

    const bpp = Math.max(1, Math.ceil(channels * bitDepth / 8));
    const scanlineBytes = Math.ceil(width * channels * bitDepth / 8);

    // Reconstruct filtered scanlines
    const rawPixels = Buffer.alloc(scanlineBytes * height);
    let pos = 0;

    for (let y = 0; y < height; y++) {
        const filterType = decompressed[pos++];
        const rowStart = y * scanlineBytes;
        const prevRowStart = (y - 1) * scanlineBytes;

        for (let i = 0; i < scanlineBytes; i++) {
            const raw = decompressed[pos++];
            const a = i >= bpp ? rawPixels[rowStart + i - bpp] : 0;
            const b = y > 0 ? rawPixels[prevRowStart + i] : 0;
            const c = (y > 0 && i >= bpp) ? rawPixels[prevRowStart + i - bpp] : 0;

            let val: number;
            switch (filterType) {
                case 0: val = raw; break;
                case 1: val = (raw + a) & 0xFF; break;
                case 2: val = (raw + b) & 0xFF; break;
                case 3: val = (raw + Math.floor((a + b) / 2)) & 0xFF; break;
                case 4: val = (raw + paethPredictor(a, b, c)) & 0xFF; break;
                default: throw new Error(`Unknown PNG filter type: ${filterType}`);
            }
            rawPixels[rowStart + i] = val;
        }
    }

    // Convert to RGBA
    const data = Buffer.alloc(width * height * 4);

    for (let y = 0; y < height; y++) {
        for (let x = 0; x < width; x++) {
            const dstIdx = (y * width + x) * 4;

            if (bitDepth === 8) {
                const srcIdx = y * scanlineBytes + x * channels;
                switch (colorType) {
                    case 0:
                        data[dstIdx] = data[dstIdx + 1] = data[dstIdx + 2] = rawPixels[srcIdx];
                        data[dstIdx + 3] = 255;
                        break;
                    case 2:
                        data[dstIdx] = rawPixels[srcIdx];
                        data[dstIdx + 1] = rawPixels[srcIdx + 1];
                        data[dstIdx + 2] = rawPixels[srcIdx + 2];
                        data[dstIdx + 3] = 255;
                        break;
                    case 3:
                        if (palette) {
                            const c = palette[rawPixels[srcIdx]] || [0, 0, 0, 255];
                            data[dstIdx] = c[0];
                            data[dstIdx + 1] = c[1];
                            data[dstIdx + 2] = c[2];
                            data[dstIdx + 3] = c[3];
                        }
                        break;
                    case 4:
                        data[dstIdx] = data[dstIdx + 1] = data[dstIdx + 2] = rawPixels[srcIdx];
                        data[dstIdx + 3] = rawPixels[srcIdx + 1];
                        break;
                    case 6:
                        data[dstIdx] = rawPixels[srcIdx];
                        data[dstIdx + 1] = rawPixels[srcIdx + 1];
                        data[dstIdx + 2] = rawPixels[srcIdx + 2];
                        data[dstIdx + 3] = rawPixels[srcIdx + 3];
                        break;
                }
            } else if (bitDepth === 16) {
                const srcIdx = y * scanlineBytes + x * channels * 2;
                switch (colorType) {
                    case 0:
                        data[dstIdx] = data[dstIdx + 1] = data[dstIdx + 2] = rawPixels[srcIdx];
                        data[dstIdx + 3] = 255;
                        break;
                    case 2:
                        data[dstIdx] = rawPixels[srcIdx];
                        data[dstIdx + 1] = rawPixels[srcIdx + 2];
                        data[dstIdx + 2] = rawPixels[srcIdx + 4];
                        data[dstIdx + 3] = 255;
                        break;
                    case 4:
                        data[dstIdx] = data[dstIdx + 1] = data[dstIdx + 2] = rawPixels[srcIdx];
                        data[dstIdx + 3] = rawPixels[srcIdx + 2];
                        break;
                    case 6:
                        data[dstIdx] = rawPixels[srcIdx];
                        data[dstIdx + 1] = rawPixels[srcIdx + 2];
                        data[dstIdx + 2] = rawPixels[srcIdx + 4];
                        data[dstIdx + 3] = rawPixels[srcIdx + 6];
                        break;
                }
            } else if (bitDepth <= 4 && colorType === 3) {
                const pixelsPerByte = 8 / bitDepth;
                const byteIdx = y * scanlineBytes + Math.floor(x / pixelsPerByte);
                const bitShift = (pixelsPerByte - 1 - (x % pixelsPerByte)) * bitDepth;
                const mask = (1 << bitDepth) - 1;
                const palIdx = (rawPixels[byteIdx] >> bitShift) & mask;
                if (palette) {
                    const c = palette[palIdx] || [0, 0, 0, 255];
                    data[dstIdx] = c[0];
                    data[dstIdx + 1] = c[1];
                    data[dstIdx + 2] = c[2];
                    data[dstIdx + 3] = c[3];
                }
            } else if (bitDepth < 8 && colorType === 0) {
                const pixelsPerByte = 8 / bitDepth;
                const byteIdx = y * scanlineBytes + Math.floor(x / pixelsPerByte);
                const bitShift = (pixelsPerByte - 1 - (x % pixelsPerByte)) * bitDepth;
                const mask = (1 << bitDepth) - 1;
                const val = ((rawPixels[byteIdx] >> bitShift) & mask) * (255 / mask);
                data[dstIdx] = data[dstIdx + 1] = data[dstIdx + 2] = val;
                data[dstIdx + 3] = 255;
            }
        }
    }

    return { width, height, data };
}

// ===== OTB Decoder =====

function decodeOtb(buf: Buffer): RawImage {
    if (buf.length < 4) {
        throw new Error('Invalid OTB file: too small');
    }

    // Byte 0: type (ignored), 1: width, 2: height, 3: color depth
    const width = buf[1];
    const height = buf[2];
    const colorDepth = buf[3];

    if (width === 0 || height === 0) {
        throw new Error('Invalid OTB dimensions');
    }
    if (colorDepth !== 1) {
        throw new Error(`Unsupported OTB color depth: ${colorDepth}. Only 1-bit is supported`);
    }

    const expectedBytes = Math.ceil(width * height / 8);
    if (buf.length < 4 + expectedBytes) {
        throw new Error(`Invalid OTB file: expected ${expectedBytes} bytes of bitmap data`);
    }

    const data = Buffer.alloc(width * height * 4);
    const bitmapData = buf.slice(4);

    for (let y = 0; y < height; y++) {
        for (let x = 0; x < width; x++) {
            const bitIndex = y * width + x;
            const byteIndex = Math.floor(bitIndex / 8);
            const bitPosition = 7 - (bitIndex % 8);
            // OTB: 1 = black, 0 = white
            const isBlack = (bitmapData[byteIndex] >> bitPosition) & 1;
            const lum = isBlack ? 0 : 255;
            const dstIdx = (y * width + x) * 4;
            data[dstIdx] = lum;
            data[dstIdx + 1] = lum;
            data[dstIdx + 2] = lum;
            data[dstIdx + 3] = 255;
        }
    }

    return { width, height, data };
}

// ===== JPEG Decoder =====

function decodeJpeg(buf: Buffer): RawImage {
    const jpeg = require('jpeg-js');
    const decoded = jpeg.decode(buf, { useTArray: false, formatAsRGBA: true });
    return {
        width: decoded.width,
        height: decoded.height,
        data: Buffer.from(decoded.data),
    };
}

// ===== Scaling =====

function scaleDown(img: RawImage, maxDim: number): RawImage {
    const maxSide = Math.max(img.width, img.height);
    if (maxSide <= maxDim) { return img; }

    const scale = maxDim / maxSide;
    const newW = Math.max(1, Math.round(img.width * scale));
    const newH = Math.max(1, Math.round(img.height * scale));

    const result = Buffer.alloc(newW * newH * 4);
    const xRatio = img.width / newW;
    const yRatio = img.height / newH;

    for (let y = 0; y < newH; y++) {
        for (let x = 0; x < newW; x++) {
            // Area averaging for quality downscale
            const x0 = Math.floor(x * xRatio);
            const x1 = Math.min(Math.ceil((x + 1) * xRatio), img.width);
            const y0 = Math.floor(y * yRatio);
            const y1 = Math.min(Math.ceil((y + 1) * yRatio), img.height);

            let r = 0, g = 0, b = 0, a = 0, count = 0;
            for (let sy = y0; sy < y1; sy++) {
                for (let sx = x0; sx < x1; sx++) {
                    const idx = (sy * img.width + sx) * 4;
                    r += img.data[idx];
                    g += img.data[idx + 1];
                    b += img.data[idx + 2];
                    a += img.data[idx + 3];
                    count++;
                }
            }

            const dstIdx = (y * newW + x) * 4;
            result[dstIdx] = Math.round(r / count);
            result[dstIdx + 1] = Math.round(g / count);
            result[dstIdx + 2] = Math.round(b / count);
            result[dstIdx + 3] = Math.round(a / count);
        }
    }

    return { width: newW, height: newH, data: result };
}

// ===== WBMP Encoder =====

function writeMultiByte(value: number): Buffer {
    if (value === 0) { return Buffer.from([0]); }
    const bytes: number[] = [];
    let v = value;
    while (v > 0) {
        bytes.unshift(v & 0x7F);
        v >>= 7;
    }
    for (let i = 0; i < bytes.length - 1; i++) {
        bytes[i] |= 0x80;
    }
    return Buffer.from(bytes);
}

function encodeToWbmp(image: RawImage, threshold: number = 128): Buffer {
    const parts: Buffer[] = [];

    // Type 0
    parts.push(Buffer.from([0]));
    // Fix header
    parts.push(Buffer.from([0]));
    // Width & Height (multi-byte encoded)
    parts.push(writeMultiByte(image.width));
    parts.push(writeMultiByte(image.height));

    // Pixel data: 1 bit per pixel, 1=white, 0=black
    const rowBytes = Math.ceil(image.width / 8);
    const pixelData = Buffer.alloc(rowBytes * image.height);

    for (let y = 0; y < image.height; y++) {
        for (let x = 0; x < image.width; x++) {
            const pixIdx = (y * image.width + x) * 4;
            const alpha = image.data[pixIdx + 3];
            // Alpha-composite against white background:
            // blended = fg * (alpha/255) + 255 * (1 - alpha/255)
            const a = alpha / 255;
            const r = image.data[pixIdx] * a + 255 * (1 - a);
            const g = image.data[pixIdx + 1] * a + 255 * (1 - a);
            const b = image.data[pixIdx + 2] * a + 255 * (1 - a);
            const luminance = 0.299 * r + 0.587 * g + 0.114 * b;
            if (luminance >= threshold) {
                const byteIdx = y * rowBytes + Math.floor(x / 8);
                pixelData[byteIdx] |= (1 << (7 - (x % 8)));
            }
        }
    }

    parts.push(pixelData);
    return Buffer.concat(parts);
}

// ===== Public API =====

export interface WbmpConversionResult {
    buffer: Buffer;
    width: number;
    height: number;
    originalWidth: number;
    originalHeight: number;
    scaled: boolean;
}

export function convertImageToWbmp(inputPath: string): WbmpConversionResult {
    const ext = path.extname(inputPath).toLowerCase();
    const buf = fs.readFileSync(inputPath);

    let image: RawImage;

    switch (ext) {
        case '.bmp':
            image = decodeBmp(buf);
            break;
        case '.png':
            image = decodePng(buf);
            break;
        case '.jpg':
        case '.jpeg':
            image = decodeJpeg(buf);
            break;
        case '.otb':
            image = decodeOtb(buf);
            break;
        default:
            throw new Error(`Unsupported image format: ${ext}. Supported: PNG, JPG, BMP, OTB`);
    }

    const originalWidth = image.width;
    const originalHeight = image.height;

    // Scale down if any dimension exceeds MAX_DIMENSION
    image = scaleDown(image, MAX_DIMENSION);

    const wbmpBuffer = encodeToWbmp(image);

    return {
        buffer: wbmpBuffer,
        width: image.width,
        height: image.height,
        originalWidth,
        originalHeight,
        scaled: originalWidth !== image.width || originalHeight !== image.height,
    };
}
