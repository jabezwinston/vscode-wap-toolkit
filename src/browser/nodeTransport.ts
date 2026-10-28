/**
 *  Copyright (C) 2026 Jabez Winston
 *
 *  SPDX-License-Identifier: Apache-2.0
 *
 *  Node-backed transport ports for the WAP browser core.
 *
 *  The browsing logic lives in src/shared/browserCore.ts, which is deliberately
 *  host-agnostic. These two classes are the extension host's half of that seam:
 *  a single-shot HTTP request and a UDP socket. Redirects, cookies, WSP PDU
 *  assembly, retransmission and WTP acknowledgement all live in shared code
 *  above them.
 *
 *  Kept free of `vscode` so the whole transport path can be exercised against a
 *  real socket in the test suite.
 */

import * as http from 'http';
import * as https from 'https';
import * as dgram from 'dgram';
import { HttpRequest, HttpResponse, HttpTransport } from '../shared/httpClient';
import { DatagramFactory, DatagramSession } from '../shared/wspClient';

export class NodeHttpTransport implements HttpTransport {
    request(req: HttpRequest): Promise<HttpResponse> {
        return new Promise((resolve, reject) => {
            const parsed = new URL(req.url);
            const lib = parsed.protocol === 'https:' ? https : http;

            const options: http.RequestOptions = {
                method: req.method,
                hostname: parsed.hostname,
                port: parsed.port,
                path: parsed.pathname + parsed.search,
                headers: req.headers,
                timeout: req.timeoutMs,
            };

            const outbound = lib.request(options, (res) => {
                const chunks: Buffer[] = [];
                res.on('data', (chunk: Buffer) => chunks.push(chunk));
                res.on('end', () => resolve({
                    status: res.statusCode || 0,
                    headers: res.headers as Record<string, string | string[]>,
                    body: Buffer.concat(chunks),
                }));
            });

            outbound.on('error', (err) => reject(err));
            outbound.on('timeout', () => { outbound.destroy(); reject(new Error('Request timeout')); });

            if (req.body) { outbound.write(req.body); }
            outbound.end();
        });
    }
}

/**
 * A bound udp4 socket presented as the pull-based DatagramSession the WSP client
 * expects. Datagrams that arrive while nothing is waiting are queued, so a reply
 * that beats its receive() call is not lost.
 */
export class NodeDatagramSession implements DatagramSession {
    private readonly socket = dgram.createSocket('udp4');
    private readonly queued: Buffer[] = [];
    private waiting?: (msg: Buffer | null) => void;
    private failure?: Error;
    private closed = false;

    constructor(private readonly host: string, private readonly port: number) {
        this.socket.on('message', (msg) => this.deliver(Buffer.from(msg)));
        this.socket.on('error', (err) => { this.failure = err; this.deliver(null); });
    }

    private deliver(msg: Buffer | null): void {
        if (this.waiting) {
            const waiter = this.waiting;
            this.waiting = undefined;
            waiter(msg);
        } else if (msg) {
            this.queued.push(msg);
        }
    }

    send(packet: Buffer): void {
        this.socket.send(packet, this.port, this.host, (err) => {
            if (err) { this.failure = err; this.deliver(null); }
        });
    }

    receive(timeoutMs: number): Promise<Buffer | null> {
        if (this.failure) { return Promise.reject(this.failure); }
        const queued = this.queued.shift();
        if (queued) { return Promise.resolve(queued); }

        return new Promise((resolve, reject) => {
            const timer = setTimeout(() => {
                if (this.waiting) { this.waiting = undefined; resolve(null); }
            }, timeoutMs);
            this.waiting = (msg) => {
                clearTimeout(timer);
                if (msg === null && this.failure) { reject(this.failure); } else { resolve(msg); }
            };
        });
    }

    close(): void {
        if (this.closed) { return; }
        this.closed = true;
        try { this.socket.close(); } catch { /* already closed */ }
    }
}

export class NodeDatagramFactory implements DatagramFactory {
    open(host: string, port: number): Promise<DatagramSession> {
        return Promise.resolve(new NodeDatagramSession(host, port));
    }
}

