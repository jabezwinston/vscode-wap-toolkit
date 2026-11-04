/**
 *  Copyright (C) 2026 Jabez Winston
 *
 *  SPDX-License-Identifier: Apache-2.0
 * 
 *  Date : 09-April-2026
 *
 *  WAP Browser — Webview Client Script
 *
 *  Runs inside the VS Code webview. Handles address bar, cross-deck navigation,
 *  WMLScript execution via extension host, dialogs, and WBMP image proxying.
 *  Requires wml-engine.js (loaded first) for shared WML navigation engine.
 */

/* global acquireVsCodeApi */
var vscodeApi = acquireVsCodeApi();

// This is a browser, not the editor preview: an unset variable renders as
// nothing (WML 1.3: 10.3.1) rather than as wmlTransform's "[name]" authoring
// placeholder. See updateVariables() in wml-engine.js.
window.WML_STRICT_VARS = true;

// ── State (browser-specific; wmlHistory & wmlVars are in wml-engine.js) ──
var deckHistory = [];      // stack of {url, method, postfields} for cross-deck back
var currentUrl = '';       // current deck URL
var currentFetch = { method: 'get', postfields: null }; // how the current deck was fetched
// The deck load in flight: its task's setvars (applied when the deck
// arrives, WML 1.3: 12.5.1 step 5), the card a Back returns to, and what
// to restore if the reply is no deck (a WMLScript unit)
var pendingNav = null;

// The card on screen
function currentCardEl() {
    return document.querySelector('.wml-card[style*="display: block"], .wml-card[style*="display:block"]');
}

// WMLScript: 8.3 WMLScript and URLs
//
// A WMLScript call: a .wmls / .wmlsc URL with a fragment.  Other URLs are
// fetched, and a reply typed as WMLScript is run too (scriptContent).
function isScriptHref(href) {
    return /\.wmlsc?(#|%23)/.test(href);
}

// ── Address bar ──────────────────────────────────────────────────

function doNavigate() {
    var url = document.getElementById('url-input').value.trim();
    if (!url) return;
    // Auto-add http:// if no scheme
    if (!/^https?:\/\//i.test(url)) {
        url = 'http://' + url;
        document.getElementById('url-input').value = url;
    }
    openUrl(url);
}

// WML 1.3: 10.4 Context Restrictions
//
// A URL the user enters (the address bar, history) is no interaction with
// the content: its deck starts another context (WML 1.3: 10.4), no
// variables and no history, the deck left not kept to go back to; a fetch
// that fails changes nothing
function openUrl(url) {
    navigateToUrl(url, null, 'get', false, false, null, null, false, true);
}

// WML 1.3:
//  - 12.5.2 The Prev Task
//  - 9.2 History
function doBack(setvars) {
    if (deckHistory.length > 0) {
        var prev = deckHistory.pop();
        // WML 1.3: 12.5.2 The Prev Task: back to the card left, with that deck's card
        // history; onenterbackward, not onenterforward or newcontext
        pendingNav = { setvars: timerExit(setvars), back: true, card: prev.card, cards: prev.cards };
        document.getElementById('url-input').value = prev.url;
        currentUrl = prev.url;
        // Restore how this deck was originally fetched so POST decks re-issue
        // their post data on back navigation (WML 1.3: 9.2, 12.5.2).
        currentFetch = { method: prev.method || 'get', postfields: prev.postfields || null,
                         acceptCharset: prev.acceptCharset || null };
        vscodeApi.postMessage({
            type: 'navigate',
            url: prev.url,
            postfields: prev.postfields || null,
            method: prev.method || 'get',
            acceptCharset: prev.acceptCharset || null,
        });
    }
}

// WML 1.3: 12.5.4 The Refresh Task
function doRefresh() {
    if (currentUrl) {
        vscodeApi.postMessage({ type: 'navigate', url: currentUrl });
    }
}

function doDebug() {
    // Start (or focus) a WMLScript debug session for this browser. The extension
    // host opens the deck/scripts as read-only sources for breakpoints.
    vscodeApi.postMessage({ type: 'debug' });
}

document.getElementById('url-input').addEventListener('keydown', function(e) {
    // keyCode for Chromium 30 (Android 4.4), which has no KeyboardEvent.key.
    if (e.key === 'Enter' || e.keyCode === 13) {
        doNavigate();
    }
});

// ── Navigation ───────────────────────────────────────────────────

// WML 1.3: 9.5.1 The Go Element
//
// The referring deck as a sendreferer Referer: its URL relative to `url`,
// the one requested (WML 1.3: 9.5.1: "the smallest relative URI possible
// if it can be relative at all"), as wap-browser-c sends it.  From another
// site the whole URL; else the shorter of its path and the path relative
// to url's directory ("../" up).  The query stays.
function relativeReferer(from, url) {
    var origin = function(u) { var m = /^[A-Za-z][A-Za-z0-9+.-]*:\/\/[^\/?#]*/.exec(u); return m ? m[0] : null; };
    var o = origin(from);
    if (!o || o !== origin(url) || from.charAt(o.length) !== '/') { return from; }
    var k = o.length, dir = o.length;
    while (k < from.length && from.charAt(k) === url.charAt(k) && from.charAt(k) !== '?') {
        if (from.charAt(k++) === '/') { dir = k - 1; }
    }
    var rest = url.substring(dir + (url.charAt(dir) === '/' ? 1 : 0)).split(/[?#]/)[0];
    var ups = rest.split('/').length - 1;
    var tail = from.substring(dir + 1), path = from.substring(o.length);
    if ((!ups && (!tail || /^[^\/?]*:/.test(tail))) || 3 * ups + tail.length >= path.length) {
        return path;
    }
    return new Array(ups + 1).join('../') + tail;
}

// WML 1.3:
//  - 12.5.1 The Go Task
//  - 9.5.1 The Go Element
//  - 11.3.1 The Access Element
function navigateToUrl(url, postfields, method, sendreferer, isLink, acceptCharset, setvars, noCache, fresh) {
    // Resolve relative URLs
    if (currentUrl && !url.match(/^https?:\/\//i)) {
        try {
            url = new URL(url, currentUrl).toString();
        } catch(e) { /* use as-is */ }
    }

    // Check for WMLScript call
    if (isScriptHref(url)) {
        commitSetvars(setvars);
        executeWmlScript(url);
        return;
    }

    // Check for fragment-only navigation (card switch within deck)
    if (url.startsWith('#') && !noCache) {
        showCard(url.substring(1), setvars);
        return;
    }

    // Check if it's same-deck card navigation (e.g. "deck.wml#card2");
    // cache-control="no-cache" fetches it again (WML 1.3: 9.5.1)
    try {
        var parsed = new URL(url);
        var baseUrl = parsed.origin + parsed.pathname + parsed.search;
        var currentBase = '';
        if (currentUrl) {
            var parsedCurrent = new URL(currentUrl);
            currentBase = parsedCurrent.origin + parsedCurrent.pathname + parsedCurrent.search;
        }
        if (baseUrl === currentBase && parsed.hash && !noCache) {
            showCard(parsed.hash.substring(1), setvars);
            return;
        }
    } catch(e) { /* not a valid URL, send to extension anyway */ }

    // Save current deck (and how it was fetched) in deck history for back
    // nav, with the card on screen and the deck's card history.
    var fromUrl = currentUrl;
    var card = currentCardEl();
    pendingNav = { setvars: timerExit(setvars), fromUrl: currentUrl, fromFetch: currentFetch,
                   pushed: !!currentUrl && !fresh, fresh: !!fresh };
    if (currentUrl && !fresh) {
        deckHistory.push({ url: currentUrl, method: currentFetch.method, postfields: currentFetch.postfields,
                           acceptCharset: currentFetch.acceptCharset,
                           card: card ? card.id : null, cards: wmlHistory.slice() });
    }

    currentUrl = url;
    currentFetch = { method: method || 'get', postfields: postfields || null,
                     acceptCharset: acceptCharset || null };
    document.getElementById('url-input').value = url;

    setStatus('Loading ' + url + '...');
    vscodeApi.postMessage({
        type: 'navigate',
        url: url,
        postfields: postfields || null,
        method: method || 'get',
        // sendreferer="true" → send the referring deck URL, relative to
        // the one requested (WML 1.3: 9.5.1)
        referer: sendreferer && fromUrl ? relativeReferer(fromUrl, url) : null,
        // cache-control="no-cache" → reload from the origin server, with
        // the header (WML 1.3: 9.5.1)
        noCache: !!noCache,
        // Referring deck for deck access control — only for in-deck links, not
        // user-initiated address-bar / history navigation (WML 1.3: 11.3.1).
        fromDeck: isLink ? fromUrl : null,
        // <go accept-charset>: the charset postfields are sent in (WML 1.3: 9.5.1)
        acceptCharset: acceptCharset || null
    });
}

// WMLScript: 8.3 WMLScript and URLs
function executeWmlScript(href) {
    // Parse "script.wmls#func(args)" — handle both encoded and decoded '#'.
    // The unit's URL may have any name (a reply typed as WMLScript).
    var normalizedHref = href.replace(/(\.wmlsc?)%23/, '$1#');
    var hashIdx = normalizedHref.indexOf('#');
    var scriptUrl = normalizedHref.substring(0, hashIdx);
    var callPart = normalizedHref.substring(hashIdx + 1);
    var parenIdx = callPart.indexOf('(');
    var funcName, args;
    if (parenIdx >= 0) {
        funcName = callPart.substring(0, parenIdx);
        var argsStr = callPart.substring(parenIdx + 1, callPart.length - 1);
        args = parseWmlScriptArgs(argsStr);
    } else {
        funcName = callPart;
        args = [];
    }

    // Resolve script URL relative to current page
    if (currentUrl && !scriptUrl.match(/^https?:\/\//i)) {
        try {
            scriptUrl = new URL(scriptUrl, currentUrl).toString();
        } catch(e) { /* use as-is */ }
    }

    // Collect current wmlVars to pass to VM
    var varsSnapshot = {};
    for (var k in wmlVars) {
        if (wmlVars.hasOwnProperty(k)) varsSnapshot[k] = wmlVars[k];
    }

    setStatus('Executing WMLScript...');
    vscodeApi.postMessage({
        type: 'execWmlScript',
        scriptUrl: scriptUrl,
        funcName: funcName,
        args: args,
        wmlVars: varsSnapshot,
        // the card on screen, for WMLBrowser.getCurrentCard (WMLScript Libraries: 11.6)
        card: (document.querySelector('.wml-card[style*="display: block"], .wml-card[style*="display:block"]') || {}).id || ''
    });
}

// ── Navigation (browser-specific: wmlNavigate, wmlPrevDeck hook) ─

// WML 1.3: 12.5.2 The Prev Task
//
// Cross-deck Back hook (called by wml-engine.js's wmlPrev when a deck's card
// history is exhausted): step back through the browser's deck history.
function wmlPrevDeck(setvars) {
    doBack(setvars);
}

// newcontext hook (wml-engine.js wmlNewContext): the deck history goes too
function wmlClearHistory() {
    deckHistory = [];
}

// WML 1.3: 12.5.1 The Go Task
function wmlNavigate(href, postfields, method, sendreferer, acceptCharset, setvars, noCache) {
    href = substituteVars(href, true);  // %HREF context → default escape conversion
    if (href.startsWith('#') && noCache && currentUrl) {
        // no-cache: this deck fetched again, its postfields sent (WML 1.3: 9.5.1)
        navigateToUrl(currentUrl.split('#')[0] + href, postfields, method, sendreferer, true,
                      acceptCharset, setvars, true);
    } else if (href.startsWith('#')) {
        showCard(href.substring(1), setvars);
    } else if (isScriptHref(href)) {
        commitSetvars(setvars);
        executeWmlScript(href);
    } else if (/\.wml#/.test(href)) {
        // Same-deck or cross-deck card reference
        var hashIdx = href.indexOf('#');
        var deckPart = href.substring(0, hashIdx);
        var cardPart = href.substring(hashIdx + 1);
        // Check if it's the same deck
        if (!deckPart || deckPart === '') {
            showCard(cardPart, setvars);
        } else {
            // Different deck: navigate then show card
            navigateToUrl(href, postfields, method, sendreferer, true, acceptCharset, setvars, noCache);
        }
    } else {
        navigateToUrl(href, postfields, method, sendreferer, true, acceptCharset, setvars, noCache);
    }
}

// WMLScript Dialogs (alert/confirm/prompt) use the shared in-page modal
// (wmlShowDialog in wml-engine.js); the extension host requests them via the
// 'dialog' message below. The modal markup + CSS are shared with the preview.

// ── Status bar ───────────────────────────────────────────────────

function setStatus(msg, isError) {
    var bar = document.getElementById('status-bar');
    bar.textContent = msg;
    bar.className = 'status-bar' + (isError ? ' error' : '');
}

// ── Render deck content received from extension ──────────────────

// WML 1.3:
//  - 12.5.1 The Go Task
//  - 5.2 Fragment Anchors
function renderDeck(data) {
    var screen = document.getElementById('phone-screen');
    var nav = pendingNav || {};
    pendingNav = null;
    // The variables are this page's, across decks (WML 1.3: 10): the host's
    // copy (data.vars) is only as new as the last script run.  A Back
    // brings the deck's card history back.  A URL the user entered starts
    // another context (WML 1.3: 10.4).
    if (nav.fresh) { wmlNewContext(); }
    wmlHistory = nav.cards || [];
    if (data.movedTo) {
        // A redirect: the deck is the one at the new URL, fetched by GET
        // (WML 1.3: 5.3, 9.2), so links resolve, Refresh and Back fetch it there
        currentUrl = data.movedTo;
        currentFetch = { method: 'get', postfields: null, acceptCharset: currentFetch.acceptCharset };
        document.getElementById('url-input').value = currentUrl;
    }
    commitSetvars(nav.setvars);                 // WML 1.3: 12.5.1 step 5, WML 1.3: 12.5.2 step 4
    wmlCharsetMap = data.charsetMap || null;   // $(v:escape) in the deck's charset

    screen.innerHTML = data.cardsHtml;

    var titleEl = document.getElementById('card-title');

    // Navigate to specific card if URL has fragment; Back to the card left
    var targetCard = null;
    if (nav.card) {
        targetCard = findCard(nav.card);
    }
    if (!targetCard && data.fragment) {
        targetCard = findCard(data.fragment);    // else the first (WML 1.3: 12.5.1 step 4c)
    }

    // The first card or target card; its newcontext (WML 1.3: 12.5.1 step 6, a go
    // only) comes before the fields take their initial values
    var firstCard = targetCard || document.querySelector('.wml-card');
    if (firstCard && !nav.back && firstCard.getAttribute('data-newcontext') === 'true') {
        wmlNewContext();
    }

    // Wire up form elements; their values are the card's, set at its
    // entry (WML 1.3: 11.6.2.1, 11.6.3)
    initFormElements();

    if (firstCard) {
        document.querySelectorAll('.wml-card').forEach(function(c) { c.style.display = 'none'; });
        firstCard.style.display = 'block';
        showCardTitle(firstCard);
        var went = processOnEvent(firstCard, nav.back ? 'onenterbackward' : 'onenterforward');
        if (firstCard.style.display !== 'none') {
            if (!went) { initCardFields(firstCard); }
            updateSoftkeys(firstCard);
            if (!went) { processTimers(firstCard); }
        }
    } else if (titleEl && data.firstCardTitle) {
        titleEl.textContent = data.firstCardTitle;
    }

    updateVariables();
    proxyWbmpImages();
    setStatus('Done');
}

// ── WBMP image proxy ─────────────────────────────────────────────
// Browsers can't render WBMP natively. For any <img> that points to
// a .wbmp URL, ask the extension to fetch + convert to data URI.
var _proxyIdCounter = 0;
var _pendingProxies = {};

/** WML 1.3:
 *  - 11.9 Images
 *  - 5.3 Relative URLs
 *
 * Resolve an image src to an absolute URL using currentUrl as base. */
function resolveImageSrc(src) {
    if (!src || src.indexOf('data:') === 0) return src;
    if (/^https?:\/\//i.test(src)) return src;  // already absolute
    if (currentUrl) {
        try { return new URL(src, currentUrl).toString(); } catch(e) {}
    }
    // Last resort: use the DOM property which resolves against webview origin
    // (only useful if webview and target share origin, which they don't — but
    //  it's better than sending a bare relative path to the extension)
    return src;
}

function proxyWbmpImages() {
    document.querySelectorAll('img.wml-img').forEach(function(img) {
        var src = resolveImageSrc(img.getAttribute('src') || '');
        if (src.match(/\.wbmp(\?|$)/i) || src.indexOf('image/vnd.wap.wbmp') !== -1) {
            var id = 'proxy-' + (++_proxyIdCounter);
            _pendingProxies[id] = img;
            img.setAttribute('data-original-src', src);
            img.style.visibility = 'hidden';
            vscodeApi.postMessage({ type: 'proxyImage', src: src, id: id });
        }
    });
    // Also catch any images that fail to load (server may return WBMP without .wbmp extension)
    document.querySelectorAll('img.wml-img').forEach(function(img) {
        img.addEventListener('error', function() {
            var s = resolveImageSrc(img.getAttribute('src') || '');
            if (s.indexOf('data:') === 0) return;  // already proxied
            var id = 'proxy-' + (++_proxyIdCounter);
            _pendingProxies[id] = img;
            img.setAttribute('data-original-src', s);
            vscodeApi.postMessage({ type: 'proxyImage', src: s, id: id });
        }, { once: true });
    });
}

function initFormElements() {
    initWmlFormElements();
    // Handle onpick on select options (browser-specific: wml-engine doesn't wire onpick)
    document.querySelectorAll('.wml-select').forEach(function(sel) {
        sel.addEventListener('change', function() {
            var opt = sel.options[sel.selectedIndex];
            if (opt) {
                var onpick = opt.getAttribute('data-onpick');
                if (onpick) wmlNavigate(onpick);
            }
        });
    });
}

// ── Event Delegation (shared + browser-specific) ─────────────────

initWmlEventDelegation();

// ── Messages from Extension Host ─────────────────────────────────

window.addEventListener('message', function(event) {
    var msg = event.data;
    switch (msg.type) {
        case 'deckContent':
            renderDeck(msg);
            break;

        case 'error': {
            // WML 1.3: 12.5.5 Task Execution Failure: a task that fails (a fetch, a deck its <access>
            // refuses) is told, and the card that started it stays, with
            // the deck and the history as they were; no setvars applied.
            // With no card on screen the error is the page.
            var failed = pendingNav || {};
            pendingNav = null;
            setStatus(msg.message, true);
            if (failed.pushed) { deckHistory.pop(); }
            if (failed.fromFetch && currentCardEl()) {
                currentUrl = failed.fromUrl;
                currentFetch = failed.fromFetch;
                document.getElementById('url-input').value = currentUrl;
                processTimers(currentCardEl());
                break;
            }
            var screen = document.getElementById('phone-screen');
            screen.innerHTML = '<div class="browser-welcome"><h2>Error</h2><p>' +
                escapeHtml(msg.message) + '</p></div>';
            break;
        }

        case 'scriptContent': {
            // The link's reply was a WMLScript unit (WMLScript: 14): no
            // page, so the deck load is undone, and the function its
            // fragment names is run
            var nav = pendingNav || {};
            pendingNav = null;
            if (nav.pushed) { deckHistory.pop(); }
            if (nav.fromFetch) {
                currentUrl = nav.fromUrl;
                currentFetch = nav.fromFetch;
                document.getElementById('url-input').value = currentUrl;
            }
            commitSetvars(nav.setvars);
            var stay = currentCardEl();         // still on it: its timer starts
            if (stay) { processTimers(stay); }
            executeWmlScript(msg.url);
            break;
        }

        case 'wmlscriptResult':
            // WMLScript VM finished: apply variable changes and navigation.
            // WMLBrowser.newContext(): the variables and the history go
            // first; msg.vars are those set after it (WMLScript Libraries: 11.5)
            if (msg.newContext) { wmlNewContext(); }
            if (msg.vars) {
                for (var k in msg.vars) {
                    if (msg.vars.hasOwnProperty(k)) wmlVars[k] = msg.vars[k];
                }
                updateVariables();
            }
            if (msg.goUrl) {
                wmlNavigate(msg.goUrl);
            } else if (msg.doPrev) {
                wmlPrev();
            } else if (msg.doRefresh) {
                updateVariables();
            }
            if (msg.error) {
                setStatus('WMLScript error: ' + msg.error, true);
            } else {
                setStatus('Done');
            }
            break;

        case 'dialog':
            wmlShowDialog(msg.dialogType, msg.message, {
                def: msg.defaultValue,
                okLabel: msg.okLabel,
                cancelLabel: msg.cancelLabel
            }).then(function(result) {
                vscodeApi.postMessage({ type: 'dialogResult', requestId: msg.requestId, result: result });
            });
            break;

        case 'imageProxyResult':
            if (msg.id && _pendingProxies[msg.id]) {
                var img = _pendingProxies[msg.id];
                if (msg.dataUri) {
                    img.src = msg.dataUri;
                    img.style.visibility = 'visible';
                } else {
                    // The bitmap could not be fetched or decoded — which is
                    // precisely when alt matters. WML 1.3: 11.9 makes alt the
                    // image's alternative representation for exactly this case,
                    // so the deck's own text must survive; overwriting it threw
                    // away what the author wrote ("Company Logo") in favour of
                    // a generic marker. Only supply one if the deck gave none.
                    if (!img.getAttribute('alt')) { img.alt = '[image]'; }
                    img.style.visibility = 'visible';
                }
                delete _pendingProxies[msg.id];
            }
            break;

        case 'cookiesCleared':
            setStatus('Cleared ' + msg.count + ' cookie' + (msg.count !== 1 ? 's' : ''));
            break;

        case 'imageSaved':
            setStatus('Saved: ' + msg.name);
            break;

        case 'downloadsList':
            renderDownloadsList(msg.downloads);
            break;

        case 'historyList':
            renderHistoryList(msg.history);
            break;

        case 'settingsData':
            populateSettings(msg.settings);
            break;

        case 'status':
            setStatus(msg.message);
            break;

        case 'debugState': {
            // Reflect debug-session state on the debug button.
            var dbgBtn = document.getElementById('btn-debug');
            if (dbgBtn) {
                if (msg.active) {
                    dbgBtn.classList.add('active');
                    dbgBtn.title = 'Debug (active)';
                } else {
                    dbgBtn.classList.remove('active');
                    dbgBtn.title = 'Debug';
                }
            }
            break;
        }
    }
});

// ── Browser Menu ────────────────────────────────────────────────

function toggleMenu() {
    var menu = document.getElementById('browser-menu');
    menu.classList.toggle('visible');
}

// Close menu when clicking outside. The button's own click has just opened
// it, and the target of that click is usually the icon inside the button, so
// the test is containment, not identity.
document.addEventListener('click', function(e) {
    var menu = document.getElementById('browser-menu');
    var btn = document.getElementById('btn-menu');
    if (menu.classList.contains('visible') && !menu.contains(e.target) && !btn.contains(e.target)) {
        menu.classList.remove('visible');
    }
});

// ── Save Page ───────────────────────────────────────────────────

function doSavePage() {
    document.getElementById('browser-menu').classList.remove('visible');
    vscodeApi.postMessage({ type: 'savePage' });
}

document.addEventListener('keydown', function(e) {
    if ((e.ctrlKey || e.metaKey) && e.key === 's') {
        e.preventDefault();
        doSavePage();
    }
    if ((e.ctrlKey || e.metaKey) && e.key === 'h') {
        e.preventDefault();
        doShowHistory();
    }
});

// ── Clear Cookies ───────────────────────────────────────────────

function doClearCookies() {
    document.getElementById('browser-menu').classList.remove('visible');
    vscodeApi.postMessage({ type: 'clearCookies' });
}

// ── Save Image (right-click context menu) ───────────────────────

var _ctxMenu = document.getElementById('img-context-menu');
var _ctxTarget = null;

document.addEventListener('contextmenu', function(e) {
    var img = e.target.closest('img.wml-img');
    if (!img) {
        _ctxMenu.style.display = 'none';
        return;
    }
    e.preventDefault();
    _ctxTarget = img;
    var x = e.clientX;
    var y = e.clientY;
    // Keep menu within viewport
    _ctxMenu.style.left = x + 'px';
    _ctxMenu.style.top = y + 'px';
    _ctxMenu.style.display = 'block';
    // Adjust if overflowing
    var rect = _ctxMenu.getBoundingClientRect();
    if (rect.right > window.innerWidth) _ctxMenu.style.left = (window.innerWidth - rect.width - 4) + 'px';
    if (rect.bottom > window.innerHeight) _ctxMenu.style.top = (window.innerHeight - rect.height - 4) + 'px';
});

function doSaveImageAs() {
    _ctxMenu.style.display = 'none';
    if (!_ctxTarget) return;
    var img = _ctxTarget;
    var originalSrc = img.getAttribute('data-original-src') || '';
    var src = img.getAttribute('src') || '';
    var dataUri = '';
    if (originalSrc) {
        // Proxied image (e.g. WBMP→SVG) — use original URL so extension fetches raw binary
        src = originalSrc;
    } else if (src.indexOf('data:') === 0) {
        dataUri = src;
        src = '';
    } else {
        src = resolveImageSrc(src);
    }
    vscodeApi.postMessage({ type: 'saveImage', src: src, dataUri: dataUri });
    _ctxTarget = null;
}

// Hide context menu on click elsewhere
document.addEventListener('click', function(e) {
    if (_ctxMenu.style.display === 'block' && !_ctxMenu.contains(e.target)) {
        _ctxMenu.style.display = 'none';
    }
});

// ── Downloads Panel ─────────────────────────────────────────────

function doShowDownloads() {
    document.getElementById('browser-menu').classList.remove('visible');
    document.getElementById('downloads-overlay').classList.add('visible');
    vscodeApi.postMessage({ type: 'getDownloads' });
}

function doCloseDownloads() {
    document.getElementById('downloads-overlay').classList.remove('visible');
}

function doClearDownloads() {
    vscodeApi.postMessage({ type: 'clearDownloads' });
}

function renderDownloadsList(downloads) {
    var list = document.getElementById('downloads-list');
    if (!downloads || downloads.length === 0) {
        list.innerHTML = '<div class="panel-empty">No downloads yet.</div>';
        return;
    }
    var html = '';
    for (var i = downloads.length - 1; i >= 0; i--) {
        var d = downloads[i];
        var sizeStr = d.size < 1024 ? d.size + ' B' :
            d.size < 1048576 ? (d.size / 1024).toFixed(1) + ' KB' :
            (d.size / 1048576).toFixed(1) + ' MB';
        var dateStr = new Date(d.date).toLocaleString();
        html += '<div class="panel-item">' +
            '<div class="item-info">' +
                '<span class="item-name">' + escapeHtml(d.name) + '</span>' +
                '<span class="item-meta">' + sizeStr + ' \u2022 ' + dateStr + '</span>' +
            '</div>' +
            '<div class="item-actions">' +
                '<button class="dialog-btn" onclick="doOpenDownload(\'' + escapeHtml(d.path).replace(/'/g, "\\'") + '\')">Open</button>' +
                '<button class="dialog-btn" onclick="doRevealDownload(\'' + escapeHtml(d.path).replace(/'/g, "\\'") + '\')" title="Show in folder">Reveal</button>' +
            '</div>' +
        '</div>';
    }
    list.innerHTML = html;
}

function doOpenDownload(filePath) {
    vscodeApi.postMessage({ type: 'openDownload', path: filePath });
}

function doRevealDownload(filePath) {
    vscodeApi.postMessage({ type: 'revealDownload', path: filePath });
}

// ── History Panel ───────────────────────────────────────────────

function doShowHistory() {
    document.getElementById('browser-menu').classList.remove('visible');
    document.getElementById('history-overlay').classList.add('visible');
    vscodeApi.postMessage({ type: 'getHistory' });
}

function doCloseHistory() {
    document.getElementById('history-overlay').classList.remove('visible');
}

function doClearHistory() {
    vscodeApi.postMessage({ type: 'clearHistory' });
}

function renderHistoryList(history) {
    var list = document.getElementById('history-list');
    if (!history || history.length === 0) {
        list.innerHTML = '<div class="panel-empty">No history yet.</div>';
        return;
    }
    var html = '';
    for (var i = history.length - 1; i >= 0; i--) {
        var h = history[i];
        var dateStr = new Date(h.date).toLocaleString();
        var safeUrl = escapeHtml(h.url).replace(/'/g, "\\'");
        html += '<div class="panel-item history-item" onclick="doNavigateFromHistory(\'' + safeUrl + '\')">' +
            '<div class="item-info">' +
                '<span class="item-name">' + escapeHtml(h.title) + '</span>' +
                '<span class="item-meta">' + escapeHtml(h.url) + '</span>' +
                '<span class="item-meta">' + dateStr + '</span>' +
            '</div>' +
        '</div>';
    }
    list.innerHTML = html;
}

function doNavigateFromHistory(url) {
    document.getElementById('history-overlay').classList.remove('visible');
    document.getElementById('url-input').value = url;
    openUrl(url);
}

// ── Settings Panel ──────────────────────────────────────────────

var _currentSettings = null;

function doShowSettings() {
    document.getElementById('browser-menu').classList.remove('visible');
    document.getElementById('settings-overlay').classList.add('visible');
    vscodeApi.postMessage({ type: 'getSettings' });
}

function doCloseSettings() {
    document.getElementById('settings-overlay').classList.remove('visible');
}

function populateSettings(settings) {
    _currentSettings = settings;
    document.getElementById('setting-transport').value = settings.transport;
    document.getElementById('setting-gatewayHost').value = settings.gatewayHost;
    document.getElementById('setting-gatewayPort').value = settings.gatewayPort;
    document.getElementById('setting-wspCoPort').value = settings.wspCoPort;
    document.getElementById('setting-screenWidth').value = settings.screenWidth;
    document.getElementById('setting-screenHeight').value = settings.screenHeight;
    toggleWspFields();
}

function toggleWspFields() {
    var transport = document.getElementById('setting-transport').value;
    var wspSection = document.getElementById('wsp-settings');
    wspSection.style.display = transport === 'wsp' ? 'block' : 'none';
}

document.getElementById('setting-transport').addEventListener('change', toggleWspFields);

function doSaveSettings() {
    var settings = {
        transport: document.getElementById('setting-transport').value,
        gatewayHost: document.getElementById('setting-gatewayHost').value.trim() || '127.0.0.1',
        gatewayPort: parseInt(document.getElementById('setting-gatewayPort').value, 10) || 9200,
        wspCoPort: parseInt(document.getElementById('setting-wspCoPort').value, 10) || 9201,
        screenWidth: parseInt(document.getElementById('setting-screenWidth').value, 10) || 280,
        screenHeight: parseInt(document.getElementById('setting-screenHeight').value, 10) || 380,
    };
    vscodeApi.postMessage({ type: 'updateSettings', settings: settings });
    applyScreenSize(settings.screenWidth, settings.screenHeight);
    document.getElementById('settings-overlay').classList.remove('visible');
    setStatus('Settings updated');
}

function applyScreenSize(width, height) {
    var frame = document.querySelector('.wap-phone-frame');
    var screen = document.getElementById('phone-screen');
    if (frame) frame.style.width = width + 'px';
    if (screen) screen.style.height = height + 'px';
}

// Apply initial screen size when settings arrive
;(function() {
    var _origPopulate = populateSettings;
    populateSettings = function(settings) {
        _origPopulate(settings);
        applyScreenSize(settings.screenWidth, settings.screenHeight);
    };
})();

// Request initial settings on load
vscodeApi.postMessage({ type: 'getSettings' });

function escapeHtml(text) {
    var div = document.createElement('div');
    div.appendChild(document.createTextNode(text));
    return div.innerHTML;
}
