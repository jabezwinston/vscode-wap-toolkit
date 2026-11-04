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
// Per WML 1.3: 10.3.1 (rule WML-S-65): attributes of type %HREF default to the
// `escape` conversion, while everywhere else the default is `noesc`. Only the
// substituted *value* is escaped — literal URL text (scheme, '/', '?', '&') is
// left untouched. Pass hrefContext=true when substituting into an href/URL.
// $$ is a literal dollar sign.

// WML 1.3: 10.3.1 Variable Substitution: the escape conversion, RFC2396 URL-escape, lowercase %xx for
// every octet outside the unreserved set, of the value encoded in the charset
// the deck came in (WML 1.3: 9.5.1, as the C browser does): wmlCharsetMap maps code
// points to bytes for a single-byte charset (from the host's deckContent);
// null means UTF-8.  A character the charset lacks goes as '?' (%3f).
// (URL.escapeString keeps its own WMLScript Libraries: 10.12 rule: the character's code.)
var URL_UNRESERVED = /[A-Za-z0-9\-_.!~*'()]/;
var wmlCharsetMap = null;
function pctByte(b) { return '%' + (b < 16 ? '0' : '') + b.toString(16); }
// WML 1.3:
//  - 10.3.1 Variable Substitution
//  - 9.5.1 The Go Element
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
// WML 1.3: 10.3.1 Variable Substitution
//
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

// WML 1.3: 10.3.1 Variable Substitution
//
// A conversion's name (WML 1.3: 10.3.1): noesc, escape or unesc, and the
// deprecated forms the same — any case, or the first letter alone (a
// prefix is taken, as wap-browser-c); null for none or another, which
// leaves the context's default
function convName(c) {
    var words = ['noesc', 'escape', 'unesc'];
    c = (c || '').toLowerCase();
    for (var i = 0; c && i < words.length; i++) {
        if (words[i].indexOf(c) === 0) { return words[i]; }
    }
    return null;
}

// WML 1.3:
//  - 10.3.1 Variable Substitution
//  - 10.3.2 Parsing the Variable Substitution Syntax
//  - 10.3.3 The Dollar-sign Character
function substituteVars(str, hrefContext) {
    var defaultConv = hrefContext ? 'escape' : 'noesc';
    function convert(val, mode) {
        var conv = convName(mode) || defaultConv;
        if (conv === 'escape') { return escapeUrlString(val); }
        if (conv === 'unesc') { return unescapeUrlString(val); }
        return val; // noesc
    }
    return str.replace(/\$\(([A-Za-z_][A-Za-z0-9_]*)(?::([A-Za-z]*))?\)/g, function(m, name, mode) {
        if (wmlVars[name] === undefined) { return m; }
        return convert(wmlVars[name], mode);
    }).replace(/\$([A-Za-z_][A-Za-z0-9_]*)/g, function(m, name) {
        return wmlVars[name] !== undefined ? convert(wmlVars[name], null) : m;
    }).replace(/\$\$/g, '$');
}

// WML 1.3:
//  - 9.4 The Setvar Element
//  - 12.5.1 The Go Task
//
// A task's setvars (data-setvars on its element), substituted now — names
// too (vdata, WML 1.3: 9.4), all against the variables as they are
// (WML 1.3: 12.5.1 step 1).  commitSetvars() applies them at the destination card
// (go step 5, prev step 4); a task that fails never does (WML 1.3: 12.5.5).
function stageSetvars(el) {
    var staged = [];
    var setvarsAttr = el && el.getAttribute('data-setvars');
    if (setvarsAttr) {
        try {
            JSON.parse(setvarsAttr).forEach(function(sv) {
                staged.push({ name: substituteVars(sv.name), value: substituteVars(sv.value) });
            });
        } catch(e) { /* ignore parse errors */ }
    }
    return staged;
}

// A setvar whose name, substituted, is not a variable's is ignored (WML 1.3: 9.4)
var WML_VAR_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

// WML 1.3:
//  - 12.5.1 The Go Task
//  - 12.5.2 The Prev Task
//  - 12.5.4 The Refresh Task
function commitSetvars(staged) {
    (staged || []).forEach(function(sv) {
        if (WML_VAR_NAME.test(sv.name)) { wmlVars[sv.name] = sv.value; }
    });
}

// ── Postfields & Method helpers ──────────────────────────────────

// WML 1.3:
//  - 9.3 The Postfield Element
//  - 9.5.1 The Go Element
//
// Extract postfields from a data-postfields attribute on an element
// Returns an array of {name, value} with variable substitution applied
function getPostfields(el) {
    var attr = el.getAttribute('data-postfields');
    if (!attr) { return []; }
    try {
        var pf = JSON.parse(attr);
        return pf.map(function(f) {       // both vdata (WML 1.3: 9.5.1 step 1)
            return { name: substituteVars(f.name), value: substituteVars(f.value) };
        });
    } catch(e) { return []; }
}

// WML 1.3: 9.5.1 The Go Element
//
// Get the HTTP method from an element's data-method attribute
function getMethod(el) {
    return (el.getAttribute('data-method') || 'get').toLowerCase();
}

// WML 1.3: 9.5.1 The Go Element
//
// The accept-charset of a navigating <go> (WML 1.3: 9.5.1), or null
function getAcceptCharset(el) {
    return el ? el.getAttribute('data-accept-charset') : null;
}

// WML 1.3: 9.5.1 The Go Element
//
// Whether a navigating element requested sendreferer="true" (WML 1.3: 9.5.1)
function getSendreferer(el) {
    return el.getAttribute('data-sendreferer') === 'true';
}

// WML 1.3: 9.5.1 The Go Element
//
// Whether a go has cache-control="no-cache": fetched from the origin
// server, a card of this deck too, with the header (WML 1.3: 9.5.1)
function getNoCache(el) {
    return el.getAttribute('data-cache-control') === 'no-cache';
}

// ── Card Navigation ──────────────────────────────────────────────

// WML 1.3:
//  - 9.10.1 The Onevent Element
//  - 9.10.2 Card/Deck Intrinsic Events
//
// Process onevent elements (onenterforward, onenterbackward) on a card.
// Handles both the card-level attribute shorthand (data-onenterforward/data-onenterbackward)
// and child <onevent> elements (.wml-onevent).  True when the task is a
// go or a prev: the card entry stops there, before the timer
// (WML 1.3: 12.5.1 step 8, 12.5.2 step 5); a refresh has started it (WML 1.3: 12.5.4).
// A go to another card of the deck has entered that one; a go to another
// deck or a script leaves this card on screen meanwhile.
function processOnEvent(card, eventType) {
    // Card-level attribute shorthand, e.g. onenterforward="#target"
    var attrHref = card.getAttribute('data-' + eventType);
    if (attrHref) {
        wmlNavigate(attrHref);
        return true;
    }
    // <onevent> child elements
    var went = false;
    card.querySelectorAll('.wml-onevent[data-type="' + eventType + '"]').forEach(function(e) {
        var href = e.getAttribute('data-href');
        var action = e.getAttribute('data-action');
        runTask(e, href, action);
        went = went || !!href || action === 'prev';
    });
    return went;
}

// WML 1.3: 12.5 Reference Processing Behaviour - Inter-card Navigation
//
// Run the task of a go/prev/refresh element: its setvars are staged
// before the href and postfields are read (WML 1.3: 12.5.1 step 1).
// A refresh is an exit and an entry of the card (WML 1.3: 11.7): the timer stops,
// the setvars apply, `refresh` (default updateVariables) redraws, and the
// timer resumes (WML 1.3: 12.5.4 step 3).
function runTask(el, href, action, refresh) {
    var setvars = stageSetvars(el);
    if (href) {
        wmlNavigate(href, getPostfields(el), getMethod(el), getSendreferer(el),
                    getAcceptCharset(el), setvars, getNoCache(el));
    } else if (action === 'prev') {
        wmlPrev(setvars);
    } else if (action === 'refresh') {
        var left = timerLeft();
        commitSetvars(timerExit(setvars));
        (refresh || updateVariables)();
        var card = document.querySelector('.wml-card[style*="display: block"], .wml-card[style*="display:block"]');
        if (card) { processTimers(card, left); }
    }
}

// WML 1.3: 10.2 The Newcontext Attribute
//
// newcontext (WML 1.3: 10.2): no variables, and no history — the card
// history here, the environment's deck history through wmlClearHistory()
function wmlNewContext() {
    wmlVars = {};
    wmlHistory = [];
    if (typeof wmlClearHistory === 'function') { wmlClearHistory(); }
}

// WML 1.3:
//  - 5.2 Fragment Anchors
//  - 12.5.1 The Go Task
//
// The deck's card with this id; not another element of it (an id is a
// core attribute, WML 1.3: 8.9) or of the page
function findCard(id) {
    var cards = document.querySelectorAll('.wml-card');
    for (var i = 0; i < cards.length; i++) {
        if (cards[i].id === id) { return cards[i]; }
    }
    return null;
}

// WML 1.3:
//  - 11.5.2 The Card Element
//  - 10.3.1 Variable Substitution
//
// The card's title in the title bar: vdata, substituted (WML 1.3: 10.3.1)
function showCardTitle(card) {
    var titleEl = document.getElementById('card-title');
    if (titleEl && card) {
        titleEl.textContent = substituteVars(card.getAttribute('data-title') || card.id);
    }
}

// WML 1.3: 12.5.1 The Go Task
function showCard(cardId, setvars) {
    setvars = timerExit(setvars);
    var currentCard = document.querySelector('.wml-card[style*="display: block"], .wml-card[style*="display:block"]');

    if (currentCard) {
        wmlHistory.push(currentCard.id);
        currentCard.style.display = 'none';
    }

    // A fragment that names no card: the deck's first card (WML 1.3: 12.5.1 step 4c)
    var target = findCard(cardId) || document.querySelector('.wml-card');
    if (target) {
        commitSetvars(setvars);                 // WML 1.3: 12.5.1 step 5, then 6
        if (target.getAttribute('data-newcontext') === 'true') {
            wmlNewContext();
        }
        target.style.display = 'block';
        showCardTitle(target);

        // Process onenterforward events
        var went = processOnEvent(target, 'onenterforward');
        if (target.style.display === 'none') { return; }

        if (!went) { initCardFields(target); }
        updateSoftkeys(target);
        updateVariables();
        if (!went) { processTimers(target); }
    }
}

// WML 1.3: 12.5.2 The Prev Task
function wmlPrev(setvars) {
    if (wmlHistory.length === 0) {
        // Card history exhausted — let the environment step back across decks
        // (browser history / extension-host deck stack) if it provides a hook.
        if (typeof wmlPrevDeck === 'function') { wmlPrevDeck(setvars); }
        return;
    }
    setvars = timerExit(setvars);
    var prevId = wmlHistory.pop();
    document.querySelectorAll('.wml-card').forEach(function(c) { c.style.display = 'none'; });
    var target = findCard(prevId);
    if (target) {
        commitSetvars(setvars);                 // WML 1.3: 12.5.2 step 4
        target.style.display = 'block';
        showCardTitle(target);

        // Process onenterbackward events
        var went = processOnEvent(target, 'onenterbackward');
        if (target.style.display === 'none') { return; }

        if (!went) { initCardFields(target); }
        updateSoftkeys(target);
        updateVariables();
        if (!went) { processTimers(target); }   // WML 1.3: 12.5.2 step 6
    }
}

// WML 1.3: 12.5.4 The Refresh Task
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

// WML 1.3:
//  - 9.7 The Do Element
//  - 9.6 Card/Deck Task Shadowing
//  - 11.4 The Template Element
//
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

// WML 1.3: 9.7 The Do Element
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
    if (action.el) {
        runTask(action.el, action.href, action.action);
    } else if (action.href) {
        wmlNavigate(action.href, [], 'get', false, null);
    } else if (action.action === 'prev') {
        wmlPrev();
    } else if (action.action === 'refresh') {
        updateVariables();
    }
}

// WML 1.3: 9.7 The Do Element
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

// The card's timer starts at card entry and stops when the card is left
// (WML 1.3: 11.7): one runs at a time, so entering a card stops the last.
// On expiry a named timer's variable is "0", and the card's ontimer runs
// like any intrinsic event (WML 1.3: 9.10.2).
var wmlTimer = null;
var wmlTimerName = '';
var wmlTimerEnd = 0;

// WML 1.3: 11.7 The Timer Element
//
// The running timer's time left, in tenths of a second (0: none running)
function timerLeft() {
    return wmlTimer ? Math.max(1, Math.ceil((wmlTimerEnd - Date.now()) / 100)) : 0;
}

// WML 1.3: 11.7 The Timer Element
//
// Card exit, the execution of a task (WML 1.3: 11.7): the timer stops, and a named
// timer's variable is to be set with the time left.  That assignment is
// returned ahead of the task's `setvars`, so it is made where they are,
// after the exit (go step 7, prev step 4) and not when the task fails
// (WML 1.3: 12.5.5).
function timerExit(setvars) {
    var left = timerLeft();
    clearTimeout(wmlTimer);
    wmlTimer = null;
    if (!left || !wmlTimerName) { return setvars; }
    return [{ name: wmlTimerName, value: String(left) }].concat(setvars || []);
}

// WML 1.3: 11.7 The Timer Element
//
// Card entry: a named timer starts from its variable if that is set,
// else from its value, which the variable is set to (WML 1.3: 11.7); an unnamed
// one a refresh resumes starts from the time it had `left`.  A timeout
// that is not an integer is no timer, and 0 disables it.
function processTimers(card, left) {
    clearTimeout(wmlTimer);
    wmlTimer = null;
    var t = card.querySelector('.wml-timer');   // one per card (WML 1.3: 11.7)
    if (!t) { return; }
    var name = t.getAttribute('data-name') || '';
    var value = name && wmlVars[name] ? wmlVars[name]
        : !name && left ? String(left) : substituteVars(t.getAttribute('data-value') || '');
    if (!/^[0-9]+$/.test(value)) { return; }
    if (name && wmlVars[name] !== value) {
        wmlVars[name] = value;
        updateVariables();
    }
    if (+value > 0) {
        wmlTimerName = name;
        wmlTimerEnd = Date.now() + value * 100;
        wmlTimer = setTimeout(function() {
            wmlTimer = null;
            if (card.style.display !== 'none') {
                if (name) { wmlVars[name] = '0'; }
                processOnEvent(card, 'ontimer');
            }
        }, value * 100);
    }
}

// ── Variable Display ─────────────────────────────────────────────

/**
 * WML 1.3: 10.3.1 Variable Substitution
 *
 * Apply a WML variable conversion (WML 1.3: 10.3.1).
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

// WML 1.3: 10.3.1 Variable Substitution
function updateVariables() {
    // WML 1.3: 10.3.1 Variable Substitution: substituting an unset variable yields the empty
    // string.
    // wmlTransform emits a "[name]" placeholder for every reference, which is
    // the right thing for the editor preview — an author wants to see which
    // variables a deck uses before any are set — and the wrong thing for a
    // browser, where it puts text on screen that the deck never wrote. A
    // browser sets WML_STRICT_VARS (see browser.js) to get the spec behaviour;
    // the preview leaves it unset and keeps its placeholders.
    var strictVars = typeof window !== 'undefined' && !!window.WML_STRICT_VARS;
    showCardTitle(document.querySelector('.wml-card[style*="display: block"], .wml-card[style*="display:block"]'));
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
            var currentIndices = indices.join(';') || '0';
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

// WMLScript:
//  - 8.3.3 URL Call Syntax
//  - 8.3.4 URL Calls and Parameter Passing
//  - 8.3.5 Character Escaping
//
// Parse the argument list of a `script.wmls#func(...)` fragment call.
// Returns an array of { value, quoted } tokens. `quoted` records whether the
// token was written as a string literal ('...' or "..."), which
// determines its type (WMLScript: 8.3.4): a quoted token is passed as a String, an
// unquoted token keeps its literal type (integer/float/boolean/invalid). The
// caller's convertArgs/convertWmlsArgs coerce only unquoted tokens.
//
// Split on commas that are not inside quotes, then classify each segment: a
// segment that (after trimming surrounding whitespace) is wrapped in matching
// quotes is a string literal whose inner text is kept verbatim; anything else
// is an unquoted literal and is trimmed.
// The arguments of a URL call, "s.wmls#f(1, 'a b', x)" (WMLScript: 8.3.3):
// each a literal between white space; a quoted one is { quoted: true }.
// An argument is unescaped once its extent is found (WMLScript: 8.3.5: the call
// syntax applies to the unescaped fragment), so an escaped %27 or %2C
// stays inside it.  WML's default escaping leaves ' as it is (RFC 2396
// unreserved), so a quote ends a string only before a , or the end: a
// value like "Co's" in '$(v)' keeps its apostrophe (as wap-browser-c).
function parseWmlScriptArgs(argsStr) {
    var args = [];
    if (!argsStr || argsStr.trim().length === 0) return args;

    var segments = [];
    var cur = '', inQuote = false, quoteChar = '';
    for (var i = 0; i < argsStr.length; i++) {
        var ch = argsStr[i];
        if (inQuote) {
            cur += ch;
            if (ch === quoteChar) {
                var j = i + 1;
                while (j < argsStr.length && /\s/.test(argsStr[j])) { j++; }
                if (j >= argsStr.length || argsStr[j] === ',') { inQuote = false; }
            }
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
            args.push({ value: unescapeUrlString(tok.slice(1, -1)), quoted: true });
        } else {
            args.push({ value: unescapeUrlString(tok), quoted: false });
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

/**
 * WML 1.3: 11.6.3 The Input Element
 *
 * Parse a WML format mask into an array of slot descriptors; null when there
 * is none, or it is not a valid mask (WML 1.3: 11.6.3: only codes, \c and one
 * *f or nf, n 1-9, at the end), which "user agents must ignore".  An nf
 * gives n 'opt' slots: up to n characters.
 */
function parseFormatSlots(fmt) {
    if (!fmt) return null;
    var slots = [];
    for (var i = 0; i < fmt.length; i++) {
        var ch = fmt[i];
        if (ch === '\\' && i + 1 < fmt.length) {
            slots.push({ type: 'literal', char: fmt[++i] });
        } else if ((ch === '*' || (ch >= '1' && ch <= '9')) && FORMAT_CODES[fmt[i + 1]]) {
            if (i + 2 !== fmt.length) return null;
            if (ch === '*') {
                slots.push({ type: 'star', code: fmt[i + 1] });
            }
            for (var j = 0; ch !== '*' && j < +ch; j++) {
                slots.push({ type: 'opt', code: fmt[i + 1] });
            }
            return slots;
        } else if (FORMAT_CODES[ch]) {
            slots.push({ type: 'char', code: ch });
        } else {
            return null;
        }
    }
    return slots.length > 0 ? slots : null;
}

/**
 * WML 1.3: 11.6.3 The Input Element
 *
 * Does value v fit the mask (WML 1.3: 11.6.3): a character for each slot as its code
 * takes it (a literal as written), and every slot before a trailing *f or nf
 * filled.  No mask, or an invalid one: anything does.  "" fits only a lone *f
 * ("the format mask is implied or a *f format code": M*M requires input).
 */
function maskAccepts(fmt, v) {
    var slots = parseFormatSlots(fmt);
    if (!slots) return true;
    if (!v) return slots.length === 1 && slots[0].type === 'star';
    var i = 0;
    for (var si = 0; si < slots.length; si++) {
        var slot = slots[si];
        if (slot.type === 'star') {
            for (; i < v.length; i++) { if (!FORMAT_CODES[slot.code].test(v[i])) return false; }
            return true;
        }
        if (i >= v.length) return slot.type === 'opt';
        if (slot.type === 'literal' ? v[i] !== slot.char : !FORMAT_CODES[slot.code].test(v[i])) {
            return false;
        }
        i++;
    }
    return i === v.length;
}

/** WML 1.3: 11.6.3 The Input Element
 *
 * Whether an input takes "" (WML 1.3: 11.6.3): its emptyok, else what its mask implies. */
function inputEmptyOk(inp) {
    var e = inp.getAttribute('data-emptyok');
    return e === 'true' || (e !== 'false' && maskAccepts(inp.getAttribute('data-format') || '', ''));
}

/**
 * WML 1.3: 11.6.3 The Input Element
 *
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
        // type === 'char' or 'opt'
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

// WML 1.3: 11.6.3 The Input Element
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
            runTask(el, el.getAttribute('data-href'), null);
            return;
        }
        var actionEl = e.target.closest('[data-action]');
        if (actionEl && !actionEl.classList.contains('wml-onevent')) {
            e.preventDefault();
            runTask(actionEl, null, actionEl.getAttribute('data-action'), wmlRefresh);
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
        runTask(el, el.getAttribute('data-href'), el.getAttribute('data-action'), wmlRefresh);
    });
}

// ── Common Form Initialization ───────────────────────────────────

// WML 1.3:
//  - 11.6.3 The Input Element
//  - 11.6.2.1 The Select Element
function initWmlFormElements() {
    // Normalize table rows to the declared column count, then apply alignment.
    // Per WML 1.3: 11.8.5: rows with fewer cells than `columns` are padded with
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

    // The fields' listeners; their values are set at card entry
    // (initCardFields)
    document.querySelectorAll('.wml-input').forEach(function(inp) {
        var name = inp.getAttribute('name');
        var fmt = inp.getAttribute('data-format') || '';
        var slots = parseFormatSlots(fmt);
        if (name) {
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
                // WML 1.3: 11.6.3 The Input Element: input that does not fit the mask (too short, or
                // empty where it is required) is not taken: the variable
                // keeps its value, and the field says so (wml-invalid)
                var ok = inp.value ? maskAccepts(fmt, inp.value) : inputEmptyOk(inp);
                if (ok) { wmlVars[name] = inp.value; }
                inp.classList[ok ? 'remove' : 'add']('wml-invalid');
                updateVariables();
            });
        }
    });
    document.querySelectorAll('.wml-select').forEach(function(sel) {
        sel.addEventListener('change', function() {
            selectCommitVars(sel);
            updateVariables();
        });
    });
    updateVariables();
}

/**
 * WML 1.3:
 *  - 11.6.2.1 The Select Element
 *  - 11.6.3 The Input Element
 *
 * Initialise the inputs and selects within `card`, in card order, as it is
 * entered (WML 1.3: 11.6.2.1, 11.6.3): not the deck's other cards'.
 */
function initCardFields(card) {
    if (!card) return;
    card.querySelectorAll('.wml-input, .wml-select').forEach(function(f) {
        if (f.classList.contains('wml-select')) { initSelect(f); } else { initInput(f); }
    });
}

/**
 * WML 1.3:
 *  - 11.6.3 The Input Element
 *  - 10.3 Variables
 *
 * An input's initial value (WML 1.3: 11.6.3): its variable's if that fits the mask,
 * else (the variable unset) its value attribute's, vdata, substituted, if
 * that fits; else none.  A variable set to "" is not set (WML 1.3: 10.3).
 */
function initInput(inp) {
    var name = inp.getAttribute('name');
    if (!name) return;
    var fmt = inp.getAttribute('data-format') || '';
    var cur = wmlVars[name];
    inp.classList.remove('wml-invalid');
    if (cur !== undefined && cur !== '') {
        if (maskAccepts(fmt, cur)) { inp.value = cur; return; }
        delete wmlVars[name];
    }
    var dflt = inp.getAttribute('value');
    var v = dflt ? substituteVars(dflt) : '';
    if (v && maskAccepts(fmt, v)) { wmlVars[name] = v; } else { v = ''; }
    inp.value = v;
}

// WML 1.3: 11.6.2.2 The Option Element
//
// An option's value: vdata, substituted (WML 1.3: 11.6.2.2)
function optionValue(o) {
    return substituteVars(o.value);
}

// WML 1.3: 11.6.2.1 The Select Element
//
// Select-list initialisation per WML 1.3: 11.6.2.1 (validate operation +
// iname/ivalue/name/value precedence; single-choice treats a value
// containing ';' as one literal value rather than a list).  value and
// ivalue are vdata.
function initSelect(sel) {
    var name = sel.getAttribute('name');
    var iname = sel.getAttribute('data-iname') || '';
    var ivalue = substituteVars(sel.getAttribute('data-ivalue') || '');
    var value = substituteVars(sel.getAttribute('data-value') || '');
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
        for (var i = 0; i < nOpts; i++) { if (optionValue(sel.options[i]) === v) { return i + 1; } }
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

    // Step 2 — commit name / iname variables from the selection.
    selectCommitVars(sel);
}

// WML 1.3: 11.6.2.1 The Select Element
//
// A select's name and iname variables from its selection (WML 1.3: 11.6.2.1 step
// 2): name the chosen options' values (vdata), iname their indices, 0 when
// none is chosen
function selectCommitVars(sel) {
    var name = sel.getAttribute('name');
    var iname = sel.getAttribute('data-iname') || '';
    var selIdx = [];
    for (var j = 0; j < sel.options.length; j++) { if (sel.options[j].selected) { selIdx.push(j + 1); } }
    if (name) {
        if (sel.multiple) {
            var nv = [];
            selIdx.forEach(function(n) { var v = optionValue(sel.options[n - 1]); if (v !== '') { nv.push(v); } });
            wmlVars[name] = nv.join(';');
        } else {
            var sv = selIdx.length ? optionValue(sel.options[selIdx[0] - 1]) : '';
            if (sv === '') { delete wmlVars[name]; } else { wmlVars[name] = sv; }
        }
    }
    if (iname) { wmlVars[iname] = selIdx.join(';') || '0'; }
}

// ── WMLScript Dialogs UI (WMLScript Libraries: 12) ───────────────────────────
// Shared by the WAP Browser and the WML preview so Dialogs.alert / confirm /
// prompt look and behave identically in both. Drives the #dialog-overlay modal
// markup (see wmlToHtml.ts / browserPanel.ts) and returns a Promise resolving to:
//   alert   → ""                 (OK only)
//   confirm → true | false       (per the chosen button)
//   prompt  → entered string     (Cancel → the supplied default)
// `opts` may carry { def, okLabel, cancelLabel }. When the modal markup is
// absent (e.g. a stripped-down host) it falls back to native window dialogs.
var _wmlDialogResolve = null;

// WMLScript Libraries: 12 DIALOGS
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

// WMLScript Libraries: 12 DIALOGS
//
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
