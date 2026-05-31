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

// ── State (browser-specific; wmlHistory & wmlVars are in wml-engine.js) ──
var deckHistory = [];      // stack of {url, method, postfields} for cross-deck back
var currentUrl = '';       // current deck URL
var currentFetch = { method: 'get', postfields: null }; // how the current deck was fetched

// ── Address bar ──────────────────────────────────────────────────

function doNavigate() {
    var url = document.getElementById('url-input').value.trim();
    if (!url) return;
    // Auto-add http:// if no scheme
    if (!/^https?:\/\//i.test(url)) {
        url = 'http://' + url;
        document.getElementById('url-input').value = url;
    }
    navigateToUrl(url);
}

function doBack() {
    if (deckHistory.length > 0) {
        var prev = deckHistory.pop();
        document.getElementById('url-input').value = prev.url;
        currentUrl = prev.url;
        // Restore how this deck was originally fetched so POST decks re-issue
        // their post data on back navigation (WAP-191 §9.2, §12.5.2).
        currentFetch = { method: prev.method || 'get', postfields: prev.postfields || null };
        vscodeApi.postMessage({
            type: 'navigate',
            url: prev.url,
            postfields: prev.postfields || null,
            method: prev.method || 'get',
        });
    }
}

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
    if (e.key === 'Enter') {
        doNavigate();
    }
});

// ── Navigation ───────────────────────────────────────────────────

function navigateToUrl(url, postfields, method, sendreferer, isLink) {
    // Resolve relative URLs
    if (currentUrl && !url.match(/^https?:\/\//i)) {
        try {
            url = new URL(url, currentUrl).toString();
        } catch(e) { /* use as-is */ }
    }

    // Check for WMLScript call
    if (url.indexOf('.wmls#') >= 0 || url.indexOf('.wmls%23') >= 0) {
        executeWmlScript(url);
        return;
    }

    // Check for fragment-only navigation (card switch within deck)
    if (url.startsWith('#')) {
        showCard(url.substring(1));
        return;
    }

    // Check if it's same-deck card navigation (e.g. "deck.wml#card2")
    try {
        var parsed = new URL(url);
        var baseUrl = parsed.origin + parsed.pathname + parsed.search;
        var currentBase = '';
        if (currentUrl) {
            var parsedCurrent = new URL(currentUrl);
            currentBase = parsedCurrent.origin + parsedCurrent.pathname + parsedCurrent.search;
        }
        if (baseUrl === currentBase && parsed.hash) {
            showCard(parsed.hash.substring(1));
            return;
        }
    } catch(e) { /* not a valid URL, send to extension anyway */ }

    // Save current deck (and how it was fetched) in deck history for back nav.
    var fromUrl = currentUrl;
    if (currentUrl) {
        deckHistory.push({ url: currentUrl, method: currentFetch.method, postfields: currentFetch.postfields });
    }

    currentUrl = url;
    currentFetch = { method: method || 'get', postfields: postfields || null };
    document.getElementById('url-input').value = url;

    setStatus('Loading ' + url + '...');
    vscodeApi.postMessage({
        type: 'navigate',
        url: url,
        postfields: postfields || null,
        method: method || 'get',
        // sendreferer="true" → send the referring deck URL (WAP-191 §9.5.1)
        referer: sendreferer ? fromUrl : null,
        // Referring deck for deck access control — only for in-deck links, not
        // user-initiated address-bar / history navigation (WAP-191 §11.3.1).
        fromDeck: isLink ? fromUrl : null
    });
}

function executeWmlScript(href) {
    // Parse "script.wmls#func(args)" — handle both encoded and decoded '#'
    var normalizedHref = href.replace('.wmls%23', '.wmls#');
    var hashIdx = normalizedHref.indexOf('.wmls#');
    var scriptUrl = normalizedHref.substring(0, hashIdx + 5);
    var callPart = normalizedHref.substring(hashIdx + 6);
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
        wmlVars: varsSnapshot
    });
}

// ── Navigation (browser-specific: wmlNavigate, wmlPrevDeck hook) ─

// Cross-deck Back hook (called by wml-engine.js's wmlPrev when a deck's card
// history is exhausted): step back through the browser's deck history.
function wmlPrevDeck() {
    doBack();
}

function wmlNavigate(href, postfields, method, sendreferer) {
    href = substituteVars(href, true);  // %HREF context → default escape conversion
    if (href.startsWith('#')) {
        showCard(href.substring(1));
    } else if (href.indexOf('.wmls#') >= 0 || href.indexOf('.wmls%23') >= 0) {
        executeWmlScript(href);
    } else if (/\.wml#/.test(href)) {
        // Same-deck or cross-deck card reference
        var hashIdx = href.indexOf('#');
        var deckPart = href.substring(0, hashIdx);
        var cardPart = href.substring(hashIdx + 1);
        // Check if it's the same deck
        if (!deckPart || deckPart === '') {
            showCard(cardPart);
        } else {
            // Different deck: navigate then show card
            navigateToUrl(href, postfields, method, sendreferer, true);
        }
    } else {
        navigateToUrl(href, postfields, method, sendreferer, true);
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

function renderDeck(data) {
    var screen = document.getElementById('phone-screen');
    wmlHistory = [];  // reset intra-deck history
    wmlVars = data.vars || {};

    screen.innerHTML = data.cardsHtml;

    // Update title
    var titleEl = document.getElementById('card-title');
    if (titleEl && data.firstCardTitle) {
        titleEl.textContent = data.firstCardTitle;
    }

    // Navigate to specific card if URL has fragment
    var targetCard = null;
    if (data.fragment) {
        targetCard = document.getElementById(data.fragment);
    }

    // Wire up form elements
    initFormElements();

    // Show first card or target card
    var firstCard = targetCard || document.querySelector('.wml-card');
    if (firstCard) {
        document.querySelectorAll('.wml-card').forEach(function(c) { c.style.display = 'none'; });
        firstCard.style.display = 'block';
        if (titleEl) titleEl.textContent = firstCard.getAttribute('data-title') || firstCard.id;
        processOnEvent(firstCard, 'onenterforward');
        if (firstCard.style.display !== 'none') {
            updateSoftkeys(firstCard);
            processTimers(firstCard);
        }
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

/** Resolve an image src to an absolute URL using currentUrl as base. */
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

        case 'error':
            setStatus(msg.message, true);
            var screen = document.getElementById('phone-screen');
            screen.innerHTML = '<div class="browser-welcome"><h2>Error</h2><p>' +
                escapeHtml(msg.message) + '</p></div>';
            break;

        case 'wmlscriptResult':
            // WMLScript VM finished: apply variable changes and navigation
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
                    img.alt = '[image]';
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

// Close menu when clicking outside
document.addEventListener('click', function(e) {
    var menu = document.getElementById('browser-menu');
    var btn = document.getElementById('btn-menu');
    if (menu.classList.contains('visible') && !menu.contains(e.target) && e.target !== btn) {
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
        list.innerHTML = '<div class="downloads-empty">No downloads yet.</div>';
        return;
    }
    var html = '';
    for (var i = downloads.length - 1; i >= 0; i--) {
        var d = downloads[i];
        var sizeStr = d.size < 1024 ? d.size + ' B' :
            d.size < 1048576 ? (d.size / 1024).toFixed(1) + ' KB' :
            (d.size / 1048576).toFixed(1) + ' MB';
        var dateStr = new Date(d.date).toLocaleString();
        html += '<div class="download-item">' +
            '<div class="download-info">' +
                '<span class="download-name">' + escapeHtml(d.name) + '</span>' +
                '<span class="download-meta">' + sizeStr + ' \u2022 ' + dateStr + '</span>' +
            '</div>' +
            '<div class="download-actions">' +
                '<button class="download-action-btn" onclick="doOpenDownload(\'' + escapeHtml(d.path).replace(/'/g, "\\'") + '\')" title="Open">\u{1F4C4}</button>' +
                '<button class="download-action-btn" onclick="doRevealDownload(\'' + escapeHtml(d.path).replace(/'/g, "\\'") + '\')" title="Show in folder">\u{1F4C2}</button>' +
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
        list.innerHTML = '<div class="downloads-empty">No history yet.</div>';
        return;
    }
    var html = '';
    for (var i = history.length - 1; i >= 0; i--) {
        var h = history[i];
        var dateStr = new Date(h.date).toLocaleString();
        var safeUrl = escapeHtml(h.url).replace(/'/g, "\\'");
        html += '<div class="download-item history-item" onclick="doNavigateFromHistory(\'' + safeUrl + '\')">' +
            '<div class="download-info">' +
                '<span class="download-name">' + escapeHtml(h.title) + '</span>' +
                '<span class="download-meta">' + escapeHtml(h.url) + '</span>' +
                '<span class="download-meta">' + dateStr + '</span>' +
            '</div>' +
        '</div>';
    }
    list.innerHTML = html;
}

function doNavigateFromHistory(url) {
    document.getElementById('history-overlay').classList.remove('visible');
    document.getElementById('url-input').value = url;
    navigateToUrl(url);
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
    if (screen) screen.style.minHeight = height + 'px';
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
