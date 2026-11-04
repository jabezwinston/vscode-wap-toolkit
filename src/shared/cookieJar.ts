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

/** RFC 6265: 5.3 Storage Model */
export interface Cookie {
    name: string;
    value: string;
    /** A host name, lower case, no leading '.' */
    domain: string;
    /** Starts with '/' */
    path: string;
    /** Sent to `domain` only, not to the names under it */
    hostOnly: boolean;
    /** Sent over https only */
    secure: boolean;
    expires?: Date;
}

/** RFC 6265: 5.1.2 Canonicalized Host Names
 *
 * The host, path and scheme of a request URL, as a cookie scope. */
function scopeOf(requestUrl: string): { host: string; path: string; secure: boolean } {
    try {
        const parsed = new URL(requestUrl);
        return {
            host: parsed.hostname || '',
            path: parsed.pathname || '/',
            secure: parsed.protocol === 'https:',
        };
    } catch {
        // Matches the previous node url.parse() behaviour on unparseable input.
        return { host: '', path: '/', secure: false };
    }
}

/** RFC 6265: 5.1.3 Domain Matching
 *
 * Is host the cookie domain, or a name under it: one ending in "." domain
 * that is not an IP address? No top-level domain ends in a digit, so a host
 * that does is an address (an IPv6 one ends in ']'). */
function domainMatches(host: string, domain: string): boolean {
    return host === domain ||
        (host.endsWith('.' + domain) && !/[\d\]]$/.test(host));
}

/** RFC 6265: 5.1.4 Paths and Path-Match
 *
 * Does the request path path-match the cookie path: is it that path, or one
 * under it (the cookie path ends in '/', or the request path goes on with
 * one)? */
function pathMatches(reqPath: string, cookiePath: string): boolean {
    return reqPath === cookiePath ||
        (reqPath.startsWith(cookiePath) &&
            (cookiePath.endsWith('/') || reqPath[cookiePath.length] === '/'));
}

/** RFC 6265: 5.1.4 Paths and Path-Match
 *
 * The default-path of a request path: up to its last '/', or "/" when that
 * is the first. */
function defaultPath(reqPath: string): string {
    const last = reqPath.lastIndexOf('/');
    return last > 0 ? reqPath.substring(0, last) : '/';
}

export class CookieJar {
    private cookies: Cookie[] = [];

    /** RFC 6265:
     *  - 5.2 The Set-Cookie Header
     *  - 5.2.1 The Expires Attribute
     *  - 5.2.2 The Max-Age Attribute
     *  - 5.2.3 The Domain Attribute
     *  - 5.2.4 The Path Attribute
     *  - 5.2.5 The Secure Attribute
     *  - 5.3 Storage Model
     *
     * Store one `Set-Cookie` value, scoped against the URL it arrived from. */
    set(rawCookie: string, requestUrl: string): void {
        const scope = scopeOf(requestUrl);

        const parts = rawCookie.split(';').map(s => s.trim());
        const [nameVal, ...attrs] = parts;
        const eqIdx = nameVal.indexOf('=');
        if (eqIdx < 0) { return; }
        const name = nameVal.substring(0, eqIdx).trim();
        const value = nameVal.substring(eqIdx + 1).trim();

        let domainAttr = '';
        let cPath = defaultPath(scope.path);
        let cExpires: Date | undefined;
        let maxAge: Date | undefined;
        let secure = false;

        for (const attr of attrs) {
            const eq = attr.indexOf('=');
            const key = (eq < 0 ? attr : attr.substring(0, eq)).trim().toLowerCase();
            const val = eq < 0 ? '' : attr.substring(eq + 1).trim();
            if (key === 'domain') {
                // An empty value is ignored; a leading '.' is dropped
                if (val) { domainAttr = val.replace(/^\./, '').toLowerCase(); }
            } else if (key === 'path') {
                // A value that is not a path leaves the default-path
                cPath = val.startsWith('/') ? val : defaultPath(scope.path);
            } else if (key === 'expires') {
                cExpires = new Date(val);
            } else if (key === 'max-age') {
                // Digits, '-' allowed first, else the attribute is ignored;
                // zero or less is the earliest time there is
                if (/^-?\d+$/.test(val)) {
                    const secs = parseInt(val, 10);
                    maxAge = new Date(secs <= 0 ? 0 : Date.now() + secs * 1000);
                }
            } else if (key === 'secure') {
                secure = true;
            }
        }
        if (maxAge) { cExpires = maxAge; }    // Max-Age wins over Expires

        // A Domain the host does not domain-match makes the cookie ignored;
        // without one the cookie is that host's alone
        let cDomain = scope.host;
        let hostOnly = true;
        if (domainAttr) {
            if (!domainMatches(scope.host, domainAttr)) { return; }
            cDomain = domainAttr;
            hostOnly = false;
        }

        // Replace any existing cookie with the same name+domain+path
        this.cookies = this.cookies.filter(c =>
            !(c.name === name && c.domain === cDomain && c.path === cPath)
        );

        // Don't store if already expired
        if (cExpires && cExpires.getTime() < Date.now()) { return; }

        this.cookies.push({
            name, value, domain: cDomain, path: cPath, hostOnly, secure, expires: cExpires,
        });
    }

    /** RFC 6265: 5.4 The Cookie Header
     *
     * Build the `Cookie` request header for a URL. */
    get(requestUrl: string): string {
        const scope = scopeOf(requestUrl);
        const now = Date.now();

        const matching = this.cookies.filter(c => {
            if (c.expires && c.expires.getTime() < now) { return false; }
            if (c.hostOnly ? scope.host !== c.domain : !domainMatches(scope.host, c.domain)) {
                return false;
            }
            if (!pathMatches(scope.path, c.path)) { return false; }
            if (c.secure && !scope.secure) { return false; }
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
