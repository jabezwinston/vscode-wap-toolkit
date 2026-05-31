/**
 *
 *  Copyright (C) 2026 Jabez Winston
 * 
 *  SPDX-License-Identifier: Apache-2.0
 *
 *  Date : 20-March-2026
 *  WMLScript to JavaScript Transpiler
 *
 *  Transpiles WMLScript source code to JavaScript for direct client-side
 *  execution in the WML preview browser, replacing the server-round-trip
 *  approach (__wmlscript__/exec).
 *
 *  Uses the existing WMLScript parser to build an AST, then walks it to
 *  emit equivalent JavaScript that calls into the __wmls runtime object.
 */

import * as fs from 'fs';
import * as path from 'path';
import { Parser } from '../wmlsc/parser';
import {
    CompilationUnit, FunctionDeclaration,
    Statement, BlockStatement, VariableStatement,
    IfStatement, ForStatement,
    Expression, AssignmentExpression, BinaryExpression,
    UnaryExpression, UpdateExpression, LibraryCallExpression,
    ExternalCallExpression, CommaExpression,
} from '../wmlsc/ast';

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Transpile WMLScript source code to a self-registering JavaScript module.
 * The output wraps all functions in an IIFE that registers extern functions
 * on the global __wmls script registry.
 *
 * @param source  WMLScript source text
 * @param scriptPath  URL path used as the registry key (e.g. '/examples/app.wmls')
 * @returns JavaScript source code string
 */
export function transpileWmls(source: string, scriptPath: string): string {
    const parser = new Parser();
    const ast = parser.parse(source);
    return new CodeGenerator(ast, scriptPath).generate();
}

/**
 * Return the URL paths of external scripts referenced via `use url` pragmas.
 * Paths are resolved relative to the given scriptPath.
 */
export function getExternalDeps(source: string, scriptPath: string): string[] {
    const parser = new Parser();
    const ast = parser.parse(source);
    const dir = scriptPath.substring(0, scriptPath.lastIndexOf('/') + 1);
    return ast.externalDeclarations.map(ext => {
        const url = ext.url;
        if (url.startsWith('/') || url.startsWith('http://') || url.startsWith('https://')) {
            return url;
        }
        return dir + url;
    });
}

/**
 * Return the __wmls runtime library source (plain JavaScript).
 * Must be included in the page before any transpiled modules.
 */
export function getWmlsRuntime(): string {
    return fs.readFileSync(path.join(__dirname, 'wmlsRuntime.js'), 'utf-8');
}

// ---------------------------------------------------------------------------
// Code Generator
// ---------------------------------------------------------------------------

class CodeGenerator {
    private lines: string[] = [];
    private depth = 0;
    private externalUrls = new Map<string, string>();

    constructor(private ast: CompilationUnit, private scriptPath: string) {
        for (const ext of ast.externalDeclarations) {
            this.externalUrls.set(ext.alias, this.resolveUrl(ext.url));
        }
    }

    // ---- helpers --------------------------------------------------------

    private resolveUrl(url: string): string {
        if (url.startsWith('/') || url.startsWith('http://') || url.startsWith('https://')) {
            return url;
        }
        const i = this.scriptPath.lastIndexOf('/');
        const base = i >= 0 ? this.scriptPath.substring(0, i + 1) : '/';
        return base + url;
    }

    private emit(line: string) {
        this.lines.push('  '.repeat(this.depth) + line);
    }

    // ---- top-level ------------------------------------------------------

    generate(): string {
        this.emit('(function(__wmls) {');
        this.depth++;
        this.emit('var __exports = {};');

        for (const fn of this.ast.functions) {
            this.emit('');
            this.emitFunction(fn);
        }

        this.emit('');
        this.emit(`__wmls._register(${JSON.stringify(this.scriptPath)}, __exports);`);
        this.depth--;
        this.emit('})(__wmls);');
        return this.lines.join('\n');
    }

    // ---- functions ------------------------------------------------------

    private emitFunction(fn: FunctionDeclaration) {
        const params = fn.params.join(', ');
        // Functions are async so call sites can `await __wmls._brk(...)` and pause
        // execution without freezing the single-threaded webview event loop.
        if (fn.isExtern) {
            this.emit(`var ${fn.name} = __exports.${fn.name} = async function ${fn.name}(${params}) {`);
        } else {
            this.emit(`async function ${fn.name}(${params}) {`);
        }
        this.depth++;
        // Register a live call-stack frame. The locals thunk closes over the
        // function's (hoisted) variables, so it reports their current values
        // whenever the debugger reads it.
        const locals = this.collectLocals(fn);
        const localsObj = locals.length
            ? `{ ${locals.map(n => `${n}: ${n}`).join(', ')} }`
            : '{}';
        this.emit(`__wmls._enter(${JSON.stringify(this.scriptPath)}, ${JSON.stringify(fn.name)}, [${fn.params.join(', ')}], function(){ return ${localsObj}; });`);
        this.emit('try {');
        this.depth++;
        this.emitBlockBody(fn.body);
        if (!this.blockEndsWithReturn(fn.body)) {
            this.emit('return __wmls._ret("");');
        }
        this.depth--;
        this.emit('} finally { __wmls._leave(); }');
        this.depth--;
        this.emit(fn.isExtern ? '};' : '}');
    }

    /** Collect param names + every (hoisted) declared variable name in the body. */
    private collectLocals(fn: FunctionDeclaration): string[] {
        const names: string[] = [...fn.params];
        const seen = new Set(names);
        const addDecls = (vs: VariableStatement) => {
            for (const d of vs.declarations) {
                if (!seen.has(d.name)) { seen.add(d.name); names.push(d.name); }
            }
        };
        const walk = (s: Statement) => {
            switch (s.type) {
                case 'VariableStatement': addDecls(s); break;
                case 'BlockStatement': s.body.forEach(walk); break;
                case 'IfStatement':
                    walk(s.consequent);
                    if (s.alternate) walk(s.alternate);
                    break;
                case 'WhileStatement': walk(s.body); break;
                case 'ForStatement':
                    if (s.init && s.init.type === 'VariableStatement') addDecls(s.init);
                    walk(s.body);
                    break;
            }
        };
        fn.body.body.forEach(walk);
        return names;
    }

    private blockEndsWithReturn(block: BlockStatement): boolean {
        const stmts = block.body;
        if (stmts.length === 0) return false;
        return this.stmtReturns(stmts[stmts.length - 1]);
    }

    private stmtReturns(s: Statement): boolean {
        switch (s.type) {
            case 'ReturnStatement': return true;
            case 'BlockStatement': return this.blockEndsWithReturn(s);
            case 'IfStatement':
                return !!s.alternate && this.stmtReturns(s.consequent) && this.stmtReturns(s.alternate);
            default: return false;
        }
    }

    // ---- statements -----------------------------------------------------

    private emitBlockBody(block: BlockStatement) {
        for (const s of block.body) this.emitStatement(s);
    }

    private emitStatementBody(s: Statement) {
        if (s.type === 'BlockStatement') {
            this.emitBlockBody(s);
        } else {
            this.emitStatement(s);
        }
    }

    /** Emit a breakpoint/step check before each line-bearing statement. */
    private emitBrk(s: Statement) {
        switch (s.type) {
            case 'ExpressionStatement':
            case 'VariableStatement':
            case 'IfStatement':
            case 'WhileStatement':
            case 'ForStatement':
            case 'ReturnStatement':
            case 'BreakStatement':
            case 'ContinueStatement':
                this.emit(`await __wmls._brk(${s.loc.line});`);
                break;
        }
    }

    private emitStatement(s: Statement) {
        this.emitBrk(s);
        switch (s.type) {
            case 'BlockStatement':
                this.emit('{');
                this.depth++;
                this.emitBlockBody(s);
                this.depth--;
                this.emit('}');
                break;
            case 'VariableStatement':
                this.emitVarStmt(s);
                break;
            case 'ExpressionStatement':
                this.emit(this.expr(s.expression) + ';');
                break;
            case 'IfStatement':
                this.emitIf(s, false);
                break;
            case 'WhileStatement':
                this.emit(`while (${this.expr(s.test)}) {`);
                this.depth++;
                this.emitStatementBody(s.body);
                this.depth--;
                this.emit('}');
                break;
            case 'ForStatement':
                this.emitFor(s);
                break;
            case 'BreakStatement':
                this.emit('break;');
                break;
            case 'ContinueStatement':
                this.emit('continue;');
                break;
            case 'ReturnStatement':
                this.emit(s.argument ? `return __wmls._ret(${this.expr(s.argument)});` : 'return __wmls._ret("");');
                break;
            case 'EmptyStatement':
                break;
        }
    }

    private emitVarStmt(s: VariableStatement) {
        const parts = s.declarations.map(d =>
            d.init ? `${d.name} = ${this.expr(d.init)}` : `${d.name} = ""`
        );
        this.emit(`var ${parts.join(', ')};`);
    }

    private emitIf(s: IfStatement, elseIf: boolean) {
        const kw = elseIf ? '} else if' : 'if';
        this.emit(`${kw} (${this.expr(s.test)}) {`);
        this.depth++;
        this.emitStatementBody(s.consequent);
        this.depth--;
        if (s.alternate) {
            if (s.alternate.type === 'IfStatement') {
                this.emitIf(s.alternate, true);
            } else {
                this.emit('} else {');
                this.depth++;
                this.emitStatementBody(s.alternate);
                this.depth--;
                this.emit('}');
            }
        } else {
            this.emit('}');
        }
    }

    private emitFor(s: ForStatement) {
        let init = '';
        if (s.init) {
            if (s.init.type === 'VariableStatement') {
                const parts = (s.init as VariableStatement).declarations.map(d =>
                    d.init ? `${d.name} = ${this.expr(d.init)}` : `${d.name} = ""`
                );
                init = `var ${parts.join(', ')}`;
            } else {
                init = this.expr(s.init as Expression);
            }
        }
        const test = s.test ? this.expr(s.test) : '';
        const update = s.update ? this.expr(s.update) : '';
        this.emit(`for (${init}; ${test}; ${update}) {`);
        this.depth++;
        this.emitStatementBody(s.body);
        this.depth--;
        this.emit('}');
    }

    // ---- expressions ----------------------------------------------------

    private expr(e: Expression): string {
        switch (e.type) {
            case 'IntegerLiteral':
                return String(e.value);
            case 'FloatLiteral':
                return String(e.value);
            case 'StringLiteral':
                return JSON.stringify(e.value);
            case 'BooleanLiteral':
                return String(e.value);
            case 'InvalidLiteral':
                return 'undefined';
            case 'IdentifierExpression':
                return e.name;
            case 'AssignmentExpression':
                return this.exprAssign(e);
            case 'ConditionalExpression':
                return `(${this.expr(e.test)} ? ${this.expr(e.consequent)} : ${this.expr(e.alternate)})`;
            case 'BinaryExpression':
                return this.exprBinary(e);
            case 'UnaryExpression':
                return this.exprUnary(e);
            case 'UpdateExpression':
                return this.exprUpdate(e);
            case 'TypeofExpression':
                return `__wmls.typeOf(${this.expr(e.operand)})`;
            case 'IsvalidExpression':
                return `(${this.expr(e.operand)} !== undefined)`;
            case 'CallExpression':
                return `(await ${e.callee}(${e.arguments.map(a => this.expr(a)).join(', ')}))`;
            case 'LibraryCallExpression':
                return this.exprLibCall(e);
            case 'ExternalCallExpression':
                return this.exprExtCall(e);
            case 'CommaExpression':
                return `(${(e as CommaExpression).expressions.map(x => this.expr(x)).join(', ')})`;
            default:
                return '""';
        }
    }

    private exprAssign(e: AssignmentExpression): string {
        const name = e.left.name;
        const right = this.expr(e.right);
        if (e.operator === 'div=') {
            return `${name} = __wmls.div(${name}, ${right})`;
        }
        return `${name} ${e.operator} ${right}`;
    }

    private exprBinary(e: BinaryExpression): string {
        const left = this.expr(e.left);
        const right = this.expr(e.right);
        if (e.operator === 'div') {
            return `__wmls.div(${left}, ${right})`;
        }
        return `(${left} ${e.operator} ${right})`;
    }

    private exprUnary(e: UnaryExpression): string {
        return `${e.operator}${this.expr(e.operand)}`;
    }

    private exprUpdate(e: UpdateExpression): string {
        const name = e.argument.name;
        return e.prefix ? `${e.operator}${name}` : `${name}${e.operator}`;
    }

    private exprLibCall(e: LibraryCallExpression): string {
        const args = e.arguments.map(a => this.expr(a)).join(', ');
        const call = `__wmls.${e.library}.${e.method}(${args})`;
        // Dialogs.* run an async in-page modal and return a Promise; await it so
        // the caller sees the resolved value. (All transpiled functions are
        // async, so `await` is always valid here.) Other libraries are sync.
        return e.library === 'Dialogs' ? `(await ${call})` : call;
    }

    private exprExtCall(e: ExternalCallExpression): string {
        const url = this.externalUrls.get(e.scriptAlias) || e.scriptAlias;
        const args = e.arguments.map(a => this.expr(a)).join(', ');
        return `(await __wmls._call(${JSON.stringify(url)}, ${JSON.stringify(e.functionName)}, [${args}]))`;
    }
}