/**
 *
 *  Copyright (C) 2026 Jabez Winston
 * 
 *  SPDX-License-Identifier: Apache-2.0
 *
 *  Date : 28-March-2026
 *  
 *  WAP Server — WSP/WTP local file server for VS Code extension.
 *
 * Modes:
 *   1. WSP over UDP connectionless GET (port 9200) — serves compiled .wmlc/.wmlsc
 *   2. WSP over UDP connection-oriented POST (port 9201) — serves compiled .wmlc/.wmlsc
 *   3. WAP-over-HTTP (port 9798) — serves text .wml/.wmls
 *
 * Reference: WAP-230, WAP-192-WBXML
 */
import * as vscode from 'vscode';
import * as dgram from 'dgram';
import * as http from 'http';
import * as fs from 'fs';
import * as path from 'path';
import { encodeWbxml } from './wbxml/encoder';
import { decodeDeck } from './shared/charset';
import { compileWmls } from './wmlsc/compiler';
import { xmlEscape } from './shared/htmlUtils';
import {
    WTP_PDU_INVOKE, WTP_PDU_RESULT, WTP_PDU_ACK, WTP_TID_RESPONDER_BIT,
    WTP_TYPE_SHIFT, WTP_TYPE_MASK, WTP_GTR, WTP_TTR, WTP_CLASS_MASK,
    WTP_HDR_LEN, WTP_INVOKE_HDR_LEN,
    WSP_PDU_CONNECT, WSP_PDU_CONNECT_REPLY, WSP_PDU_REPLY, WSP_PDU_DISCONNECT,
    WSP_PDU_GET, WSP_PDU_POST, WSP_SHORT_INT, WSP_SHORT_INT_BITS,
    WSP_CT, CT_WSP,
    encodeUintvar, decodeUintvar,
    wspGetRange, httpRange, cutRange, wspLengthHeaders,
} from './shared/wapProtocol';

// ── Constants ───────────────────────────────────────────────────

const DEFAULT_WSP_PORT = 9200;
const DEFAULT_WSP_CO_PORT = 9201;
const DEFAULT_HTTP_PORT = 3003; // updated per request
const DEFAULT_BIND_ADDR = '127.0.0.1'; // loopback unless wap.bindAddress says otherwise
let bindAddr = DEFAULT_BIND_ADDR;

function getWapServerPorts() {
    const config = vscode.workspace.getConfiguration('wap');
    return {
        wspPort: config.get<number>('wspPort', DEFAULT_WSP_PORT),
        wspCoPort: config.get<number>('wspCoPort', DEFAULT_WSP_CO_PORT),
        httpPort: config.get<number>('httpPort', DEFAULT_HTTP_PORT),
        bindAddress: config.get<string>('bindAddress', DEFAULT_BIND_ADDR) || DEFAULT_BIND_ADDR,
    };
}

// Extension → MIME
const MIME_TYPES: Record<string, string> = {
    '.wml': 'text/vnd.wap.wml',
    '.wmlc': 'application/vnd.wap.wmlc',
    '.wmls': 'text/vnd.wap.wmlscript',
    '.wmlsc': 'application/vnd.wap.wmlscriptc',
    '.wbxml': 'application/vnd.wap.wmlc',
    '.html': 'text/html',
    '.htm': 'text/html',
    '.txt': 'text/plain',
    '.gif': 'image/gif',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.png': 'image/png',
    '.wbmp': 'image/vnd.wap.wbmp',
};

// ── Output channel ──────────────────────────────────────────────

let outputChannel: vscode.OutputChannel | undefined;

function log(msg: string): void {
    if (!outputChannel) {
        outputChannel = vscode.window.createOutputChannel('WAP Server');
    }
    outputChannel.appendLine(`[wap_server] ${msg}`);
}

// ── WSP status conversion ───────────────────────────────────────

// WSP: 8.2.3.3 Reply
//
// HTTP status → WSP status, WSP Table 36 (Status Code Assignments):
// 1xx-3xx are class << 4 | detail; the 4xx run on past 0x4F (416 = 0x50,
// 417 = 0x51) and the 5xx start at 0x60.  A status the table has no
// code for gets its class's first one.
function httpToWspStatus(httpStatus: number): number {
    const hi = Math.floor(httpStatus / 100);
    const lo = httpStatus % 100;
    const assigned = (hi === 1 && lo <= 1) || (hi === 2 && lo <= 6) ||
        (hi === 3 && lo <= 7 && lo !== 6) || (hi === 4 && lo <= 17) || (hi === 5 && lo <= 5);
    if (!assigned) { return hi >= 1 && hi <= 4 ? hi << 4 : 0x60; }
    return hi === 5 ? 0x60 + lo : (hi << 4) + lo;
}

// ── WSP PDU building ────────────────────────────────────────────

// WSP: 8.2.3.3 Reply
//
// `extra`: more encoded headers after the content type
function buildWspReply(statusCode: number, contentType: string, body: Buffer,
                       extra: Buffer = Buffer.alloc(0)): Buffer {
    const pdu: number[] = [];
    pdu.push(WSP_PDU_REPLY);
    pdu.push(httpToWspStatus(statusCode));

    // Headers: content-type
    const hdrs: number[] = [];
    const ctCode = CT_WSP[contentType];
    if (ctCode !== undefined) {
        hdrs.push(WSP_SHORT_INT | ctCode);
    } else {
        for (let i = 0; i < contentType.length; i++) {
            hdrs.push(contentType.charCodeAt(i));
        }
        hdrs.push(0x00);
    }
    hdrs.push(...extra);

    const hdrsLenBuf = encodeUintvar(hdrs.length);
    const result = Buffer.alloc(pdu.length + hdrsLenBuf.length + hdrs.length + body.length);
    let off = 0;
    for (const b of pdu) { result[off++] = b; }
    hdrsLenBuf.copy(result, off); off += hdrsLenBuf.length;
    for (const b of hdrs) { result[off++] = b; }
    body.copy(result, off);
    return result;
}

// WSP: 8.2.2.2 ConnectReply
function buildWspConnectReply(sessionId: number): Buffer {
    const sidBuf = encodeUintvar(sessionId);
    const capLen = encodeUintvar(0);
    const hdrLen = encodeUintvar(0);
    const result = Buffer.alloc(1 + sidBuf.length + capLen.length + hdrLen.length);
    let off = 0;
    result[off++] = WSP_PDU_CONNECT_REPLY;
    sidBuf.copy(result, off); off += sidBuf.length;
    capLen.copy(result, off); off += capLen.length;
    hdrLen.copy(result, off);
    return result;
}

// ── WTP PDU building ────────────────────────────────────────────

// WTP: 8.3.2 Result PDU
function buildWtpResult(tid: number, wspPdu: Buffer): Buffer {
    // Byte 0: CON=0, TYPE=RESULT(0010), GTR=1, TTR=1, RID=0
    const b0 = (WTP_PDU_RESULT << WTP_TYPE_SHIFT) | WTP_GTR | WTP_TTR;
    const result = Buffer.alloc(WTP_HDR_LEN + wspPdu.length);
    result[0] = b0;
    tid ^= WTP_TID_RESPONDER_BIT;   // the Invoke's, its high bit inverted (WTP: 7.8.1)
    result[1] = (tid >> 8) & 0xFF;
    result[2] = tid & 0xFF;
    wspPdu.copy(result, WTP_HDR_LEN);
    return result;
}

// ── WSP PDU parsing ─────────────────────────────────────────────

// WSP: 8.2.3.1 Get
function parseWspGet(data: Buffer): string | null {
    if (data.length < 2 || data[0] !== WSP_PDU_GET) { return null; }
    let pos = 1;
    const { value: uriLen, consumed } = decodeUintvar(data, pos);
    pos += consumed;
    if (pos + uriLen > data.length) { return null; }
    return data.slice(pos, pos + uriLen).toString('ascii');
}

// WSP: 8.2.3.2 Post
function parseWspPost(data: Buffer): { url: string; contentType: string; body: Buffer } | null {
    if (data.length < 2 || data[0] !== WSP_PDU_POST) { return null; }
    let pos = 1;

    const { value: uriLen, consumed: c1 } = decodeUintvar(data, pos);
    pos += c1;
    const { value: hdrsLen, consumed: c2 } = decodeUintvar(data, pos);
    pos += c2;

    if (pos + uriLen > data.length) { return null; }
    const reqUrl = data.slice(pos, pos + uriLen).toString('ascii');
    pos += uriLen;

    const hdrsEnd = pos + hdrsLen;
    let contentType = 'application/x-www-form-urlencoded';
    if (pos < hdrsEnd) {
        const ctByte = data[pos];
        if (ctByte & WSP_SHORT_INT) {
            const code = ctByte & WSP_SHORT_INT_BITS;
            contentType = WSP_CT[code] || contentType;
        }
    }
    pos = hdrsEnd;

    const body = data.slice(pos);
    return { url: reqUrl, contentType, body };
}

// ── WTP PDU parsing ─────────────────────────────────────────────

// WTP: 8.3.1 Invoke PDU
function parseWtpInvoke(data: Buffer): { tid: number; tcl: number; payload: Buffer } | null {
    if (data.length < WTP_INVOKE_HDR_LEN) { return null; }
    const b0 = data[0];
    const pduType = (b0 >> WTP_TYPE_SHIFT) & WTP_TYPE_MASK;
    if (pduType !== WTP_PDU_INVOKE) { return null; }
    const tid = (data[1] << 8) | data[2];
    const tcl = data[3] & WTP_CLASS_MASK;
    const payload = data.slice(WTP_INVOKE_HDR_LEN);
    return { tid, tcl, payload };
}

function errorWml(code: number, msg: string): Buffer {
    const wml =
        '<?xml version="1.0"?>\n' +
        '<!DOCTYPE wml PUBLIC "-//WAPFORUM//DTD WML 1.3//EN"' +
        ' "http://www.wapforum.org/DTD/wml13.dtd">\n' +
        `<wml><card id="err" title="Error ${code}">\n` +
        `<p>${xmlEscape(msg)}</p>\n` +
        '</card></wml>\n';
    return Buffer.from(wml, 'utf-8');
}

// ── Local file serving ──────────────────────────────────────────

type ServeResult = { status: number; contentType: string; body: Buffer };

/**
 * Resolve a URL path to a file on disk, with path traversal protection.
 */
/**
 * The path of a WSP request URL. A gateway may send an absolute URL or a bare
 * path; the placeholder base resolves the latter and is ignored for the former.
 * The result is percent-encoded, which resolveFilePath decodes.
 */
function requestPath(reqUrl: string): string {
    try {
        return new URL(reqUrl, 'http://localhost').pathname || '/';
    } catch {
        return '/';
    }
}

function resolveFilePath(rootDir: string, urlPath: string): string | null {
    const decoded = decodeURIComponent(urlPath);
    const rel = path.normalize(decoded.replace(/^\/+/, '') || '.');
    if (rel.startsWith('..')) { return null; }
    const full = rel === '.' ? rootDir : path.join(rootDir, rel);
    const resolved = path.resolve(full);
    if (resolved !== rootDir && !resolved.startsWith(rootDir + path.sep)) { return null; }
    return resolved;
}

/**
 * Serve a local file. For WSP mode, .wml→.wmlc and .wmls→.wmlsc compilation
 * is applied on the fly. For HTTP mode, text formats are preferred.
 */
function serveLocalFile(
    rootDir: string,
    urlPath: string,
    compileForWsp: boolean,
): ServeResult {
    const full = resolveFilePath(rootDir, urlPath);
    if (!full) {
        return { status: 403, contentType: 'text/vnd.wap.wml', body: errorWml(403, 'Forbidden') };
    }

    if (!fs.existsSync(full)) {
        // For WSP requests: try .wml if .wmlc requested (and vice versa)
        if (compileForWsp) {
            // If requesting .wmlc but only .wml exists, compile
            if (full.endsWith('.wmlc')) {
                const wmlPath = full.replace(/\.wmlc$/i, '.wml');
                if (fs.existsSync(wmlPath) && fs.statSync(wmlPath).isFile()) {
                    return compileAndServeWml(wmlPath);
                }
            }
            // If requesting .wmlsc but only .wmls exists, compile
            if (full.endsWith('.wmlsc')) {
                const wmlsPath = full.replace(/\.wmlsc$/i, '.wmls');
                if (fs.existsSync(wmlsPath) && fs.statSync(wmlsPath).isFile()) {
                    return compileAndServeWmls(wmlsPath);
                }
            }
        }
        return { status: 404, contentType: 'text/vnd.wap.wml', body: errorWml(404, 'Not Found') };
    }

    const stat = fs.statSync(full);

    if (stat.isDirectory()) {
        // Check for index.wml
        const indexPath = path.join(full, 'index.wml');
        if (fs.existsSync(indexPath) && fs.statSync(indexPath).isFile()) {
            if (compileForWsp) {
                return compileAndServeWml(indexPath);
            }
            return serveRawFile(indexPath);
        }
        return directoryListing(urlPath, full, compileForWsp);
    }

    if (stat.isFile()) {
        const ext = path.extname(full).toLowerCase();

        if (compileForWsp) {
            // WSP mode: compile .wml → wmlc, .wmls → wmlsc on the fly
            if (ext === '.wml') {
                return compileAndServeWml(full);
            }
            if (ext === '.wmls') {
                return compileAndServeWmls(full);
            }
        }
        return serveRawFile(full);
    }

    return { status: 404, contentType: 'text/vnd.wap.wml', body: errorWml(404, 'Not Found') };
}

/**
 * WSP:
 *  - 8.4.2.20 Content length field
 *  - 8.4.2.23 Content range field
 *  - 8.4.2.42 Range field
 *
 * A file's WSP reply cut to the Range its Get asked for (wap-browser-c reads
 * a long text file a window at a time), with its length headers; an error
 * goes as it is.
 */
function rangedReply(r: ServeResult, getPdu: Buffer): ServeResult & { extra: Buffer } {
    if (r.status !== 200) { return { ...r, extra: Buffer.alloc(0) }; }
    const cut = cutRange(r.body, wspGetRange(getPdu));
    return { ...r, status: cut.status, body: cut.body, extra: wspLengthHeaders(cut) };
}

function serveRawFile(fullPath: string): ServeResult {
    const ext = path.extname(fullPath).toLowerCase();
    const mime = MIME_TYPES[ext] || 'application/octet-stream';
    const data = fs.readFileSync(fullPath);
    return { status: 200, contentType: mime, body: data };
}

function compileAndServeWml(wmlPath: string): ServeResult {
    try {
        // Read in the deck's own charset (BOM / XML declaration, WML 1.3: 6.1);
        // the WBXML is UTF-8 whatever it was (the same section allows transcoding)
        const wmlContent = decodeDeck(fs.readFileSync(wmlPath)).text;
        const wmlcBuf = encodeWbxml(wmlContent);
        return { status: 200, contentType: 'application/vnd.wap.wmlc', body: wmlcBuf };
    } catch (err: any) {
        log(`WBXML compile error for ${wmlPath}: ${err.message}`);
        return { status: 200, contentType: 'text/vnd.wap.wml', body: fs.readFileSync(wmlPath) };
    }
}

function compileAndServeWmls(wmlsPath: string): ServeResult {
    try {
        const source = decodeDeck(fs.readFileSync(wmlsPath)).text;
        const bytecode = compileWmls(source);
        return { status: 200, contentType: 'application/vnd.wap.wmlscriptc', body: bytecode };
    } catch (err: any) {
        log(`WMLScript compile error for ${wmlsPath}: ${err.message}`);
        return { status: 200, contentType: 'text/vnd.wap.wmlscript', body: fs.readFileSync(wmlsPath) };
    }
}

function directoryListing(displayPath: string, fullPath: string, compileForWsp: boolean): ServeResult {
    let entries: string[];
    try {
        entries = fs.readdirSync(fullPath).sort((a, b) => a.toLowerCase().localeCompare(b.toLowerCase()));
    } catch {
        return { status: 403, contentType: 'text/vnd.wap.wml', body: errorWml(403, 'Forbidden') };
    }

    const normalizedPath = displayPath.endsWith('/') ? displayPath : displayPath + '/';

    let wml =
        '<?xml version="1.0" encoding="UTF-8"?>\n' +
        '<!DOCTYPE wml PUBLIC "-//WAPFORUM//DTD WML 1.3//EN"' +
        ' "http://www.wapforum.org/DTD/wml13.dtd">\n' +
        '<wml>\n<card id="dir" title="Index">\n' +
        `<p><b>${xmlEscape(normalizedPath)}</b></p>\n`;

    const trimmed = displayPath.replace(/\/+$/, '');
    if (trimmed && trimmed !== '/') {
        const parent = trimmed.lastIndexOf('/') > 0
            ? trimmed.substring(0, trimmed.lastIndexOf('/'))
            : '/';
        wml += `<p><a href="${encodeURI(parent)}">..</a></p>\n`;
    }

    for (const name of entries) {
        const entryFull = path.join(fullPath, name);
        const isDir = fs.statSync(entryFull).isDirectory();
        const link = isDir ? name + '/' : name;
        const href = encodeURIComponent(link).replace(/%2F/g, '/');
        wml += `<p><a href="${normalizedPath}${href}">${xmlEscape(link)}</a></p>\n`;
    }

    wml += '</card>\n</wml>\n';

    const body = Buffer.from(wml, 'utf-8');

    if (compileForWsp) {
        try {
            const compiled = encodeWbxml(wml);
            return { status: 200, contentType: 'application/vnd.wap.wmlc', body: compiled };
        } catch {
            // Fall through to text
        }
    }
    return { status: 200, contentType: 'text/vnd.wap.wml', body };
}

// ── Connectionless WSP Server (UDP port 9200) ───────────────────

let clSocket: dgram.Socket | undefined;

// WSP: 7.2 Connectionless WSP
function startConnectionlessWSP(rootDir: string, wspPort: number): void {
    clSocket = dgram.createSocket('udp4');

    clSocket.on('message', (msg, rinfo) => {
        if (msg.length < 3) { return; }

        // Wire format: [TID:1 byte][WSP PDU...]
        const tidByte = msg[0];
        const wspData = msg.slice(1);
        const pduType = wspData[0];

        if (pduType === WSP_PDU_GET) {
            const reqUrl = parseWspGet(wspData);
            if (!reqUrl) {
                log(`Bad GET PDU from ${rinfo.address}:${rinfo.port}`);
                return;
            }

            log(`CL GET ${reqUrl} from ${rinfo.address}:${rinfo.port} (TID=${tidByte})`);

            const urlPath = requestPath(reqUrl);
            const result = rangedReply(serveLocalFile(rootDir, urlPath, true), wspData);
            const reply = buildWspReply(result.status, result.contentType, result.body, result.extra);

            const response = Buffer.alloc(1 + reply.length);
            response[0] = tidByte;
            reply.copy(response, 1);

            clSocket!.send(response, rinfo.port, rinfo.address, (err) => {
                if (err) { log(`CL send error: ${err.message}`); }
            });
            log(`CL Reply ${result.status} (${result.body.length} bytes) → ${rinfo.address}:${rinfo.port}`);
        } else {
            log(`Unexpected PDU type 0x${pduType.toString(16)} on CL port from ${rinfo.address}:${rinfo.port}`);
        }
    });

    clSocket.on('error', (err) => {
        log(`CL UDP error: ${err.message}`);
        vscode.window.showErrorMessage(`WAP Server CL UDP error: ${err.message}`);
    });

    clSocket.bind(wspPort, bindAddr, () => {
        log(`Connectionless WSP listening on UDP ${bindAddr}:${wspPort}`);
    });
}

// ── Connection-Oriented WSP Server (UDP port configurable)

let coSocket: dgram.Socket | undefined;
let nextSessionId = 1;

// WSP: 7.1 Connection-Mode WSP
function startConnectionOrientedWSP(rootDir: string, wspCoPort: number): void {
    coSocket = dgram.createSocket('udp4');

    coSocket.on('message', (msg, rinfo) => {
        if (msg.length < WTP_HDR_LEN) { return; }

        const b0 = msg[0];
        const pduType = (b0 >> WTP_TYPE_SHIFT) & WTP_TYPE_MASK;

        if (pduType === WTP_PDU_INVOKE) {
            handleInvoke(msg, rinfo, rootDir);
        } else if (pduType === WTP_PDU_ACK) {
            // Client ack — nothing to do
        } else {
            log(`Unexpected WTP PDU type ${pduType} from ${rinfo.address}:${rinfo.port}`);
        }
    });

    coSocket.on('error', (err) => {
        log(`CO UDP error: ${err.message}`);
        vscode.window.showErrorMessage(`WAP Server CO UDP error: ${err.message}`);
    });

    coSocket.bind(wspCoPort, bindAddr, () => {
        log(`Connection-oriented WSP listening on UDP ${bindAddr}:${wspCoPort}`);
    });
}

// WTP: 7.8.2 Procedure at the Responder
// WSP:
//  - 7.1.2.1 Session Management Facility
//  - 7.1.2.3 Method Invocation Facility
function handleInvoke(data: Buffer, rinfo: dgram.RemoteInfo, rootDir: string): void {
    const invoke = parseWtpInvoke(data);
    if (!invoke) { return; }
    const { tid, payload } = invoke;

    if (payload.length < 1) { return; }
    const wspType = payload[0];

    if (wspType === WSP_PDU_CONNECT) {
        const sessionId = nextSessionId++;
        log(`CO Connect from ${rinfo.address}:${rinfo.port} → session ${sessionId}`);
        const replyPdu = buildWspConnectReply(sessionId);
        const wtpResult = buildWtpResult(tid, replyPdu);
        coSocket!.send(wtpResult, rinfo.port, rinfo.address);

    } else if (wspType === WSP_PDU_POST) {
        const parsed = parseWspPost(payload);
        if (!parsed) {
            log(`Bad POST PDU from ${rinfo.address}:${rinfo.port}`);
            return;
        }
        log(`CO POST ${parsed.url} from ${rinfo.address}:${rinfo.port} (${parsed.body.length} bytes)`);

        const urlPath = requestPath(parsed.url);
        const result = serveLocalFile(rootDir, urlPath, true);
        const replyPdu = buildWspReply(result.status, result.contentType, result.body);
        const wtpResult = buildWtpResult(tid, replyPdu);
        coSocket!.send(wtpResult, rinfo.port, rinfo.address);
        log(`CO Reply ${result.status} (${result.body.length} bytes) → ${rinfo.address}:${rinfo.port}`);

    } else if (wspType === WSP_PDU_GET) {
        const reqUrl = parseWspGet(payload);
        if (!reqUrl) { return; }
        log(`CO GET ${reqUrl} from ${rinfo.address}:${rinfo.port}`);

        const urlPath = requestPath(reqUrl);
        const result = rangedReply(serveLocalFile(rootDir, urlPath, true), payload);
        const replyPdu = buildWspReply(result.status, result.contentType, result.body, result.extra);
        const wtpResult = buildWtpResult(tid, replyPdu);
        coSocket!.send(wtpResult, rinfo.port, rinfo.address);

    } else if (wspType === WSP_PDU_DISCONNECT) {
        log(`CO Disconnect from ${rinfo.address}:${rinfo.port}`);
    } else {
        log(`Unknown WSP PDU 0x${wspType.toString(16)} in CO Invoke from ${rinfo.address}:${rinfo.port}`);
    }
}

// ── WAP-over-HTTP Server (configurable port)

let httpServer: http.Server | undefined;

function startHttpServer(rootDir: string, httpPort: number): void {
    httpServer = http.createServer((req, res) => {
        const urlPath = decodeURIComponent(req.url || '/');

        // Security: prevent path traversal
        const resolved = resolveFilePath(rootDir, urlPath);
        if (!resolved) {
            res.writeHead(403, { 'Content-Type': 'text/plain' });
            res.end('Forbidden');
            return;
        }

        if (req.method === 'GET' || req.method === 'HEAD') {
            // RFC 9110: 14.2 Range: a file's bytes from first to last
            // (wap-browser-c's text pages), 206 / 416 with Content-Range
            const result = serveLocalFile(rootDir, urlPath, false);
            const head: http.OutgoingHttpHeaders = { 'Content-Type': result.contentType };
            if (result.status === 200) {
                const cut = cutRange(result.body, httpRange(req.headers.range));
                if (cut.status !== 200) {
                    head['Content-Range'] = cut.status === 206
                        ? `bytes ${cut.first}-${cut.first + cut.body.length - 1}/${cut.size}`
                        : `bytes */${cut.size}`;
                }
                result.status = cut.status;
                result.body = cut.body;
            }
            head['Content-Length'] = result.body.length.toString();
            res.writeHead(result.status, head);
            if (req.method === 'GET') {
                res.end(result.body);
            } else {
                res.end();
            }
        } else if (req.method === 'POST') {
            const chunks: Buffer[] = [];
            req.on('data', (chunk: Buffer) => chunks.push(chunk));
            req.on('end', () => {
                // For local file serving, POST falls back to GET behavior
                const result = serveLocalFile(rootDir, urlPath, false);
                res.writeHead(result.status, {
                    'Content-Type': result.contentType,
                    'Content-Length': result.body.length.toString(),
                });
                res.end(result.body);
            });
        } else {
            res.writeHead(405, { 'Content-Type': 'text/plain' });
            res.end('Method Not Allowed');
        }
    });

    httpServer.on('error', (err: NodeJS.ErrnoException) => {
        if (err.code === 'EADDRINUSE') {
            log(`HTTP port ${httpPort} is already in use`);
            vscode.window.showErrorMessage(`WAP Server: HTTP port ${httpPort} is already in use`);
        } else {
            log(`HTTP error: ${err.message}`);
        }
    });

    httpServer.listen(httpPort, bindAddr, () => {
        log(`WAP-over-HTTP listening on http://${bindAddr}:${httpPort}`);
    });
}

// ── Public API ──────────────────────────────────────────────────

let wapServerRunning = false;

export function isWapServerRunning(): boolean {
    return wapServerRunning;
}

export function startWapServer(): void {
    if (wapServerRunning) { return; }

    const workspaceFolders = vscode.workspace.workspaceFolders;
    if (!workspaceFolders || workspaceFolders.length === 0) {
        vscode.window.showErrorMessage('No workspace folder open');
        return;
    }
    const rootDir = workspaceFolders[0].uri.fsPath;

    nextSessionId = 1;

    const { wspPort, wspCoPort, httpPort, bindAddress } = getWapServerPorts();
    bindAddr = bindAddress;

    startConnectionlessWSP(rootDir, wspPort);
    startConnectionOrientedWSP(rootDir, wspCoPort);
    startHttpServer(rootDir, httpPort);

    wapServerRunning = true;

    log(`WAP Server started — root: ${rootDir}`);
    log(`  WSP CL (GET):  UDP ${bindAddr}:${wspPort}  (compiled wmlc/wmlsc)`);
    log(`  WSP CO (POST): UDP ${bindAddr}:${wspCoPort} (compiled wmlc/wmlsc)`);
    log(`  HTTP:          http://${bindAddr}:${httpPort} (text wml/wmls)`);
    outputChannel?.show(true);

    vscode.window.showInformationMessage(
        `WAP Server running — WSP UDP :${wspPort}/:${wspCoPort}, HTTP :${httpPort}`
    );
}

export function stopWapServer(): void {
    if (!wapServerRunning) { return; }

    if (clSocket) {
        try { clSocket.close(); } catch { /* ignore */ }
        clSocket = undefined;
    }
    if (coSocket) {
        try { coSocket.close(); } catch { /* ignore */ }
        coSocket = undefined;
    }
    if (httpServer) {
        httpServer.close();
        httpServer = undefined;
    }

    wapServerRunning = false;
    log('WAP Server stopped');
    vscode.window.showInformationMessage('WAP Server stopped');
}
