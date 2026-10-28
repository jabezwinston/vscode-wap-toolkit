/**
 *  Copyright (C) 2026 Jabez Winston
 *
 *  SPDX-License-Identifier: Apache-2.0
 *
 *  Cookie storage for the WAP browser, shared by the HTTP and WSP transports.
 *
 *  Host-free (no node `url` module) so it can be unit tested directly and reused
 *  outside the extension host — the Android port runs this same code inside a
 *  WebView.
 */

export interface Cookie {
    name: string;
    value: string;
    domain: string;
    path: string;
    expires?: Date;
}

/** Split a request URL into the host and path a cookie is scoped to. */
function scopeOf(requestUrl: string): { domain: string; path: string } {
    try {
        const parsed = new URL(requestUrl);
        return { domain: parsed.hostname || '', path: parsed.pathname || '/' };
    } catch {
        // Matches the previous node url.parse() behaviour on unparseable input.
        return { domain: '', path: '/' };
    }
}

export class CookieJar {
    private cookies: Cookie[] = [];

    /** Store one `Set-Cookie` value, scoped against the URL it arrived from. */
    set(rawCookie: string, requestUrl: string): void {
        const scope = scopeOf(requestUrl);

        const parts = rawCookie.split(';').map(s => s.trim());
        const [nameVal, ...attrs] = parts;
        const eqIdx = nameVal.indexOf('=');
        if (eqIdx < 0) { return; }
        const name = nameVal.substring(0, eqIdx).trim();
        const value = nameVal.substring(eqIdx + 1).trim();

        let cDomain = scope.domain;
        let cPath = scope.path;
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

        // Replace any existing cookie with the same name+domain+path
        this.cookies = this.cookies.filter(c =>
            !(c.name === name && c.domain === cDomain && c.path === cPath)
        );

        // Don't store if already expired
        if (cExpires && cExpires.getTime() < Date.now()) { return; }

        this.cookies.push({ name, value, domain: cDomain, path: cPath, expires: cExpires });
    }

    /** Build the `Cookie` request header for a URL. */
    get(requestUrl: string): string {
        const scope = scopeOf(requestUrl);
        const now = Date.now();

        const matching = this.cookies.filter(c => {
            if (c.expires && c.expires.getTime() < now) { return false; }
            if (!scope.domain.endsWith(c.domain) && scope.domain !== c.domain) { return false; }
            if (!scope.path.startsWith(c.path)) { return false; }
            return true;
        });

        return matching.map(c => `${c.name}=${c.value}`).join('; ');
    }

    /**
     * Store every cookie a response set.
     *
     * Takes the values already separated (FetchResult.setCookies) rather than
     * the comma-joined header: an `Expires=` date contains ", " itself, so a
     * joined string cannot be split back into individual cookies reliably.
     */
    setAll(setCookies: string[] | undefined, requestUrl: string): void {
        if (!setCookies) { return; }
        for (const raw of setCookies) {
            this.set(raw.trim(), requestUrl);
        }
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
