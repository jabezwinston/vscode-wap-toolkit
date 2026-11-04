/**
 *  Copyright (C) 2026 Jabez Winston
 *
 *  SPDX-License-Identifier: Apache-2.0
 *
 *  Date : 30-October-2026
 *
 *  The markup a server sends is put into the browser's own page (innerHTML),
 *  beside the host's bridge (VS Code's webview API, Android's WapNative).
 *  A deck's `<b onclick>` or `<svg onload>`, which the WML transform passes
 *  through, or an HTML reply's scripts, ran there (wap-browser-c bugs.md
 *  #126).  So the markup is rebuilt: an allowed element keeps its allowed
 *  attributes, the rest is dropped (script and its kind with their content),
 *  and text is escaped.  What comes out is only what this builds, so it does
 *  not depend on parsing HTML the way a browser does.
 */

import { escapeHtml, escapeHtmlKeepRefs, decodeEntities } from './htmlUtils';

function setOf(names: string): { [name: string]: true } {
    const set: { [name: string]: true } = {};
    names.split(' ').forEach((n) => { set[n] = true; });
    return set;
}

// The WML transform's output and HTML's text and layout elements
const TAGS = setOf(
    'div p br span a b i u em strong big small pre img table tr td th thead tbody ' +
    'tfoot caption button input select option optgroup fieldset legend label ' +
    'h1 h2 h3 h4 h5 h6 ul ol li dl dt dd blockquote hr code tt kbd samp var s ' +
    'strike del ins sub sup center font abbr cite q dfn mark section article nav ' +
    'header footer main aside figure figcaption address');

// Dropped with everything in them
const DROP = setOf(
    'script style title template iframe frame frameset object embed applet svg ' +
    'math noembed noframes xmp textarea');

// Never a URL (src on img only, resolved); no event handlers
const ATTRS = setOf(
    'class id style title alt width height align valign colspan rowspan name ' +
    'value type maxlength size placeholder pattern required multiple selected ' +
    'checked disabled label tabindex border cellpadding cellspacing start lang ' +
    'dir color xml:lang');

/* A tag, comment or declaration.  Quoted attribute values may hold ">" */
const TOKEN = /<!--[\s\S]*?(?:-->|$)|<![\s\S]*?(?:>|$)|<\?[\s\S]*?(?:>|$)|<\/([A-Za-z][^\s\/>]*)[^>]*>|<([A-Za-z][^\s\/>]*)((?:[^>"']|"[^"]*"|'[^']*')*)>/g;
const ATTR = /([^\s"'>\/=]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+)))?/g;

/* An http(s) or data:image URL, absolute against base; null otherwise */
function safeUrl(raw: string, base: string | undefined, image: boolean): string | null {
    let u = decodeEntities(raw).trim();
    try { u = base ? new URL(u, base).toString() : u; } catch { return null; }
    if (/^https?:/i.test(u) || (image && /^data:image\//i.test(u))) { return u; }
    // No base: a relative link resolves in the page's own navigation
    return !base && !/^[A-Za-z][A-Za-z0-9+.-]*:/.test(u) && !/^\/\//.test(u) ? u : null;
}

function buildTag(name: string, attrs: string, base: string | undefined): string {
    let out = '<' + name;
    let hasHref = false;
    let link: string | null = null;
    ATTR.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = ATTR.exec(attrs)) !== null) {
        const key = m[1].toLowerCase();
        const raw = m[2] !== undefined ? m[2] : m[3] !== undefined ? m[3] : m[4];
        const value = raw === undefined ? '' : raw;
        if (key === 'src') {
            if (name !== 'img') { continue; }
            const u = safeUrl(value, base, true);
            if (u !== null) { out += ' src="' + escapeHtml(u) + '"'; }
            continue;
        }
        if (key === 'href') {
            if (name !== 'a') { continue; }
            // A page's own fragment scrolls it, as it did; not a card
            if (/^#[^"]*$/.test(decodeEntities(value).trim())) {
                out += ' href="' + escapeHtml(decodeEntities(value).trim()) + '"';
            } else {
                link = safeUrl(value, base, false);
            }
            continue;
        }
        if (key === 'data-href') { hasHref = true; }
        if (key === 'name' && name === 'img') { continue; }   // document.<name>
        if (!ATTRS[key] && !/^data-[a-z0-9_.-]+$/.test(key)) { continue; }
        out += ' ' + key + (raw === undefined ? '' : '="' + value.replace(/"/g, '&quot;') + '"');
    }
    // An HTML page's link is followed by the browser, as a deck's is
    if (link !== null && !hasHref) {
        out += ' data-href="' + escapeHtml(link) + '"';
    }
    return out + '>';
}

/**
 * Rebuild server markup for innerHTML.  `base` resolves an HTML page's
 * links and images; a deck's are resolved by the transform already.
 */
export function sanitizeMarkup(html: string, base?: string): string {
    let out = '';
    let at = 0;
    let skip = '';                      // inside a DROP element
    TOKEN.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = TOKEN.exec(html)) !== null) {
        if (!skip) { out += escapeHtmlKeepRefs(html.substring(at, m.index)); }
        at = TOKEN.lastIndex;
        const end = m[1] ? m[1].toLowerCase() : '';
        const start = m[2] ? m[2].toLowerCase() : '';
        if (skip) {
            if (end === skip) { skip = ''; }
        } else if (end) {
            if (TAGS[end]) { out += '</' + end + '>'; }
        } else if (start) {
            if (DROP[start]) {
                if (!/\/\s*$/.test(m[3])) { skip = start; }
            } else if (TAGS[start]) {
                out += buildTag(start, m[3], base);
            }
        }
    }
    if (!skip) { out += escapeHtmlKeepRefs(html.substring(at)); }
    return out;
}
