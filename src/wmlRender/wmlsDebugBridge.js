/**
 * Copyright (C) 2026 Jabez Winston
 *
 * SPDX-License-Identifier: Apache-2.0
 *
 * Date : 29-May-2026
 *
 * WMLScript debug bridge.
 *
 * Connects the in-webview __wmls._dbg controller (wmlsRuntime.js) to the
 * VS Code debug adapter (WmlsPreviewDebugAdapter) over the webview postMessage
 * channel, so WMLScript running live in the WML preview is debugged through
 * VS Code's native Run & Debug UI (editor breakpoints, stepping, call stack,
 * variables, Debug Console).
 *
 * Loaded after wmlsRuntime.js + preview.js. Active only inside the VS Code
 * webview (where acquireVsCodeApi is defined); in a plain browser preview it is
 * a no-op and __wmls._dbg simply falls back to the console.
 */
(function () {
  'use strict';

  if (typeof __wmls === 'undefined' || !__wmls._dbg) { return; }

  // Reuse preview.js's cached handle (acquireVsCodeApi may be called only once
  // per page load). Null in a plain browser → no DAP bridge.
  /* global wmlsGetVsCodeApi */
  var api = (typeof wmlsGetVsCodeApi === 'function') ? wmlsGetVsCodeApi() : null;
  if (!api) { return; }

  var dbg = __wmls._dbg;

  function post(ev, payload) {
    api.postMessage({ type: 'wmlsDbg', ev: ev, payload: payload });
  }

  // ── __wmls._dbg  →  host (debug adapter) ──────────────────────────
  dbg.onUpdate = function (event) {
    if (event === 'stopped') {
      post('stopped', dbg.snapshot());
    } else if (event === 'resumed') {
      post('continued');
    }
  };
  dbg.onOutput = function (text) {
    post('output', { text: String(text) });
  };

  // ── host (debug adapter)  →  __wmls._dbg ──────────────────────────
  window.addEventListener('message', function (e) {
    var msg = e.data;
    if (!msg || msg.type !== 'wmlsDbg' || !msg.cmd) { return; }
    var a = msg.args || {};
    switch (msg.cmd) {
      case 'setBreakpoints': dbg.setBreakpoints(a.script, a.lines); break;
      case 'setEnabled':     dbg.setEnabled(a.enabled); break;
      case 'continue':       dbg.continue(); break;
      case 'stepOver':       dbg.stepOver(); break;
      case 'stepIn':         dbg.stepIn(); break;
      case 'stepOut':        dbg.stepOut(); break;
      case 'stop':           dbg.stop(); break;
      case 'evaluate':
        post('evaluateResult', { requestId: a.requestId, result: dbg.evaluate(a.frameId, a.expr) });
        break;
    }
  });

  // Announce readiness so the adapter (re)sends breakpoints + enables debugging.
  // Re-fires on every preview reload (auto-refresh), keeping breakpoints alive.
  post('ready');
})();
