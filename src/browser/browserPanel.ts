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
import * as http from 'http';
import * as https from 'https';
import * as dgram from 'dgram';
import * as path from 'path';
import * as fs from 'fs';
import * as os from 'os';
import * as url from 'url';
import { decodeWbxml } from '../wbxml/decoder';
import { compileWmls, compileWmlsWithDebugInfo } from '../wmlsc/compiler';
import { decodeWmlsc, disassembleWithLineMap } from '../wmlsc/decoder';
import { WmlsVM } from '../wmlsc/vm';
import {
    LibraryContext, createDefaultContext,
    mkString, mkInt, mkFloat, mkBool, mkInvalid,
    WmlsValue, toString as wmlsToString, DialogRequest,
} from '../wmlsc/stdlib';

// A parsed WMLScript call argument. `quoted` marks a string-literal token
// ('...'/"...") whose type must stay String per WMLScript §8.3.4; a bare string
// (legacy / unquoted) is coerced by its literal form. Produced by
// parseWmlScriptArgs in src/shared/wml-engine.js and forwarded by the webview.
type WmlsCallArg = string | { value: string; quoted: boolean };
import { browserDebugSession } from '../wmlsc/browserDebugSession';
import { urlToDebugUri } from './debugUri';
import { debugSourceProvider, DEBUG_SCHEME } from './debugSourceProvider';
import {
    WmlCard, escapeHtml, renderCards, ImageResolver,
} from '../wmlTransform';
import { wbmpToDataUri } from '../shared/wbmpUtils';
import { checkDeckAccess } from '../shared/deckAccess';
import {
    WTP_PDU_INVOKE, WTP_PDU_RESULT,
    WSP_PDU_CONNECT, WSP_PDU_CONNECT_REPLY, WSP_PDU_REPLY, WSP_PDU_GET, WSP_PDU_POST,
    WSP_CT as WSP_CT_MAP,
    WSP_HDR_ACCEPT, WSP_HDR_LOCATION, WSP_HDR_SET_COOKIE,
    encodeUintvar, decodeUintvar,
} from '../shared/wapProtocol';

// ── Browser Settings ────────────────────────────────────────────

interface BrowserSettings {
    transport: 'http' | 'wsp';
    gatewayHost: string;
    gatewayPort: number;
    wspCoPort: number;
    screenWidth: number;
    screenHeight: number;
}

const SETTINGS_KEY = 'wapBrowser.settings';

const DEFAULT_SETTINGS: BrowserSettings = {
    transport: 'http',
    gatewayHost: '127.0.0.1',
    gatewayPort: 9200,
    wspCoPort: 9201,
    screenWidth: 280,
    screenHeight: 380,
};

// ── Types ────────────────────────────────────────────────────────

interface Cookie {
    name: string;
    value: string;
    domain: string;
    path: string;
    expires?: Date;
}

// ── Cookie Jar ───────────────────────────────────────────────────

class CookieJar {
    private cookies: Cookie[] = [];

    set(rawCookie: string, requestUrl: string): void {
        const parsed = url.parse(requestUrl);
        const domain = parsed.hostname || '';
        const cookiePath = parsed.pathname || '/';

        const parts = rawCookie.split(';').map(s => s.trim());
        const [nameVal, ...attrs] = parts;
        const eqIdx = nameVal.indexOf('=');
        if (eqIdx < 0) { return; }
        const name = nameVal.substring(0, eqIdx).trim();
        const value = nameVal.substring(eqIdx + 1).trim();

        let cDomain = domain;
        let cPath = cookiePath;
        let cExpires: Date | undefined;

        for (const attr of attrs) {
            const lower = attr.toLowerCase();
            if (lower.startsWith('domain=')) {
                cDomain = attr.substring(7).trim();
            } else if (lower.startsWith('path=')) {
                cPath = attr.substring(5).trim();
            } else if (lower.startsWith('expires=')) {
                cExpires = new Date(attr.substring(8).trim());
            }
        }

        // Remove any existing cookie with same name+domain+path
        this.cookies = this.cookies.filter(c =>
            !(c.name === name && c.domain === cDomain && c.path === cPath)
        );

        // Don't store if expired
        if (cExpires && cExpires.getTime() < Date.now()) { return; }

        this.cookies.push({ name, value, domain: cDomain, path: cPath, expires: cExpires });
    }

    get(requestUrl: string): string {
        const parsed = url.parse(requestUrl);
        const domain = parsed.hostname || '';
        const reqPath = parsed.pathname || '/';
        const now = Date.now();

        const matching = this.cookies.filter(c => {
            if (c.expires && c.expires.getTime() < now) { return false; }
            if (!domain.endsWith(c.domain) && domain !== c.domain) { return false; }
            if (!reqPath.startsWith(c.path)) { return false; }
            return true;
        });

        return matching.map(c => `${c.name}=${c.value}`).join('; ');
    }

    clear(): number {
        const count = this.cookies.length;
        this.cookies = [];
        return count;
    }

    count(): number {
        return this.cookies.length;
    }
}

// ── WML to HTML Renderer (browser-specific) ──────────────────────

function renderCardsHtml(wmlContent: string, baseUrl: string): { html: string, cards: WmlCard[], firstTitle: string } {
    const resolveImage: ImageResolver = (src) => {
        if (!src || src.startsWith('data:')) { return escapeHtml(src); }
        try { return escapeHtml(new URL(src, baseUrl).toString()); } catch { return escapeHtml(src); }
    };
    const { parts, cards, firstTitle } = renderCards(wmlContent, resolveImage);
    return { html: parts.join('\n'), cards, firstTitle };
}

// ── HTTP Fetcher ─────────────────────────────────────────────────

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

interface FetchResult {
    status: number;
    contentType: string;
    body: Buffer;
    headers: Record<string, string>;
    finalUrl: string;
}

function fetchHttp(targetUrl: string, method: string = 'GET', postBody?: string, cookies?: string, cookieJar?: CookieJar, referer?: string, _redirectsLeft: number = 5): Promise<FetchResult> {
    return new Promise((resolve, reject) => {
        const parsed = new URL(targetUrl);
        const isHttps = parsed.protocol === 'https:';
        const lib = isHttps ? https : http;

        const headers: Record<string, string> = {
            'User-Agent': USER_AGENT,
            'Accept': 'application/vnd.wap.wmlc, application/vnd.wap.wmlscriptc, text/vnd.wap.wml, text/vnd.wap.wmlscript, image/vnd.wap.wbmp',
        };
        if (cookies) { headers['Cookie'] = cookies; }
        if (referer) { headers['Referer'] = referer; }
        if (method === 'POST' && postBody) {
            headers['Content-Type'] = 'application/x-www-form-urlencoded';
            headers['Content-Length'] = String(Buffer.byteLength(postBody));
        }

        const options: http.RequestOptions = {
            method,
            hostname: parsed.hostname,
            port: parsed.port,
            path: parsed.pathname + parsed.search,
            headers,
            timeout: 15000,
        };

        const req = lib.request(options, (res) => {
            // Handle redirects (up to 5)
            if (res.statusCode && res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
                if (_redirectsLeft <= 0) {
                    reject(new Error('Too many redirects'));
                    return;
                }
                // Store cookies from redirect response before following
                if (cookieJar && res.headers['set-cookie']) {
                    for (const raw of res.headers['set-cookie']) {
                        cookieJar.set(raw, targetUrl);
                    }
                }
                const redirectUrl = new URL(res.headers.location, targetUrl).toString();
                const redirectCookies = cookieJar ? cookieJar.get(redirectUrl) : cookies;
                fetchHttp(redirectUrl, 'GET', undefined, redirectCookies || undefined, cookieJar, referer, _redirectsLeft - 1).then(resolve).catch(reject);
                return;
            }

            const chunks: Buffer[] = [];
            res.on('data', (chunk: Buffer) => chunks.push(chunk));
            res.on('end', () => {
                const body = Buffer.concat(chunks);
                const rawHeaders: Record<string, string> = {};
                for (const [key, val] of Object.entries(res.headers)) {
                    if (val) { rawHeaders[key] = Array.isArray(val) ? val.join(', ') : val; }
                }
                resolve({
                    status: res.statusCode || 0,
                    contentType: res.headers['content-type'] || '',
                    body,
                    headers: rawHeaders,
                    finalUrl: targetUrl,
                });
            });
        });

        req.on('error', (err) => reject(err));
        req.on('timeout', () => { req.destroy(); reject(new Error('Request timeout')); });

        if (method === 'POST' && postBody) { req.write(postBody); }
        req.end();
    });
}

// ── WSP Client (Connectionless over UDP, port 9200) ─────────────

// Shorthand aliases for content-type codes used in PDU construction
const WSP_CT_TEXT_WML = 0x08;
const WSP_CT_TEXT_WMLS = 0x09;
const WSP_CT_APP_WMLC = 0x14;
const WSP_CT_APP_WMLSC = 0x15;
const WSP_CT_APP_URLENC = 0x12;

/**  WSP status → HTTP status.  hi nibble = class, lo = detail.
 *   Special: 0x6* → 500+lo (not 600).  Per WAP-230-WSP Table 36. */
function wspStatusToHttp(s: number): number {
    const hi = (s >> 4) & 0x0F;
    const lo = s & 0x0F;
    if (hi >= 6) { return 500 + lo; }
    return hi * 100 + lo;
}

function fetchWsp(targetUrl: string, gatewayHost: string, gatewayPort: number, cookieHeader?: string): Promise<FetchResult> {
    return new Promise((resolve, reject) => {
        const socket = dgram.createSocket('udp4');
        const MAX_RETRIES = 3;
        const RECV_TIMEOUT_MS = 5000;
        const TOTAL_TIMEOUT_S = 15;
        let attempt = 0;
        let closed = false;

        const totalTimeout = setTimeout(() => {
            if (!closed) { closed = true; socket.close(); reject(new Error('WSP request timeout')); }
        }, TOTAL_TIMEOUT_S * 1000);

        // 1-byte TID for connectionless WSP (port 9200)
        const tid = (Date.now() & 0xFF);

        // ── Build WSP GET PDU with Accept + User-Agent + Cookie headers ──
        const urlBuf = Buffer.from(targetUrl, 'utf-8');
        const uriLenBuf = encodeUintvar(urlBuf.length);

        // WSP request headers (binary well-known encoding per WAP-230-WSP)
        const hdrParts: number[] = [];
        // Accept: application/vnd.wap.wmlc  (0x14 | 0x80 = short-int)
        hdrParts.push(0x80 | WSP_HDR_ACCEPT);  // Accept header token
        hdrParts.push(0x80 | WSP_CT_APP_WMLC);
        // Accept: application/vnd.wap.wmlscriptc
        hdrParts.push(0x80 | WSP_HDR_ACCEPT);
        hdrParts.push(0x80 | WSP_CT_APP_WMLSC);
        // Accept: text/vnd.wap.wml
        hdrParts.push(0x80 | WSP_HDR_ACCEPT);
        hdrParts.push(0x80 | WSP_CT_TEXT_WML);
        // Accept: text/vnd.wap.wmlscript
        hdrParts.push(0x80 | WSP_HDR_ACCEPT);
        hdrParts.push(0x80 | WSP_CT_TEXT_WMLS);
        // Accept: image/vnd.wap.wbmp (0x21)
        hdrParts.push(0x80 | WSP_HDR_ACCEPT);
        hdrParts.push(0x80 | 0x21);
        // User-Agent (0x29 | 0x80 = token, null-terminated string)
        hdrParts.push(0xA9);  // User-Agent header token
        const ua = USER_AGENT;
        for (let i = 0; i < ua.length; i++) { hdrParts.push(ua.charCodeAt(i)); }
        hdrParts.push(0x00);  // null terminator
        // Cookie header (if any)
        if (cookieHeader && cookieHeader.length > 0) {
            hdrParts.push(0x80 | 0x42);  // Cookie header token (0x42 | 0x80 = 0xC2)
            for (let i = 0; i < cookieHeader.length; i++) { hdrParts.push(cookieHeader.charCodeAt(i)); }
            hdrParts.push(0x00);
        }
        const hdrsBuf = Buffer.from(hdrParts);

        // WSP GET PDU: [0x40] [URI_LEN uintvar] [URI] [headers]
        const wspPdu = Buffer.concat([
            Buffer.from([WSP_PDU_GET]),
            uriLenBuf,
            urlBuf,
            hdrsBuf,
        ]);

        // CL-WSP packet: [TID:1] [WSP PDU]  (no WTP framing on port 9200)
        const packet = Buffer.alloc(1 + wspPdu.length);
        packet[0] = tid;
        wspPdu.copy(packet, 1);

        function sendRequest() {
            socket.send(packet, gatewayPort, gatewayHost, (err) => {
                if (err && !closed) { closed = true; clearTimeout(totalTimeout); reject(err); socket.close(); }
            });
        }

        // Retry timer for per-attempt timeout
        let retryTimer: ReturnType<typeof setTimeout> | undefined;
        function scheduleRetry() {
            retryTimer = setTimeout(() => {
                attempt++;
                if (attempt < MAX_RETRIES && !closed) {
                    sendRequest();
                    scheduleRetry();
                }
                // total timeout will catch final failure
            }, RECV_TIMEOUT_MS);
        }

        socket.on('message', (msg) => {
            if (closed) { return; }

            // CL-WSP reply: [TID:1] [WSP Reply PDU]
            if (msg.length < 3) { return; }
            const replyTid = msg[0];
            if (replyTid !== tid) { return; }  // not our transaction

            const wspData = msg.slice(1);  // WSP Reply PDU after TID byte
            if (wspData[0] !== WSP_PDU_REPLY || wspData.length < 3) { return; }

            closed = true;
            clearTimeout(totalTimeout);
            if (retryTimer) { clearTimeout(retryTimer); }

            try {
                const parsed = parseWspReply(wspData);
                parsed.finalUrl = targetUrl;
                resolve(parsed);
            } catch (err: any) {
                reject(err);
            }
            socket.close();
        });

        socket.on('error', (err) => {
            if (!closed) { closed = true; clearTimeout(totalTimeout); if (retryTimer) { clearTimeout(retryTimer); } reject(err); socket.close(); }
        });

        sendRequest();
        scheduleRetry();
    });
}

// ── WSP Reply PDU parser (shared by CL-GET and CO-POST) ────────

function parseWspReply(wspData: Buffer): FetchResult & { rawHeaders: Buffer } {
    if (wspData[0] !== WSP_PDU_REPLY || wspData.length < 3) {
        throw new Error('Invalid WSP Reply PDU');
    }

    const httpStatus = wspStatusToHttp(wspData[1]);
    const { value: hdrsLen, consumed: hvLen } = decodeUintvar(wspData, 2);
    const hdrsStart = 2 + hvLen;
    const hdrsEnd = hdrsStart + hdrsLen;
    const body = Buffer.from(wspData.slice(hdrsEnd));

    let contentType = '';
    let location = '';
    const respHeaders: Record<string, string> = {};
    let pos = hdrsStart;

    // First item is always the content-type
    if (hdrsLen > 0 && pos < hdrsEnd) {
        const ctByte = wspData[pos];
        if (ctByte & 0x80) {
            contentType = WSP_CT_MAP[ctByte & 0x7F] || 'application/octet-stream';
            pos++;
        } else if (ctByte <= 0x1F) {
            const ctLen = ctByte;
            pos++;
            if (pos < hdrsEnd && (wspData[pos] & 0x80)) {
                contentType = WSP_CT_MAP[wspData[pos] & 0x7F] || 'application/octet-stream';
            }
            pos = hdrsStart + 1 + ctLen;
        } else {
            const strStart = pos;
            while (pos < hdrsEnd && wspData[pos] !== 0) { pos++; }
            contentType = wspData.slice(strStart, pos).toString('ascii');
            if (pos < hdrsEnd) { pos++; }
        }
    }

    // Scan remaining headers
    while (pos < hdrsEnd) {
        const hdr = wspData[pos];
        if (hdr & 0x80) {
            const field = hdr & 0x7F;
            pos++;
            if (field === (WSP_HDR_LOCATION & 0x7F)) {
                const strStart = pos;
                while (pos < hdrsEnd && wspData[pos] !== 0) { pos++; }
                location = wspData.slice(strStart, pos).toString('ascii');
                if (pos < hdrsEnd) { pos++; }
                respHeaders['location'] = location;
            } else if (field === (WSP_HDR_SET_COOKIE & 0x7F)) {
                if (pos < hdrsEnd && wspData[pos] <= 0x1F) {
                    const vLen = wspData[pos++];
                    const cookieStr = wspData.slice(pos, pos + vLen).toString('ascii');
                    pos += vLen;
                    if (!respHeaders['set-cookie']) {
                        respHeaders['set-cookie'] = cookieStr;
                    } else {
                        respHeaders['set-cookie'] += ', ' + cookieStr;
                    }
                } else {
                    const strStart = pos;
                    while (pos < hdrsEnd && wspData[pos] !== 0) { pos++; }
                    const cookieStr = wspData.slice(strStart, pos).toString('ascii');
                    if (pos < hdrsEnd) { pos++; }
                    if (!respHeaders['set-cookie']) {
                        respHeaders['set-cookie'] = cookieStr;
                    } else {
                        respHeaders['set-cookie'] += ', ' + cookieStr;
                    }
                }
            } else {
                if (pos < hdrsEnd) {
                    if (wspData[pos] & 0x80) { pos++; }
                    else if (wspData[pos] <= 0x1F) { const vl = wspData[pos++]; pos += vl; }
                    else { while (pos < hdrsEnd && wspData[pos] !== 0) { pos++; } if (pos < hdrsEnd) { pos++; } }
                }
            }
        } else if (hdr >= 0x20) {
            while (pos < hdrsEnd && wspData[pos] !== 0) { pos++; }
            if (pos < hdrsEnd) { pos++; }
            if (pos < hdrsEnd) {
                if (wspData[pos] & 0x80) { pos++; }
                else if (wspData[pos] <= 0x1F) { const vl = wspData[pos++]; pos += vl; }
                else { while (pos < hdrsEnd && wspData[pos] !== 0) { pos++; } if (pos < hdrsEnd) { pos++; } }
            }
        } else {
            pos++;
        }
    }

    if (!contentType) { contentType = 'application/vnd.wap.wmlc'; }
    respHeaders['content-type'] = contentType;

    return { status: httpStatus, contentType, body, headers: respHeaders, finalUrl: '', rawHeaders: wspData.slice(hdrsStart, hdrsEnd) };
}

// ── WSP POST Client (Connection-Oriented over UDP via WTP) ──────

function buildWtpInvoke(tid: number, wspPdu: Buffer): Buffer {
    // Byte 0: CON=0, TYPE=INVOKE(0001), GTR=1, TTR=1, RID=0
    const b0 = (WTP_PDU_INVOKE << 3) | (1 << 2) | (1 << 1);
    // Byte 3: TCL=2 (class 2 = reliable two-way transaction)
    const result = Buffer.alloc(4 + wspPdu.length);
    result[0] = b0;
    result[1] = (tid >> 8) & 0xFF;
    result[2] = tid & 0xFF;
    result[3] = 0x02;  // TCL = 2
    wspPdu.copy(result, 4);
    return result;
}

function buildWtpAck(tid: number): Buffer {
    // Byte 0: CON=0, TYPE=ACK(0011), Tve/Tok=0, RID=0
    const b0 = (0x03 << 3);
    const buf = Buffer.alloc(3);
    buf[0] = b0;
    buf[1] = (tid >> 8) & 0xFF;
    buf[2] = tid & 0xFF;
    return buf;
}

function fetchWspPost(
    targetUrl: string,
    gatewayHost: string,
    gatewayPort: number,  // CL port (9200) for GET — CO port for POST
    postBody: string,
    cookieHeader?: string,
): Promise<FetchResult> {
    return new Promise((resolve, reject) => {
        const socket = dgram.createSocket('udp4');
        const TOTAL_TIMEOUT_S = 15;
        const RECV_TIMEOUT_MS = 5000;
        const MAX_RETRIES = 3;
        let closed = false;
        let phase: 'connect' | 'post' = 'connect';
        let attempt = 0;

        const totalTimeout = setTimeout(() => {
            if (!closed) { closed = true; socket.close(); reject(new Error('WSP POST timeout')); }
        }, TOTAL_TIMEOUT_S * 1000);

        const tid = (Date.now() & 0xFFFF);

        // ── Phase 1: WSP Connect via WTP ──
        const connectPdu = Buffer.from([WSP_PDU_CONNECT, 0x01, 0x00, 0x00]);
        // version=1.0, capabilities-len=0, headers-len=0
        const connectPacket = buildWtpInvoke(tid, connectPdu);

        // ── Phase 2: WSP POST via WTP ──
        const urlBuf = Buffer.from(targetUrl, 'utf-8');
        const uriLenBuf = encodeUintvar(urlBuf.length);

        // Build POST headers
        const hdrParts: number[] = [];
        // Content-Type: application/x-www-form-urlencoded (0x12 | 0x80)
        hdrParts.push(0x80 | WSP_CT_APP_URLENC);
        // Accept: application/vnd.wap.wmlc
        hdrParts.push(0x80 | WSP_HDR_ACCEPT);
        hdrParts.push(0x80 | WSP_CT_APP_WMLC);
        // Accept: text/vnd.wap.wml
        hdrParts.push(0x80 | WSP_HDR_ACCEPT);
        hdrParts.push(0x80 | WSP_CT_TEXT_WML);
        // User-Agent
        hdrParts.push(0xA9);
        const ua = USER_AGENT;
        for (let i = 0; i < ua.length; i++) { hdrParts.push(ua.charCodeAt(i)); }
        hdrParts.push(0x00);
        // Cookie
        if (cookieHeader && cookieHeader.length > 0) {
            hdrParts.push(0x80 | 0x42);
            for (let i = 0; i < cookieHeader.length; i++) { hdrParts.push(cookieHeader.charCodeAt(i)); }
            hdrParts.push(0x00);
        }
        const hdrsBuf = Buffer.from(hdrParts);
        const hdrsLenBuf = encodeUintvar(hdrsBuf.length);
        const bodyBuf = Buffer.from(postBody, 'utf-8');

        const postPdu = Buffer.concat([
            Buffer.from([WSP_PDU_POST]),
            uriLenBuf,
            hdrsLenBuf,
            urlBuf,
            hdrsBuf,
            bodyBuf,
        ]);
        const postTid = (tid + 1) & 0xFFFF;
        const postPacket = buildWtpInvoke(postTid, postPdu);

        let retryTimer: ReturnType<typeof setTimeout> | undefined;
        let currentPacket = connectPacket;

        function sendCurrent() {
            socket.send(currentPacket, gatewayPort, gatewayHost, (err) => {
                if (err && !closed) { closed = true; clearTimeout(totalTimeout); reject(err); socket.close(); }
            });
        }

        function scheduleRetry() {
            retryTimer = setTimeout(() => {
                attempt++;
                if (attempt < MAX_RETRIES && !closed) {
                    sendCurrent();
                    scheduleRetry();
                }
            }, RECV_TIMEOUT_MS);
        }

        socket.on('message', (msg) => {
            if (closed || msg.length < 3) { return; }

            const b0 = msg[0];
            const pduType = (b0 >> 3) & 0x0F;
            if (pduType !== WTP_PDU_RESULT) { return; }
            const replyTid = (msg[1] << 8) | msg[2];
            const wspData = msg.slice(3);

            if (phase === 'connect') {
                // Expect WSP ConnectReply (0x02)
                if (replyTid !== tid || wspData.length < 1 || wspData[0] !== WSP_PDU_CONNECT_REPLY) { return; }

                // Send WTP ACK for the Connect
                const ack = buildWtpAck(tid);
                socket.send(ack, gatewayPort, gatewayHost);

                // Move to POST phase
                phase = 'post';
                attempt = 0;
                if (retryTimer) { clearTimeout(retryTimer); }
                currentPacket = postPacket;
                sendCurrent();
                scheduleRetry();
                return;
            }

            // Phase: post — expect WSP Reply
            if (replyTid !== postTid || wspData.length < 1 || wspData[0] !== WSP_PDU_REPLY) { return; }

            closed = true;
            clearTimeout(totalTimeout);
            if (retryTimer) { clearTimeout(retryTimer); }

            // Send WTP ACK
            const ack = buildWtpAck(postTid);
            socket.send(ack, gatewayPort, gatewayHost);

            try {
                const parsed = parseWspReply(wspData);
                parsed.finalUrl = targetUrl;
                resolve(parsed);
            } catch (err: any) {
                reject(err);
            }
            socket.close();
        });

        socket.on('error', (err) => {
            if (!closed) { closed = true; clearTimeout(totalTimeout); if (retryTimer) { clearTimeout(retryTimer); } reject(err); socket.close(); }
        });

        sendCurrent();
        scheduleRetry();
    });
}

// ── Browser Panel ────────────────────────────────────────────────

export class WapBrowserPanel {
    public static currentPanel: WapBrowserPanel | undefined;
    private static readonly viewType = 'wapBrowser';

    private readonly panel: vscode.WebviewPanel;
    private readonly extensionUri: vscode.Uri;
    private readonly context: vscode.ExtensionContext;
    private disposables: vscode.Disposable[] = [];
    private cookieJar = new CookieJar();
    private wmlVars: Record<string, string> = {};
    private currentUrl = '';
    private currentWml = '';
    private downloads: { name: string; path: string; size: number; date: string }[] = [];
    private history: { url: string; title: string; date: string }[] = [];
    private settings: BrowserSettings;
    // Outstanding interactive Dialogs.* calls (requestId → resolver), fulfilled
    // by the webview's 'dialogResult' reply. See requestDialog().
    private dialogSeq = 0;
    private pendingDialogs = new Map<number, (result: string | boolean | null) => void>();
    // Editor column where debug sources (.wml/.wmls virtual docs) are revealed.
    private sourceColumn: vscode.ViewColumn = vscode.ViewColumn.One;
    // Bound hub listeners, detached on dispose.
    private readonly onDebugAttached = () => {
        // A debug session started — light up the debug button and surface the current
        // deck + its scripts so the user can place breakpoints immediately.
        this.panel.webview.postMessage({ type: 'debugState', active: true });
        if (this.currentWml && this.currentUrl) {
            void this.prepareDebugSources(this.currentWml, this.currentUrl);
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
        this.settings = { ...DEFAULT_SETTINGS, ...context.globalState.get<BrowserSettings>(SETTINGS_KEY) };

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
        // Settle any dialog the VM is still waiting on so its run promise unwinds.
        for (const resolve of this.pendingDialogs.values()) { resolve(null); }
        this.pendingDialogs.clear();
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
                await this.navigate(msg.url, msg.postfields, msg.method, msg.referer, msg.fromDeck);
                break;

            case 'execWmlScript':
                await this.execWmlScript(msg.scriptUrl, msg.funcName, msg.args, msg.wmlVars);
                break;

            case 'debug':
                await this.startDebugSession();
                break;

            case 'proxyImage':
                await this.proxyImage(msg.src, msg.id);
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
                this.panel.webview.postMessage({ type: 'historyList', history: this.history });
                break;

            case 'clearHistory':
                this.history = [];
                this.panel.webview.postMessage({ type: 'historyList', history: this.history });
                break;

            case 'getSettings':
                this.panel.webview.postMessage({ type: 'settingsData', settings: this.settings });
                break;

            case 'updateSettings':
                this.settings = { ...this.settings, ...msg.settings };
                this.context.globalState.update(SETTINGS_KEY, this.settings);
                this.panel.webview.postMessage({ type: 'settingsData', settings: this.settings });
                break;

            case 'dialogResult': {
                // The webview answered an interactive Dialogs.* modal — resolve
                // the matching promise so the suspended VM resumes (requestDialog).
                const resolver = this.pendingDialogs.get(msg.requestId);
                if (resolver) {
                    this.pendingDialogs.delete(msg.requestId);
                    resolver(msg.result);
                }
                break;
            }
        }
    }

    // ── Navigation ───────────────────────────────────────────────

    private async navigate(targetUrl: string, postfields?: any[], method: string = 'get', referer?: string, fromDeck?: string): Promise<void> {
        // The deck we are navigating away from — used for deck access control.
        const referringDeck = fromDeck || '';
        try {
            const { transport, gatewayHost, gatewayPort, wspCoPort } = this.settings;

            let result: FetchResult;
            let postBody: string | undefined;
            const httpMethod = method.toUpperCase();

            if (postfields && postfields.length > 0) {
                // WML 1.3 §9.x form submission: URI-escape (RFC2396, lowercase
                // %xx, unreserved set preserved) both field names and values,
                // mirroring escapeUrlString in src/shared/wml-engine.js and
                // src/wmlsc/stdlib.ts, then join as name=value pairs with '&'.
                const escapeFormField = (s: string): string => {
                    let out = '';
                    for (let i = 0; i < s.length; i++) {
                        const ch = s[i], code = s.charCodeAt(i);
                        if (/[A-Za-z0-9\-_.!~*'()]/.test(ch)) { out += ch; }
                        else if (code <= 0xFF) { out += '%' + code.toString(16).padStart(2, '0'); }
                        else { out += encodeURIComponent(ch).toLowerCase(); }
                    }
                    return out;
                };
                const encoded = postfields.map((pf: any) =>
                    escapeFormField(String(pf.name)) + '=' + escapeFormField(String(pf.value))
                ).join('&');

                if (httpMethod === 'GET') {
                    // GET: append postfields as query parameters
                    const sep = targetUrl.includes('?') ? '&' : '?';
                    targetUrl = targetUrl + sep + encoded;
                } else {
                    postBody = encoded;
                }
            }

            if (transport === 'wsp') {
                const cookies = this.cookieJar.get(targetUrl);

                if (httpMethod === 'POST' && postBody) {
                    // WSP POST uses connection-oriented WTP on the CO port
                    result = await fetchWspPost(targetUrl, gatewayHost, wspCoPort, postBody, cookies || undefined);
                } else {
                    result = await fetchWsp(targetUrl, gatewayHost, gatewayPort, cookies || undefined);
                }

                // Handle WSP redirects (3xx with Location header)
                let redirects = 0;
                while (result.status >= 300 && result.status < 400 && result.headers['location'] && redirects < 5) {
                    // Store cookies from redirect response
                    if (result.headers['set-cookie']) {
                        for (const raw of result.headers['set-cookie'].split(/,(?=[^ ])/)) {
                            this.cookieJar.set(raw.trim(), targetUrl);
                        }
                    }
                    const redirectUrl = new URL(result.headers['location'], targetUrl).toString();
                    targetUrl = redirectUrl;
                    const rCookies = this.cookieJar.get(redirectUrl);
                    result = await fetchWsp(redirectUrl, gatewayHost, gatewayPort, rCookies || undefined);
                    redirects++;
                }
            } else {
                const cookies = this.cookieJar.get(targetUrl);
                result = await fetchHttp(targetUrl, httpMethod, postBody, cookies, this.cookieJar, referer);
            }

            // 404 fallback: try compiled variant if source not found
            if (result.status === 404) {
                const fallbackUrl = this.getFallbackUrl(targetUrl);
                if (fallbackUrl) {
                    if (transport === 'wsp') {
                        const cookies = this.cookieJar.get(fallbackUrl);
                        result = await fetchWsp(fallbackUrl, gatewayHost, gatewayPort, cookies || undefined);
                    } else {
                        const cookies = this.cookieJar.get(fallbackUrl);
                        result = await fetchHttp(fallbackUrl, httpMethod, postBody, cookies);
                    }
                    if (result.status === 200) {
                        targetUrl = fallbackUrl;
                    }
                }
            }

            // Process cookies from response
            const setCookies = result.headers['set-cookie'];
            if (setCookies) {
                for (const raw of setCookies.split(/,(?=[^ ])/)) {
                    this.cookieJar.set(raw.trim(), result.finalUrl);
                }
            }

            this.currentUrl = result.finalUrl;

            // Determine content type and process response
            const ct = result.contentType.toLowerCase();

            if (ct.includes('application/vnd.wap.wmlc') || ct.includes('application/vnd.wap.wbxml')) {
                // WBXML binary → decode to WML text
                const wmlText = decodeWbxml(result.body);
                if (!this.enforceAccess(wmlText, referringDeck, result.finalUrl)) { return; }
                this.renderWml(wmlText, result.finalUrl);
            } else if (ct.includes('text/vnd.wap.wml') || ct.includes('text/xml') || result.finalUrl.endsWith('.wml')) {
                // WML text
                const wmlText = result.body.toString('utf-8');
                if (!this.enforceAccess(wmlText, referringDeck, result.finalUrl)) { return; }
                this.renderWml(wmlText, result.finalUrl);
            } else if (ct.includes('text/html')) {
                // Plain HTML — show as-is in an iframe-like view
                this.panel.webview.postMessage({
                    type: 'deckContent',
                    cardsHtml: `<div class="wml-card" id="html" data-title="HTML" style="display:block"><div style="font-size:12px">${result.body.toString('utf-8')}</div></div>`,
                    firstCardTitle: 'HTML Page',
                    fragment: '',
                    vars: this.wmlVars,
                });
            } else if (ct.includes('image/vnd.wap.wbmp') || result.finalUrl.endsWith('.wbmp')) {
                // WBMP image — convert to SVG and display
                const dataUri = wbmpToDataUri(result.body);
                if (dataUri) {
                    this.panel.webview.postMessage({
                        type: 'deckContent',
                        cardsHtml: `<div class="wml-card" id="image" data-title="Image" style="display:block"><img src="${dataUri}" class="wml-img" style="image-rendering:pixelated"></div>`,
                        firstCardTitle: 'WBMP Image',
                        fragment: '',
                        vars: this.wmlVars,
                    });
                } else {
                    this.panel.webview.postMessage({ type: 'error', message: 'Invalid WBMP image' });
                }
            } else {
                // Unsupported content type — offer as download
                await this.downloadFile(result.body, result.contentType, result.finalUrl);
            }
        } catch (err: any) {
            this.panel.webview.postMessage({
                type: 'error',
                message: err.message || String(err),
            });
        }
    }

    /** Proxy image fetch: fetch URL, convert WBMP to data URI, send back to webview */
    private async proxyImage(src: string, id: string): Promise<void> {
        try {
            // Resolve root-relative or relative paths against currentUrl
            if (src && !/^https?:\/\//i.test(src) && this.currentUrl) {
                try { src = new URL(src, this.currentUrl).toString(); } catch { /* keep original */ }
            }

            if (!src || !/^https?:\/\//i.test(src)) {
                this.panel.webview.postMessage({ type: 'imageProxyResult', id, dataUri: '' });
                return;
            }

            let result: FetchResult;

            if (this.settings.transport === 'wsp') {
                result = await fetchWsp(src, this.settings.gatewayHost, this.settings.gatewayPort);
            } else {
                result = await fetchHttp(src);
            }

            const ct = result.contentType.toLowerCase();
            let dataUri = '';

            if (ct.includes('image/vnd.wap.wbmp') || src.toLowerCase().endsWith('.wbmp')) {
                dataUri = wbmpToDataUri(result.body);
            } else if (ct.startsWith('image/')) {
                // Other image types — pass as base64 data URI
                dataUri = `data:${result.contentType};base64,${result.body.toString('base64')}`;
            } else if (result.body.length > 4 && result.body[0] === 0x00 && result.body[1] === 0x00) {
                // Heuristic: WBMP Type 0 starts with 0x00 0x00 — content-type may be wrong
                const candidate = wbmpToDataUri(result.body);
                if (candidate) { dataUri = candidate; }
            }

            this.panel.webview.postMessage({ type: 'imageProxyResult', id, dataUri });
        } catch {
            this.panel.webview.postMessage({ type: 'imageProxyResult', id, dataUri: '' });
        }
    }

    /** Get fallback URL: .wml → .wmlc, .wmls → .wmlsc */
    private getFallbackUrl(targetUrl: string): string | undefined {
        const noHash = targetUrl.split('#')[0];
        if (noHash.endsWith('.wml')) {
            return noHash + 'c';  // .wml → .wmlc
        }
        if (noHash.endsWith('.wmls')) {
            return noHash + 'c';  // .wmls → .wmlsc
        }
        // Try appending .wmlc if no recognized extension
        if (!noHash.match(/\.(wmlc|wbxml|wmlsc|html?)(\?|$)/i)) {
            return undefined;
        }
        return undefined;
    }

    /**
     * Apply deck access control before rendering a fetched deck.  On denial the
     * navigation fails: the user is notified and the invoking deck stays current
     * (WAP-191 §12.5.5).  Returns true when rendering may proceed.
     */
    private enforceAccess(wml: string, referrerUrl: string, destUrl: string): boolean {
        const verdict = checkDeckAccess(wml, referrerUrl, destUrl);
        if (!verdict.allowed) {
            this.currentUrl = referrerUrl;
            this.panel.webview.postMessage({ type: 'error', message: verdict.reason });
            return false;
        }
        return true;
    }

    private renderWml(wmlContent: string, baseUrl: string): void {
        this.currentWml = wmlContent;
        const parsed = new URL(baseUrl);
        const fragment = parsed.hash ? parsed.hash.substring(1) : '';

        const { html, firstTitle } = renderCardsHtml(wmlContent, baseUrl);

        // Record in history (avoid duplicate consecutive entries)
        const lastEntry = this.history.length > 0 ? this.history[this.history.length - 1] : null;
        if (!lastEntry || lastEntry.url !== baseUrl) {
            this.history.push({
                url: baseUrl,
                title: firstTitle || baseUrl,
                date: new Date().toISOString(),
            });
        }

        this.panel.webview.postMessage({
            type: 'deckContent',
            cardsHtml: html,
            firstCardTitle: firstTitle,
            fragment,
            vars: this.wmlVars,
        });

        // When debugging, surface the deck + its scripts as read-only virtual docs so
        // breakpoints can be placed before a script is triggered (fire-and-forget).
        if (browserDebugSession.isDebugging()) {
            void this.prepareDebugSources(wmlContent, baseUrl);
        }
    }

    // ── WMLScript Execution ──────────────────────────────────────

    private async execWmlScript(scriptUrl: string, funcName: string, args: WmlsCallArg[], clientVars: Record<string, string>): Promise<void> {
        // Merge client vars from the deck.
        this.wmlVars = { ...this.wmlVars, ...clientVars };

        // Debug path: run on the VM under debugger control (source breakpoints / stepping).
        if (browserDebugSession.isDebugging()) {
            try {
                if (await this.execWmlScriptDebug(scriptUrl, funcName, args)) { return; }
            } catch (err: any) {
                this.panel.webview.postMessage({ type: 'wmlscriptResult', vars: this.wmlVars, error: err.message || String(err) });
                return;
            }
            // else: no source / compile error → fall through to a normal (non-debug) run.
        }

        // Normal path: fetch, compile/decode, run on the VM to completion.
        try {
            const fetched = await this.fetchScript(scriptUrl);
            const mod = fetched.isCompiled
                ? decodeWmlsc(fetched.body)
                : decodeWmlsc(compileWmls(fetched.body.toString('utf-8')));
            const { ctx, nav } = this.buildVmContext();
            // Non-debug runs present real Dialogs.* modals; the VM suspends on
            // each dialog and resumes with the user's response (requestDialog).
            ctx.interactiveDialogs = true;
            const vm = new WmlsVM(mod, { context: ctx, maxSteps: 10000000 });
            const result = await vm.callFunctionAsync(funcName, this.convertArgs(args), (req) => this.requestDialog(req));
            this.applyScriptResult(ctx, nav(), result.error);
        } catch (err: any) {
            this.panel.webview.postMessage({
                type: 'wmlscriptResult',
                vars: this.wmlVars,
                error: err.message || String(err),
            });
        }
    }

    /**
     * Run a script on the bytecode VM under debugger control. Returns true when the
     * run was handled (source found, compiled, executed); false when there is no
     * source to debug (caller then falls back to a normal VM run).
     */
    private async execWmlScriptDebug(scriptUrl: string, funcName: string, args: WmlsCallArg[]): Promise<boolean> {
        // Register on demand (in case the deck-load scan missed it), opening the
        // .wmls source — or, when only compiled bytecode exists, its disassembly.
        const sourceUri = await this.registerScriptForDebug(scriptUrl, true);
        if (!sourceUri) {
            this.panel.webview.postMessage({
                type: 'status',
                message: 'No WMLScript available to debug — running without breakpoints.',
            });
            return false;
        }
        const { ctx, nav } = this.buildVmContext();
        const result = await browserDebugSession.run(sourceUri, funcName, this.convertArgs(args), ctx);
        if (!result) { return false; }
        this.applyScriptResult(ctx, nav(), result.error);
        return true;
    }

    /** Fetch a script body for a normal (non-debug) run, with .wmls → .wmlsc 404 fallback. */
    private async fetchScript(scriptUrl: string): Promise<{ body: Buffer; isCompiled: boolean }> {
        let fetchUrl = scriptUrl;
        let result = await this.getResource(fetchUrl);
        if (result.status === 404 && fetchUrl.endsWith('.wmls')) {
            fetchUrl = fetchUrl + 'c';
            result = await this.getResource(fetchUrl);
        }
        const isCompiled = result.contentType.toLowerCase().includes('wmlscriptc') || fetchUrl.endsWith('.wmlsc');
        return { body: result.body, isCompiled };
    }

    /**
     * Fetch WMLScript *source* for debugging, preferring the .wmls source variant
     * when only compiled bytecode is referenced. Returns null when no source is
     * available (compiled-only server / fetch failure).
     */
    private async fetchSource(scriptUrl: string): Promise<string | null> {
        const noFrag = scriptUrl.split('#')[0];
        const isCompiled = (r: FetchResult, u: string) =>
            r.contentType.toLowerCase().includes('wmlscriptc') || u.toLowerCase().endsWith('.wmlsc');
        try {
            // Prefer a .wmls source URL (coerce a referenced .wmlsc down to .wmls).
            const srcUrl = noFrag.replace(/\.wmlsc$/i, '.wmls');
            let r = await this.getResource(srcUrl);
            if (r.status === 200 && !isCompiled(r, srcUrl)) { return r.body.toString('utf-8'); }
            if (srcUrl !== noFrag) {
                r = await this.getResource(noFrag);
                if (r.status === 200 && !isCompiled(r, noFrag)) { return r.body.toString('utf-8'); }
            }
            return null;
        } catch {
            return null;
        }
    }

    /** GET a resource over the configured transport, attaching cookies. */
    private getResource(u: string): Promise<FetchResult> {
        const cookies = this.cookieJar.get(u) || undefined;
        return this.settings.transport === 'wsp'
            ? fetchWsp(u, this.settings.gatewayHost, this.settings.gatewayPort, cookies)
            : fetchHttp(u, 'GET', undefined, cookies);
    }

    /** Build the VM library context bound to the browser's WML variables + navigation. */
    private buildVmContext(): { ctx: LibraryContext; nav: () => { goUrl?: string; doPrev: boolean; doRefresh: boolean } } {
        let goUrl: string | undefined;
        let doPrev = false;
        let doRefresh = false;
        const ctx: LibraryContext = {
            wmlVariables: new Map(Object.entries(this.wmlVars)),
            wmlVars: { ...this.wmlVars },
            currentCard: this.currentUrl,
            onSetVar: (name, value) => { this.wmlVars[name] = value; },
            onGo: (u) => { goUrl = u; },
            onPrev: () => { doPrev = true; },
            onRefresh: () => { doRefresh = true; },
            onOutput: () => { /* discarded for non-debug; the debug adapter overrides this */ },
        };
        return { ctx, nav: () => ({ goUrl, doPrev, doRefresh }) };
    }

    /**
     * Show a WMLScript Dialogs.* modal in the webview and resolve with the user's
     * response. Posts a 'dialog' message keyed by requestId; the webview replies
     * 'dialogResult' (handled in onDidReceiveMessage), which resolves the promise.
     */
    private requestDialog(req: DialogRequest): Promise<string | boolean | null> {
        return new Promise((resolve) => {
            const requestId = ++this.dialogSeq;
            this.pendingDialogs.set(requestId, resolve);
            this.panel.webview.postMessage({
                type: 'dialog',
                requestId,
                dialogType: req.type,
                message: req.message,
                defaultValue: req.def ?? '',
                okLabel: req.okLabel,
                cancelLabel: req.cancelLabel,
            });
        });
    }

    /** Convert deck-supplied string args to WMLScript values. */
    // Convert parsed WMLScript call args to typed WmlsValues. Per WMLScript
    // §8.3.4 a quoted token ('...'/"...") is passed as a String; only unquoted
    // tokens are coerced to boolean / number / invalid by their literal form.
    // Accepts both the structured { value, quoted } tokens emitted by
    // parseWmlScriptArgs and bare strings (treated as unquoted) for safety.
    private convertArgs(args: WmlsCallArg[]): WmlsValue[] {
        return args.map(a => {
            const quoted = typeof a === 'object' && a !== null && !!a.quoted;
            const s = typeof a === 'object' && a !== null ? a.value : a;
            if (quoted) { return mkString(s); }
            if (s === 'true') { return mkBool(true); }
            if (s === 'false') { return mkBool(false); }
            if (s === 'invalid') { return mkInvalid(); }
            const n = Number(s);
            if (!isNaN(n) && s.length > 0) {
                return Number.isInteger(n) ? mkInt(n) : mkFloat(n);
            }
            return mkString(s);
        });
    }

    /** Sync variables changed by the script back to wmlVars and notify the webview. */
    private applyScriptResult(
        ctx: LibraryContext,
        nav: { goUrl?: string; doPrev: boolean; doRefresh: boolean },
        error?: string,
    ): void {
        for (const [key, val] of ctx.wmlVariables) { this.wmlVars[key] = val; }
        for (const key of Object.keys(ctx.wmlVars)) { this.wmlVars[key] = ctx.wmlVars[key]; }
        this.panel.webview.postMessage({
            type: 'wmlscriptResult',
            vars: this.wmlVars,
            goUrl: nav.goUrl,
            doPrev: nav.doPrev,
            doRefresh: nav.doRefresh,
            error,
        });
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
        const source = await this.fetchSource(absScriptUrl);
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
            const r = await this.getResource(compiledUrl);
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
        const count = this.cookieJar.clear();
        this.panel.webview.postMessage({
            type: 'cookiesCleared',
            count,
        });
    }

    // ── Save Page ───────────────────────────────────────────────

    private async savePage(): Promise<void> {
        if (!this.currentWml || !this.currentUrl) {
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
                const parsed = new URL(this.currentUrl);
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
            const resourceUrls = this.extractResourceUrls(this.currentWml);

            // Fetch and save each resource, building a URL → local filename map
            const urlToLocal = new Map<string, string>();
            let savedCount = 0;

            for (const relUrl of resourceUrls) {
                let absUrl: string;
                try {
                    absUrl = new URL(relUrl, this.currentUrl).toString();
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
                    let result: FetchResult;
                    if (this.settings.transport === 'wsp') {
                        const cookies = this.cookieJar.get(absUrl);
                        result = await fetchWsp(absUrl, this.settings.gatewayHost, this.settings.gatewayPort, cookies || undefined);
                    } else {
                        const cookies = this.cookieJar.get(absUrl);
                        result = await fetchHttp(absUrl, 'GET', undefined, cookies);
                    }

                    // Mirror the script-run path's .wmls → .wmlsc fallback: a
                    // compiled-only server 404s the .wmls URL but serves .wmlsc,
                    // so retry the compiled variant so Save Page still saves it.
                    if (result.status !== 200 && absUrl.endsWith('.wmls')) {
                        const compiledUrl = absUrl + 'c';
                        let compiledResult: FetchResult;
                        if (this.settings.transport === 'wsp') {
                            const cookies = this.cookieJar.get(compiledUrl);
                            compiledResult = await fetchWsp(compiledUrl, this.settings.gatewayHost, this.settings.gatewayPort, cookies || undefined);
                        } else {
                            const cookies = this.cookieJar.get(compiledUrl);
                            compiledResult = await fetchHttp(compiledUrl, 'GET', undefined, cookies);
                        }
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
            let rewrittenWml = this.currentWml;
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
                if (resolvedSrc && !/^https?:\/\//i.test(resolvedSrc) && this.currentUrl) {
                    try { resolvedSrc = new URL(resolvedSrc, this.currentUrl).toString(); } catch { /* keep */ }
                }

                let result: FetchResult;

                if (this.settings.transport === 'wsp') {
                    result = await fetchWsp(resolvedSrc, this.settings.gatewayHost, this.settings.gatewayPort);
                } else {
                    result = await fetchHttp(resolvedSrc);
                }

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
                const parsed = new URL(src.startsWith('data:') ? this.currentUrl : src);
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
  <div class="browser-chrome">
    <div class="address-bar">
      <button id="btn-back" onclick="doBack()" title="Back">\u2190</button>
      <input id="url-input" type="text" placeholder="Enter URL (e.g. http://wap-server:3003/)" spellcheck="false" />
      <button id="btn-go" onclick="doNavigate()" title="Go">Go</button>
      <button id="btn-refresh" onclick="doRefresh()" title="Refresh">\u21BB</button>
      <button id="btn-debug" onclick="doDebug()" title="Debug WMLScript">\uD83D\uDC1E</button>
      <button id="btn-menu" onclick="toggleMenu()" title="Menu">\u22EE</button>
    </div>
    <div class="browser-menu" id="browser-menu">
      <button class="menu-item" onclick="doSavePage()">Save Page</button>
      <button class="menu-item" onclick="doShowHistory()">History</button>
      <button class="menu-item" onclick="doClearCookies()">Clear Cookies</button>
      <button class="menu-item" onclick="doShowDownloads()">Downloads</button>
      <button class="menu-item" onclick="doShowSettings()">Settings</button>
    </div>
    <div class="status-bar" id="status-bar">Ready</div>
  </div>

  <div class="phone-container">
    <div class="wap-phone-frame">
      <div class="phone-header">
        <span class="phone-signal">&#9679;&#9679;&#9679;&#9675;&#9675;</span>
        <span class="phone-title" id="card-title">WAP Browser</span>
        <span class="phone-battery">&#9608;&#9608;&#9608;</span>
      </div>
      <div class="phone-screen" id="phone-screen">
        <div class="browser-welcome">
          <p>Enter a URL above to browse WAP sites.</p>
        </div>
      </div>
      <div class="phone-softkeys">
        <div class="softkey-menu-overlay" id="softkey-overlay"></div>
        <div class="softkey-menu" id="softkey-menu"></div>
        <button class="softkey softkey-left" id="softkey-left" onclick="wmlSoftkeyLeft()"></button>
        <button class="softkey softkey-right" id="softkey-right" onclick="wmlSoftkeyRight()">Back</button>
      </div>
    </div>
  </div>

  <!-- Dialog overlay for WMLScript Dialogs -->
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

  <!-- Downloads panel -->
  <div class="downloads-overlay" id="downloads-overlay">
    <div class="downloads-panel">
      <div class="downloads-header">
        <span>Downloads</span>
        <button class="downloads-close" onclick="doCloseDownloads()">\u2715</button>
      </div>
      <div class="downloads-list" id="downloads-list">
        <div class="downloads-empty">No downloads yet.</div>
      </div>
      <div class="downloads-actions">
        <button class="dialog-btn" onclick="doClearDownloads()">Clear All</button>
      </div>
    </div>
  </div>

  <!-- History panel -->
  <div class="downloads-overlay" id="history-overlay">
    <div class="downloads-panel">
      <div class="downloads-header">
        <span>History</span>
        <button class="downloads-close" onclick="doCloseHistory()">\u2715</button>
      </div>
      <div class="downloads-list" id="history-list">
        <div class="downloads-empty">No history yet.</div>
      </div>
      <div class="downloads-actions">
        <button class="dialog-btn" onclick="doClearHistory()">Clear All</button>
      </div>
    </div>
  </div>

  <!-- Image right-click context menu -->
  <div class="img-context-menu" id="img-context-menu">
    <button class="menu-item" onclick="doSaveImageAs()">Save Image As\u2026</button>
  </div>

  <!-- Settings panel -->
  <div class="settings-overlay" id="settings-overlay">
    <div class="settings-panel">
      <div class="settings-header">
        <span>Settings</span>
        <button class="downloads-close" onclick="doCloseSettings()">\u2715</button>
      </div>
      <div class="settings-body">
        <div class="settings-group">
          <label class="settings-label">Transport</label>
          <select class="settings-input" id="setting-transport">
            <option value="http">HTTP (Direct)</option>
            <option value="wsp">WSP (WAP Gateway)</option>
          </select>
        </div>
        <div class="settings-group wsp-only" id="wsp-settings">
          <label class="settings-label">Gateway Host</label>
          <input class="settings-input" id="setting-gatewayHost" type="text" placeholder="127.0.0.1" />
          <label class="settings-label">Gateway Port (CL/GET)</label>
          <input class="settings-input" id="setting-gatewayPort" type="number" min="1" max="65535" placeholder="9200" />
          <label class="settings-label">Gateway Port (CO/POST)</label>
          <input class="settings-input" id="setting-wspCoPort" type="number" min="1" max="65535" placeholder="9201" />
        </div>
        <div class="settings-group">
          <label class="settings-label">Screen Size</label>
          <div class="settings-row">
            <input class="settings-input settings-input-short" id="setting-screenWidth" type="number" min="120" max="640" placeholder="280" />
            <span class="settings-x">\u00D7</span>
            <input class="settings-input settings-input-short" id="setting-screenHeight" type="number" min="160" max="800" placeholder="380" />
            <span class="settings-unit">px</span>
          </div>
        </div>
      </div>
      <div class="settings-footer">
        <button class="dialog-btn" onclick="doCloseSettings()">Cancel</button>
        <button class="dialog-btn primary" onclick="doSaveSettings()">Apply</button>
      </div>
    </div>
  </div>

  <script>${js}</script>
</body>
</html>`;
    }
}
