/**
 * Copyright (C) 2026 Jabez Winston
 *
 * SPDX-License-Identifier: Apache-2.0
 * 
 * Date : 09-April-2026
 *
 * WML Navigation Engine — Shared core for preview and browser environments.
 *
 * Provides: variable substitution, card navigation, softkeys, timers,
 * format mask enforcement, and event handling.
 *
 * Environment-specific code must define before use:
 *   - wmlNavigate(href, postfields, method)
 *   - executeWmlScript(href)
 * And may optionally define:
 *   - wmlPrevDeck()      (cross-deck Back once a deck's card history is spent;
 *                         default: no-op, i.e. intra-deck Back only)
 */

// ── State ────────────────────────────────────────────────────────
var wmlHistory = [];
var wmlVars = {};

// ── Variable Substitution ────────────────────────────────────────

// Substitute $(var:mode) patterns in a string with current variable values.
// Modes: :escape (URL-encode), :unesc (URL-decode), :noesc (no conversion).
//
// Per WAP-191 §10.3.1 (rule WML-S-65): attributes of type %HREF default to the
// `escape` conversion, while everywhere else the default is `noesc`. Only the
// substituted *value* is escaped — literal URL text (scheme, '/', '?', '&') is
// left untouched. Pass hrefContext=true when substituting into an href/URL.
// $$ is a literal dollar sign.

// WML 1.3 §10.3.1 escape conversion: RFC2396 URL-escape, lowercase %xx for
// every octet outside the unreserved set, of the value encoded in the charset
// the deck came in (§9.5.1, as the C browser does): wmlCharsetMap maps code
// points to bytes for a single-byte charset (from the host's deckContent);
// null means UTF-8.  A character the charset lacks goes as '?' (%3f).
// (URL.escapeString keeps its own §10.12 rule: the character's code.)
var URL_UNRESERVED = /[A-Za-z0-9\-_.!~*'()]/;
var wmlCharsetMap = null;
function pctByte(b) { return '%' + (b < 16 ? '0' : '') + b.toString(16); }
function escapeUrlString(val) {
    var out = '';
    for (var i = 0; i < val.length; i++) {
        var ch = val[i], code = val.charCodeAt(i);
        if (URL_UNRESERVED.test(ch)) { out += ch; }
        else if (code < 0x80) { out += pctByte(code); }
        else if (wmlCharsetMap) {
            var b = wmlCharsetMap[code];
            out += b !== undefined ? pctByte(b) : '%3f';
        } else {
            var pair = code >= 0xD800 && code <= 0xDBFF && i + 1 < val.length;
            out += encodeURIComponent(pair ? val.substr(i++, 2) : ch).toLowerCase();
        }
    }
    return out;
}
// unesc: percent-decode; bytes that are not UTF-8 are read in the deck's
// charset (Latin-1 without a map).  A malformed value passes through.
function unescapeUrlString(val) {
    try { return decodeURIComponent(val); } catch (e) { /* not UTF-8 */ }
    var inv = {};
    if (wmlCharsetMap) {
        for (var cp in wmlCharsetMap) {
            if (wmlCharsetMap.hasOwnProperty(cp)) { inv[wmlCharsetMap[cp]] = +cp; }
        }
    }
    return val.replace(/%([0-9a-fA-F]{2})/g, function(m, h) {
        var b = parseInt(h, 16);
        return String.fromCharCode(b < 0x80 || !wmlCharsetMap ? b : (inv[b] || 0x3F));
    });
}

function substituteVars(str, hrefContext) {
    var defaultConv = hrefContext ? 'escape' : 'noesc';
    function convert(val, mode) {
        var conv = mode || defaultConv;
        if (conv === 'escape') { return escapeUrlString(val); }
        if (conv === 'unesc') { return unescapeUrlString(val); }
        return val; // noesc
    }
    return str.replace(/\$\(([A-Za-z_][A-Za-z0-9_]*)(?::(escape|noesc|unesc))?\)/g, function(m, name, mode) {
        if (wmlVars[name] === undefined) { return m; }
        return convert(wmlVars[name], mode);
    }).replace(/\$([A-Za-z_][A-Za-z0-9_]*)/g, function(m, name) {
        return wmlVars[name] !== undefined ? convert(wmlVars[name], null) : m;
    }).replace(/\$\$/g, '$');
}

// Apply setvars from a data-setvars attribute on an element
function applySetvars(el) {
    var setvarsAttr = el.getAttribute('data-setvars');
    if (setvarsAttr) {
        try {
            var setvars = JSON.parse(setvarsAttr);
            setvars.forEach(function(sv) {
                wmlVars[sv.name] = substituteVars(sv.value);
            });
        } catch(e) { /* ignore parse errors */ }
    }
}

// ── Postfields & Method helpers ──────────────────────────────────

// Extract postfields from a data-postfields attribute on an element
// Returns an array of {name, value} with variable substitution applied
function getPostfields(el) {
    var attr = el.getAttribute('data-postfields');
    if (!attr) { return []; }
    try {
        var pf = JSON.parse(attr);
        return pf.map(function(f) {
            return { name: f.name, value: substituteVars(f.value) };
        });
    } catch(e) { return []; }
}

// Get the HTTP method from an element's data-method attribute
function getMethod(el) {
    return (el.getAttribute('data-method') || 'get').toLowerCase();
}

// The accept-charset of a navigating <go> (WAP-191 §9.5.1), or null
function getAcceptCharset(el) {
    return el ? el.getAttribute('data-accept-charset') : null;
}

// Whether a navigating element requested sendreferer="true" (WAP-191 §9.5.1)
function getSendreferer(el) {
    return el.getAttribute('data-sendreferer') === 'true';
}

// ── Card Navigation ──────────────────────────────────────────────

// Process onevent elements (onenterforward, onenterbackward) on a card.
// Handles both the card-level attribute shorthand (data-onenterforward/data-onenterbackward)
// and child <onevent> elements (.wml-onevent).
function processOnEvent(card, eventType) {
    // Card-level attribute shorthand, e.g. onenterforward="#target"
    var attrHref = card.getAttribute('data-' + eventType);
    if (attrHref) {
        wmlNavigate(attrHref);
        return;
    }
    // <onevent> child elements
    card.querySelectorAll('.wml-onevent[data-type="' + eventType + '"]').forEach(function(e) {
        applySetvars(e);
        var href = e.getAttribute('data-href');
        var action = e.getAttribute('data-action');
        if (href) {
            var postfields = getPostfields(e);
            var method = getMethod(e);
            wmlNavigate(href, postfields, method, getSendreferer(e), getAcceptCharset(e));
        } else if (action === 'refresh') {
            updateVariables();
        } else if (action === 'prev') {
            wmlPrev();
        }
    });
}

function showCard(cardId) {
    var currentCard = document.querySelector('.wml-card[style*="display: block"], .wml-card[style*="display:block"]');

    if (currentCard) {
        wmlHistory.push(currentCard.id);
        currentCard.style.display = 'none';
    }

    var target = document.getElementById(cardId);
    if (target) {
        // Handle newcontext: clear all variables and history
        if (target.getAttribute('data-newcontext') === 'true') {
            wmlVars = {};
            wmlHistory = [];
        }
        target.style.display = 'block';
        var title = target.getAttribute('data-title') || cardId;
        var titleEl = document.getElementById('card-title');
        if (titleEl) titleEl.textContent = title;

        // Process onenterforward events
        processOnEvent(target, 'onenterforward');

        updateSoftkeys(target);
        updateVariables();
        processTimers(target);
    }
}

function wmlPrev() {
    if (wmlHistory.length === 0) {
        // Card history exhausted — let the environment step back across decks
        // (browser history / extension-host deck stack) if it provides a hook.
        if (typeof wmlPrevDeck === 'function') { wmlPrevDeck(); }
        return;
    }
    var prevId = wmlHistory.pop();
    document.querySelectorAll('.wml-card').forEach(function(c) { c.style.display = 'none'; });
    var target = document.getElementById(prevId);
    if (target) {
        target.style.display = 'block';
        var title = target.getAttribute('data-title') || prevId;
        var titleEl = document.getElementById('card-title');
        if (titleEl) titleEl.textContent = title;

        // Process onenterbackward events
        processOnEvent(target, 'onenterbackward');

        updateSoftkeys(target);
        updateVariables();
    }
}

function wmlRefresh() {
    var currentCard = document.querySelector('.wml-card[style*="display: block"], .wml-card[style*="display:block"]');
    if (currentCard) {
        currentCard.querySelectorAll('.wml-setvar').forEach(function(sv) {
            var name = sv.getAttribute('data-name');
            var value = sv.getAttribute('data-value');
            wmlVars[name] = substituteVars(value);
        });
        updateVariables();
    }
}

// ── Softkeys ─────────────────────────────────────────────────────

// Collect do-element actions for a card (used by softkeys and menu)
function getCardActions(card) {
    var actions = [];
    card.querySelectorAll('.wml-do').forEach(function(d) {
        var type = d.getAttribute('data-type') || 'accept';
        var label = d.textContent || type;
        var href = d.getAttribute('data-href');
        var action = d.getAttribute('data-action');
        actions.push({ type: type, label: label, href: href, action: action, el: d });
    });
    return actions;
}

function closeSoftkeyMenu() {
    var menu = document.getElementById('softkey-menu');
    var overlay = document.getElementById('softkey-overlay');
    if (menu) menu.classList.remove('visible');
    if (overlay) overlay.classList.remove('visible');
}

function wmlSoftkeyLeft() {
    var currentCard = document.querySelector('.wml-card[style*="display: block"], .wml-card[style*="display:block"]');
    if (!currentCard) return;
    var actions = getCardActions(currentCard);
    // Filter to left-key actions (non-prev types)
    var leftActions = actions.filter(function(a) { return a.type !== 'prev'; });
    if (leftActions.length === 0) return;
    if (leftActions.length === 1) {
        // Single action: execute directly
        triggerAction(leftActions[0]);
    } else {
        // Multiple actions: show options menu
        showSoftkeyMenu(leftActions);
    }
}

function showSoftkeyMenu(actions) {
    var menu = document.getElementById('softkey-menu');
    var overlay = document.getElementById('softkey-overlay');
    if (!menu) return;
    menu.innerHTML = '';
    actions.forEach(function(a) {
        var item = document.createElement('button');
        item.className = 'softkey-menu-item';
        item.textContent = a.label;
        item.addEventListener('click', function() {
            closeSoftkeyMenu();
            triggerAction(a);
        });
        menu.appendChild(item);
    });
    menu.classList.add('visible');
    if (overlay) overlay.classList.add('visible');
}

function triggerAction(action) {
    // Apply setvars from the triggering element before navigating
    if (action.el) { applySetvars(action.el); }
    if (action.href) {
        var postfields = action.el ? getPostfields(action.el) : [];
        var method = action.el ? getMethod(action.el) : 'get';
        wmlNavigate(action.href, postfields, method, action.el ? getSendreferer(action.el) : false,
                    getAcceptCharset(action.el));
    } else if (action.action === 'prev') {
        wmlPrev();
    } else if (action.action === 'refresh') {
        updateVariables();
    }
}

function wmlSoftkeyRight() {
    closeSoftkeyMenu();
    wmlPrev();
}

function updateSoftkeys(card) {
    var leftBtn = document.getElementById('softkey-left');
    var rightBtn = document.getElementById('softkey-right');
    if (!leftBtn || !rightBtn) return;
    closeSoftkeyMenu();

    var actions = getCardActions(card);
    var leftActions = actions.filter(function(a) { return a.type !== 'prev'; });
    rightBtn.textContent = 'Back';

    if (leftActions.length === 0) {
        leftBtn.textContent = '';
    } else if (leftActions.length === 1) {
        leftBtn.textContent = leftActions[0].label;
    } else {
        // Multiple do elements: show "Options" label
        leftBtn.textContent = 'Options';
    }
}

// ── Timers ───────────────────────────────────────────────────────

function processTimers(card) {
    card.querySelectorAll('.wml-timer').forEach(function(t) {
        var value = parseInt(t.getAttribute('data-value') || '0', 10);
        if (value > 0) {
            setTimeout(function() {
                if (card.style.display !== 'none') {
                    card.querySelectorAll('.wml-onevent[data-type="ontimer"]').forEach(function(e) {
                        wmlNavigate(e.getAttribute('data-href') || '');
                    });
                    var ontimer = card.getAttribute('data-ontimer');
                    if (ontimer) wmlNavigate(ontimer);
                }
            }, value * 100);
        }
    });
}

// ── Variable Display ─────────────────────────────────────────────

/**
 * Apply a WML variable conversion (WML 1.3 §10.3.1).
 *
 *   escape  URL-encode the value      $(x:escape) with x="a b" -> "a%20b"
 *   unesc   URL-decode the value      $(x:unesc)  with x="a%20b" -> "a b"
 *   noesc   leave it alone (the default in text content)
 *
 * A value that is not valid percent-encoding cannot be decoded; WML has no
 * error path for that, so it is passed through rather than thrown away.
 */
function wmlConvertValue(value, conversion) {
    if (conversion === 'escape') {
        return encodeURIComponent(value);
    }
    if (conversion === 'unesc') {
        try { return decodeURIComponent(value); } catch (e) { return value; }
    }
    return value;
}

function updateVariables() {
    // WML 1.3 §10.3.1: substituting an unset variable yields the empty
    // string.
    // wmlTransform emits a "[name]" placeholder for every reference, which is
    // the right thing for the editor preview — an author wants to see which
    // variables a deck uses before any are set — and the wrong thing for a
    // browser, where it puts text on screen that the deck never wrote. A
    // browser sets WML_STRICT_VARS (see browser.js) to get the spec behaviour;
    // the preview leaves it unset and keeps its placeholders.
    var strictVars = typeof window !== 'undefined' && !!window.WML_STRICT_VARS;
    document.querySelectorAll('.wml-var').forEach(function(s) {
        var name = s.getAttribute('data-var');
        if (!name) { return; }
        if (wmlVars[name] !== undefined) {
            s.textContent = wmlConvertValue(wmlVars[name], s.getAttribute('data-conv'));
        } else if (strictVars) {
            s.textContent = '';
        }
    });
    // Sync wmlVars back to input fields
    document.querySelectorAll('.wml-input').forEach(function(inp) {
        var name = inp.getAttribute('name');
        if (name && wmlVars[name] !== undefined && inp.value !== wmlVars[name]) {
            inp.value = wmlVars[name];
        }
    });
    // Sync wmlVars back to select elements
    document.querySelectorAll('.wml-select').forEach(function(sel) {
        var name = sel.getAttribute('name');
        var iname = sel.getAttribute('data-iname') || '';
        if (name && wmlVars[name] !== undefined) {
            if (sel.multiple) {
                var values = wmlVars[name].split(';');
                for (var i = 0; i < sel.options.length; i++) {
                    sel.options[i].selected = values.indexOf(sel.options[i].value) !== -1;
                }
            } else if (sel.value !== wmlVars[name]) {
                sel.value = wmlVars[name];
            }
        }
        // Sync iname variable: update selected index display
        if (iname && wmlVars[iname] !== undefined) {
            var indices = [];
            for (var i = 0; i < sel.options.length; i++) {
                if (sel.options[i].selected) indices.push(i + 1);
            }
            var currentIndices = indices.join(';');
            if (currentIndices !== wmlVars[iname]) {
                // Restore selection from iname variable
                var storedIndices = wmlVars[iname].split(';');
                if (sel.multiple) {
                    for (var i = 0; i < sel.options.length; i++) sel.options[i].selected = false;
                }
                storedIndices.forEach(function(idx) {
                    var n = parseInt(idx, 10);
                    if (n >= 1 && n <= sel.options.length) {
                        sel.options[n - 1].selected = true;
                    }
                });
            }
        }
    });
}

// ── WMLScript argument parsing ───────────────────────────────────

// Parse the argument list of a `script.wmls#func(...)` fragment call.
// Returns an array of { value, quoted } tokens. `quoted` records whether the
// token was written as a string literal ('...' or "..."), which WMLScript 1.x
// §8.3.4 says determines its type: a quoted token is passed as a String, an
// unquoted token keeps its literal type (integer/float/boolean/invalid). The
// caller's convertArgs/convertWmlsArgs coerce only unquoted tokens.
//
// Split on commas that are not inside quotes, then classify each segment: a
// segment that (after trimming surrounding whitespace) is wrapped in matching
// quotes is a string literal whose inner text is kept verbatim; anything else
// is an unquoted literal and is trimmed.
function parseWmlScriptArgs(argsStr) {
    var args = [];
    if (!argsStr || argsStr.trim().length === 0) return args;

    var segments = [];
    var cur = '', inQuote = false, quoteChar = '';
    for (var i = 0; i < argsStr.length; i++) {
        var ch = argsStr[i];
        if (inQuote) {
            cur += ch;
            if (ch === quoteChar) { inQuote = false; }
        } else if (ch === "'" || ch === '"') {
            inQuote = true; quoteChar = ch; cur += ch;
        } else if (ch === ',') {
            segments.push(cur); cur = '';
        } else {
            cur += ch;
        }
    }
    segments.push(cur);

    for (var s = 0; s < segments.length; s++) {
        var tok = segments[s].trim();
        var first = tok.charAt(0);
        if (tok.length >= 2 && (first === "'" || first === '"') && tok.charAt(tok.length - 1) === first) {
            args.push({ value: tok.slice(1, -1), quoted: true });
        } else {
            args.push({ value: tok, quoted: false });
        }
    }
    return args;
}

// ── Format Mask Enforcement ──────────────────────────────────────

var FORMAT_CODES = {
    'A': /[A-Z\u0021-\u002F\u003A-\u0040\u005B-\u0060\u007B-\u007E]/,
    'a': /[a-z\u0021-\u002F\u003A-\u0040\u005B-\u0060\u007B-\u007E]/,
    'N': /[0-9]/,
    'n': /[0-9\u0021-\u002F\u003A-\u0040\u005B-\u0060\u007B-\u007E]/,
    'X': /[A-Z0-9\u0021-\u002F\u003A-\u0040\u005B-\u0060\u007B-\u007E]/,
    'x': /[a-z0-9\u0021-\u002F\u003A-\u0040\u005B-\u0060\u007B-\u007E]/,
    'M': /[\s\S]/,
    'm': /[\s\S]/
};

/** Parse a WML format mask into an array of slot descriptors. */
function parseFormatSlots(fmt) {
    if (!fmt) return null;
    var slots = [];
    var i = 0;
    while (i < fmt.length) {
        if (fmt[i] === '\\') {
            // literal escape
            if (i + 1 < fmt.length) {
                slots.push({ type: 'literal', char: fmt[i + 1] });
            }
            i += 2;
            continue;
        }
        if (fmt[i] === '*') {
            if (i + 1 < fmt.length && FORMAT_CODES[fmt[i + 1]]) {
                slots.push({ type: 'star', code: fmt[i + 1] });
            }
            i += 2;
            continue;
        }
        var count = '';
        while (i < fmt.length && fmt[i] >= '0' && fmt[i] <= '9') {
            count += fmt[i]; i++;
        }
        if (i < fmt.length && FORMAT_CODES[fmt[i]]) {
            var n = count ? parseInt(count, 10) : 1;
            for (var j = 0; j < n; j++) {
                slots.push({ type: 'char', code: fmt[i] });
            }
            i++;
        } else {
            i++;
        }
    }
    return slots.length > 0 ? slots : null;
}

/**
 * Filter an input value through format mask slots:
 * - Auto-insert literal characters at the right positions.
 * - Drop characters that don't match the expected format code.
 * - Apply case transformations for A/X/M (uppercase) and a/x/m (lowercase).
 */
function applyFormatMask(value, slots) {
    if (!slots) return value;
    var result = '';
    var vi = 0; // position in user value
    var si = 0; // position in slots
    while (si < slots.length && vi <= value.length) {
        var slot = slots[si];
        if (slot.type === 'literal') {
            result += slot.char;
            // If the user typed the literal character, skip over it
            if (vi < value.length && value[vi] === slot.char) { vi++; }
            si++;
            continue;
        }
        if (slot.type === 'star') {
            // Consume remaining chars that match
            var re = FORMAT_CODES[slot.code];
            while (vi < value.length) {
                var ch = value[vi];
                if (re.test(ch)) {
                    result += transformCase(ch, slot.code);
                    vi++;
                } else {
                    // Try case-transforming first
                    var transformed = transformCase(ch, slot.code);
                    if (re.test(transformed)) {
                        result += transformed;
                        vi++;
                    } else {
                        vi++; // skip invalid char
                    }
                }
            }
            si++;
            continue;
        }
        // type === 'char'
        if (vi >= value.length) break;
        var ch = value[vi];
        var re = FORMAT_CODES[slot.code];
        var transformed = transformCase(ch, slot.code);
        if (re.test(transformed)) {
            result += transformed;
            vi++;
            si++;
        } else {
            vi++; // skip invalid char, don't advance slot
        }
    }
    return result;
}

function transformCase(ch, code) {
    if (code === 'A' || code === 'X' || code === 'M') return ch.toUpperCase();
    if (code === 'a' || code === 'x' || code === 'm') return ch.toLowerCase();
    return ch;
}

// ── Common Event Delegation ──────────────────────────────────────

function initWmlEventDelegation() {
    // Event delegation: handle clicks on elements with data-href
    document.addEventListener('click', function(e) {
        var el = e.target.closest('[data-href]');
        if (el && !el.classList.contains('wml-onevent') && !el.classList.contains('softkey-menu-item')) {
            e.preventDefault();
            applySetvars(el);
            var postfields = getPostfields(el);
            var method = getMethod(el);
            wmlNavigate(el.getAttribute('data-href'), postfields, method, getSendreferer(el),
                        getAcceptCharset(el));
            return;
        }
        var actionEl = e.target.closest('[data-action]');
        if (actionEl && !actionEl.classList.contains('wml-onevent')) {
            e.preventDefault();
            applySetvars(actionEl);
            var action = actionEl.getAttribute('data-action');
            if (action === 'prev') wmlPrev();
            else if (action === 'refresh') {
                wmlRefresh();
            }
            return;
        }
    });

    // Close menu when clicking overlay
    var overlay = document.getElementById('softkey-overlay');
    if (overlay) {
        overlay.addEventListener('click', closeSoftkeyMenu);
    }

    // Handle accesskey: pressing a key activates the matching element in the current card
    document.addEventListener('keydown', function(e) {
        // Skip if user is typing in an input or select
        var tag = (e.target.tagName || '').toLowerCase();
        if (tag === 'input' || tag === 'textarea' || tag === 'select') return;

        var key = e.key;
        var currentCard = document.querySelector('.wml-card[style*="display: block"], .wml-card[style*="display:block"]');
        if (!currentCard) return;

        var el = currentCard.querySelector('[data-accesskey="' + CSS.escape(key) + '"]');
        if (!el) return;

        e.preventDefault();
        var href = el.getAttribute('data-href');
        var action = el.getAttribute('data-action');
        applySetvars(el);
        if (href) {
            var postfields = getPostfields(el);
            var method = getMethod(el);
            wmlNavigate(href, postfields, method, getSendreferer(el), getAcceptCharset(el));
        } else if (action === 'prev') {
            wmlPrev();
        } else if (action === 'refresh') {
            wmlRefresh();
        }
    });
}

// ── Common Form Initialization ───────────────────────────────────

function initWmlFormElements() {
    // Normalize table rows to the declared column count, then apply alignment.
    // Per WAP-191 §11.8.5: rows with fewer cells than `columns` are padded with
    // empty cells; rows with more cells aggregate the surplus into the last
    // column, separated by a single inter-word space.
    document.querySelectorAll('.wml-table').forEach(function(table) {
        var cols = parseInt(table.getAttribute('data-columns') || '0', 10);
        var alignStr = table.getAttribute('data-align') || '';
        table.querySelectorAll('tr').forEach(function(tr) {
            var tds = Array.prototype.slice.call(tr.querySelectorAll('td'));
            if (cols > 0) {
                if (tds.length > cols) {
                    var last = tds[cols - 1];
                    for (var k = cols; k < tds.length; k++) {
                        last.innerHTML += ' ' + tds[k].innerHTML;
                        tds[k].parentNode.removeChild(tds[k]);
                    }
                    tds = tds.slice(0, cols);
                } else if (tds.length < cols) {
                    for (var p = tds.length; p < cols; p++) {
                        var pad = document.createElement('td');
                        tr.appendChild(pad);
                        tds.push(pad);
                    }
                }
            }
            if (alignStr) {
                for (var i = 0; i < tds.length; i++) {
                    var ac = (i < alignStr.length) ? alignStr[i].toUpperCase() : 'L';
                    if (ac === 'C' || ac === 'R' || ac === 'L') {
                        tds[i].classList.add('align-' + ac);
                    }
                }
            }
        });
    });

    document.querySelectorAll('.wml-input').forEach(function(inp) {
        var name = inp.getAttribute('name');
        var fmt = inp.getAttribute('data-format') || '';
        var slots = parseFormatSlots(fmt);
        if (name) {
            if (wmlVars[name] !== undefined) inp.value = wmlVars[name];
            else wmlVars[name] = inp.value;
            inp.addEventListener('input', function() {
                if (slots) {
                    var pos = inp.selectionStart;
                    var filtered = applyFormatMask(inp.value, slots);
                    if (filtered !== inp.value) {
                        inp.value = filtered;
                        // Try to restore cursor position reasonably
                        var newPos = Math.min(pos, filtered.length);
                        inp.setSelectionRange(newPos, newPos);
                    }
                }
                wmlVars[name] = inp.value;
                updateVariables();
            });
        }
    });
    // Select-list initialisation per WAP-191 §11.6.2.1 (validate operation +
    // iname/ivalue/name/value precedence; single-choice treats a value
    // containing ';' as one literal value rather than a list).
    document.querySelectorAll('.wml-select').forEach(function(sel) {
        var name = sel.getAttribute('name');
        var iname = sel.getAttribute('data-iname') || '';
        var ivalue = sel.getAttribute('data-ivalue') || '';
        var value = sel.getAttribute('data-value');
        var isMultiple = sel.multiple;
        var nOpts = sel.options.length;

        // validate(): drop non-integer, out-of-range and duplicate indices.
        function validateIndices(list) {
            var seen = {}, out = [];
            list.forEach(function(s) {
                s = (s || '').trim();
                if (!/^[0-9]+$/.test(s)) { return; }
                var n = parseInt(s, 10);
                if (n < 1 || n > nOpts || seen[n]) { return; }
                seen[n] = 1; out.push(n);
            });
            return out;
        }
        function firstIndexOfValue(v) {
            for (var i = 0; i < nOpts; i++) { if (sel.options[i].value === v) { return i + 1; } }
            return 0;
        }
        function valuesToIndices(raw) {
            var out = [];
            var vals = isMultiple ? raw.split(';') : [raw];  // single-choice: literal value
            vals.forEach(function(v) {
                var idx = firstIndexOfValue(v);
                if (idx && out.indexOf(idx) < 0) { out.push(idx); }
            });
            return out;
        }

        // Step 1 — default option index (precedence: iname, ivalue, name, value).
        var defIdx = [];
        if (iname && wmlVars[iname] !== undefined && wmlVars[iname] !== '') {
            defIdx = validateIndices(wmlVars[iname].split(';'));
        }
        if (defIdx.length === 0 && ivalue) {
            defIdx = validateIndices(ivalue.split(';'));
        }
        if (defIdx.length === 0 && name && wmlVars[name] !== undefined && wmlVars[name] !== '') {
            defIdx = valuesToIndices(wmlVars[name]);
        }
        if (defIdx.length === 0 && value) {
            defIdx = valuesToIndices(value);
        }
        if (defIdx.length === 0 && !isMultiple && nOpts > 0) {
            defIdx = [1];
        }
        if (!isMultiple && defIdx.length > 1) { defIdx = [defIdx[0]]; }

        // Step 3 — pre-select option(s) named by the default index.
        for (var i = 0; i < nOpts; i++) { sel.options[i].selected = false; }
        defIdx.forEach(function(n) { sel.options[n - 1].selected = true; });

        // Step 2 — commit name / iname variables from the current selection.
        function commitVars() {
            var selIdx = [];
            for (var j = 0; j < nOpts; j++) { if (sel.options[j].selected) { selIdx.push(j + 1); } }
            if (name) {
                if (isMultiple) {
                    var nv = [];
                    selIdx.forEach(function(n) { var v = sel.options[n - 1].value; if (v !== '') { nv.push(v); } });
                    wmlVars[name] = nv.join(';');
                } else {
                    var sv = selIdx.length ? sel.options[selIdx[0] - 1].value : '';
                    if (sv === '') { delete wmlVars[name]; } else { wmlVars[name] = sv; }
                }
            }
            if (iname) { wmlVars[iname] = selIdx.join(';'); }
        }
        commitVars();

        sel.addEventListener('change', function() {
            commitVars();
            updateVariables();
        });
    });
    updateVariables();
}

// ── WMLScript Dialogs UI (WAP-194 §13) ───────────────────────────
// Shared by the WAP Browser and the WML preview so Dialogs.alert / confirm /
// prompt look and behave identically in both. Drives the #dialog-overlay modal
// markup (see wmlToHtml.ts / browserPanel.ts) and returns a Promise resolving to:
//   alert   → ""                 (OK only)
//   confirm → true | false       (per the chosen button)
//   prompt  → entered string     (Cancel → the supplied default)
// `opts` may carry { def, okLabel, cancelLabel }. When the modal markup is
// absent (e.g. a stripped-down host) it falls back to native window dialogs.
var _wmlDialogResolve = null;

function wmlShowDialog(type, message, opts) {
    opts = opts || {};
    var overlay = (typeof document !== 'undefined') ? document.getElementById('dialog-overlay') : null;
    var msgEl = overlay && document.getElementById('dialog-message');
    var inputEl = overlay && document.getElementById('dialog-input');
    var okBtn = overlay && document.getElementById('dialog-ok');
    var cancelBtn = overlay && document.getElementById('dialog-cancel');

    // No modal markup available → native dialogs / safe defaults.
    if (!overlay || !msgEl || !okBtn) {
        return Promise.resolve(wmlNativeDialog(type, message, opts));
    }

    var def = (opts.def !== undefined && opts.def !== null) ? String(opts.def) : '';
    msgEl.textContent = String(message);
    okBtn.textContent = opts.okLabel ? String(opts.okLabel) : 'OK';
    if (cancelBtn) { cancelBtn.textContent = opts.cancelLabel ? String(opts.cancelLabel) : 'Cancel'; }

    if (type === 'prompt') {
        if (inputEl) { inputEl.style.display = 'block'; inputEl.value = def; }
        if (cancelBtn) { cancelBtn.style.display = 'inline-block'; }
    } else if (type === 'confirm') {
        if (inputEl) { inputEl.style.display = 'none'; }
        if (cancelBtn) { cancelBtn.style.display = 'inline-block'; }
    } else { // alert
        if (inputEl) { inputEl.style.display = 'none'; }
        if (cancelBtn) { cancelBtn.style.display = 'none'; }
    }

    overlay.classList.add('visible');
    if (type === 'prompt' && inputEl) { inputEl.focus(); inputEl.select(); }

    return new Promise(function(resolve) {
        _wmlDialogResolve = function(confirmed) {
            overlay.classList.remove('visible');
            _wmlDialogResolve = null;
            if (type === 'alert') { resolve(''); }
            else if (type === 'confirm') { resolve(!!confirmed); }
            else { resolve(confirmed ? (inputEl ? inputEl.value : def) : def); }  // prompt: Cancel → default
        };
        okBtn.onclick = function() { if (_wmlDialogResolve) { _wmlDialogResolve(true); } };
        if (cancelBtn) { cancelBtn.onclick = function() { if (_wmlDialogResolve) { _wmlDialogResolve(false); } }; }
        if (inputEl) {
            inputEl.onkeydown = function(e) {
                if (e.key === 'Enter') { if (_wmlDialogResolve) { _wmlDialogResolve(true); } }
                else if (e.key === 'Escape') { if (_wmlDialogResolve) { _wmlDialogResolve(false); } }
            };
        }
    });
}

// Fallback for hosts without the modal markup (e.g. plain stdout). Mirrors the
// WAP-194 return contract of wmlShowDialog using the browser's native dialogs.
function wmlNativeDialog(type, message, opts) {
    opts = opts || {};
    var def = (opts.def !== undefined && opts.def !== null) ? String(opts.def) : '';
    if (typeof window === 'undefined') {
        return type === 'confirm' ? true : (type === 'prompt' ? def : '');
    }
    if (type === 'alert') { if (window.alert) { window.alert(String(message)); } return ''; }
    if (type === 'confirm') { return window.confirm ? window.confirm(String(message)) : true; }
    var r = window.prompt ? window.prompt(String(message), def) : def;  // prompt
    return (r !== null && r !== undefined) ? r : def;
}
