/**
 *  Copyright (C) 2026 Jabez Winston
 *
 *  SPDX-License-Identifier: Apache-2.0
 *
 *  Date : 29-May-2026
 *
 *  Maps a fetched WAP resource URL to a stable read-only virtual-document URI used
 *  by the WAP Browser debugger, and back.
 *
 *  The browser fetches decks/scripts from a server (HTTP/WSP), so the source is not
 *  a workspace file. To place breakpoints we surface it through a TextDocument
 *  ContentProvider under the `wml-debug` scheme. The original scheme is preserved as
 *  authority userinfo (`http@host:port`) so the mapping is reversible, and the file
 *  extension is kept so VS Code infers the `wml`/`wmlscript` language (→ breakpoints).
 *
 *  No `vscode` dependency, so it is require()-able from plain-Node tests. The URI
 *  string IS the registry key shared by the panel (registerScript) and the adapter
 *  (setBreakpoints source matching).
 */

export const DEBUG_SCHEME = 'wml-debug';

/** Build the `wml-debug://<scheme>@<host>/<path>` virtual-doc URI for a resource URL. */
export function urlToDebugUri(url: string): string {
    try {
        const u = new URL(url);
        const scheme = u.protocol.replace(/:$/, '');     // 'http' | 'https' | 'wsp' …
        const authority = `${scheme}@${u.host}`;          // host includes :port when present
        const path = u.pathname || '/';
        return `${DEBUG_SCHEME}://${authority}${path}`;
    } catch {
        // Not an absolute URL — fall back to an opaque, still-unique key.
        return `${DEBUG_SCHEME}:///${url.replace(/^[/]+/, '')}`;
    }
}

/** Reverse of urlToDebugUri — reconstruct the original resource URL. */
export function debugUriToUrl(uri: string): string {
    const m = /^wml-debug:\/\/([^@/]+)@([^/]+)(\/.*)?$/.exec(uri);
    if (!m) { return uri; }
    const [, scheme, host, path] = m;
    return `${scheme}://${host}${path || '/'}`;
}
