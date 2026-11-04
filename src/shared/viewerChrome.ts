/**
 *  Copyright (C) 2026 Jabez Winston
 *
 *  SPDX-License-Identifier: Apache-2.0
 *
 *  Page shell shared by the read-only file viewers (WBMP, WBXML, WMLSC): one
 *  header — the file name, facts about the file, actions — and one stylesheet,
 *  so the three custom editors read as one tool and follow the VS Code theme.
 */

import { escapeHtml } from './htmlUtils';

export interface ViewerPage {
    fileName: string;
    /** Short plain-text facts, shown as chips after the name. */
    facts: string[];
    /** Trusted HTML for the header's right-hand side. */
    actions?: string;
    /** Trusted HTML for the page below the header. */
    body: string;
    /** Rules for this viewer only. */
    css?: string;
    /** Script for this viewer only; the webview must enable scripts. */
    script?: string;
}

const VIEWER_CSS = `
  body {
    margin: 0;
    background: var(--vscode-editor-background, #1e1e1e);
    color: var(--vscode-editor-foreground, #ccc);
    font-family: var(--vscode-font-family, sans-serif);
    font-size: 13px;
  }
  .viewer-header {
    position: sticky;
    top: 0;
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 8px 16px;
    padding: 8px 16px;
    background: var(--vscode-sideBar-background, #252526);
    border-bottom: 1px solid var(--vscode-panel-border, #2b2b2b);
  }
  .viewer-facts { flex: 1; display: flex; flex-wrap: wrap; align-items: center; gap: 6px; }
  .viewer-name { font-weight: 600; margin-right: 4px; }
  .viewer-fact {
    padding: 1px 8px;
    border-radius: 10px;
    background: var(--vscode-badge-background, #4d4d4d);
    color: var(--vscode-badge-foreground, #fff);
    font-size: 12px;
  }
  .viewer-actions { display: flex; align-items: center; gap: 4px; }
  button {
    background: var(--vscode-button-secondaryBackground, #3a3d41);
    color: var(--vscode-button-secondaryForeground, #fff);
    border: none;
    border-radius: 4px;
    padding: 4px 12px;
    font: inherit;
    font-size: 12px;
    cursor: pointer;
  }
  button:hover { background: var(--vscode-button-secondaryHoverBackground, #45494e); }
  button.primary { background: var(--vscode-button-background, #0e639c); color: var(--vscode-button-foreground, #fff); }
  button.primary:hover { background: var(--vscode-button-hoverBackground, #1177bb); }
  .viewer-code {
    margin: 0;
    padding: 12px 16px;
    font-family: var(--vscode-editor-font-family, monospace);
    font-size: var(--vscode-editor-font-size, 14px);
    line-height: 1.5;
    white-space: pre;
    tab-size: 2;
  }
`;

export function viewerHtml(page: ViewerPage): string {
    const facts = page.facts.map(f => `<span class="viewer-fact">${escapeHtml(f)}</span>`).join('');
    return `<!DOCTYPE html>
<html>
<head>
<meta charset="UTF-8">
<style>${VIEWER_CSS}${page.css || ''}</style>
</head>
<body>
  <div class="viewer-header">
    <div class="viewer-facts"><span class="viewer-name">${escapeHtml(page.fileName)}</span>${facts}</div>
    ${page.actions ? `<div class="viewer-actions">${page.actions}</div>` : ''}
  </div>
  ${page.body}
  ${page.script ? `<script>${page.script}</script>` : ''}
</body>
</html>`;
}
