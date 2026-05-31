/**
 * Copyright (C) 2026 Jabez Winston 
 * 
 * SPDX-License-Identifier: Apache-2.0
 *
 * Date : 20-March-2026
 *
 * WML Preview — Environment-specific code.
 * Requires wml-engine.js (loaded first) for shared WML navigation engine.
 */

// Reuse the single cached VS Code API handle. acquireVsCodeApi() may be called
// only once per page load, and wmlsDebugBridge.js may have acquired it already,
// so always go through window.__wmlsVscodeApi. Returns null in a plain browser
// (the HTTP-server preview), where direct window.location navigation works.
function wmlsGetVsCodeApi() {
    if (typeof window === 'undefined') { return null; }
    if (window.__wmlsVscodeApi) { return window.__wmlsVscodeApi; }
    if (typeof acquireVsCodeApi === 'function') {
        try { window.__wmlsVscodeApi = acquireVsCodeApi(); } catch (e) { return null; }
        return window.__wmlsVscodeApi;
    }
    return null;
}

// Encode WML postfields as an application/x-www-form-urlencoded string.
// Per WML 1.3 §9.x, the field names AND values are URI-escaped (RFC2396) and
// assembled as name=value pairs joined by '&'. escapeUrlString (from
// wml-engine.js, concatenated ahead of this file) gives the spec's lowercase
// %xx encoding, keeping form submission consistent with $(var) href escaping
// and URL.escapeString.
function buildQueryString(postfields) {
    return postfields.map(function(pf) {
        return escapeUrlString(pf.name) + '=' + escapeUrlString(pf.value);
    }).join('&');
}

// Append GET postfields to a URL as query parameters. POST fields and the
// empty case leave the URL unchanged.
function appendGetParams(href, postfields, method) {
    if (!postfields || postfields.length === 0 || method === 'post') { return href; }
    var sep = href.indexOf('?') >= 0 ? '&' : '?';
    return href + sep + buildQueryString(postfields);
}

// Direct navigation for the plain-browser (HTTP-server) preview: POST submits a
// hidden form; GET/plain navigations set window.location.
function navigateBrowser(href, postfields, method) {
    if (postfields && postfields.length > 0 && method === 'post') {
        var form = document.createElement('form');
        form.method = 'POST';
        form.action = href;
        postfields.forEach(function(pf) {
            var input = document.createElement('input');
            input.type = 'hidden';
            input.name = pf.name;
            input.value = pf.value;
            form.appendChild(input);
        });
        document.body.appendChild(form);
        form.submit();
        return;
    }
    window.location.href = appendGetParams(href, postfields, method);
}

// ── Navigation (preview-specific) ────────────────────────────────
function wmlNavigate(href, postfields, method) {
    href = substituteVars(href, true);  // %HREF context → default escape conversion
    if (href.startsWith('#')) {
        showCard(href.substring(1));
    } else if (href.includes('.wmls#')) {
        executeWmlScript(href);
    } else if (/\.wml#/.test(href)) {
        // e.g. "index.wml#dashboard" — a card in the current deck
        showCard(href.substring(href.indexOf('#') + 1));
    } else {
        // Cross-deck (another .wml file) or external URL. Inside the VS Code
        // side-panel webview, top-level navigation (window.location / form
        // submit) is blocked, so delegate to the extension host, which loads
        // and re-renders the target deck; a plain browser navigates directly.
        var vscodeApi = wmlsGetVsCodeApi();
        if (vscodeApi) {
            vscodeApi.postMessage({ type: 'wmlNavigate', href: appendGetParams(href, postfields, method) });
        } else {
            navigateBrowser(href, postfields, method);
        }
    }
}

// Cross-deck Back hook (called by wml-engine.js's wmlPrev when a deck's card
// history is exhausted). The side-panel webview delegates to the extension host
// (which owns the deck stack); a plain browser (HTTP preview) uses native history.
function wmlPrevDeck() {
    var vscodeApi = wmlsGetVsCodeApi();
    if (vscodeApi) {
        vscodeApi.postMessage({ type: 'wmlNavigateBack' });
    } else if (typeof window !== 'undefined' && window.history && window.history.length > 1) {
        window.history.back();
    }
}

// Convert parsed WMLScript call args into JS values for the transpiled runtime.
// Per WMLScript §8.3.4 a token's literal form decides its type: a quoted token
// ('...'/"...") is always a String; only unquoted tokens are coerced to
// boolean / number / invalid. Accepts both the structured { value, quoted }
// tokens from parseWmlScriptArgs and bare strings (treated as unquoted).
function convertWmlsArgs(args) {
    return args.map(function(a) {
        var quoted = (a && typeof a === 'object') ? !!a.quoted : false;
        var s = (a && typeof a === 'object') ? a.value : a;
        if (quoted) return s;                    // string literal → keep as string
        if (s === 'true') return true;
        if (s === 'false') return false;
        if (s === 'invalid') return undefined;
        var n = Number(s);
        if (!isNaN(n) && s.length > 0) return n;
        return s;
    });
}

function executeWmlScript(href) {
    // Parse "file.wmls#func(arg1,arg2,...)"
    var hashIdx = href.indexOf('.wmls#');
    var scriptPath = href.substring(0, hashIdx + 5);
    var callPart = href.substring(hashIdx + 6);
    var parenIdx = callPart.indexOf('(');
    var funcName = callPart.substring(0, parenIdx);
    var argsStr = callPart.substring(parenIdx + 1, callPart.length - 1);
    var args = parseWmlScriptArgs(argsStr);
    var jsArgs = convertWmlsArgs(args);

    // Resolve scriptPath relative to the deck. Prefer the workspace-relative
    // deck base injected at render time (window.__wmlDeckBase) — in the
    // side-panel webview window.location is a vscode-webview:// path that does
    // NOT match the script registry keys. Fall back to the page path for the
    // HTTP-server preview.
    var baseDir;
    if (typeof window !== 'undefined' && window.__wmlDeckBase) {
        baseDir = window.__wmlDeckBase;
    } else {
        var base = window.location.pathname;
        baseDir = base.substring(0, base.lastIndexOf('/') + 1);
    }
    var resolvedScript = baseDir + scriptPath;

    // Client-side execution: call the transpiled function directly.
    if (typeof __wmls !== 'undefined') {
        if (!__wmls._scripts[resolvedScript]) {
            // Fall back to matching a registered script by filename (handles
            // relative `..` segments and base-path drift across preview modes).
            var fname = scriptPath.substring(scriptPath.lastIndexOf('/') + 1);
            var hits = Object.keys(__wmls._scripts).filter(function (k) {
                return k.substring(k.lastIndexOf('/') + 1) === fname;
            });
            if (hits.length === 1) { resolvedScript = hits[0]; }
        }
        if (__wmls._scripts[resolvedScript]) {
            __wmls._callFunction(resolvedScript, funcName, jsArgs);
            return;
        }
    }

    // Fallback: dynamically load the transpiled .wmls from the server
    var script = document.createElement('script');
    script.src = resolvedScript;
    script.onload = function() {
        if (typeof __wmls !== 'undefined' && __wmls._scripts[resolvedScript]) {
            __wmls._callFunction(resolvedScript, funcName, jsArgs);
        } else {
            console.error('WMLScript module failed to register: ' + resolvedScript);
        }
    };
    script.onerror = function() {
        console.error('Failed to load WMLScript: ' + resolvedScript);
    };
    document.head.appendChild(script);
}

// ── Initialization ───────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', function() {
    initWmlFormElements();

    // Handle onpick on select options
    document.querySelectorAll('select').forEach(function(sel) {
        sel.addEventListener('change', function() {
            var opt = sel.options[sel.selectedIndex];
            if (opt) {
                var onpick = opt.getAttribute('data-onpick');
                if (onpick) wmlNavigate(onpick);
            }
        });
    });

    var firstCard = document.querySelector('.wml-card');
    if (firstCard) {
        // Fire onenterforward for the initial card (entering the deck goes forward)
        processOnEvent(firstCard, 'onenterforward');
        // If onenterforward navigated away, showCard already handled setup for the
        // target card. Only run setup here if we're still on the first card.
        if (firstCard.style.display !== 'none') {
            updateSoftkeys(firstCard);
            processTimers(firstCard);
            updateVariables();
        }
    }

    initWmlEventDelegation();
});
