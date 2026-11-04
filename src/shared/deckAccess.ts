/**
 *  Copyright (C) 2026 Jabez Winston
 *
 *  SPDX-License-Identifier: Apache-2.0
 *
 *  WML 1.3 deck access control (WML 1.3: 11.3.1, conformance rule WML-C-14).
 *
 *  vscode-free so it can be unit tested directly.
 */

export interface AccessVerdict {
    allowed: boolean;
    reason?: string;
}

/**
 * WML 1.3:
 *  - 11.3.1 The Access Element
 *  - 12.1 Deck Access Control
 *
 * Enforce a destination deck's <access> element against the referring deck URL.
 *
 * The access domain is suffix-matched against the referrer host (whole sub-domain
 * labels, each matched exactly — e.g. "wapforum.org" matches "www.wapforum.org"
 * but not "forum.org") and the access path is prefix-matched against the referrer
 * path (whole path elements, each matched exactly — e.g. "/X" matches "/X/Y" but
 * not "/XZ").
 *
 * A deck without an <access> element has access control disabled.  A navigation
 * with no referring deck (user-initiated address-bar / history / back) is allowed.
 */
export function checkDeckAccess(wml: string, referrerUrl: string, destUrl: string): AccessVerdict {
    const m = /<access\b([^>]*?)\/?>/i.exec(wml);
    if (!m) { return { allowed: true }; }            // no <access> → control disabled
    if (!referrerUrl) { return { allowed: true }; }  // no referring deck

    const attrs = m[1] || '';
    const domAttr = (/\bdomain\s*=\s*"([^"]*)"/i.exec(attrs) || [])[1];
    const pathAttr = (/\bpath\s*=\s*"([^"]*)"/i.exec(attrs) || [])[1];
    return accessAllows(domAttr, pathAttr, referrerUrl, destUrl, 'link to');
}

/**
 * WML 1.3: 11.3.1 The Access Element
 * WMLScript: 6.7.2 Access Control
 *
 * The match of an access domain and path (either may be absent: the
 * destination's host and "/") against the referrer, as WML's <access>
 * (WML 1.3: 11.3.1) and a WMLScript unit's `use access` (WMLScript: 6.7.2)
 * define it alike.
 */
export function accessAllows(domAttr: string | undefined, pathAttr: string | undefined,
                             referrerUrl: string, destUrl: string, verb = 'call'): AccessVerdict {
    let dest: URL, ref: URL;
    try { dest = new URL(destUrl); ref = new URL(referrerUrl); } catch { return { allowed: true }; }

    // Defaults: domain → destination's host; path → "/".
    const accessDomain = (domAttr || dest.hostname).toLowerCase();
    let accessPath = pathAttr || '/';
    if (!accessPath.startsWith('/')) {
        try { accessPath = new URL(accessPath, destUrl).pathname; } catch { /* keep literal */ }
    }

    // Domain suffix match — whole sub-domain labels, each matched exactly.
    const accLabels = accessDomain.split('.').filter(Boolean);
    const refLabels = ref.hostname.toLowerCase().split('.').filter(Boolean);
    const domainOk = accLabels.length <= refLabels.length &&
        accLabels.every((lab, i) => lab === refLabels[refLabels.length - accLabels.length + i]);

    // Path prefix match — whole path elements, each matched exactly.
    const accParts = accessPath.split('/').filter(Boolean);
    const refParts = ref.pathname.split('/').filter(Boolean);
    const pathOk = accParts.length <= refParts.length &&
        accParts.every((p, i) => p === refParts[i]);

    if (domainOk && pathOk) { return { allowed: true }; }
    return {
        allowed: false,
        reason: `Access denied: ${referrerUrl} may not ${verb} ${destUrl} ` +
                `(${verb === 'call' ? 'unit' : 'deck'} restricts access to domain "${accessDomain}", path "${accessPath}")`,
    };
}
