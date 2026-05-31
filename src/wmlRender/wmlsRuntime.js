/**
 *  Copyright (C) 2026 Jabez Winston
 * 
 *  SPDX-License-Identifier: Apache-2.0
 *
 *  Date : 20-March-2026
 * 
 *  Runtime Library for transpiled WMLScript
 *
 */

// WMLScript Runtime Library — Client-side execution support
// Provides standard library functions and script registry for transpiled WMLScript.
// Must be included BEFORE any transpiled WMLScript modules.

var __wmls = (function() {
  var rt = {};
  rt._scripts = {};
  rt._pending = null;

  // ===================================================================
  // Debugger controller
  // ===================================================================
  // Drives WMLScript debugging in the WML preview. The transpiler always
  // instruments emitted code with _enter/_leave/_ret and `await _brk(line)`,
  // but _brk is a cheap no-op unless debugging is enabled and a breakpoint/step
  // condition is met, in which case it returns a Promise that resolves only
  // when a step/continue command arrives. In the VS Code webview the events
  // (onUpdate / onOutput) are bridged to a DAP debug adapter (wmlsDebugBridge.js);
  // in a plain browser they fall back to the console.
  rt._dbg = {
    enabled: false,
    breakpoints: {},   // script -> { line: true }
    mode: 'run',       // 'run' | 'stepOver' | 'stepIn' | 'stepOut'
    stack: [],         // live call-stack frames
    stepDepth: 0,
    paused: false,
    pausedFrame: null,
    pauseReason: 'breakpoint',
    trace: [],         // execution + console trace entries
    onUpdate: null,    // function(event) — host bridge state-change sink
    onOutput: null,    // function(text) — Console/error output → Debug Console
    resume: null,      // resolver of the pending _brk Promise while paused
    _terminate: false
  };

  function dbgEmit(event) {
    if (typeof rt._dbg.onUpdate === 'function') {
      try { rt._dbg.onUpdate(event); } catch (e) { /* ignore UI errors */ }
    }
  }

  rt._dbg.log = function(text) {
    rt._dbg.trace.push({ kind: 'log', text: String(text) });
    if (typeof rt._dbg.onOutput === 'function') {
      try { rt._dbg.onOutput(String(text)); } catch (e) { /* ignore sink errors */ }
    }
    dbgEmit('log');
  };

  rt._dbg.toggleBreakpoint = function(script, line) {
    var bps = rt._dbg.breakpoints[script] || (rt._dbg.breakpoints[script] = {});
    if (bps[line]) { delete bps[line]; }
    else { bps[line] = true; rt._dbg.enabled = true; }
    dbgEmit('breakpoints');
    return !!bps[line];
  };

  // Replace the full breakpoint set for a script (DAP sends every breakpoint
  // for a source file in one setBreakpoints request).
  rt._dbg.setBreakpoints = function(script, lines) {
    var map = {};
    (lines || []).forEach(function(ln) { map[Number(ln)] = true; });
    rt._dbg.breakpoints[script] = map;
    if ((lines || []).length > 0) { rt._dbg.enabled = true; }
    dbgEmit('breakpoints');
  };

  rt._dbg.setEnabled = function(on) { rt._dbg.enabled = !!on; dbgEmit('breakpoints'); };

  rt._dbg.getState = function() {
    return {
      enabled: rt._dbg.enabled,
      paused: rt._dbg.paused,
      stack: rt._dbg.stack,
      trace: rt._dbg.trace,
      breakpoints: rt._dbg.breakpoints
    };
  };

  // --- serialization for the host debug adapter ---

  function dbgTypeName(v) {
    switch (rt.typeOf(v)) {
      case 0: return 'integer';
      case 1: return 'float';
      case 2: return 'string';
      case 3: return 'boolean';
      default: return 'invalid';
    }
  }
  function dbgValueString(v) {
    if (v === undefined) return 'invalid';
    if (v === true) return 'true';
    if (v === false) return 'false';
    if (typeof v === 'string') return JSON.stringify(v);
    return String(v);
  }
  function dbgSerializeValue(v) {
    return { value: dbgValueString(v), type: dbgTypeName(v) };
  }

  // Evaluate a bare variable name in a frame's scope (Watch / hover).
  rt._dbg.evaluate = function(frameId, expr) {
    var name = String(expr == null ? '' : expr).trim();
    if (!name) { return undefined; }
    var frame = (typeof frameId === 'number' && rt._dbg.stack[frameId])
      ? rt._dbg.stack[frameId]
      : (rt._dbg.pausedFrame || rt._dbg.stack[rt._dbg.stack.length - 1]);
    if (frame && typeof frame.localsFn === 'function') {
      var locals = frame.localsFn() || {};
      if (Object.prototype.hasOwnProperty.call(locals, name)) {
        return dbgSerializeValue(locals[name]);
      }
    }
    if (typeof wmlVars !== 'undefined' && wmlVars &&
        Object.prototype.hasOwnProperty.call(wmlVars, name)) {
      return dbgSerializeValue(wmlVars[name]);
    }
    return undefined;
  };

  // Serializable snapshot of the paused state for postMessage to the host.
  rt._dbg.snapshot = function() {
    var frames = [];
    for (var i = 0; i < rt._dbg.stack.length; i++) {
      var f = rt._dbg.stack[i];
      var vars = [];
      if (typeof f.localsFn === 'function') {
        var locals = {};
        try { locals = f.localsFn() || {}; } catch (e) { locals = {}; }
        for (var k in locals) {
          if (Object.prototype.hasOwnProperty.call(locals, k)) {
            var sv = dbgSerializeValue(locals[k]);
            vars.push({ name: k, value: sv.value, type: sv.type });
          }
        }
      }
      frames.push({ id: i, fn: f.fn, script: f.script, line: f.line, vars: vars });
    }
    var wv = [];
    if (typeof wmlVars !== 'undefined' && wmlVars) {
      for (var n in wmlVars) {
        if (Object.prototype.hasOwnProperty.call(wmlVars, n)) {
          wv.push({ name: n, value: dbgValueString(String(wmlVars[n])), type: 'string' });
        }
      }
    }
    return {
      paused: rt._dbg.paused,
      reason: rt._dbg.pauseReason,
      stack: frames,
      wmlVars: wv
    };
  };

  function dbgResume(mode) {
    rt._dbg.mode = mode;
    rt._dbg.stepDepth = rt._dbg.stack.length;
    rt._dbg.paused = false;
    rt._dbg.pausedFrame = null;
    var r = rt._dbg.resume;
    rt._dbg.resume = null;
    dbgEmit('resumed');
    if (r) r();
  }

  rt._dbg.continue = function() { dbgResume('run'); };
  rt._dbg.stepOver = function() { dbgResume('stepOver'); };
  rt._dbg.stepIn = function() { dbgResume('stepIn'); };
  rt._dbg.stepOut = function() { dbgResume('stepOut'); };
  rt._dbg.stop = function() {
    rt._dbg._terminate = true;
    if (rt._dbg.paused) dbgResume('run');
  };

  // --- instrumentation hooks emitted by the transpiler ---

  rt._enter = function(script, fn, args, localsFn) {
    var frame = { script: script, fn: fn, line: 0, args: args, localsFn: localsFn, retval: undefined };
    rt._dbg.stack.push(frame);
    rt._dbg.trace.push({ kind: 'enter', script: script, fn: fn, args: args });
    return frame;
  };

  rt._ret = function(v) {
    var frame = rt._dbg.stack[rt._dbg.stack.length - 1];
    if (frame) frame.retval = v;
    rt._dbg.trace.push({ kind: 'return', value: v });
    return v;
  };

  rt._leave = function() {
    var frame = rt._dbg.stack.pop();
    if (frame) rt._dbg.trace.push({ kind: 'leave', fn: frame.fn });
  };

  rt._brk = function(line) {
    var stack = rt._dbg.stack;
    var frame = stack[stack.length - 1];
    if (frame) frame.line = line;
    if (rt._dbg._terminate) { throw { __wmlsTerminate: true }; }
    if (!rt._dbg.enabled) { return; }

    var hitBp = frame && rt._dbg.breakpoints[frame.script] && rt._dbg.breakpoints[frame.script][line];
    var stepHit = false;
    switch (rt._dbg.mode) {
      case 'stepIn': stepHit = true; break;
      case 'stepOver': stepHit = stack.length <= rt._dbg.stepDepth; break;
      case 'stepOut': stepHit = stack.length < rt._dbg.stepDepth; break;
    }
    if (!hitBp && !stepHit) { return; }

    rt._dbg.paused = true;
    rt._dbg.pausedFrame = frame;
    rt._dbg.pauseReason = hitBp ? 'breakpoint' : 'step';
    dbgEmit('stopped');
    return new Promise(function(resolve) { rt._dbg.resume = resolve; });
  };

  // --- Script Registry ---

  rt._register = function(scriptPath, exports) {
    rt._scripts[scriptPath] = exports;
    // Also register with normalized path (without leading slash duplication)
    var norm = scriptPath.replace(/\/+/g, '/');
    if (norm !== scriptPath) rt._scripts[norm] = exports;
  };

  rt._call = async function(scriptPath, funcName, args) {
    var mod = rt._scripts[scriptPath];
    if (mod && typeof mod[funcName] === 'function') {
      return await mod[funcName].apply(null, args);
    }
    console.error('WMLScript external function not found: ' + scriptPath + '#' + funcName);
    return undefined;
  };

  rt._callFunction = async function(scriptPath, funcName, args) {
    rt._pending = null;
    rt._dbg._terminate = false;
    rt._dbg.stack = [];
    rt._dbg.mode = 'run';
    try {
      var mod = rt._scripts[scriptPath];
      if (!mod || typeof mod[funcName] !== 'function') {
        console.error('WMLScript function not found: ' + scriptPath + '#' + funcName);
        return;
      }
      await mod[funcName].apply(null, args);
    } catch(e) {
      if (e && e.__wmlsExit) { /* normal Lang.exit() */ }
      else if (e && e.__wmlsTerminate) { rt._dbg.log('Execution stopped by debugger'); }
      else if (e && e.__wmlsAbort) { rt._dbg.log('aborted: ' + e.reason); console.error('WMLScript aborted: ' + e.reason); }
      else if (e && e.__wmlsNav) { /* navigation via WMLBrowser.go/prev */ }
      else { rt._dbg.log('runtime error: ' + e); console.error('WMLScript runtime error:', e); }
    } finally {
      rt._dbg.paused = false;
      rt._dbg.resume = null;
      dbgEmit('resumed');
    }
    // Process deferred navigation
    var action = rt._pending;
    rt._pending = null;
    if (action) {
      if (action.type === 'go' && typeof wmlNavigate === 'function') {
        wmlNavigate(action.url);
        return;
      }
      if (action.type === 'prev' && typeof wmlPrev === 'function') {
        wmlPrev();
        return;
      }
    }
    // Refresh display if variables may have changed
    if (typeof updateVariables === 'function') updateVariables();
  };

  // --- Type Helpers ---

  rt.div = function(a, b) {
    if (a === undefined || b === undefined || b === 0) return undefined;
    return Math.trunc(a / b);
  };

  rt.typeOf = function(v) {
    if (v === undefined) return 4;     // invalid
    if (typeof v === 'boolean') return 3;
    if (typeof v === 'string') return 2;
    if (typeof v === 'number') return Number.isInteger(v) ? 0 : 1;
    return 4;
  };

  // --- Spec helpers (WAP-194) ---

  function _floatInt(v) {                      // Float.int() truncation; null if NaN
    var n = Number(v);
    return isNaN(n) ? null : Math.trunc(n);
  }

  // RFC2396 URL split — never throws, supports relative URLs (not resolved)
  function _parseUrl(u) {
    var m = /^(?:([a-zA-Z][a-zA-Z0-9+.-]*):)?(?:\/\/([^/?#]*))?([^?#]*)(?:\?([^#]*))?(?:#(.*))?$/.exec(u) || [];
    var authority = m[2], host = '', port = '';
    if (authority !== undefined) {
      var at = authority.indexOf('@');
      var hp = at >= 0 ? authority.slice(at + 1) : authority;
      var colon = hp.lastIndexOf(':');
      if (colon >= 0 && /^[0-9]*$/.test(hp.slice(colon + 1))) { host = hp.slice(0, colon); port = hp.slice(colon + 1); }
      else { host = hp; }
    }
    return { scheme: m[1] || '', host: host, port: port, path: m[3] || '',
             query: m[4] === undefined ? '' : m[4], fragment: m[5] === undefined ? '' : m[5] };
  }
  function _isValidUrl(u) { return !/[\x00-\x20\x7f-￿<>"{}|\\^`]/.test(u); }
  function _stripPathParams(p) {
    return p.split('/').map(function(seg) { var i = seg.indexOf(';'); return i >= 0 ? seg.slice(0, i) : seg; }).join('/');
  }
  function _lastSegParams(p) {
    var segs = p.split('/'), last = segs[segs.length - 1], i = last.indexOf(';');
    return i >= 0 ? last.slice(i + 1) : '';
  }
  var _URL_SAFE = /[A-Za-z0-9\-_.!~*'()]/;
  function _escapeUrl(s) {
    var out = '';
    for (var i = 0; i < s.length; i++) {
      var code = s.charCodeAt(i);
      if (code > 0xFF) return undefined;       // > U+00FF → invalid
      out += _URL_SAFE.test(s[i]) ? s[i] : '%' + ('0' + code.toString(16)).slice(-2);
    }
    return out;
  }
  function _unescapeUrl(s) {
    if (/[^\x00-\x7f]/.test(s)) return undefined;
    return s.replace(/%([0-9a-fA-F]{2})/g, function(_m, h) { return String.fromCharCode(parseInt(h, 16)); });
  }

  // String.format (§9.16)
  function _intForFmt(v) {
    if (typeof v === 'string') { var m = /^[+-]?[0-9]+/.exec(v.trim()); return m ? parseInt(m[0], 10) : null; }
    var n = Number(v); return isNaN(n) ? null : Math.trunc(n);
  }
  function _floatForFmt(v) { var n = Number(typeof v === 'string' ? v.trim() : v); return isNaN(n) ? null : n; }
  function _padLeft(s, w) { return (w !== undefined && s.length < w) ? new Array(w - s.length + 1).join(' ') + s : s; }
  function _fmtStr(v) { if (v === undefined) return 'invalid'; if (v === true) return 'true'; if (v === false) return 'false'; return String(v); }
  function _renderSpec(type, w, prec, value) {
    if (type === 'd') {
      var n = _intForFmt(value); if (n === null) return null;
      var precision = prec === undefined ? 1 : prec, digits;
      if (precision === 0 && n === 0) { digits = ''; }
      else { digits = String(Math.abs(n)); if (digits.length < precision) { digits = new Array(precision - digits.length + 1).join('0') + digits; } }
      return _padLeft((n < 0 ? '-' : '') + digits, w);
    }
    if (type === 'f') {
      var x = _floatForFmt(value); if (x === null) return null;
      return _padLeft(x.toFixed(prec === undefined ? 6 : prec), w);
    }
    var str = _fmtStr(value);
    if (prec !== undefined) { str = str.slice(0, prec); }
    if (w !== undefined && !(prec !== undefined && w > prec)) { str = _padLeft(str, w); }
    return str;
  }
  function _format(fmt, value) {
    var result = '', firstDone = false, i = 0;
    while (i < fmt.length) {
      if (fmt[i] !== '%') { result += fmt[i++]; continue; }
      if (fmt[i + 1] === '%') { result += '%'; i += 2; continue; }
      var m = /^%([0-9]+)?(?:\.([0-9]+))?([dfs])/.exec(fmt.slice(i));
      if (!m) { return undefined; }            // illegal format specifier → invalid
      i += m[0].length;
      if (firstDone) { continue; }             // subsequent specifiers → empty string
      var w = m[1] !== undefined ? parseInt(m[1], 10) : undefined;
      var prec = m[2] !== undefined ? parseInt(m[2], 10) : undefined;
      var tok = _renderSpec(m[3], w, prec, value);
      if (tok === null) { return undefined; }
      result += tok;
      firstDone = true;
    }
    return result;
  }

  // Lang.seed/random — Park–Miller LCG state (null ⇒ use Math.random)
  rt._rngState = null;
  function _rngNext() {
    if (rt._rngState === null) { return Math.random(); }
    rt._rngState = (rt._rngState * 16807) % 2147483647;
    return (rt._rngState - 1) / 2147483646;
  }

  // ===================================================================
  // Lang Library (0) — WAP-194 Section 8
  // ===================================================================
  rt.Lang = {
    abs: function(v) {
      if (v === undefined) return undefined;
      return Math.abs(v);
    },
    min: function(a, b) {
      if (a === undefined || b === undefined) return undefined;
      return Math.min(a, b);
    },
    max: function(a, b) {
      if (a === undefined || b === undefined) return undefined;
      return Math.max(a, b);
    },
    parseInt: function(s) {
      var n = parseInt(String(s), 10);
      return isNaN(n) ? undefined : n;
    },
    parseFloat: function(s) {
      var n = parseFloat(String(s));
      return isNaN(n) ? undefined : n;
    },
    isInt: function(v) {
      if (typeof v !== 'string') return false;
      var s = v.trim();
      if (s.length === 0) return false;
      var n = parseInt(s, 10);
      return !isNaN(n);
    },
    isFloat: function(v) {
      if (typeof v !== 'string') return false;
      var s = v.trim();
      if (s.length === 0) return false;
      var n = parseFloat(s);
      return !isNaN(n);
    },
    maxInt: function() { return 2147483647; },
    minInt: function() { return -2147483648; },
    float: function(v) {
      if (v === undefined) return undefined;
      var n = Number(v);
      return isNaN(n) ? undefined : n;
    },
    exit: function(v) {
      throw { __wmlsExit: true, value: v };
    },
    abort: function(v) {
      throw { __wmlsAbort: true, reason: String(v) };
    },
    random: function(n) {
      var iv = _floatInt(n);
      if (iv === null || iv < 0) return undefined;
      if (iv === 0) return 0;
      return Math.floor(_rngNext() * (iv + 1));
    },
    seed: function(v) {
      var iv = _floatInt(v);
      if (iv === null) return undefined;        // non-numeric ⇒ invalid, seed unchanged
      rt._rngState = iv >= 0 ? (iv % 2147483646) + 1 : Math.floor(Math.random() * 2147483646) + 1;
      return "";
    },
    characterSet: function() { return 4; }
  };

  // ===================================================================
  // Float Library (1) — WAP-194 Section 9
  // ===================================================================
  rt.Float = {
    int: function(v) {
      if (v === undefined) return undefined;
      var n = Number(v);
      return isNaN(n) ? undefined : Math.trunc(n);
    },
    floor: function(v) {
      if (v === undefined) return undefined;
      var n = Number(v);
      return isNaN(n) ? undefined : Math.floor(n);
    },
    ceil: function(v) {
      if (v === undefined) return undefined;
      var n = Number(v);
      return isNaN(n) ? undefined : Math.ceil(n);
    },
    pow: function(base, exp) {
      if (base === undefined || exp === undefined) return undefined;
      return Math.pow(base, exp);
    },
    round: function(v) {
      if (v === undefined) return undefined;
      var n = Number(v);
      return isNaN(n) ? undefined : Math.round(n);
    },
    sqrt: function(v) {
      if (v === undefined || v < 0) return undefined;
      return Math.sqrt(v);
    },
    maxFloat: function() { return 3.4028235e+38; },
    minFloat: function() { return 1.17549435e-38; }
  };

  // ===================================================================
  // String Library (2) — WAP-194 Section 10
  // ===================================================================
  rt.String = {
    length: function(s) {
      return String(s === undefined ? '' : s).length;
    },
    isEmpty: function(s) {
      return String(s === undefined ? '' : s).length === 0;
    },
    charAt: function(s, i) {
      var str = String(s === undefined ? '' : s);
      if (i === undefined || i < 0 || i >= str.length) return "";
      return str.charAt(i);
    },
    subString: function(s, start, len) {
      if (start === undefined || len === undefined) return undefined;
      var str = String(s === undefined ? '' : s);
      var st = Math.max(0, Math.min(start, str.length));
      var ln = Math.max(0, len);
      return str.substring(st, st + ln);
    },
    find: function(s, sub) {
      return String(s === undefined ? '' : s).indexOf(String(sub === undefined ? '' : sub));
    },
    replace: function(s, old, rep) {
      return String(s === undefined ? '' : s).split(String(old === undefined ? '' : old)).join(String(rep === undefined ? '' : rep));
    },
    elements: function(s, sep) {
      var sp = String(sep === undefined ? '' : sep);
      if (sp.length === 0) return undefined;            // empty separator → invalid
      return String(s === undefined ? '' : s).split(sp[0]).length;
    },
    elementAt: function(s, i, sep) {
      var idx = _floatInt(i);
      var sp = String(sep === undefined ? ',' : sep);
      if (idx === null || sp.length === 0) return undefined;
      var str = String(s === undefined ? '' : s);
      if (str.length === 0) return "";
      var parts = str.split(sp[0]);
      var k = idx < 0 ? 0 : idx >= parts.length ? parts.length - 1 : idx;
      return parts[k];
    },
    removeAt: function(s, i, sep) {
      var idx = _floatInt(i);
      var sp = String(sep === undefined ? ',' : sep);
      if (idx === null || sp.length === 0) return undefined;
      var str = String(s === undefined ? '' : s);
      if (str.length === 0) return "";
      var parts = str.split(sp[0]);
      var k = idx < 0 ? 0 : idx >= parts.length ? parts.length - 1 : idx;
      parts.splice(k, 1);
      return parts.join(sp[0]);
    },
    replaceAt: function(s, elem, i, sep) {
      var idx = _floatInt(i);
      var sp = String(sep === undefined ? ',' : sep);
      if (idx === null || sp.length === 0) return undefined;
      var el = String(elem === undefined ? '' : elem);
      var str = String(s === undefined ? '' : s);
      if (str.length === 0) return el;
      var parts = str.split(sp[0]);
      var k = idx < 0 ? 0 : idx >= parts.length ? parts.length - 1 : idx;
      parts[k] = el;
      return parts.join(sp[0]);
    },
    insertAt: function(s, elem, i, sep) {
      var idx = _floatInt(i);
      var sp = String(sep === undefined ? ',' : sep);
      if (idx === null || sp.length === 0) return undefined;
      var el = String(elem === undefined ? '' : elem);
      var str = String(s === undefined ? '' : s);
      if (str.length === 0) return el;
      var parts = str.split(sp[0]);
      var k = idx < 0 ? 0 : idx > parts.length ? parts.length : idx;
      parts.splice(k, 0, el);
      return parts.join(sp[0]);
    },
    squeeze: function(s) {
      return String(s === undefined ? '' : s).replace(/\s+/g, ' ');
    },
    trim: function(s) {
      return String(s === undefined ? '' : s).trim();
    },
    compare: function(a, b) {
      var sa = String(a === undefined ? '' : a);
      var sb = String(b === undefined ? '' : b);
      return sa < sb ? -1 : sa > sb ? 1 : 0;
    },
    toString: function(v) {
      if (v === undefined) return 'invalid';
      if (v === true) return 'true';
      if (v === false) return 'false';
      return String(v);
    },
    format: function(fmt, val) {
      return _format(String(fmt === undefined ? '' : fmt), val);
    }
  };

  // ===================================================================
  // URL Library (3) — WAP-194 Section 11
  // ===================================================================
  rt.URL = {
    isValid: function(u) { return _isValidUrl(String(u)); },
    getScheme: function(u) { var s = String(u); return _isValidUrl(s) ? _parseUrl(s).scheme : undefined; },
    getHost: function(u) { var s = String(u); return _isValidUrl(s) ? _parseUrl(s).host : undefined; },
    getPort: function(u) { var s = String(u); return _isValidUrl(s) ? _parseUrl(s).port : undefined; },
    getPath: function(u) { var s = String(u); return _isValidUrl(s) ? _stripPathParams(_parseUrl(s).path) : undefined; },
    getParameters: function(u) { var s = String(u); return _isValidUrl(s) ? _lastSegParams(_parseUrl(s).path) : undefined; },
    getQuery: function(u) { var s = String(u); return _isValidUrl(s) ? _parseUrl(s).query : undefined; },
    getFragment: function(u) { var s = String(u); return _isValidUrl(s) ? _parseUrl(s).fragment : undefined; },
    getBase: function() {
      var b = (typeof window !== 'undefined' && window.location) ? window.location.href : '';
      var h = b.indexOf('#');
      return h >= 0 ? b.slice(0, h) : b;
    },
    getReferer: function() {
      return (typeof document !== 'undefined' && document.referrer) ? document.referrer : '';
    },
    resolve: function(base, rel) {
      try { return new URL(String(rel), String(base)).toString(); } catch(e) { return undefined; }
    },
    escapeString: function(s) { return _escapeUrl(String(s === undefined ? '' : s)); },
    unescapeString: function(s) { return _unescapeUrl(String(s === undefined ? '' : s)); },
    loadString: function(url, contentType) {
      // §10.14. The runtime cannot block on a network fetch; a host may provide
      // content synchronously via rt.onLoadString (kept in sync with the VM's
      // ctx.onLoadString in stdlib.ts). Absent/unavailable/bad type ⇒ invalid.
      var ct = String(contentType === undefined ? '' : contentType);
      if (!/^text\/\S+$/.test(ct)) { return undefined; }   // erroneous content type
      if (typeof rt.onLoadString !== 'function') { return undefined; }
      var body = rt.onLoadString(String(url === undefined ? '' : url), ct);
      return (body === undefined || body === null) ? undefined : String(body);
    }
  };

  // ===================================================================
  // WMLBrowser Library (4) — WAP-194 Section 12
  // Bridges to the WML preview engine globals (wmlVars, wmlNavigate, etc.)
  // ===================================================================
  rt.WMLBrowser = {
    getVar: function(name) {
      var n = String(name);
      return (typeof wmlVars !== 'undefined' && wmlVars[n] !== undefined) ? wmlVars[n] : "";
    },
    setVar: function(name, value) {
      var n = String(name);
      var v = String(value === undefined ? '' : value);
      if (typeof wmlVars !== 'undefined') wmlVars[n] = v;
      return true;
    },
    go: function(url) {
      rt._pending = { type: 'go', url: String(url) };
      throw { __wmlsNav: true };
    },
    prev: function() {
      rt._pending = { type: 'prev' };
      throw { __wmlsNav: true };
    },
    newContext: function() {
      if (typeof wmlVars !== 'undefined') {
        for (var k in wmlVars) {
          if (wmlVars.hasOwnProperty(k)) delete wmlVars[k];
        }
      }
      if (typeof wmlHistory !== 'undefined') wmlHistory.length = 0;
      return "";
    },
    getCurrentCard: function() {
      if (typeof document === 'undefined') return '';
      var c = document.querySelector('.wml-card[style*="display: block"], .wml-card[style*="display:block"]');
      return c ? c.id : '';
    },
    refresh: function() {
      if (typeof updateVariables === 'function') updateVariables();
      return "";
    }
  };

  // ===================================================================
  // Dialogs Library (5) — WAP-194 Section 13
  // Drives the shared in-page modal (wmlShowDialog, defined in wml-engine.js)
  // so dialogs work inside the VS Code webview, where native window.prompt /
  // confirm / alert are unavailable. Each method returns a Promise; the
  // transpiler emits `await` for Dialogs calls (see wmlsToJs.ts). When the
  // shared modal is absent, wmlShowDialog falls back to native dialogs.
  // ===================================================================
  function _wmlsDialog(type, msg, opts) {
    if (typeof wmlShowDialog === 'function') {
      return wmlShowDialog(type, msg, opts);
    }
    // No shared UI available — resolve to the WAP-194 default.
    var o = opts || {};
    return Promise.resolve(
      type === 'confirm' ? true
        : type === 'prompt' ? ((o.def !== undefined && o.def !== null) ? String(o.def) : '')
        : ''
    );
  }
  rt.Dialogs = {
    prompt: function(msg, def) {
      return _wmlsDialog('prompt', msg, { def: def });
    },
    confirm: function(msg, ok, cancel) {
      return _wmlsDialog('confirm', msg, { okLabel: ok, cancelLabel: cancel });
    },
    alert: function(msg) {
      return _wmlsDialog('alert', msg);
    }
  };

  // ===================================================================
  // Console Library (6) — Non-standard debug extension
  // ===================================================================
  rt.Console = {
    print: function(v) {
      var s = v === undefined ? 'invalid' : String(v);
      rt._dbg.log(s);
      console.log(s);
      return "";
    },
    println: function(v) {
      var s = v === undefined ? 'invalid' : String(v);
      rt._dbg.log(s);
      console.log(s);
      return "";
    }
  };

  return rt;
})();
