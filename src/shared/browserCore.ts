/**
 *  Copyright (C) 2026 Jabez Winston
 *
 *  SPDX-License-Identifier: Apache-2.0
 *
 *  WAP browser core — transport- and host-agnostic browsing logic.
 *
 *  Everything a WAP browser does between "the user asked for a URL" and "here is
 *  the markup to display" lives here: transport selection, redirects, the
 *  compiled-variant fallback, cookie bookkeeping, content-type dispatch, deck
 *  access control, history, and WMLScript execution on the bytecode VM.
 *
 *  It talks to its host through {@link BrowserPorts} — sockets, a message sink
 *  and an optional debugger. That is the whole seam. The VS Code extension backs
 *  the ports with node's http/dgram and a webview; the Android port backs them
 *  with HttpURLConnection, DatagramSocket and a WebView, and reuses this file
 *  unchanged.
 */

import { decodeWbxml } from '../wbxml/decoder';
import { WBXML_VERSION, MB_UINT_MORE, MB_UINT_BITS } from '../wbxml/tokenTable';
import { compileWmls } from '../wmlsc/compiler';
import { decodeWmlsc, WmlscModule } from '../wmlsc/decoder';
import { PragmaType, WmlsType } from '../wmlsc/opcodes';
import { WmlsVM, VMResult } from '../wmlsc/vm';
import {
    LibraryContext,
    mkString, mkBool, mkInvalid, strNum,
    WmlsValue, DialogRequest,
} from '../wmlsc/stdlib';
import { WmlCard, escapeHtml, renderCards, ImageResolver } from '../wmlTransform';
import {
    charsetByMib, charsetByName, charsetByteMap, charsetFromContentType, charsetMib, decodeDeck,
    percentEncode, sentCharset,
} from './charset';
import { wbmpToDataUri } from './wbmpUtils';
import { AccessVerdict, accessAllows, checkDeckAccess } from './deckAccess';
import { sanitizeMarkup } from './sanitize';
import { CookieJar } from './cookieJar';
import { FetchResult } from './wapProtocol';
import { HttpTransport, fetchHttp } from './httpClient';
import { DatagramFactory, fetchWspGet, fetchWspPost } from './wspClient';

/** Nested external calls (a unit calling a unit calling ...) */
const MAX_EXTERNAL_DEPTH = 8;

/**
 * WMLScript:
 *  - 6.7.2 Access Control
 *  - 8.5 Access Control
 *
 * A unit's `use access` pragma against the calling deck or unit
 * (WMLScript: 6.7.2, 8.5): without one, any caller may call it; with one, the domain
 * defaults to the unit's host and the path to "/".
 */
export function checkUnitAccess(mod: WmlscModule, referrerUrl: string, unitUrl: string): AccessVerdict {
    const value = (type: PragmaType): string | undefined => {
        const p = mod.pragmas.find((x) => x.type === type);
        const c = p ? mod.constants[p.indices[0]] : undefined;
        return p ? (c && typeof c.value === 'string' ? c.value : '') : undefined;
    };
    const domain = value(PragmaType.ACCESS_DOMAIN), path = value(PragmaType.ACCESS_PATH);
    if ((domain === undefined && path === undefined) || !referrerUrl) { return { allowed: true }; }
    return accessAllows(domain || undefined, path || undefined, referrerUrl, unitUrl);
}

// ── Settings ─────────────────────────────────────────────────────

export interface BrowserSettings {
    transport: 'http' | 'wsp';
    gatewayHost: string;
    gatewayPort: number;
    wspCoPort: number;
    screenWidth: number;
    screenHeight: number;
}

export const DEFAULT_SETTINGS: BrowserSettings = {
    transport: 'http',
    gatewayHost: '127.0.0.1',
    gatewayPort: 9200,
    wspCoPort: 9201,
    screenWidth: 280,
    screenHeight: 380,
};

/**
 * A parsed WMLScript call argument. `quoted` marks a string-literal token
 * ('...'/"...") whose type must stay String per WMLScript: 8.3.4; a bare string
 * (legacy / unquoted) is coerced by its literal form. Produced by
 * parseWmlScriptArgs in src/shared/wml-engine.js and forwarded by the UI.
 */
export type WmlsCallArg = string | { value: string; quoted: boolean };

/** What a script asked of the browser when it ended */
export interface ScriptNav {
    goUrl?: string;
    doPrev: boolean;
    doRefresh: boolean;
    newContext?: boolean;
}

export interface HistoryEntry {
    url: string;
    title: string;
    date: string;
}

// ── Host ports ───────────────────────────────────────────────────

/**
 * Optional debugger integration. Only the VS Code host implements this; the
 * Android port leaves it undefined and every script runs on the plain VM.
 */
export interface BrowserDebugPort {
    isDebugging(): boolean;
    /** A deck was rendered — surface it and its scripts for breakpointing. */
    onDeckRendered(wml: string, baseUrl: string): void;
    /**
     * Run a script under debugger control. Returns null when there is no source
     * to debug, in which case the core falls back to a normal VM run.
     */
    runScript(
        scriptUrl: string, funcName: string, args: WmlsValue[], ctx: LibraryContext,
    ): Promise<{ error?: string } | null>;
}

export interface BrowserPorts {
    http: HttpTransport;
    datagram: DatagramFactory;
    /** Deliver a message to the UI layer. */
    post(msg: Record<string, unknown>): void;
    /** Offer a resource whose content type the browser cannot display. */
    download(body: Buffer, contentType: string, url: string): Promise<void>;
    /** Advertised in the User-Agent header over both transports. */
    userAgent: string;
    debug?: BrowserDebugPort;
}

// ── Core ─────────────────────────────────────────────────────────

export class WapBrowserCore {
    private readonly ports: BrowserPorts;

    public cookieJar = new CookieJar();
    public settings: BrowserSettings;
    public history: HistoryEntry[] = [];
    public wmlVars: Record<string, string> = {};
    public currentUrl = '';
    /** The card on screen when a script was called (its id) */
    private currentCardId = '';
    public currentWml = '';
    /** Charset the current deck came in: the default for text sent back (WML 1.3: 9.5.1). */
    public deckCharset = 'utf-8';

    // Outstanding interactive Dialogs.* calls (requestId → resolver), fulfilled
    // by the UI's 'dialogResult' reply. See requestDialog().
    private dialogSeq = 0;
    private pendingDialogs = new Map<number, (result: string | boolean | null) => void>();

    constructor(ports: BrowserPorts, settings?: Partial<BrowserSettings>) {
        this.ports = ports;
        this.settings = { ...DEFAULT_SETTINGS, ...settings };
    }

    /** Settle any dialog the VM is still waiting on so its run promise unwinds. */
    public dispose(): void {
        for (const resolve of this.pendingDialogs.values()) { resolve(null); }
        this.pendingDialogs.clear();
    }

    // ── Navigation ───────────────────────────────────────────────

    // WML 1.3:
    //  - 12.5.1 The Go Task
    //  - 9.5.1 The Go Element
    //  - 12.5.5 Task Execution Failure
    public async navigate(
        targetUrl: string,
        postfields?: { name: string; value: string }[],
        method: string = 'get',
        referer?: string,
        fromDeck?: string,
        acceptCharset?: string,
        noCache?: boolean,
    ): Promise<void> {
        // The deck we are navigating away from — used for deck access control.
        const referringDeck = fromDeck || '';
        // A task that fails leaves the deck it started from current (WML 1.3: 12.5.5)
        const before = this.currentUrl;
        try {
            const { transport } = this.settings;

            let result: FetchResult;
            let postBody: string | undefined;
            const httpMethod = method.toUpperCase();

            // WML 1.3: 9.5.1 The Go Element: in the first known charset of accept-charset, else the
            // one the deck came in; a POST's Content-Type names it
            const cs = sentCharset(goCharset(acceptCharset, this.deckCharset));
            if (postfields && postfields.length > 0) {
                const encoded = postfields.map((pf) =>
                    escapeFormField(String(pf.name), cs) + '=' + escapeFormField(String(pf.value), cs)
                ).join('&');

                if (httpMethod === 'GET') {
                    // GET: the fields join the query, before the fragment
                    const h = targetUrl.indexOf('#');
                    const base = h < 0 ? targetUrl : targetUrl.substring(0, h);
                    targetUrl = base + (base.includes('?') ? '&' : '?') + encoded +
                        (h < 0 ? '' : targetUrl.substring(h));
                } else {
                    postBody = encoded;
                }
            }
            if (httpMethod === 'POST' && postBody === undefined) {
                postBody = '';                  // method="post" posts, fields or none
            }
            const extra = { referer, noCache: !!noCache, charset: cs };

            const requested = targetUrl;
            if (transport === 'wsp') {
                result = await this.fetchOverWsp(targetUrl, httpMethod, postBody, extra);

                // WSP has no transport-level redirect handling — follow them here.
                let redirects = 0;
                while (result.status >= 300 && result.status < 400 &&
                       result.headers['location'] && redirects < 5) {
                    this.cookieJar.setAll(result.setCookies, targetUrl);
                    targetUrl = new URL(result.headers['location'], targetUrl).toString();
                    result = await this.fetchOverWsp(targetUrl, 'GET');
                    redirects++;
                }
            } else {
                result = await fetchHttp(this.ports.http, targetUrl, {
                    method: httpMethod,
                    postBody,
                    cookies: this.cookieJar.get(targetUrl),
                    cookieJar: this.cookieJar,
                    referer,
                    contentCharset: cs,
                    noCache: !!noCache,
                    userAgent: this.ports.userAgent,
                });
            }

            // 404 fallback: try the compiled variant if the source is not found
            if (result.status === 404) {
                const fallbackUrl = getFallbackUrl(targetUrl);
                if (fallbackUrl) {
                    const fallback = await this.getResource(fallbackUrl);
                    if (fallback.status === 200) {
                        result = fallback;
                        targetUrl = fallbackUrl;
                    }
                }
            }

            this.cookieJar.setAll(result.setCookies, result.finalUrl);
            this.currentUrl = result.finalUrl;

            /*
             * An HTTP error is not a page. Dispatching it anyway meant a 404 —
             * once the .wmlc fallback above had also missed — was routed by
             * content type like any other response, and a "not found" body of
             * text/plain rendered as an empty deck: a blank screen reporting
             * "Done", with nothing to say the fetch had failed.
             *
             * A server that answers an error *with a deck* still gets it
             * rendered, since some WAP gateways report failures that way, but
             * the status is surfaced either way.
             */
            if (result.status >= 400) {
                const errorCt = result.contentType.toLowerCase();
                const renderable = (errorCt.includes('wml') || errorCt.includes('wbxml'))
                    && result.body.length > 0;
                if (!renderable) {
                    this.currentUrl = before;
                    this.ports.post({
                        type: 'error',
                        message: `HTTP ${result.status} — ${result.finalUrl}`,
                    });
                    return;
                }
                this.ports.post({ type: 'status', message: `HTTP ${result.status}` });
            }

            /*
             * A redirect (or the .wmlc fallback) fetched the deck from
             * another URL, by GET: that URL is the deck's, its base for
             * relative links (WML 1.3: 5.3) and the one a Back fetches, with no post
             * data (WML 1.3: 9.2; RFC 9110: 15.4).  The UI only knows the URL it asked
             * for, so it is told.
             */
            const movedTo = result.finalUrl !== requested ? result.finalUrl : undefined;
            this.dispatchContent(result, referringDeck, movedTo);
        } catch (err: unknown) {
            this.currentUrl = before;
            this.ports.post({ type: 'error', message: errorText(err) });
        }
    }

    /** WML 1.3:
     *  - 13.1.2 WML Media Type
     *  - 5.3 Relative URLs
     * WMLScript: 14 CONTENT TYPES
     *
     * Route a fetched resource to the right renderer by content type. */
    private async dispatchContent(result: FetchResult, referringDeck: string, movedTo?: string): Promise<void> {
        const ct = result.contentType.toLowerCase();

        // The charset named by the Content-Type (WML 1.3: 6.1, WBXML 1.3: 5.2)
        const headerCs = charsetFromContentType(result.contentType);
        if (ct.includes('vnd.wap.wmlscript')) {
            // WMLScript: 14 CONTENT TYPES: a unit is known by its content type, whatever
            // its URL (`msg.php#show()`); checked before text/vnd.wap.wml, a
            // prefix of its type.  The UI undoes the deck load and calls the
            // function the fragment names; with none it is a download.
            if (result.finalUrl.includes('#')) {
                this.currentUrl = referringDeck || this.currentUrl;
                this.ports.post({ type: 'scriptContent', url: result.finalUrl });
            } else {
                await this.ports.download(result.body, result.contentType, result.finalUrl);
            }
        } else if (ct.includes('application/vnd.wap.wmlc') || ct.includes('application/vnd.wap.wbxml')) {
            // WBXML binary → decode to WML text
            const wmlText = decodeWbxml(result.body, headerCs);
            if (!this.enforceAccess(wmlText, referringDeck, result.finalUrl)) { return; }
            this.renderWml(wmlText, result.finalUrl, wbxmlCharset(result.body) || headerCs, movedTo);
        } else if (ct.includes('text/vnd.wap.wml') || ct.includes('text/xml') ||
                   result.finalUrl.endsWith('.wml')) {
            const deck = decodeDeck(result.body, headerCs);
            if (!this.enforceAccess(deck.text, referringDeck, result.finalUrl)) { return; }
            this.renderWml(deck.text, result.finalUrl, deck.charset, movedTo);
        } else if (ct.includes('text/html')) {
            // Plain HTML: its text, layout, links and images, never its
            // scripts (bugs.md #126)
            const page = sanitizeMarkup(decodeDeck(result.body, headerCs).text, result.finalUrl);
            this.ports.post({
                type: 'deckContent',
                cardsHtml: `<div class="wml-card" id="html" data-title="HTML" style="display:block">` +
                    `<div style="font-size:12px">${page}</div></div>`,
                firstCardTitle: 'HTML Page',
                fragment: '',
                vars: this.wmlVars,
                movedTo,
            });
        } else if (ct.includes('image/vnd.wap.wbmp') || result.finalUrl.endsWith('.wbmp')) {
            const dataUri = wbmpToDataUri(result.body);
            if (dataUri) {
                this.ports.post({
                    type: 'deckContent',
                    cardsHtml: `<div class="wml-card" id="image" data-title="Image" style="display:block">` +
                        `<img src="${dataUri}" class="wml-img" style="image-rendering:pixelated"></div>`,
                    firstCardTitle: 'WBMP Image',
                    fragment: '',
                    vars: this.wmlVars,
                    movedTo,
                });
            } else {
                this.ports.post({ type: 'error', message: 'Invalid WBMP image' });
            }
        } else {
            // A deck under a type that does not say so — text/plain, as we
            // Accept, octet-stream or none, from servers that don't know .wml
            // — is still shown; anything else is offered as a download.
            const sniffed = sniffDeck(ct, result.body);
            // A version byte is weak evidence, so the binary must decode to a
            // deck as well; anything else stays a download.
            let wmlText = '';
            if (sniffed === 'wbxml') {
                try { wmlText = decodeWbxml(result.body, headerCs); } catch { wmlText = ''; }
            }
            if (/<wml[\s>]/.test(wmlText)) {
                if (!this.enforceAccess(wmlText, referringDeck, result.finalUrl)) { return; }
                this.renderWml(wmlText, result.finalUrl, wbxmlCharset(result.body) || headerCs, movedTo);
            } else if (sniffed === 'text') {
                const deck = decodeDeck(result.body, headerCs);
                if (!this.enforceAccess(deck.text, referringDeck, result.finalUrl)) { return; }
                this.renderWml(deck.text, result.finalUrl, deck.charset, movedTo);
            } else if (isPlainText(ct, result.body)) {
                // Plain text (a .txt, source code, a log): its lines as
                // written, wrapped, under its file name (wap-browser-c's
                // text pages)
                const name = fileName(result.finalUrl) || 'Text';
                const text = plainText(decodeDeck(result.body, headerCs).text);
                this.ports.post({
                    type: 'deckContent',
                    cardsHtml: `<div class="wml-card" id="text" data-title="${escapeHtml(name)}" style="display:block">` +
                        `<pre class="wml-text-page" style="white-space:pre-wrap;word-wrap:break-word;tab-size:4;margin:0">` +
                        `${escapeHtml(text)}</pre></div>`,
                    firstCardTitle: name,
                    fragment: '',
                    vars: this.wmlVars,
                    movedTo,
                });
            } else {
                await this.ports.download(result.body, result.contentType, result.finalUrl);
            }
        }
    }

    /** WSP:
     *  - 7.1.2.3 Method Invocation Facility
     *  - 7.2 Connectionless WSP
     *
     * GET or POST over WSP, picking the connectionless or connection-oriented port. */
    private fetchOverWsp(targetUrl: string, method: string, postBody?: string,
                         extra?: { referer?: string; noCache?: boolean; charset?: string }): Promise<FetchResult> {
        const { gatewayHost, gatewayPort, wspCoPort } = this.settings;
        const hdrs = {
            userAgent: this.ports.userAgent,
            cookie: this.cookieJar.get(targetUrl) || undefined,
            referer: extra && extra.referer || undefined,
            noCache: !!(extra && extra.noCache),
            contentCharsetMib: charsetMib(extra && extra.charset || 'utf-8'),
        };
        // method="post" posts, a body or none (WML 1.3: 9.5.1)
        return method === 'POST'
            ? fetchWspPost(this.ports.datagram, targetUrl, gatewayHost, wspCoPort, postBody || '', hdrs)
            : fetchWspGet(this.ports.datagram, targetUrl, gatewayHost, gatewayPort, hdrs);
    }

    /** GET a resource over the configured transport, attaching cookies. */
    public getResource(u: string): Promise<FetchResult> {
        if (this.settings.transport === 'wsp') {
            return this.fetchOverWsp(u, 'GET');
        }
        return fetchHttp(this.ports.http, u, {
            method: 'GET',
            cookies: this.cookieJar.get(u) || undefined,
            userAgent: this.ports.userAgent,
        });
    }

    /**
     * WML 1.3:
     *  - 11.3.1 The Access Element
     *  - 12.5.5 Task Execution Failure
     *
     * Apply deck access control before rendering a fetched deck. On denial the
     * navigation fails: the user is notified and the invoking deck stays current
     * (WML 1.3: 12.5.5). Returns true when rendering may proceed.
     */
    private enforceAccess(wml: string, referrerUrl: string, destUrl: string): boolean {
        const verdict = checkDeckAccess(wml, referrerUrl, destUrl);
        if (!verdict.allowed) {
            this.currentUrl = referrerUrl;
            this.ports.post({ type: 'error', message: verdict.reason });
            return false;
        }
        return true;
    }

    // WML 1.3: 6.1 Reference Processing Model
    public renderWml(wmlContent: string, baseUrl: string, charset?: string, movedTo?: string): void {
        this.currentWml = wmlContent;
        this.deckCharset = charset || 'utf-8';
        let fragment = '';
        try {
            const parsed = new URL(baseUrl);
            fragment = parsed.hash ? parsed.hash.substring(1) : '';
        } catch { /* no fragment */ }

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

        this.ports.post({
            type: 'deckContent',
            cardsHtml: html,
            firstCardTitle: firstTitle,
            fragment,
            vars: this.wmlVars,
            // $(v:escape) in the deck's charset (WML 1.3: 9.5.1): code point → byte
            // for a single-byte one, null for UTF-8
            charsetMap: charsetByteMap(this.deckCharset),
            movedTo,
        });

        if (this.ports.debug?.isDebugging()) {
            this.ports.debug.onDeckRendered(wmlContent, baseUrl);
        }
    }

    /** WML 1.3: 11.9 Images
     *
     * Fetch an image, converting WBMP to a data URI, and return it to the UI. */
    public async proxyImage(src: string, id: string): Promise<void> {
        try {
            // Resolve root-relative or relative paths against currentUrl
            if (src && !isAbsoluteHttp(src) && this.currentUrl) {
                try { src = new URL(src, this.currentUrl).toString(); } catch { /* keep original */ }
            }

            if (!src || !isAbsoluteHttp(src)) {
                this.ports.post({ type: 'imageProxyResult', id, dataUri: '' });
                return;
            }

            const result = await this.getResource(src);
            const ct = result.contentType.toLowerCase();
            let dataUri = '';

            if (ct.includes('image/vnd.wap.wbmp') || src.toLowerCase().endsWith('.wbmp')) {
                dataUri = wbmpToDataUri(result.body);
            } else if (ct.startsWith('image/')) {
                dataUri = `data:${result.contentType};base64,${result.body.toString('base64')}`;
            } else if (result.body.length > 4 && result.body[0] === 0x00 && result.body[1] === 0x00) {
                // Heuristic: WBMP Type 0 starts with 0x00 0x00 — content-type may be wrong
                const candidate = wbmpToDataUri(result.body);
                if (candidate) { dataUri = candidate; }
            }

            this.ports.post({ type: 'imageProxyResult', id, dataUri });
        } catch {
            this.ports.post({ type: 'imageProxyResult', id, dataUri: '' });
        }
    }

    // ── WMLScript execution ──────────────────────────────────────

    // WMLScript:
    //  - 8.3 WMLScript and URLs
    //  - 8.3.2 Fragment Anchors
    //  - 8.3.4 URL Calls and Parameter Passing
    public async execWmlScript(
        scriptUrl: string, funcName: string, args: WmlsCallArg[],
        clientVars: Record<string, string>, card?: string,
    ): Promise<void> {
        this.currentCardId = card || '';
        // The UI's variables are the browser context (WML 1.3: 10): a
        // variable it no longer has (newcontext) must not come back.
        this.wmlVars = { ...clientVars };

        // Debug path: run under debugger control (source breakpoints / stepping).
        if (this.ports.debug?.isDebugging()) {
            try {
                const { ctx, nav } = this.buildVmContext();
                ctx.baseUrl = scriptUrl.split('#')[0];
                ctx.refererUrl = this.currentUrl;
                const result = await this.ports.debug.runScript(
                    scriptUrl, funcName, convertArgs(args), ctx,
                );
                if (result) {
                    this.applyScriptResult(ctx, nav(), result.error);
                    return;
                }
                this.ports.post({
                    type: 'status',
                    message: 'No WMLScript available to debug — running without breakpoints.',
                });
            } catch (err: unknown) {
                this.ports.post({
                    type: 'wmlscriptResult', vars: this.wmlVars, error: errorText(err),
                });
                return;
            }
            // else: no source / compile error → fall through to a normal run.
        }

        // Normal path: fetch, compile/decode, run on the VM to completion.
        try {
            const { ctx, nav } = this.buildVmContext();
            // Non-debug runs present real Dialogs.* modals; the VM suspends on
            // each dialog and resumes with the user's response (requestDialog).
            ctx.interactiveDialogs = true;
            const result = await this.runUnit(scriptUrl, funcName, convertArgs(args), ctx,
                                              this.currentUrl, 0);
            this.applyScriptResult(ctx, nav(), result.error);
        } catch (err: unknown) {
            this.ports.post({
                type: 'wmlscriptResult', vars: this.wmlVars, error: errorText(err),
            });
        }
    }

    /**
     * WMLScript:
     *  - 6.4.2.2 External Functions
     *  - 12.3.1 Bytecode Errors
     *
     * Load the unit at `unitUrl` (fragment ignored), check its access pragma
     * against `referrer` (the deck of a URL call, or the calling unit), and
     * run `funcName` with `args`.  The unit's external calls run the same
     * way, on a context sharing the browser's variables and navigation, and
     * a failed one is fatal (WMLScript: 12.3.1).
     */
    private async runUnit(unitUrl: string, funcName: string, args: WmlsValue[],
                          ctx: LibraryContext, referrer: string, depth: number): Promise<VMResult> {
        const url = unitUrl.split('#')[0];
        ctx.baseUrl = url;                  // URL.getBase, getCurrentCard (WMLScript Libraries: 10.9)
        ctx.refererUrl = referrer;          // URL.getReferer (WMLScript Libraries: 10.10)
        const fetched = await this.fetchScript(url);
        if (fetched.status >= 400) {
            throw new Error(`WMLScript unit not loaded: ${url} (${fetched.status})`);
        }
        const mod = fetched.isCompiled
            ? decodeWmlsc(fetched.body)
            : decodeWmlsc(compileWmls(decodeDeck(fetched.body, fetched.charset).text));
        const access = checkUnitAccess(mod, referrer, url);
        if (!access.allowed) { throw new Error(access.reason); }
        const vm = new WmlsVM(mod, { context: ctx, maxSteps: 10000000 });
        return vm.callFunctionAsync(
            funcName, args, (req) => this.requestDialog(req),
            async (extUrl, extFunc, extArgs) => {
                if (depth + 1 >= MAX_EXTERNAL_DEPTH) {
                    throw new Error(`External calls nested deeper than ${MAX_EXTERNAL_DEPTH}`);
                }
                let target: string;
                try { target = new URL(extUrl, url).toString(); } catch { target = extUrl; }
                // The callee's own run state (Lang.exit/abort); the browser's
                // variables and navigation are shared
                const sub: LibraryContext = { ...ctx, exitResult: undefined, aborted: undefined };
                const r = await this.runUnit(target, extFunc, extArgs, sub, url, depth + 1);
                if (r.error) { throw new Error(r.error); }
                // Lang.exit in the callee ends the whole script (WMLScript Libraries: 7.11)
                if (sub.exitResult !== undefined) { ctx.exitResult = sub.exitResult; }
                return r.value;
            },
        );
    }

    /** WMLScript:
     *  - 14 CONTENT TYPES
     *  - 7.1.7 Character Set Resolution
     *
     * Fetch a script body for a normal run, with .wmls → .wmlsc 404 fallback. */
    public async fetchScript(scriptUrl: string): Promise<{ body: Buffer; isCompiled: boolean; charset: string; status: number }> {
        let fetchUrl = scriptUrl;
        let result = await this.getResource(fetchUrl);
        if (result.status === 404 && fetchUrl.endsWith('.wmls')) {
            fetchUrl = fetchUrl + 'c';
            result = await this.getResource(fetchUrl);
        }
        const isCompiled = result.contentType.toLowerCase().includes('wmlscriptc') ||
                           fetchUrl.endsWith('.wmlsc');
        // WMLScript source is read in its Content-Type charset (WMLScript: 7.1.7)
        return { body: result.body, isCompiled, charset: charsetFromContentType(result.contentType), status: result.status };
    }

    /**
     * Fetch WMLScript *source* for debugging, preferring the .wmls source variant
     * when only compiled bytecode is referenced. Returns null when no source is
     * available (compiled-only server / fetch failure).
     */
    public async fetchSource(scriptUrl: string): Promise<string | null> {
        const noFrag = scriptUrl.split('#')[0];
        const isCompiled = (r: FetchResult, u: string) =>
            r.contentType.toLowerCase().includes('wmlscriptc') || u.toLowerCase().endsWith('.wmlsc');
        try {
            // Prefer a .wmls source URL (coerce a referenced .wmlsc down to .wmls).
            const srcUrl = noFrag.replace(/\.wmlsc$/i, '.wmls');
            let r = await this.getResource(srcUrl);
            const text = (x: FetchResult) => decodeDeck(x.body, charsetFromContentType(x.contentType)).text;
            if (r.status === 200 && !isCompiled(r, srcUrl)) { return text(r); }
            if (srcUrl !== noFrag) {
                r = await this.getResource(noFrag);
                if (r.status === 200 && !isCompiled(r, noFrag)) { return text(r); }
            }
            return null;
        } catch {
            return null;
        }
    }

    /**
     * WMLScript Libraries:
     *  - 10.9 getBase
     *  - 10.10 getReferer
     *  - 11.6 getCurrentCard
     *
     * Build the VM library context bound to the browser's WML variables +
     * navigation.  The last go() or prev() stays in effect, go("") cancels
     * both (WMLScript Libraries: 11.3-11.4); newContext() clears the variables and,
     * when the script ends, the history, and makes a previous or later
     * prev() do nothing (WMLScript Libraries: 11.5).
     */
    public buildVmContext(): {
        ctx: LibraryContext;
        nav: () => ScriptNav;
    } {
        let goUrl: string | undefined;
        let doPrev = false;
        let doRefresh = false;
        let newContext = false;
        const deck = this.currentUrl.split('#')[0];
        const ctx: LibraryContext = {
            wmlVariables: new Map(Object.entries(this.wmlVars)),
            wmlVars: { ...this.wmlVars },
            currentCard: deck && (this.currentCardId ? deck + '#' + this.currentCardId : deck),
            onSetVar: (name, value) => { this.wmlVars[name] = value; },
            onGo: (u) => { goUrl = u; doPrev = false; },
            onPrev: () => { if (!newContext) { doPrev = true; goUrl = undefined; } },
            onNewContext: () => { newContext = true; doPrev = false; this.wmlVars = {}; },
            onRefresh: () => { doRefresh = true; },
            onOutput: () => { /* discarded for non-debug; the debug adapter overrides this */ },
        };
        return { ctx, nav: () => ({ goUrl, doPrev, doRefresh, newContext }) };
    }

    /**
     * Show a WMLScript Dialogs.* modal in the UI and resolve with the user's
     * response. Posts a 'dialog' message keyed by requestId; the UI replies with
     * resolveDialog(), which resolves the promise.
     */
    public requestDialog(req: DialogRequest): Promise<string | boolean | null> {
        return new Promise((resolve) => {
            const requestId = ++this.dialogSeq;
            this.pendingDialogs.set(requestId, resolve);
            this.ports.post({
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

    /** The UI answered a Dialogs.* modal — resume the suspended VM. */
    public resolveDialog(requestId: number, result: string | boolean | null): void {
        const resolver = this.pendingDialogs.get(requestId);
        if (resolver) {
            this.pendingDialogs.delete(requestId);
            resolver(result);
        }
    }

    /** WMLScript Libraries:
     *  - 11.3 go
     *  - 11.4 prev
     *  - 11.5 newContext
     *
     * Sync variables changed by the script back to wmlVars and notify the UI. */
    public applyScriptResult(
        ctx: LibraryContext,
        nav: ScriptNav,
        error?: string,
    ): void {
        for (const [key, val] of ctx.wmlVariables) { this.wmlVars[key] = val; }
        for (const key of Object.keys(ctx.wmlVars)) { this.wmlVars[key] = ctx.wmlVars[key]; }
        // A fatal error (Lang.abort too) cancels the pending go() or prev()
        // (WMLScript Libraries: 11.3, WMLScript: 12.3); what the script set stays
        this.ports.post({
            type: 'wmlscriptResult',
            vars: this.wmlVars,
            newContext: nav.newContext || undefined,
            goUrl: error ? undefined : nav.goUrl,
            doPrev: !error && nav.doPrev,
            doRefresh: !error && nav.doRefresh,
            error,
        });
    }

    // ── UI-driven state ──────────────────────────────────────────

    public clearCookies(): number {
        return this.cookieJar.clear();
    }

    public updateSettings(patch: Partial<BrowserSettings>): BrowserSettings {
        this.settings = { ...this.settings, ...patch };
        return this.settings;
    }

    public clearHistory(): void {
        this.history = [];
    }
}

// ── Helpers ──────────────────────────────────────────────────────

function errorText(err: unknown): string {
    if (err instanceof Error) { return err.message; }
    return String(err);
}

function isAbsoluteHttp(u: string): boolean {
    const lower = u.toLowerCase();
    return lower.startsWith('http://') || lower.startsWith('https://');
}

/**
 * WML 1.3: 9.5.1 The Go Element: form submission: URI-escape (RFC2396, lowercase %xx,
 * unreserved set preserved) field names and values, each character encoded
 * in `charset` first (default UTF-8; a character it lacks goes as '?').
 * Before, characters up to U+00FF went as Latin-1 and the rest as UTF-8,
 * which no server reads back right.
 */
export function escapeFormField(s: string, charset: string = 'utf-8'): string {
    return percentEncode(s, charset);
}

/** WML 1.3: 9.5.1 The Go Element
 *
 * The charset a <go accept-charset="..."> list asks for: its first known
 *  name (comma- or space-separated), else the deck's ("unknown" too). */
export function goCharset(acceptCharset: string | undefined, deckCharset: string): string {
    const names = String(acceptCharset || '').split(/[\s,]+/);
    for (let i = 0; i < names.length; i++) {
        const cs = charsetByName(names[i]);
        if (cs) { return cs; }
    }
    return deckCharset || 'utf-8';
}

/**
 * WML 1.3: 13.1.2 WML Media Type
 * WBXML 1.3: 5.4 Version Number
 *
 * Is a reply of a non-WAP content type a deck? wap-browser-c's reply_is_deck:
 * never for media, else WBXML (a version byte 0-3) or text whose first element,
 * after a BOM and the prolog (<?xml?>, <!DOCTYPE>, comments), is <wml>.
 * dispatchContent asks only after the WBMP check, whose 0x00 type byte this
 * WBXML test would pass.
 */
export function sniffDeck(contentType: string, body: Buffer): 'wbxml' | 'text' | null {
    if (/^(image|audio|video)\//.test(contentType)) { return null; }
    const n = body.length;
    if (n >= 4 && body[0] <= WBXML_VERSION) { return 'wbxml'; }   // 1.0-1.3
    let i = (n >= 3 && body[0] === 0xEF && body[1] === 0xBB && body[2] === 0xBF) ? 3 : 0;
    while (i < n && i < 1024) {
        const c = body[i];
        if (c === 0x20 || (c >= 0x09 && c <= 0x0D)) { i++; continue; }
        if (c !== 0x3C || i + 1 >= n) { return null; }               // '<'
        if (body[i + 1] !== 0x3F && body[i + 1] !== 0x21) {          // not '?' or '!'
            return n - i >= 4 && body.toString('latin1', i + 1, i + 4) === 'wml' ? 'text' : null;
        }
        while (i < n && body[i] !== 0x3E) { i++; }                    // past '>'
        i++;
    }
    return null;
}

/**
 * Is a reply that is not a deck plain text?  As wap-browser-c's
 * reply_is_text: its type is none, a text one (text/plain, a source file's
 * text/x-csrc), octet-stream (a log or a file with no extension from a
 * server that does not know the name), JSON or JavaScript, never HTML, and
 * its first 512 bytes hold no NUL or other control byte but white space
 * and ESC (a log's colours).  Any other type (a PDF, a font, an archive)
 * is a download, however its first bytes look.
 */
export function isPlainText(contentType: string, body: Buffer): boolean {
    if (/html/.test(contentType) ||
        (contentType && !/text\/|octet-stream|json|javascript/.test(contentType))) { return false; }
    for (let i = 0; i < body.length && i < 512; i++) {
        const c = body[i];
        if (c < 0x20 && (c < 0x09 || c > 0x0D) && c !== 0x1B) { return false; }
    }
    return true;
}

/**
 * ECMA-48: 5.4 Control sequences
 *
 * A text page's text as wap-browser-c shows it: a terminal control
 * sequence (ESC [ ... final byte, a log's colours) dropped, any other
 * control character but a tab or line end a space.
 */
export function plainText(text: string): string {
    return text.replace(/\x1b\[[\x20-\x3f]*[\x40-\x7e]?/g, '')
        .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, ' ');
}

/** The last path segment of a URL (no query or fragment), '' if none. */
function fileName(u: string): string {
    try {
        const p = new URL(u).pathname;
        return decodeURIComponent(p.slice(p.lastIndexOf('/') + 1));
    } catch { return ''; }
}

/** WBXML 1.3: 5.6 Charset
 *
 * The charset field of a WBXML document, '' when 0 / unknown (WBXML 1.3: 5.6). */
function wbxmlCharset(b: Buffer): string {
    let p = 1;
    const mb = () => {
        let v = 0, c = 0;
        do { c = p < b.length ? b[p++] : 0; v = v * 128 + (c & MB_UINT_BITS); } while (c & MB_UINT_MORE);
        return v;
    };
    if (mb() === 0) { mb(); }            // public id 0: a string table index
    return charsetByMib(mb());
}

/** Compiled-variant fallback for a 404: .wml → .wmlc, .wmls → .wmlsc. */
export function getFallbackUrl(targetUrl: string): string | undefined {
    const noHash = targetUrl.split('#')[0];
    if (noHash.endsWith('.wml')) { return noHash + 'c'; }
    if (noHash.endsWith('.wmls')) { return noHash + 'c'; }
    return undefined;
}

/**
 * WMLScript: 8.3.4 URL Calls and Parameter Passing
 *
 * Convert parsed WMLScript call args to typed WmlsValues. Per WMLScript: 8.3.4
 * a quoted token ('...'/"...") is passed as a String; only unquoted tokens are
 * coerced to boolean / number / invalid by their literal form. Accepts both the
 * structured { value, quoted } tokens emitted by parseWmlScriptArgs and bare
 * strings (treated as unquoted) for safety.
 */
export function convertArgs(args: WmlsCallArg[]): WmlsValue[] {
    return args.map(a => {
        const quoted = typeof a === 'object' && a !== null && !!a.quoted;
        const s = typeof a === 'object' && a !== null ? a.value : a;
        if (quoted) { return mkString(s); }
        if (s === 'true') { return mkBool(true); }
        if (s === 'false') { return mkBool(false); }
        if (s === 'invalid') { return mkInvalid(); }
        // A number by the literal grammar (WMLScript: 8.3.3, decimal only), an
        // integer past 32 bits a float; anything else stays a string
        // (lenient: the spec fails the call)
        const n = strNum(s);
        return n.type === WmlsType.Invalid ? mkString(s) : n;
    });
}

/** Render a deck's cards to HTML, resolving image srcs against the deck URL. */
export function renderCardsHtml(
    wmlContent: string, baseUrl: string,
): { html: string; cards: WmlCard[]; firstTitle: string } {
    const resolveImage: ImageResolver = (src) => {
        if (!src || src.startsWith('data:')) { return escapeHtml(src); }
        try { return escapeHtml(new URL(src, baseUrl).toString()); } catch { return escapeHtml(src); }
    };
    const { parts, cards, firstTitle } = renderCards(wmlContent, resolveImage);
    // A deck's own markup passes through the transform (bugs.md #126)
    return { html: sanitizeMarkup(parts.join('\n')), cards, firstTitle };
}
