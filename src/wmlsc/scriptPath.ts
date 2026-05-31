/**
 *  Copyright (C) 2026 Jabez Winston
 *
 *  SPDX-License-Identifier: Apache-2.0
 *
 *  Date : 29-May-2026
 *
 *  Mapping between an absolute filesystem path and the WMLScript registry key
 *  used in the preview (`'/' + workspace-relative posix path`). Mirrors the
 *  key construction in wmlToHtml.getEmbeddedWmlScripts. No `vscode` dependency,
 *  so it is require()-able from plain-Node tests.
 */
import * as path from 'path';

export function fsPathToScriptPath(fsPath: string, root: string): string {
    const rel = path.relative(root, fsPath).split(path.sep).join('/');
    return '/' + rel.replace(/^\/+/, '');
}

export function scriptPathToFsPath(scriptPath: string, root: string): string {
    const rel = scriptPath.replace(/^\/+/, '');
    return path.join(root, rel.split('/').join(path.sep));
}
