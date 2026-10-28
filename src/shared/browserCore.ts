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
import { compileWmls } from '../wmlsc/compiler';
import { decodeWmlsc } from '../wmlsc/decoder';
import { WmlsVM } from '../wmlsc/vm';
import {
    LibraryContext,
    mkString, mkInt, mkFloat, mkBool, mkInvalid,
    WmlsValue, DialogRequest,
} from '../wmlsc/stdlib';
import { WmlCard, escapeHtml, renderCards, ImageResolver } from '../wmlTransform';
import {
    charsetByMib, charsetByName, charsetByteMap, charsetFromContentType, decodeDeck, percentEncode,
} from './charset';
import { wbmpToDataUri } from './wbmpUtils';
import { checkDeckAccess } from './deckAccess';
import { CookieJar } from './cookieJar';
import { FetchResult } from './wapProtocol';
import { HttpTransport, fetchHttp } from './httpClient';
import { DatagramFactory, fetchWspGet, fetchWspPost } from './wspClient';

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
 * ('...'/"...") whose type must stay String per WMLScript §8.3.4; a bare string
 * (legacy / unquoted) is coerced by its literal form. Produced by
 * parseWmlScriptArgs in src/shared/wml-engine.js and forwarded by the UI.
 */
export type WmlsCallArg = string | { value: string; quoted: boolean };

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
    public currentWml = '';
    /** Charset the current deck came in: the default for text sent back (§9.5.1). */
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

    public async navigate(
        targetUrl: string,
        postfields?: { name: string; value: string }[],
        method: string = 'get',
        referer?: string,
        fromDeck?: string,
        acceptCharset?: string,
    ): Promise<void> {
        // The deck we are navigating away from — used for deck access control.
        const referringDeck = fromDeck || '';
        try {
            const { transport } = this.settings;

            let result: FetchResult;
            let postBody: string | undefined;
            const httpMethod = method.toUpperCase();

            if (postfields && postfields.length > 0) {
                // §9.5.1: in the first known charset of accept-charset, else
                // the one the deck came in
                const cs = goCharset(acceptCharset, this.deckCharset);
                const encoded = postfields.map((pf) =>
                    escapeFormField(String(pf.name), cs) + '=' + escapeFormField(String(pf.value), cs)
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
                result = await this.fetchOverWsp(targetUrl, httpMethod, postBody);

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
                    this.ports.post({
                        type: 'error',
                        message: `HTTP ${result.status} — ${result.finalUrl}`,
                    });
                    return;
                }
                this.ports.post({ type: 'status', message: `HTTP ${result.status}` });
            }

            this.dispatchContent(result, referringDeck);
        } catch (err: unknown) {
            this.ports.post({ type: 'error', message: errorText(err) });
        }
    }

    /** Route a fetched resource to the right renderer by content type. */
    private async dispatchContent(result: FetchResult, referringDeck: string): Promise<void> {
        const ct = result.contentType.toLowerCase();

        // The charset named by the Content-Type (WML 1.3 §6.1, WBXML §5.2)
        const headerCs = charsetFromContentType(result.contentType);
        if (ct.includes('application/vnd.wap.wmlc') || ct.includes('application/vnd.wap.wbxml')) {
            // WBXML binary → decode to WML text
            const wmlText = decodeWbxml(result.body, headerCs);
            if (!this.enforceAccess(wmlText, referringDeck, result.finalUrl)) { return; }
            this.renderWml(wmlText, result.finalUrl, wbxmlCharset(result.body) || headerCs);
        } else if (ct.includes('text/vnd.wap.wml') || ct.includes('text/xml') ||
                   result.finalUrl.endsWith('.wml')) {
            const deck = decodeDeck(result.body, headerCs);
            if (!this.enforceAccess(deck.text, referringDeck, result.finalUrl)) { return; }
            this.renderWml(deck.text, result.finalUrl, deck.charset);
        } else if (ct.includes('text/html')) {
            // Plain HTML — show as-is
            this.ports.post({
                type: 'deckContent',
                cardsHtml: `<div class="wml-card" id="html" data-title="HTML" style="display:block">` +
                    `<div style="font-size:12px">${decodeDeck(result.body, headerCs).text}</div></div>`,
                firstCardTitle: 'HTML Page',
                fragment: '',
                vars: this.wmlVars,
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
                });
            } else {
                this.ports.post({ type: 'error', message: 'Invalid WBMP image' });
            }
        } else {
            // Unsupported content type — offer as a download
            await this.ports.download(result.body, result.contentType, result.finalUrl);
        }
    }

    /** GET or POST over WSP, picking the connectionless or connection-oriented port. */
    private fetchOverWsp(targetUrl: string, method: string, postBody?: string): Promise<FetchResult> {
        const { gatewayHost, gatewayPort, wspCoPort } = this.settings;
        const hdrs = {
            userAgent: this.ports.userAgent,
            cookie: this.cookieJar.get(targetUrl) || undefined,
        };
        return method === 'POST' && postBody
            ? fetchWspPost(this.ports.datagram, targetUrl, gatewayHost, wspCoPort, postBody, hdrs)
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
     * Apply deck access control before rendering a fetched deck. On denial the
     * navigation fails: the user is notified and the invoking deck stays current
     * (WAP-191 §12.5.5). Returns true when rendering may proceed.
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

    public renderWml(wmlContent: string, baseUrl: string, charset?: string): void {
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
            // $(v:escape) in the deck's charset (§9.5.1): code point → byte
            // for a single-byte one, null for UTF-8
            charsetMap: charsetByteMap(this.deckCharset),
        });

        if (this.ports.debug?.isDebugging()) {
            this.ports.debug.onDeckRendered(wmlContent, baseUrl);
        }
    }

    /** Fetch an image, converting WBMP to a data URI, and return it to the UI. */
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

    public async execWmlScript(
        scriptUrl: string, funcName: string, args: WmlsCallArg[],
        clientVars: Record<string, string>,
    ): Promise<void> {
        // Merge client vars from the deck.
        this.wmlVars = { ...this.wmlVars, ...clientVars };

        // Debug path: run under debugger control (source breakpoints / stepping).
        if (this.ports.debug?.isDebugging()) {
            try {
                const { ctx, nav } = this.buildVmContext();
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
            const fetched = await this.fetchScript(scriptUrl);
            const mod = fetched.isCompiled
                ? decodeWmlsc(fetched.body)
                : decodeWmlsc(compileWmls(decodeDeck(fetched.body, fetched.charset).text));
            const { ctx, nav } = this.buildVmContext();
            // Non-debug runs present real Dialogs.* modals; the VM suspends on
            // each dialog and resumes with the user's response (requestDialog).
            ctx.interactiveDialogs = true;
            const vm = new WmlsVM(mod, { context: ctx, maxSteps: 10000000 });
            const result = await vm.callFunctionAsync(
                funcName, convertArgs(args), (req) => this.requestDialog(req),
            );
            this.applyScriptResult(ctx, nav(), result.error);
        } catch (err: unknown) {
            this.ports.post({
                type: 'wmlscriptResult', vars: this.wmlVars, error: errorText(err),
            });
        }
    }

    /** Fetch a script body for a normal run, with .wmls → .wmlsc 404 fallback. */
    public async fetchScript(scriptUrl: string): Promise<{ body: Buffer; isCompiled: boolean; charset: string }> {
        let fetchUrl = scriptUrl;
        let result = await this.getResource(fetchUrl);
        if (result.status === 404 && fetchUrl.endsWith('.wmls')) {
            fetchUrl = fetchUrl + 'c';
            result = await this.getResource(fetchUrl);
        }
        const isCompiled = result.contentType.toLowerCase().includes('wmlscriptc') ||
                           fetchUrl.endsWith('.wmlsc');
        // WMLScript source is read in its Content-Type charset (WAP-193 §7.1.7)
        return { body: result.body, isCompiled, charset: charsetFromContentType(result.contentType) };
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

    /** Build the VM library context bound to the browser's WML variables + navigation. */
    public buildVmContext(): {
        ctx: LibraryContext;
        nav: () => { goUrl?: string; doPrev: boolean; doRefresh: boolean };
    } {
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

    /** Sync variables changed by the script back to wmlVars and notify the UI. */
    public applyScriptResult(
        ctx: LibraryContext,
        nav: { goUrl?: string; doPrev: boolean; doRefresh: boolean },
        error?: string,
    ): void {
        for (const [key, val] of ctx.wmlVariables) { this.wmlVars[key] = val; }
        for (const key of Object.keys(ctx.wmlVars)) { this.wmlVars[key] = ctx.wmlVars[key]; }
        this.ports.post({
            type: 'wmlscriptResult',
            vars: this.wmlVars,
            goUrl: nav.goUrl,
            doPrev: nav.doPrev,
            doRefresh: nav.doRefresh,
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
 * WML 1.3 §9.5.1 form submission: URI-escape (RFC2396, lowercase %xx,
 * unreserved set preserved) field names and values, each character encoded
 * in `charset` first (default UTF-8; a character it lacks goes as '?').
 * Before, characters up to U+00FF went as Latin-1 and the rest as UTF-8,
 * which no server reads back right.
 */
export function escapeFormField(s: string, charset: string = 'utf-8'): string {
    return percentEncode(s, charset);
}

/** The charset a <go accept-charset="..."> list asks for: its first known
 *  name (comma- or space-separated), else the deck's ("unknown" too). */
export function goCharset(acceptCharset: string | undefined, deckCharset: string): string {
    const names = String(acceptCharset || '').split(/[\s,]+/);
    for (let i = 0; i < names.length; i++) {
        const cs = charsetByName(names[i]);
        if (cs) { return cs; }
    }
    return deckCharset || 'utf-8';
}

/** The charset field of a WBXML document, '' when 0 / unknown (§5.6). */
function wbxmlCharset(b: Buffer): string {
    let p = 1;
    const mb = () => {
        let v = 0, c = 0;
        do { c = p < b.length ? b[p++] : 0; v = v * 128 + (c & 0x7F); } while (c & 0x80);
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
 * Convert parsed WMLScript call args to typed WmlsValues. Per WMLScript §8.3.4
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
        const n = Number(s);
        if (!isNaN(n) && s.length > 0) {
            return Number.isInteger(n) ? mkInt(n) : mkFloat(n);
        }
        return mkString(s);
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
    return { html: parts.join('\n'), cards, firstTitle };
}
