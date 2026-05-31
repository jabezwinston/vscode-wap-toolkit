/**
 *  Copyright (C) 2026 Jabez Winston
 *
 *  SPDX-License-Identifier: Apache-2.0
 *
 *  Shared HTML/XML escaping utilities.
 */

/** Escape text for safe embedding in HTML. Uses `&#39;` for single quotes (valid in all HTML versions). */
export function escapeHtml(text: string): string {
    return text
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}

/** Escape text for safe embedding in XML/WML. Uses `&apos;` (XML predefined entity). */
export function xmlEscape(s: string): string {
    return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;').replace(/'/g, '&apos;');
}
