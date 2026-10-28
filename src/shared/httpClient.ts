/**
 *  Copyright (C) 2026 Jabez Winston
 *
 *  SPDX-License-Identifier: Apache-2.0
 *
 *  WAP-over-HTTP client.
 *
 *  Owns the browser-visible behaviour — the WAP `Accept` list, User-Agent,
 *  cookie attachment and redirect following — over an injected single-shot
 *  request port. The port deliberately does not follow redirects itself, so
 *  cookies set on a 3xx are captured here before the next hop is issued.
 */

import { CookieJar } from './cookieJar';
import { FetchResult } from './wapProtocol';

/** Content types a WAP browser advertises, in preference order. */
export const WAP_ACCEPT =
    'application/vnd.wap.wmlc, application/vnd.wap.wmlscriptc, ' +
    'text/vnd.wap.wml, text/vnd.wap.wmlscript, image/vnd.wap.wbmp';

export interface HttpRequest {
    method: string;
    url: string;
    headers: Record<string, string>;
    body?: string;
    timeoutMs: number;
}

export interface HttpResponse {
    status: number;
    /** Lower-cased header names. `set-cookie` may repeat, hence the array form. */
    headers: Record<string, string | string[]>;
    body: Buffer;
}

/**
 * A single HTTP exchange with no redirect following and no cookie handling —
 * node's http/https in the extension, HttpURLConnection on Android.
 */
export interface HttpTransport {
    request(req: HttpRequest): Promise<HttpResponse>;
}

export interface HttpFetchOptions {
    method?: string;
    postBody?: string;
    cookies?: string;
    cookieJar?: CookieJar;
    referer?: string;
    userAgent: string;
    timeoutMs?: number;
    maxRedirects?: number;
}

/** Collapse the transport's header map into single strings. */
function flatten(headers: Record<string, string | string[]>): Record<string, string> {
    const out: Record<string, string> = {};
    for (const [key, val] of Object.entries(headers)) {
        if (val === undefined || val === null) { continue; }
        out[key.toLowerCase()] = Array.isArray(val) ? val.join(', ') : val;
    }
    return out;
}

function setCookieValues(headers: Record<string, string | string[]>): string[] {
    const raw = headers['set-cookie'];
    if (!raw) { return []; }
    return Array.isArray(raw) ? raw : [raw];
}

/**
 * Fetch a resource over HTTP, following up to `maxRedirects` hops.
 *
 * Redirects are re-issued as GET without the original body, and the cookie
 * header is recomputed for each hop from the jar.
 */
export async function fetchHttp(
    transport: HttpTransport,
    targetUrl: string,
    opts: HttpFetchOptions,
): Promise<FetchResult> {
    const maxRedirects = opts.maxRedirects ?? 5;
    const timeoutMs = opts.timeoutMs ?? 15000;

    let url = targetUrl;
    let method = (opts.method || 'GET').toUpperCase();
    let body = opts.postBody;
    let cookies = opts.cookies;

    for (let hop = 0; ; hop++) {
        const headers: Record<string, string> = {
            'User-Agent': opts.userAgent,
            'Accept': WAP_ACCEPT,
            // every charset the browser decodes, UTF-8 preferred (charset.ts)
            'Accept-Charset': 'utf-8, *;q=0.5',
        };
        if (cookies) { headers['Cookie'] = cookies; }
        if (opts.referer) { headers['Referer'] = opts.referer; }
        if (method === 'POST' && body) {
            headers['Content-Type'] = 'application/x-www-form-urlencoded';
            headers['Content-Length'] = String(Buffer.byteLength(body));
        }

        const res = await transport.request({ method, url, headers, body, timeoutMs });
        const flat = flatten(res.headers);

        const isRedirect = res.status >= 300 && res.status < 400 && flat['location'];
        if (!isRedirect) {
            return {
                status: res.status,
                contentType: flat['content-type'] || '',
                body: res.body,
                headers: flat,
                setCookies: setCookieValues(res.headers),
                finalUrl: url,
            };
        }

        if (hop >= maxRedirects) { throw new Error('Too many redirects'); }

        // Capture cookies from the 3xx before moving on, so the next hop sends them.
        if (opts.cookieJar) {
            for (const raw of setCookieValues(res.headers)) {
                opts.cookieJar.set(raw, url);
            }
        }

        url = new URL(flat['location'], url).toString();
        method = 'GET';
        body = undefined;
        cookies = opts.cookieJar ? opts.cookieJar.get(url) : cookies;
    }
}
