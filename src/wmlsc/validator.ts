/**
 *
 *  Copyright (C) 2026 Jabez Winston
 *
 *  SPDX-License-Identifier: Apache-2.0
 *
 *  WMLScript Source Validator — lexical, syntactic and semantic diagnostics.
 *
 *  Based on WAP-193 (WMLScript Language) and WAP-194 (Standard Libraries).
 *
 *  The validation core (`validateWmlsText`, `Severity`, `WmlsDiag`) has NO
 *  runtime `vscode` dependency, so it can be required from plain Node (tests).
 *  `vscode` is imported as a type only and loaded lazily via `getVscode()` in
 *  the adapter functions at the bottom — mirroring `wmlValidator.ts`.
 */
import type * as vscode from 'vscode';
import { Lexer, TokenType } from './lexer';
import { Parser } from './parser';
import {
    CompilationUnit, Statement, Expression,
} from './ast';
import { STDLIB_NAME_TO_ID, STDLIB_FUNCTIONS, STDLIB_NARGS } from './opcodes';

/** Mirrors vscode.DiagnosticSeverity numeric values. */
export enum Severity {
    Error = 0,
    Warning = 1,
    Information = 2,
    Hint = 3,
}

export interface WmlsDiag {
    /** 0-based line */
    line: number;
    /** 0-based column */
    col: number;
    /** length of the highlighted range on that line */
    length: number;
    message: string;
    severity: Severity;
}

type Pusher = (loc: { line: number; column: number }, length: number, message: string, severity?: Severity) => void;

// ---------------------------------------------------------------------------
// Validation core (vscode-free)
// ---------------------------------------------------------------------------

export function validateWmlsText(source: string): WmlsDiag[] {
    const diags: WmlsDiag[] = [];
    const push: Pusher = (loc, length, message, severity = Severity.Error) => {
        diags.push({
            line: Math.max(0, loc.line - 1),
            col: Math.max(0, loc.column - 1),
            length: Math.max(1, length),
            message,
            severity,
        });
    };

    // 1) Lexical structure: strings & comments (WMLS-S-006/007/010/011).
    scanLexical(source, push);

    // 2) Parse. The parser throws on the first syntax error but records it.
    const parser = new Parser();
    let ast: CompilationUnit | null = null;
    try {
        ast = parser.parse(source);
    } catch {
        ast = null;
    }
    for (const e of parser.getErrors()) {
        push({ line: e.line, column: e.column }, 1,
            e.message.replace(/^Parse error at line \d+, column \d+: /, ''), Severity.Error);
    }
    if (!ast) { return dedupe(diags); }

    // 3) At most one access-control pragma per compilation unit (WMLScript: 6.7.2).
    checkSingleAccessPragma(source, push);

    // 3b) What the token stream shows and the AST does not keep: literals
    // past their range, escapes, reserved names, duplicates, pragma order.
    checkTokens(source, push);
    if (ast.functions.length > 0 && !ast.functions.some((f) => f.isExtern)) {
        push(ast.functions[0].loc, 'function'.length,
            'A compilation unit must have at least one extern function (WMLScript: 6.4.1)', Severity.Error);
    }

    // 4) Semantic checks against the AST.
    try {
        checkSemantics(ast, push);
    } catch {
        /* never let a semantic-walk bug suppress the syntactic diagnostics */
    }

    return dedupe(diags);
}

// --- Lexical scan -----------------------------------------------------------

function scanLexical(src: string, push: Pusher): void {
    let line = 1, col = 1;
    let i = 0;
    while (i < src.length) {
        const c = src[i];

        // String literal (single or double quoted; no line breaks allowed).
        if (c === '"' || c === "'") {
            const q = c, sl = line, sc = col;
            i++; col++;
            let terminated = false;
            while (i < src.length) {
                const d = src[i];
                if (d === '\\') { i += 2; col += 2; continue; }
                if (d === q) { i++; col++; terminated = true; break; }
                if (d === '\n') { break; }
                i++; col++;
            }
            if (!terminated) { push({ line: sl, column: sc }, 1, 'Unterminated string literal', Severity.Error); }
            continue;
        }

        // Single-line comment.
        if (c === '/' && src[i + 1] === '/') {
            while (i < src.length && src[i] !== '\n') { i++; col++; }
            continue;
        }

        // Multi-line comment — must terminate and must not nest (WMLS-S-007).
        if (c === '/' && src[i + 1] === '*') {
            const sl = line, sc = col;
            i += 2; col += 2;
            let closed = false;
            while (i < src.length) {
                if (src[i] === '/' && src[i + 1] === '*') {
                    push({ line, column: col }, 2, 'Nested comments are not allowed in WMLScript', Severity.Warning);
                    i += 2; col += 2;
                    continue;
                }
                if (src[i] === '*' && src[i + 1] === '/') { i += 2; col += 2; closed = true; break; }
                if (src[i] === '\n') { line++; col = 1; i++; } else { i++; col++; }
            }
            if (!closed) { push({ line: sl, column: sc }, 2, 'Unterminated comment', Severity.Error); }
            continue;
        }

        if (c === '\n') { line++; col = 1; i++; } else { col++; i++; }
    }
}

// WMLScript: 6.7.2 Access Control
function checkSingleAccessPragma(src: string, push: Pusher): void {
    // Count `use access` pragmas via the token stream (so comments don't count);
    // flag the second and beyond.
    const toks = new Lexer(src).tokenize();
    let count = 0;
    for (let i = 0; i < toks.length - 1; i++) {
        if (toks[i].type === TokenType.Use && toks[i + 1].type === TokenType.Access) {
            count++;
            if (count > 1) {
                push({ line: toks[i].line, column: toks[i].column }, 'use access'.length,
                    'A compilation unit may contain at most one access-control pragma', Severity.Error);
            }
        }
    }
}

// --- Token checks (WMLScript: 6.1.5, 6.2.2, 6.4.1, 6.5.4, 6.7, 7.2) -------

/** WMLScript:
 *  - 7.2 WMLScript Lexical Grammar
 *  - 6.1.7 Reserved Words
 *
 * Reserved words (WMLScript: 7.2): the keywords, those WMLScript does not use, the
 *  future ones and the literals; none may name a variable, parameter,
 *  function or `use url` alias */
const RESERVED = new Set([
    'access', 'agent', 'break', 'continue', 'div', 'domain', 'else', 'equiv', 'extern', 'for',
    'function', 'header', 'http', 'if', 'isvalid', 'meta', 'name', 'path', 'return', 'typeof',
    'url', 'use', 'user', 'var', 'while',
    'delete', 'in', 'lib', 'new', 'null', 'this', 'void', 'with',
    'case', 'catch', 'class', 'const', 'debugger', 'default', 'do', 'enum', 'export', 'extends',
    'finally', 'import', 'private', 'public', 'sizeof', 'struct', 'super', 'switch', 'throw', 'try',
    'true', 'false', 'invalid',
]);

/** Tokens a value can end with: a '-' after one is binary */
const VALUE_END = new Set([
    TokenType.Identifier, TokenType.IntegerLiteral, TokenType.FloatLiteral, TokenType.StringLiteral,
    TokenType.True, TokenType.False, TokenType.Invalid, TokenType.RightParen,
    TokenType.PlusPlus, TokenType.MinusMinus,
]);

const ASSIGN_OPS = new Set([
    TokenType.Assign, TokenType.PlusAssign, TokenType.MinusAssign, TokenType.StarAssign,
    TokenType.SlashAssign, TokenType.DivAssign, TokenType.PercentAssign, TokenType.AmpAssign,
    TokenType.PipeAssign, TokenType.CaretAssign, TokenType.LShiftAssign, TokenType.RShiftAssign,
    TokenType.URShiftAssign,
]);

/** WMLScript: 6.1.5.3 String Literals
 *
 * A string literal's escapes (WMLScript: 6.1.5.3): \' \" \\ \/ \b \f \n \r \t, \xhh, \uhhhh, \ooo */
function badEscape(raw: string): string | null {
    for (let i = 1; i < raw.length - 1; i++) {
        if (raw[i] !== '\\') { continue; }
        const e = raw[++i];
        if ('\'"\\/bfnrt'.includes(e) || /[0-7]/.test(e)) { continue; }
        if (e === 'x' && /^[0-9A-Fa-f]{2}$/.test(raw.substr(i + 1, 2))) { i += 2; continue; }
        if (e === 'u' && /^[0-9A-Fa-f]{4}$/.test(raw.substr(i + 1, 4))) { i += 4; continue; }
        return '\\' + (e ?? '');
    }
    return null;
}

// WMLScript:
//  - 6.1.5 Literals
//  - 6.2.2 Variable Scope and Lifetime
//  - 6.4.1 Declaration
//  - 6.5.4 Variable Statement
//  - 6.7 Pragmas
function checkTokens(src: string, push: Pusher): void {
    const toks = new Lexer(src).tokenize();
    const at = (t: { line: number; column: number }) => ({ line: t.line, column: t.column });
    const named = (i: number): boolean => toks[i] !== undefined &&
        (toks[i].type === TokenType.Identifier || RESERVED.has(toks[i].value));
    const declName = (i: number, what: string): void => {
        if (named(i) && RESERVED.has(toks[i].value)) {
            push(at(toks[i]), toks[i].value.length,
                `"${toks[i].value}" is a reserved word and cannot name a ${what} (WMLScript: 7.2)`, Severity.Error);
        }
    };
    let seenFunction = false;
    let names = new Set<string>();      // the current function's parameters and variables
    const aliases = new Set<string>();
    for (let i = 0; i < toks.length; i++) {
        const t = toks[i];
        switch (t.type) {
            case TokenType.IntegerLiteral: {
                const raw = t.value;
                if (/^0[0-7]*[89]/.test(raw)) {
                    push(at(t), raw.length, `"${raw}" is neither an octal nor a decimal literal (WMLScript: 6.1.5.1)`, Severity.Error);
                    break;
                }
                const v = /^0[xX]/.test(raw) ? parseInt(raw.slice(2), 16)
                    : /^0[0-7]+$/.test(raw) ? parseInt(raw, 8) : Number(raw);
                const neg = i > 0 && toks[i - 1].type === TokenType.Minus && !(i > 1 && VALUE_END.has(toks[i - 2].type));
                if (v > (neg ? 2147483648 : 2147483647)) {
                    push(at(t), raw.length, `Integer literal ${raw} is past the integer range (WMLScript: 6.1.5.1)`, Severity.Error);
                }
                break;
            }
            case TokenType.FloatLiteral: {
                const f = new Float32Array([Number(t.value)])[0];
                if (!isFinite(f)) {
                    push(at(t), t.value.length, `Floating-point literal ${t.value} is past the float range (WMLScript: 6.1.5.2)`, Severity.Error);
                }
                break;
            }
            case TokenType.StringLiteral: {
                const q = src[t.offset];
                let end = t.offset + 1;
                while (end < src.length && src[end] !== q) { end += src[end] === '\\' ? 2 : 1; }
                const bad = badEscape(src.slice(t.offset, end + 1));
                if (bad) { push(at(t), end + 1 - t.offset, `Unknown escape sequence ${bad} (WMLScript: 6.1.5.3)`, Severity.Error); }
                break;
            }
            case TokenType.Function: {
                seenFunction = true;
                declName(i + 1, 'function');
                names = new Set<string>();
                let k = i + 2;
                if (toks[k]?.type === TokenType.LeftParen) {
                    for (k++; toks[k] && toks[k].type !== TokenType.RightParen; k++) {
                        if (named(k)) { declName(k, 'parameter'); names.add(toks[k].value); }
                    }
                }
                break;
            }
            case TokenType.Var: {
                // var a [= init] {, b [= init]} — each init a ConditionalExpression (WMLScript: 6.5.4)
                let k = i + 1;
                while (named(k)) {
                    const n = toks[k];
                    declName(k, 'variable');
                    if (names.has(n.value)) {
                        push(at(n), n.value.length, `"${n.value}" is already declared in this function (WMLScript: 6.2.2)`, Severity.Error);
                    }
                    names.add(n.value);
                    k++;
                    if (toks[k]?.type === TokenType.Assign) {
                        let depth = 0;
                        for (k++; toks[k] && toks[k].type !== TokenType.EOF; k++) {
                            const tt = toks[k].type;
                            if (tt === TokenType.LeftParen) { depth++; }
                            else if (tt === TokenType.RightParen) { depth--; }
                            else if (depth === 0 && (tt === TokenType.Comma || tt === TokenType.Semicolon)) { break; }
                            else if (depth === 0 && ASSIGN_OPS.has(tt)) {
                                push(at(toks[k]), toks[k].value.length || 1,
                                    'A variable\'s initializer cannot be an assignment: put it in parentheses (WMLScript: 6.5.4)', Severity.Error);
                            }
                        }
                    }
                    if (toks[k]?.type !== TokenType.Comma) { break; }
                    k++;
                }
                break;
            }
            case TokenType.Use:
                if (seenFunction) {
                    push(at(t), 'use'.length, 'Pragmas must come before the functions (WMLScript: 6.7)', Severity.Error);
                }
                if (toks[i + 1]?.type === TokenType.Url && named(i + 2)) {
                    declName(i + 2, '"use url" alias');
                    const a = toks[i + 2].value;
                    if (aliases.has(a)) {
                        push(at(toks[i + 2]), a.length, `"use url ${a}" is declared twice (WMLScript: 6.7)`, Severity.Error);
                    }
                    aliases.add(a);
                }
                break;
        }
    }
}

// --- Semantic walk ----------------------------------------------------------

interface SemCtx {
    declared: Set<string>;
    aliases: Set<string>;
    funcArity: Map<string, number>;
    push: Pusher;
    loopDepth: number;
}

function checkSemantics(ast: CompilationUnit, push: Pusher): void {
    const funcArity = new Map<string, number>();
    const seen = new Set<string>();
    for (const fn of ast.functions) {
        if (seen.has(fn.name)) {
            push(fn.loc, fn.name.length, `Duplicate function name "${fn.name}"`, Severity.Error);
        } else {
            seen.add(fn.name);
            funcArity.set(fn.name, fn.params.length);
        }
    }

    const aliases = new Set(ast.externalDeclarations.map((e) => e.alias));

    for (const fn of ast.functions) {
        const pseen = new Set<string>();
        for (const p of fn.params) {
            if (pseen.has(p)) {
                push(fn.loc, fn.name.length, `Duplicate parameter "${p}" in function "${fn.name}"`, Severity.Error);
            }
            pseen.add(p);
        }

        const declared = new Set<string>(fn.params);
        collectVarDecls(fn.body, declared);

        const ctx: SemCtx = { declared, aliases, funcArity, push, loopDepth: 0 };
        walkStmt(fn.body, ctx);
    }
}

/** Collect every variable declared anywhere in the function (function-scoped). */
function collectVarDecls(stmt: Statement, out: Set<string>): void {
    switch (stmt.type) {
        case 'VariableStatement':
            for (const d of stmt.declarations) { out.add(d.name); }
            break;
        case 'BlockStatement':
            for (const s of stmt.body) { collectVarDecls(s, out); }
            break;
        case 'IfStatement':
            collectVarDecls(stmt.consequent, out);
            if (stmt.alternate) { collectVarDecls(stmt.alternate, out); }
            break;
        case 'WhileStatement':
            collectVarDecls(stmt.body, out);
            break;
        case 'ForStatement':
            if (stmt.init && stmt.init.type === 'VariableStatement') {
                for (const d of stmt.init.declarations) { out.add(d.name); }
            }
            collectVarDecls(stmt.body, out);
            break;
    }
}

function walkStmt(stmt: Statement, ctx: SemCtx): void {
    switch (stmt.type) {
        case 'BlockStatement':
            for (const s of stmt.body) { walkStmt(s, ctx); }
            break;
        case 'VariableStatement':
            for (const d of stmt.declarations) { if (d.init) { walkExpr(d.init, ctx); } }
            break;
        case 'ExpressionStatement':
            walkExpr(stmt.expression, ctx);
            break;
        case 'IfStatement':
            walkExpr(stmt.test, ctx);
            walkStmt(stmt.consequent, ctx);
            if (stmt.alternate) { walkStmt(stmt.alternate, ctx); }
            break;
        case 'WhileStatement':
            walkExpr(stmt.test, ctx);
            ctx.loopDepth++;
            walkStmt(stmt.body, ctx);
            ctx.loopDepth--;
            break;
        case 'ForStatement':
            if (stmt.init) {
                if (stmt.init.type === 'VariableStatement') { walkStmt(stmt.init, ctx); }
                else { walkExpr(stmt.init, ctx); }
            }
            if (stmt.test) { walkExpr(stmt.test, ctx); }
            if (stmt.update) { walkExpr(stmt.update, ctx); }
            ctx.loopDepth++;
            walkStmt(stmt.body, ctx);
            ctx.loopDepth--;
            break;
        case 'ReturnStatement':
            if (stmt.argument) { walkExpr(stmt.argument, ctx); }
            break;
        case 'BreakStatement':
            if (ctx.loopDepth === 0) { ctx.push(stmt.loc, 'break'.length, '"break" used outside of a loop', Severity.Error); }
            break;
        case 'ContinueStatement':
            if (ctx.loopDepth === 0) { ctx.push(stmt.loc, 'continue'.length, '"continue" used outside of a loop', Severity.Error); }
            break;
        case 'EmptyStatement':
            break;
    }
}

function walkExpr(expr: Expression, ctx: SemCtx): void {
    switch (expr.type) {
        case 'IdentifierExpression':
            if (!ctx.declared.has(expr.name)) {
                ctx.push(expr.loc, expr.name.length, `Undefined variable "${expr.name}"`, Severity.Error);
            }
            break;
        case 'AssignmentExpression':
            if (!ctx.declared.has(expr.left.name)) {
                ctx.push(expr.left.loc, expr.left.name.length, `Assignment to undeclared variable "${expr.left.name}"`, Severity.Error);
            }
            walkExpr(expr.right, ctx);
            break;
        case 'UpdateExpression':
            if (!ctx.declared.has(expr.argument.name)) {
                ctx.push(expr.argument.loc, expr.argument.name.length, `Undefined variable "${expr.argument.name}"`, Severity.Error);
            }
            break;
        case 'BinaryExpression':
            walkExpr(expr.left, ctx);
            walkExpr(expr.right, ctx);
            break;
        case 'UnaryExpression':
        case 'TypeofExpression':
        case 'IsvalidExpression':
            walkExpr(expr.operand, ctx);
            break;
        case 'ConditionalExpression':
            walkExpr(expr.test, ctx);
            walkExpr(expr.consequent, ctx);
            walkExpr(expr.alternate, ctx);
            break;
        case 'CommaExpression':
            for (const e of expr.expressions) { walkExpr(e, ctx); }
            break;
        case 'CallExpression':
            if (!ctx.funcArity.has(expr.callee)) {
                ctx.push(expr.loc, expr.callee.length, `Call to undefined function "${expr.callee}"`, Severity.Error);
            } else {
                const arity = ctx.funcArity.get(expr.callee)!;
                if (expr.arguments.length !== arity) {
                    ctx.push(expr.loc, expr.callee.length,
                        `Function "${expr.callee}" expects ${arity} argument(s) but got ${expr.arguments.length}`, Severity.Error);
                }
            }
            for (const a of expr.arguments) { walkExpr(a, ctx); }
            break;
        case 'LibraryCallExpression': {
            const libId = STDLIB_NAME_TO_ID[expr.library];
            if (libId === undefined) {
                ctx.push(expr.loc, expr.library.length, `Unknown standard library "${expr.library}"`, Severity.Error);
            } else {
                const funcs = STDLIB_FUNCTIONS[libId] ?? [];
                let idx = funcs.indexOf(expr.method);
                if (idx === -1) {
                    const lower = expr.method.toLowerCase();
                    idx = funcs.findIndex((f) => f.toLowerCase() === lower);
                }
                if (idx === -1) {
                    ctx.push(expr.loc, expr.library.length + 1 + expr.method.length,
                        `Unknown library function "${expr.library}.${expr.method}"`, Severity.Error);
                } else {
                    const nargs = STDLIB_NARGS[libId]?.[idx];
                    if (nargs !== undefined && expr.arguments.length !== nargs) {
                        ctx.push(expr.loc, expr.library.length + 1 + expr.method.length,
                            `"${expr.library}.${expr.method}" expects ${nargs} argument(s) but got ${expr.arguments.length}`, Severity.Error);
                    }
                }
            }
            for (const a of expr.arguments) { walkExpr(a, ctx); }
            break;
        }
        case 'ExternalCallExpression':
            if (!ctx.aliases.has(expr.scriptAlias)) {
                ctx.push(expr.loc, expr.scriptAlias.length,
                    `Undeclared external compilation unit "${expr.scriptAlias}" (add a "use url ${expr.scriptAlias} \\"...\\";" pragma)`, Severity.Error);
            }
            for (const a of expr.arguments) { walkExpr(a, ctx); }
            break;
        // Literals — nothing to check.
        case 'IntegerLiteral':
        case 'FloatLiteral':
        case 'StringLiteral':
        case 'BooleanLiteral':
        case 'InvalidLiteral':
            break;
    }
}

function dedupe(diags: WmlsDiag[]): WmlsDiag[] {
    const seen = new Set<string>();
    const out: WmlsDiag[] = [];
    for (const d of diags) {
        const key = `${d.line}:${d.col}:${d.severity}:${d.message}`;
        if (!seen.has(key)) { seen.add(key); out.push(d); }
    }
    return out;
}

// ---------------------------------------------------------------------------
// vscode adapter (lazy-loaded — see header)
// ---------------------------------------------------------------------------

function getVscode(): typeof import('vscode') {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    return require('vscode');
}

function toVsDiag(v: typeof import('vscode'), d: WmlsDiag): vscode.Diagnostic {
    const severity = [
        v.DiagnosticSeverity.Error,
        v.DiagnosticSeverity.Warning,
        v.DiagnosticSeverity.Information,
        v.DiagnosticSeverity.Hint,
    ][d.severity];
    const range = new v.Range(d.line, d.col, d.line, d.col + d.length);
    const diag = new v.Diagnostic(range, d.message, severity);
    diag.source = 'WMLScript';
    return diag;
}

export function validateWmlsDocument(document: vscode.TextDocument): vscode.Diagnostic[] {
    const v = getVscode();
    return validateWmlsText(document.getText()).map((d) => toVsDiag(v, d));
}

/** Shared with the compile/run commands so compilation errors land in the same
 *  Problems collection as the live source diagnostics. */
let sharedCollection: vscode.DiagnosticCollection | undefined;

/** Publish live source diagnostics for a file URI to the Problems panel. */
export function publishWmlsDiagnostics(uri: vscode.Uri, source: string): void {
    if (!sharedCollection) { return; }
    const v = getVscode();
    sharedCollection.set(uri, validateWmlsText(source).map((d) => toVsDiag(v, d)));
}

/**
 * Publish a thrown ParseError/CompileError as a clickable Problems-panel
 * diagnostic at its source location. Prefers the (better-located) validator
 * diagnostics; only falls back to the raw compiler error when the validator
 * found nothing — avoiding duplicate / mislocated entries.
 */
export function reportWmlsCompileError(uri: vscode.Uri, source: string, err: unknown): void {
    if (!sharedCollection) { return; }
    const v = getVscode();
    const diags = validateWmlsText(source).map((d) => toVsDiag(v, d));
    const hasError = diags.some((d) => d.severity === v.DiagnosticSeverity.Error);
    if (!hasError) {
        const e = (err || {}) as { message?: string; line?: number; column?: number };
        const line = typeof e.line === 'number' && e.line > 0 ? e.line - 1 : 0;
        const col = typeof e.column === 'number' && e.column > 0 ? e.column - 1 : 0;
        const message = (e.message || String(err)).replace(/^(?:Parse|Compile) error at line \d+, column \d+: /, '');
        const range = new v.Range(line, col, line, col + 1);
        const diag = new v.Diagnostic(range, message, v.DiagnosticSeverity.Error);
        diag.source = 'WMLScript';
        diags.push(diag);
    }
    sharedCollection.set(uri, diags);
}

export function activateWmlsValidation(context: vscode.ExtensionContext): void {
    const v = getVscode();
    const diagnosticCollection = v.languages.createDiagnosticCollection('wmlscript');
    sharedCollection = diagnosticCollection;
    context.subscriptions.push(diagnosticCollection);

    function validate(document: vscode.TextDocument): void {
        if (document.languageId !== 'wmlscript') { return; }
        diagnosticCollection.set(document.uri, validateWmlsDocument(document));
    }

    for (const doc of v.workspace.textDocuments) { validate(doc); }

    context.subscriptions.push(
        v.workspace.onDidOpenTextDocument((doc) => validate(doc))
    );

    let debounceTimer: ReturnType<typeof setTimeout> | undefined;
    context.subscriptions.push(
        v.workspace.onDidChangeTextDocument((e) => {
            if (e.document.languageId !== 'wmlscript') { return; }
            if (debounceTimer) { clearTimeout(debounceTimer); }
            debounceTimer = setTimeout(() => validate(e.document), 500);
        })
    );

    context.subscriptions.push(
        v.workspace.onDidSaveTextDocument((doc) => validate(doc))
    );

    context.subscriptions.push(
        v.workspace.onDidCloseTextDocument((doc) => {
            diagnosticCollection.delete(doc.uri);
        })
    );
}
