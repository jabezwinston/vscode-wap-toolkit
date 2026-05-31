/**
 *  Copyright (C) 2026 Jabez Winston
 *
 *  SPDX-License-Identifier: Apache-2.0
 * 
 *  Date : 09-April-2026
 *
 *  Shared WML-to-HTML transformation utilities used by both the
 *  local preview renderer (wmlToHtml.ts) and the WAP browser panel
 *  (browserPanel.ts).
 */

import { parseWmlFormatMask, resolveEmptyOk } from './wmlValidator';
import { escapeHtml } from './shared/htmlUtils';

// Re-export so existing consumers that import escapeHtml from here continue to work.
export { escapeHtml };

// ── Types ────────────────────────────────────────────────────────

export interface WmlCard {
    id: string;
    title: string;
    body: string;
    ontimer?: string;
    onenterforward?: string;
    onenterbackward?: string;
    newcontext?: boolean;
}

export interface TemplateInfo {
    doElements: Array<{ raw: string; name?: string; type?: string }>;
    oneventElements: Array<{ raw: string; type: string }>;
    onenterforward?: string;
    onenterbackward?: string;
    ontimer?: string;
}

/**
 * Callback that resolves an image `src` attribute to a value suitable
 * for the HTML output.  The preview uses local file-system resolution
 * while the browser panel resolves against a base URL.
 */
export type ImageResolver = (src: string) => string;

// ── Attribute / HTML helpers ─────────────────────────────────────

export function getAttr(attrs: string, name: string): string | undefined {
    const regex = new RegExp(`(?:^|\\s)${name}\\s*=\\s*"([^"]*)"`, 'i');
    const match = attrs.match(regex);
    return match ? match[1] : undefined;
}

// ── Setvar / Postfield extraction ────────────────────────────────

function extractNameValuePairs(content: string, tagName: string): Array<{name: string, value: string}> {
    const items: Array<{name: string, value: string}> = [];
    const regex = new RegExp(`<${tagName}\\s+name="([^"]*)"\\s+value="([^"]*)"\\s*\\/>`, 'gi');
    let m;
    while ((m = regex.exec(content)) !== null) {
        items.push({name: m[1], value: m[2]});
    }
    return items;
}

export function extractSetvars(content: string): Array<{name: string, value: string}> {
    return extractNameValuePairs(content, 'setvar');
}

export function setvarsToAttr(setvars: Array<{name: string, value: string}>): string {
    if (setvars.length === 0) { return ''; }
    return ` data-setvars="${escapeHtml(JSON.stringify(setvars))}"`;
}

export function extractPostfields(content: string): Array<{name: string, value: string}> {
    return extractNameValuePairs(content, 'postfield');
}

export function postfieldsToAttr(postfields: Array<{name: string, value: string}>): string {
    if (postfields.length === 0) { return ''; }
    return ` data-postfields="${escapeHtml(JSON.stringify(postfields))}"`;
}

export function methodToAttr(attrs: string): string {
    const method = getAttr(attrs, 'method');
    if (!method) { return ''; }
    return ` data-method="${escapeHtml(method)}"`;
}

/** Emit data-sendreferer when a <go sendreferer="true"> requests it (WAP-191 §9.5.1). */
export function sendrefererToAttr(attrs: string): string {
    return getAttr(attrs, 'sendreferer') === 'true' ? ' data-sendreferer="true"' : '';
}

// ── WML format mask helpers ──────────────────────────────────────

export function wmlFormatToPattern(format: string): string {
    if (!format) { return ''; }
    const parsed = parseWmlFormatMask(format);
    if (!parsed.valid) { return ''; }

    const codeToRegex: Record<string, string> = {
        'A': '[A-Z\\p{P}\\p{S}]',
        'a': '[a-z\\p{P}\\p{S}]',
        'N': '[0-9]',
        'n': '[0-9\\p{P}\\p{S}]',
        'X': '[A-Z0-9\\p{P}\\p{S}]',
        'x': '[a-z0-9\\p{P}\\p{S}]',
        'M': '[\\s\\S]',
        'm': '[\\s\\S]',
    };

    let pattern = '';
    let i = 0;
    while (i < format.length) {
        const ch = format[i];
        if (ch === '\\') {
            if (i + 1 < format.length) {
                pattern += format[i + 1].replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
            }
            i += 2;
            continue;
        }
        if (ch === '*') {
            const code = format[i + 1];
            pattern += (codeToRegex[code] || '.') + '*';
            i += 2;
            continue;
        }
        let count = '';
        while (i < format.length && format[i] >= '0' && format[i] <= '9') {
            count += format[i];
            i++;
        }
        if (i < format.length && codeToRegex[format[i]]) {
            const n = count ? parseInt(count, 10) : 1;
            pattern += (codeToRegex[format[i]] || '.') + `{${n}}`;
            i++;
        } else {
            i++;
        }
    }
    return pattern;
}

export function wmlFormatMaxLength(format: string): number {
    if (!format) { return 0; }
    const parsed = parseWmlFormatMask(format);
    if (!parsed.valid || parsed.maxChars === Infinity) { return 0; }
    return parsed.maxChars;
}

// ── Card / Template parsing ──────────────────────────────────────

export function parseCards(wml: string): WmlCard[] {
    const cards: WmlCard[] = [];
    const cardRegex = /<card\s+([^>]*)>([\s\S]*?)<\/card>/gi;
    let match;

    while ((match = cardRegex.exec(wml)) !== null) {
        const attrs = match[1];
        const body = match[2];
        const id = getAttr(attrs, 'id') || `card${cards.length}`;
        const title = getAttr(attrs, 'title') || id;
        const ontimer = getAttr(attrs, 'ontimer');
        const onenterforward = getAttr(attrs, 'onenterforward');
        const onenterbackward = getAttr(attrs, 'onenterbackward');
        const newcontext = getAttr(attrs, 'newcontext') === 'true';

        cards.push({ id, title, body, ontimer, onenterforward, onenterbackward, newcontext });
    }

    return cards;
}

export function parseTemplateInfo(wml: string): TemplateInfo {
    const templateMatch = wml.match(/<template([^>]*)>([\s\S]*?)<\/template>/i);
    if (!templateMatch) {
        return { doElements: [], oneventElements: [] };
    }
    const templateAttrs = templateMatch[1] || '';
    const templateBody = templateMatch[2];
    const result: TemplateInfo = {
        doElements: [],
        oneventElements: [],
        onenterforward: getAttr(templateAttrs, 'onenterforward'),
        onenterbackward: getAttr(templateAttrs, 'onenterbackward'),
        ontimer: getAttr(templateAttrs, 'ontimer'),
    };
    const doRegex = /<do\s+([^>]*)>[\s\S]*?<\/do>/gi;
    let m;
    while ((m = doRegex.exec(templateBody)) !== null) {
        result.doElements.push({ raw: m[0], name: getAttr(m[1], 'name'), type: getAttr(m[1], 'type') });
    }
    const eventRegex = /<onevent\s+([^>]*)>[\s\S]*?<\/onevent>/gi;
    while ((m = eventRegex.exec(templateBody)) !== null) {
        const type = getAttr(m[1], 'type');
        if (type) { result.oneventElements.push({ raw: m[0], type }); }
    }
    return result;
}

export function mergeTemplate(cardBody: string, card: WmlCard, tmpl: TemplateInfo): { body: string; card: WmlCard } {
    if (tmpl.doElements.length === 0 && tmpl.oneventElements.length === 0 &&
        !tmpl.onenterforward && !tmpl.onenterbackward && !tmpl.ontimer) {
        return { body: cardBody, card };
    }
    const cardDoNames = new Set<string>();
    const cardDoTypes = new Set<string>();
    const doRegex = /<do\s+([^>]*)>/gi;
    let m;
    while ((m = doRegex.exec(cardBody)) !== null) {
        const name = getAttr(m[1], 'name');
        const type = getAttr(m[1], 'type');
        if (name) { cardDoNames.add(name); }
        if (type) { cardDoTypes.add(type); }
    }
    const cardEventTypes = new Set<string>();
    const eventRegex = /<onevent\s+[^>]*type="([^"]*)"/gi;
    while ((m = eventRegex.exec(cardBody)) !== null) { cardEventTypes.add(m[1]); }
    let appended = '';
    for (const tdo of tmpl.doElements) {
        if (tdo.name && cardDoNames.has(tdo.name)) { continue; }
        if (!tdo.name && tdo.type && cardDoTypes.has(tdo.type)) { continue; }
        appended += tdo.raw;
    }
    for (const tev of tmpl.oneventElements) {
        if (cardEventTypes.has(tev.type)) { continue; }
        appended += tev.raw;
    }
    const updatedCard = { ...card };
    if (!updatedCard.onenterforward && tmpl.onenterforward) { updatedCard.onenterforward = tmpl.onenterforward; }
    if (!updatedCard.onenterbackward && tmpl.onenterbackward) { updatedCard.onenterbackward = tmpl.onenterbackward; }
    if (!updatedCard.ontimer && tmpl.ontimer) { updatedCard.ontimer = tmpl.ontimer; }
    return { body: cardBody + appended, card: updatedCard };
}

// ── Main WML body → HTML transformation ──────────────────────────

export function transformWmlBody(body: string, resolveImage: ImageResolver): string {
    let html = body;

    // Process onevent elements (convert to data attributes)
    // onevent with go task - extract setvars and postfields from inside go
    html = html.replace(/<onevent\s+type="([^"]*)">[\s\S]*?<go\s+([^>]*?)href="([^"]*)"([^>]*?)(?:\/>|>([\s\S]*?)<\/go>)[\s\S]*?<\/onevent>/gi,
        (_, type, preGoAttrs, href, postGoAttrs, goContent) => {
            const goAttrs = (preGoAttrs || '') + 'href="' + href + '"' + (postGoAttrs || '');
            const setvars = goContent ? extractSetvars(goContent) : [];
            const postfields = goContent ? extractPostfields(goContent) : [];
            return `<div class="wml-onevent" data-type="${escapeHtml(type)}" data-href="${escapeHtml(href)}"${methodToAttr(goAttrs)}${sendrefererToAttr(goAttrs)}${setvarsToAttr(setvars)}${postfieldsToAttr(postfields)} style="display:none"></div>`;
        });

    // onevent with refresh task - extract setvars
    html = html.replace(/<onevent\s+type="([^"]*)">([\s\S]*?)<refresh>([\s\S]*?)<\/refresh>[\s\S]*?<\/onevent>/gi,
        (_, type, _pre, refreshContent) => {
            const setvars = extractSetvars(refreshContent);
            return `<div class="wml-onevent" data-type="${escapeHtml(type)}" data-action="refresh"${setvarsToAttr(setvars)} style="display:none"></div>`;
        });

    // onevent with prev task - extract setvars
    html = html.replace(/<onevent\s+type="([^"]*)">([\s\S]*?)<prev(?:\s*\/>[\s\S]*?|>([\s\S]*?)<\/prev>[\s\S]*?)<\/onevent>/gi,
        (_, type, _pre, prevContent) => {
            const setvars = prevContent ? extractSetvars(prevContent) : [];
            return `<div class="wml-onevent" data-type="${escapeHtml(type)}" data-action="prev"${setvarsToAttr(setvars)} style="display:none"></div>`;
        });

    // onevent with noop task
    html = html.replace(/<onevent\s+type="([^"]*)">[\s\S]*?<noop\s*\/>[\s\S]*?<\/onevent>/gi, '');

    // Timer -> hidden data
    html = html.replace(/<timer\s+([^>]*?)\/>/gi, (_, attrs) => {
        const value = getAttr(attrs, 'value') || '0';
        return `<div class="wml-timer" data-value="${escapeHtml(value)}" style="display:none"></div>`;
    });

    // do elements -> buttons
    // Extract setvars and postfields from inside go/prev/refresh tasks
    html = html.replace(/<do\s+([^>]*)>\s*<go\s+([^>]*?)(?:\/>|>([\s\S]*?)<\/go>)\s*<\/do>/gi,
        (_, doAttrs, goAttrs, goContent) => {
            const type = getAttr(doAttrs, 'type') || 'accept';
            const label = getAttr(doAttrs, 'label') || type;
            const href = getAttr(goAttrs, 'href') || '#';
            const setvars = goContent ? extractSetvars(goContent) : [];
            const postfields = goContent ? extractPostfields(goContent) : [];
            return `<button class="wml-do wml-do-${escapeHtml(type)}" data-type="${escapeHtml(type)}" data-href="${escapeHtml(href)}"${methodToAttr(goAttrs)}${sendrefererToAttr(goAttrs)}${setvarsToAttr(setvars)}${postfieldsToAttr(postfields)}>${escapeHtml(label)}</button>`;
        });

    html = html.replace(/<do\s+([^>]*)>\s*<prev(?:\s*\/>|>([\s\S]*?)<\/prev>)\s*<\/do>/gi,
        (_, doAttrs, prevContent) => {
            const type = getAttr(doAttrs, 'type') || 'prev';
            const label = getAttr(doAttrs, 'label') || 'Back';
            const setvars = prevContent ? extractSetvars(prevContent) : [];
            return `<button class="wml-do wml-do-${escapeHtml(type)}" data-type="${escapeHtml(type)}" data-action="prev"${setvarsToAttr(setvars)}>${escapeHtml(label)}</button>`;
        });

    html = html.replace(/<do\s+[^>]*>\s*<noop\s*\/>\s*<\/do>/gi, '');

    html = html.replace(/<do\s+([^>]*)>\s*<refresh>([\s\S]*?)<\/refresh>\s*<\/do>/gi,
        (_, doAttrs, refreshContent) => {
            const type = getAttr(doAttrs, 'type') || 'accept';
            const label = getAttr(doAttrs, 'label') || type;
            const setvars = extractSetvars(refreshContent);
            return `<button class="wml-do wml-do-${escapeHtml(type)}" data-type="${escapeHtml(type)}" data-action="refresh"${setvarsToAttr(setvars)}>${escapeHtml(label)}</button>`;
        });

    // setvar (standalone ones not inside go/prev/refresh tasks)
    html = html.replace(/<setvar\s+name="([^"]*)"\s+value="([^"]*)"\s*\/>/gi,
        '<div class="wml-setvar" data-name="$1" data-value="$2" style="display:none"></div>');

    // go elements within anchors -> data-href nav (extract setvars and postfields from go content)
    // Handles both: <anchor>text<go.../></anchor> and <anchor><go.../>text</anchor>
    html = html.replace(/<anchor([^>]*)>([\s\S]*?)<\/anchor>/gi,
        (match, attrs, content) => {
            const goMatch = content.match(/<go\s+([^>]*?)href="([^"]*)"([^>]*?)(?:\/>|>([\s\S]*?)<\/go>)/i);
            if (!goMatch) { return match; } // Not a go anchor, skip
            
            const preGoAttrs = goMatch[1] || '';
            const href = goMatch[2];
            const postGoAttrs = goMatch[3] || '';
            const goContent = goMatch[4] || '';
            const goAttrs = preGoAttrs + 'href="' + href + '"' + postGoAttrs;
            
            const accesskey = getAttr(attrs, 'accesskey') || '';
            const cls = getAttr(attrs, 'class') || '';
            
            // Extract text by removing the entire go element
            const cleanText = content.replace(/<go[\s\S]*?<\/go>|<go\s[^>]*?\/>/i, '').trim();
            
            const setvars = extractSetvars(goContent);
            const postfields = extractPostfields(goContent);
            return `<a class="wml-anchor ${escapeHtml(cls)}" data-accesskey="${accesskey}" data-href="${escapeHtml(href)}"${methodToAttr(goAttrs)}${sendrefererToAttr(goAttrs)}${setvarsToAttr(setvars)}${postfieldsToAttr(postfields)}>${cleanText}</a>`;
        });

    // anchor with prev task - handles both text orderings
    html = html.replace(/<anchor([^>]*)>([\s\S]*?)<\/anchor>/gi,
        (match, attrs, content) => {
            const prevMatch = content.match(/<prev(?:\s*\/?>|>([\s\S]*?)<\/prev>)/i);
            if (!prevMatch) { return match; } // Not a prev anchor, skip
            
            const prevContent = prevMatch[1] || '';
            const accesskey = getAttr(attrs, 'accesskey') || '';
            const cls = getAttr(attrs, 'class') || '';
            
            // Extract text by removing the entire prev element
            const cleanText = content.replace(/<prev[\s\S]*?<\/prev>|<prev\s*\/>/i, '').trim();
            
            const setvars = extractSetvars(prevContent);
            return `<a class="wml-anchor ${escapeHtml(cls)}" data-accesskey="${accesskey}" data-action="prev"${setvarsToAttr(setvars)}>${cleanText}</a>`;
        });

    // anchor with refresh task - handles both text orderings
    html = html.replace(/<anchor([^>]*)>([\s\S]*?)<\/anchor>/gi,
        (match, attrs, content) => {
            const refreshMatch = content.match(/<refresh>([\s\S]*?)<\/refresh>/i);
            if (!refreshMatch) { return match; } // Not a refresh anchor, skip
            
            const refreshContent = refreshMatch[1] || '';
            const accesskey = getAttr(attrs, 'accesskey') || '';
            const cls = getAttr(attrs, 'class') || '';
            
            // Extract text by removing the entire refresh element
            const cleanText = content.replace(/<refresh[\s\S]*?<\/refresh>/i, '').trim();
            
            const setvars = extractSetvars(refreshContent);
            return `<a class="wml-anchor ${escapeHtml(cls)}" data-accesskey="${accesskey}" data-action="refresh"${setvarsToAttr(setvars)}>${cleanText}</a>`;
        });

    // <a href="..."> (skip already-processed wml-anchor/wml-link elements)
    html = html.replace(/<a\s+([^>]*)>([\s\S]*?)<\/a>/gi,
        (match, attrs, text) => {
            if (/class="wml-/.test(attrs)) { return match; }
            const href = getAttr(attrs, 'href') || '#';
            const accesskey = getAttr(attrs, 'accesskey') || '';
            return `<a class="wml-link" data-accesskey="${accesskey}" data-href="${escapeHtml(href)}">${text}</a>`;
        });

    // input
    html = html.replace(/<input\s+([^/>]*)\/?>(?:<\/input>)?/gi, (_, attrs) => {
        const name = getAttr(attrs, 'name') || '';
        const type = getAttr(attrs, 'type') || 'text';
        const maxlength = getAttr(attrs, 'maxlength') || '';
        const title = getAttr(attrs, 'title') || name;
        const format = getAttr(attrs, 'format') || '';
        const value = getAttr(attrs, 'value') || '';
        const emptyok = getAttr(attrs, 'emptyok');

        const htmlType = type === 'password' ? 'password' : 'text';
        const pattern = wmlFormatToPattern(format);
        const isRequired = !resolveEmptyOk(emptyok, format || undefined);

        let effectiveMaxlength = maxlength;
        if (!effectiveMaxlength && format) {
            const fmtMax = wmlFormatMaxLength(format);
            if (fmtMax > 0) { effectiveMaxlength = String(fmtMax); }
        }

        let result = `<input type="${htmlType}" name="${escapeHtml(name)}" placeholder="${escapeHtml(title)}" class="wml-input"`;
        if (effectiveMaxlength) { result += ` maxlength="${escapeHtml(effectiveMaxlength)}"`; }
        if (pattern) { result += ` pattern="${escapeHtml(pattern)}"`; }
        if (isRequired) { result += ` required`; }
        result += ` data-format="${escapeHtml(format)}"`;
        if (emptyok !== undefined) { result += ` data-emptyok="${escapeHtml(emptyok)}"`; }
        result += ` value="${escapeHtml(value)}">`;
        return result;
    });

    // option with <onevent type="onpick"> child -> extract href into data-onpick attribute
    html = html.replace(/<option([^>]*)>\s*<onevent\s+type="onpick">\s*<go\s+href="([^"]*)"[^>]*?(?:\/>|>[\s\S]*?<\/go>)\s*<\/onevent>([\s\S]*?)<\/option>/gi,
        (_, attrs, href, text) => {
            const value = getAttr(attrs, 'value');
            const valueAttr = value !== undefined ? ` value="${escapeHtml(value)}"` : '';
            return `<option${valueAttr} data-onpick="${escapeHtml(href)}">${text.trim()}</option>`;
        });

    // option with onpick shorthand -> data attribute
    html = html.replace(/<option\s+onpick="([^"]*)">/gi,
        '<option data-onpick="$1">');
    html = html.replace(/<option\s+value="([^"]*)"\s+onpick="([^"]*)">/gi,
        '<option value="$1" data-onpick="$2">');
    html = html.replace(/<option\s+onpick="([^"]*)"\s+value="([^"]*)">/gi,
        '<option value="$2" data-onpick="$1">');

    // select / option
    html = html.replace(/<select\s+([^>]*)>/gi, (_, attrs) => {
        const name = getAttr(attrs, 'name');
        const multiple = getAttr(attrs, 'multiple') === 'true';
        const selectValue = getAttr(attrs, 'value') || '';
        const iname = getAttr(attrs, 'iname') || '';
        const ivalue = getAttr(attrs, 'ivalue') || '';
        const title = getAttr(attrs, 'title') || '';
        return `<select${name ? ` name="${escapeHtml(name)}"` : ''} class="wml-select"${multiple ? ' multiple' : ''}${selectValue ? ` data-value="${escapeHtml(selectValue)}"` : ''}${iname ? ` data-iname="${escapeHtml(iname)}"` : ''}${ivalue ? ` data-ivalue="${escapeHtml(ivalue)}"` : ''}${title ? ` title="${escapeHtml(title)}"` : ''}>`;
    });

    // table with columns and alignment
    html = html.replace(/<table\s+([^>]*)>/gi, (_, attrs) => {
        const columns = getAttr(attrs, 'columns') || '2';
        const title = getAttr(attrs, 'title') || '';
        const align = getAttr(attrs, 'align') || '';
        return `<table class="wml-table" data-columns="${columns}"${align ? ` data-align="${escapeHtml(align)}"` : ''}${title ? ` title="${escapeHtml(title)}"` : ''}>`;
    });

    // fieldset
    html = html.replace(/<fieldset\s+title="([^"]*)">/gi,
        '<fieldset class="wml-fieldset"><legend>$1</legend>');

    // optgroup
    html = html.replace(/<optgroup\s+title="([^"]*)">/gi,
        '<optgroup label="$1">');

    // p element with align/mode attributes
    html = html.replace(/<p(?:\s+([^>]*))?>/gi, (match, attrs) => {
        if (!attrs) { return '<p class="wml-p">'; }
        const align = getAttr(attrs, 'align');
        const mode = getAttr(attrs, 'mode');
        let style = '';
        if (align) { style += `text-align:${align};`; }
        if (mode === 'nowrap') { style += 'white-space:nowrap;overflow-x:auto;'; }
        return `<p class="wml-p"${style ? ` style="${style}"` : ''}>`;
    });

    // img — delegate to the caller-provided image resolver
    html = html.replace(/<img\s+([^>]*)\/?>(?:<\/img>)?/gi, (_, attrs) => {
        const src = getAttr(attrs, 'src') || '';
        const alt = getAttr(attrs, 'alt') || '';
        const width = getAttr(attrs, 'width') || '';
        const height = getAttr(attrs, 'height') || '';
        const resolvedSrc = resolveImage(src);
        return `<img src="${resolvedSrc}" alt="${escapeHtml(alt)}" class="wml-img"${width ? ` width="${width}"` : ''}${height ? ` height="${height}"` : ''}>`;
    });

    // <br/> normalization
    html = html.replace(/<br\s*\/?>/gi, '<br>');

    // WML variables: $(var) or $var -> span placeholders
    html = html.replace(/(<[^>]+>)|\$\(([A-Za-z_][A-Za-z0-9_]*)(?::(?:escape|noesc|unesc))?\)/g,
        (match, tag, varName) => {
            if (tag) { return tag; }
            return `<span class="wml-var" data-var="${varName}">[${varName}]</span>`;
        });
    html = html.replace(/(<[^>]+>)|\$([A-Za-z_][A-Za-z0-9_]*)/g,
        (match, tag, varName) => {
            if (tag) { return tag; }
            return `<span class="wml-var" data-var="${varName}">[${varName}]</span>`;
        });

    // $$ -> literal dollar sign (must come after variable substitution)
    html = html.replace(/(<[^>]+>)|\$\$/g,
        (match, tag) => {
            if (tag) { return tag; }
            return '$';
        });

    // pre
    html = html.replace(/<pre>/gi, '<pre class="wml-pre">');

    return html;
}

// ── Convenience: render all cards from raw WML ───────────────────

export function renderCards(
    wmlContent: string,
    resolveImage: ImageResolver,
): { parts: string[]; cards: WmlCard[]; firstTitle: string } {
    const cards = parseCards(wmlContent);
    const tmpl = parseTemplateInfo(wmlContent);

    const parts = cards.map((card, index) => {
        const display = index === 0 ? 'block' : 'none';
        const merged = mergeTemplate(card.body, card, tmpl);
        const cardBody = transformWmlBody(merged.body, resolveImage);
        const mc = merged.card;
        const ontimer = mc.ontimer ? ` data-ontimer="${escapeHtml(mc.ontimer)}"` : '';
        const onenterforward = mc.onenterforward ? ` data-onenterforward="${escapeHtml(mc.onenterforward)}"` : '';
        const onenterbackward = mc.onenterbackward ? ` data-onenterbackward="${escapeHtml(mc.onenterbackward)}"` : '';
        const newcontext = mc.newcontext ? ' data-newcontext="true"' : '';
        return `<div class="wml-card" id="${escapeHtml(mc.id)}" data-title="${escapeHtml(mc.title)}"${ontimer}${onenterforward}${onenterbackward}${newcontext} style="display:${display}">${cardBody}</div>`;
    });

    return {
        parts,
        cards,
        firstTitle: cards.length > 0 ? cards[0].title : 'WML',
    };
}
