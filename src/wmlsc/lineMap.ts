/**
 *  Copyright (C) 2026 Jabez Winston
 *
 *  SPDX-License-Identifier: Apache-2.0
 *
 *  Date : 29-May-2026
 *
 *  Pure helpers for the WMLScript bytecode debugger's PC↔source-line maps.
 *
 *  The compiler emits, per function, a list of { pc, line } entries (sorted by pc,
 *  one per statement boundary). These functions translate between source lines (for
 *  DAP breakpoints) and bytecode offsets (for the VM), and back (for the call stack).
 *  No `vscode` dependency, so it is require()-able from plain-Node tests.
 */
import type { LineMapEntry } from './compiler';

/** A resolved breakpoint/step location within a module. */
export interface ResolvedLocation {
    funcIndex: number;
    pc: number;
    /** The line actually resolved to (may differ from the requested line when it
     *  had no statement and the breakpoint slid down to the next one). */
    line: number;
}

/**
 * Resolve a source line to the bytecode location where execution should stop.
 * Prefers an exact match (the first statement on that line); otherwise slides down
 * to the next statement at or after the line — matching how editors snap a
 * breakpoint set on a blank/comment line to the next executable line.
 * Returns undefined when no statement exists at or after the line.
 */
export function lineToPc(lineMaps: LineMapEntry[][], requestedLine: number): ResolvedLocation | undefined {
    let exact: ResolvedLocation | undefined;
    let next: ResolvedLocation | undefined;
    for (let fi = 0; fi < lineMaps.length; fi++) {
        for (const e of lineMaps[fi]) {
            if (e.line === requestedLine) {
                if (!exact || e.pc < exact.pc) { exact = { funcIndex: fi, pc: e.pc, line: e.line }; }
            } else if (e.line > requestedLine) {
                if (!next || e.line < next.line || (e.line === next.line && e.pc < next.pc)) {
                    next = { funcIndex: fi, pc: e.pc, line: e.line };
                }
            }
        }
    }
    return exact ?? next;
}

/**
 * Map a runtime location (funcIndex + program counter) back to a source line —
 * the line of the statement currently executing (the entry with the largest pc ≤ pc).
 * Returns 0 when the function has no line map.
 */
export function pcToLine(lineMaps: LineMapEntry[][], funcIndex: number, pc: number): number {
    const map = lineMaps[funcIndex];
    if (!map || map.length === 0) { return 0; }
    let line = map[0].line;
    for (const e of map) {
        if (e.pc <= pc) { line = e.line; } else { break; }
    }
    return line;
}
