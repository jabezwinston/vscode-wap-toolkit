/**
 *
 *  Copyright (C) 2026 Jabez Winston
 * 
 *  SPDX-License-Identifier: Apache-2.0
 *
 *  Date : 18-March-2026
 * 
 *  WMLScript Parser — Parses token stream into AST
 *  Based on WAP-193-WMLScript grammar specification
 *
 *  Implements a recursive-descent parser with operator-precedence climbing
 *  for expression parsing.
 */
import { Token, TokenType, Lexer } from './lexer';
import {
    CompilationUnit, ExternalDeclaration, FunctionDeclaration,
    AccessControlPragma, MetaPragma, MetaKind,
    Statement, BlockStatement, VariableStatement, VariableDeclarator,
    ExpressionStatement, IfStatement, WhileStatement, ForStatement,
    BreakStatement, ContinueStatement, ReturnStatement, EmptyStatement,
    Expression, AssignmentExpression, ConditionalExpression, BinaryExpression,
    UnaryExpression, UpdateExpression, CallExpression, LibraryCallExpression,
    ExternalCallExpression, IdentifierExpression, IntegerLiteral, FloatLiteral,
    StringLiteral, BooleanLiteral, InvalidLiteral, TypeofExpression,
    IsvalidExpression, SourceLocation, CommaExpression,
} from './ast';

export class ParseError extends Error {
    constructor(message: string, public line: number, public column: number) {
        super(`Parse error at line ${line}, column ${column}: ${message}`);
    }
}

export class Parser {
    private tokens: Token[] = [];
    private pos = 0;
    private errors: ParseError[] = [];

    parse(source: string): CompilationUnit {
        const lexer = new Lexer(source);
        this.tokens = lexer.tokenize();
        this.pos = 0;
        this.errors = [];

        return this.parseCompilationUnit();
    }

    getErrors(): ParseError[] {
        return this.errors;
    }

    // --- Token Utilities ---

    private current(): Token {
        return this.tokens[this.pos] ?? this.tokens[this.tokens.length - 1];
    }

    private peek(offset = 0): Token {
        return this.tokens[this.pos + offset] ?? this.tokens[this.tokens.length - 1];
    }

    private advance(): Token {
        const tok = this.current();
        if (this.pos < this.tokens.length - 1) { this.pos++; }
        return tok;
    }

    private expect(type: TokenType, contextMsg?: string): Token {
        const tok = this.current();
        if (tok.type !== type) {
            const expected = TokenType[type];
            const got = tok.type === TokenType.EOF ? 'end of file' : `'${tok.value}'`;
            const ctx = contextMsg ? ` (in ${contextMsg})` : '';
            this.error(`Expected ${expected} but got ${got}${ctx}`);
        }
        return this.advance();
    }

    private match(type: TokenType): boolean {
        if (this.current().type === type) {
            this.advance();
            return true;
        }
        return false;
    }

    private check(type: TokenType): boolean {
        return this.current().type === type;
    }

    /** Accept an identifier or a contextual keyword token as an identifier.
     *  In WMLScript, pragma keywords (url, name, path, domain, access, meta, etc.)
     *  are valid identifiers outside of pragma context. */
    private expectIdentifier(): Token {
        const tok = this.current();
        if (tok.type === TokenType.Identifier
            || tok.type === TokenType.Url
            || tok.type === TokenType.Name
            || tok.type === TokenType.Path
            || tok.type === TokenType.Domain
            || tok.type === TokenType.Access
            || tok.type === TokenType.Agent
            || tok.type === TokenType.Meta
            || tok.type === TokenType.Http
            || tok.type === TokenType.Equiv
            || tok.type === TokenType.User
            || tok.type === TokenType.Header) {
            return this.advance();
        }
        const got = tok.type === TokenType.EOF ? 'end of file' : `'${tok.value}'`;
        this.error(`Expected Identifier but got ${got}`);
    }

    /** Accept an identifier or keyword token as a method name in Lib.method() calls */
    private expectMethodName(): Token {
        const tok = this.current();
        // Accept identifiers
        if (tok.type === TokenType.Identifier) {
            return this.advance();
        }
        // Keywords are valid method names in library calls (e.g. String.toString)
        // Any non-EOF, non-punctuation token with a string value is accepted
        if (tok.type !== TokenType.EOF && typeof tok.value === 'string' && tok.value.length > 0
            && tok.type !== TokenType.LeftParen && tok.type !== TokenType.RightParen
            && tok.type !== TokenType.Semicolon && tok.type !== TokenType.Dot) {
            return this.advance();
        }
        const got = tok.type === TokenType.EOF ? 'end of file' : `'${tok.value}'`;
        this.error(`Expected method name but got ${got}`);
    }

    private loc(): SourceLocation {
        const t = this.current();
        return { line: t.line, column: t.column, offset: t.offset };
    }

    private error(message: string): never {
        const t = this.current();
        const err = new ParseError(message, t.line, t.column);
        this.errors.push(err);
        throw err;
    }

    // --- Grammar Rules ---

    private parseCompilationUnit(): CompilationUnit {
        const l = this.loc();
        const externalDeclarations: ExternalDeclaration[] = [];
        const metaPragmas: MetaPragma[] = [];
        let accessControl: AccessControlPragma | undefined;
        const functions: FunctionDeclaration[] = [];

        // Parse pragmas and function declarations (pragmas technically come first
        // per spec, but we tolerate them interspersed for robustness)
        while (!this.check(TokenType.EOF)) {
            if (this.check(TokenType.Use)) {
                this.parsePragma(externalDeclarations, metaPragmas, (ac) => { accessControl = ac; });
            } else {
                functions.push(this.parseFunctionDeclaration());
            }
        }

        return { type: 'CompilationUnit', externalDeclarations, accessControl, metaPragmas, functions, loc: l };
    }

    // use url Alias "string" ;       — WAP-193 Section 6.7.1
    // use access domain "d" path "p" ; — WAP-193 Section 6.7.2
    // use meta name/http equiv/user agent "name" "content" ; — 6.7.3
    private parsePragma(
        externals: ExternalDeclaration[],
        metas: MetaPragma[],
        setAccess: (ac: AccessControlPragma) => void,
    ): void {
        const l = this.loc();
        this.expect(TokenType.Use);

        // use url Alias "url";
        if (this.check(TokenType.Url)) {
            this.advance();
            const alias = this.expect(TokenType.Identifier);
            const urlTok = this.expect(TokenType.StringLiteral);
            this.expect(TokenType.Semicolon);
            externals.push({ type: 'ExternalDeclaration', url: urlTok.value, alias: alias.value, loc: l });
            return;
        }

        // use access domain "d" path "p" ;
        if (this.check(TokenType.Access)) {
            this.advance();
            let domain: string | undefined;
            let path: string | undefined;
            if (this.check(TokenType.Domain)) {
                this.advance();
                domain = this.expect(TokenType.StringLiteral).value;
            }
            if (this.check(TokenType.Path)) {
                this.advance();
                path = this.expect(TokenType.StringLiteral).value;
            }
            this.expect(TokenType.Semicolon);
            setAccess({ type: 'AccessControlPragma', domain, path, loc: l });
            return;
        }

        // use meta name/http equiv/user agent "name" "content" ["scheme"] ;
        if (this.check(TokenType.Meta)) {
            this.advance();
            let kind: MetaKind;
            if (this.check(TokenType.Name)) {
                this.advance();
                kind = 'name';
            } else if (this.check(TokenType.Http)) {
                this.advance();
                this.expect(TokenType.Equiv);
                kind = 'httpequiv';
            } else if (this.check(TokenType.User)) {
                this.advance();
                this.expect(TokenType.Agent);
                kind = 'useragent';
            } else {
                this.error('Expected name, http equiv, or user agent after "use meta"');
            }
            const propertyName = this.expect(TokenType.StringLiteral).value;
            const content = this.expect(TokenType.StringLiteral).value;
            let scheme: string | undefined;
            if (this.check(TokenType.StringLiteral)) {
                scheme = this.current().value;
                this.advance();
            }
            this.expect(TokenType.Semicolon);
            metas.push({ type: 'MetaPragma', kind, propertyName, content, scheme, loc: l });
            return;
        }

        // Unknown pragma — skip until semicolon
        while (!this.check(TokenType.Semicolon) && !this.check(TokenType.EOF)) this.advance();
        this.match(TokenType.Semicolon);
    }

    // [extern] function Name(params) { body }
    private parseFunctionDeclaration(): FunctionDeclaration {
        const l = this.loc();
        let isExtern = false;
        if (this.check(TokenType.Extern)) {
            isExtern = true;
            this.advance();
        }
        this.expect(TokenType.Function);
        const name = this.expectIdentifier();
        this.expect(TokenType.LeftParen);
        const params: string[] = [];
        if (!this.check(TokenType.RightParen)) {
            params.push(this.expectIdentifier().value);
            while (this.match(TokenType.Comma)) {
                params.push(this.expectIdentifier().value);
            }
        }
        this.expect(TokenType.RightParen);
        const body = this.parseBlockStatement();
        // Allow optional trailing semicolon after function body (common in WMLScript files)
        this.match(TokenType.Semicolon);
        return { type: 'FunctionDeclaration', name: name.value, params, body, isExtern, loc: l };
    }

    // { statement* }
    private parseBlockStatement(): BlockStatement {
        const l = this.loc();
        this.expect(TokenType.LeftBrace);
        const body: Statement[] = [];
        while (!this.check(TokenType.RightBrace) && !this.check(TokenType.EOF)) {
            body.push(this.parseStatement());
        }
        this.expect(TokenType.RightBrace);
        return { type: 'BlockStatement', body, loc: l };
    }

    private parseStatement(): Statement {
        switch (this.current().type) {
            case TokenType.LeftBrace:
                return this.parseBlockStatement();
            case TokenType.Var:
                return this.parseVariableStatement();
            case TokenType.If:
                return this.parseIfStatement();
            case TokenType.While:
                return this.parseWhileStatement();
            case TokenType.For:
                return this.parseForStatement();
            case TokenType.Break:
                return this.parseBreakStatement();
            case TokenType.Continue:
                return this.parseContinueStatement();
            case TokenType.Return:
                return this.parseReturnStatement();
            case TokenType.Semicolon:
                return this.parseEmptyStatement();
            default:
                return this.parseExpressionStatement();
        }
    }

    // var x = expr, y = expr ;
    private parseVariableStatement(): VariableStatement {
        const l = this.loc();
        this.expect(TokenType.Var);
        const declarations: VariableDeclarator[] = [];
        declarations.push(this.parseVariableDeclarator());
        while (this.match(TokenType.Comma)) {
            declarations.push(this.parseVariableDeclarator());
        }
        this.expect(TokenType.Semicolon, 'variable declaration');
        return { type: 'VariableStatement', declarations, loc: l };
    }

    private parseVariableDeclarator(): VariableDeclarator {
        const l = this.loc();
        const name = this.expectIdentifier();
        let init: Expression | null = null;
        if (this.match(TokenType.Assign)) {
            init = this.parseAssignmentExpression();
        }
        return { type: 'VariableDeclarator', name: name.value, init, loc: l };
    }

    // if (expr) stmt [else stmt]
    private parseIfStatement(): IfStatement {
        const l = this.loc();
        this.expect(TokenType.If);
        this.expect(TokenType.LeftParen);
        const test = this.parseExpression();
        this.expect(TokenType.RightParen);
        const consequent = this.parseStatement();
        let alternate: Statement | null = null;
        if (this.match(TokenType.Else)) {
            alternate = this.parseStatement();
        }
        return { type: 'IfStatement', test, consequent, alternate, loc: l };
    }

    // while (expr) stmt
    private parseWhileStatement(): WhileStatement {
        const l = this.loc();
        this.expect(TokenType.While);
        this.expect(TokenType.LeftParen);
        const test = this.parseExpression();
        this.expect(TokenType.RightParen);
        const body = this.parseStatement();
        return { type: 'WhileStatement', test, body, loc: l };
    }

    // for (init; test; update) stmt
    private parseForStatement(): ForStatement {
        const l = this.loc();
        this.expect(TokenType.For);
        this.expect(TokenType.LeftParen);

        let init: VariableStatement | Expression | null = null;
        if (this.check(TokenType.Var)) {
            // Parse var declaration without trailing semicolon (we handle it)
            const varLoc = this.loc();
            this.advance();
            const declarations: VariableDeclarator[] = [this.parseVariableDeclarator()];
            while (this.match(TokenType.Comma)) {
                declarations.push(this.parseVariableDeclarator());
            }
            init = { type: 'VariableStatement', declarations, loc: varLoc };
        } else if (!this.check(TokenType.Semicolon)) {
            init = this.parseExpression();
        }
        this.expect(TokenType.Semicolon, 'for init');

        let test: Expression | null = null;
        if (!this.check(TokenType.Semicolon)) {
            test = this.parseExpression();
        }
        this.expect(TokenType.Semicolon, 'for condition');

        let update: Expression | null = null;
        if (!this.check(TokenType.RightParen)) {
            update = this.parseExpression();
        }
        this.expect(TokenType.RightParen);

        const body = this.parseStatement();
        return { type: 'ForStatement', init, test, update, body, loc: l };
    }

    private parseBreakStatement(): BreakStatement {
        const l = this.loc();
        this.expect(TokenType.Break);
        this.expect(TokenType.Semicolon, 'break');
        return { type: 'BreakStatement', loc: l };
    }

    private parseContinueStatement(): ContinueStatement {
        const l = this.loc();
        this.expect(TokenType.Continue);
        this.expect(TokenType.Semicolon, 'continue');
        return { type: 'ContinueStatement', loc: l };
    }

    private parseReturnStatement(): ReturnStatement {
        const l = this.loc();
        this.expect(TokenType.Return);
        let argument: Expression | null = null;
        if (!this.check(TokenType.Semicolon)) {
            argument = this.parseExpression();
        }
        this.expect(TokenType.Semicolon, 'return');
        return { type: 'ReturnStatement', argument, loc: l };
    }

    private parseEmptyStatement(): EmptyStatement {
        const l = this.loc();
        this.expect(TokenType.Semicolon);
        return { type: 'EmptyStatement', loc: l };
    }

    private parseExpressionStatement(): ExpressionStatement {
        const l = this.loc();
        const expression = this.parseExpression();
        this.expect(TokenType.Semicolon, 'expression statement');
        return { type: 'ExpressionStatement', expression, loc: l };
    }

    // --- Expression Parsing ---

    private parseExpression(): Expression {
        const expr = this.parseAssignmentExpression();
        if (this.check(TokenType.Comma)) {
            const expressions: Expression[] = [expr];
            while (this.match(TokenType.Comma)) {
                expressions.push(this.parseAssignmentExpression());
            }
            return { type: 'CommaExpression', expressions, loc: expr.loc };
        }
        return expr;
    }

    private parseAssignmentExpression(): Expression {
        const expr = this.parseConditionalExpression();

        // Check for assignment operators
        const assignOps: Record<number, string> = {
            [TokenType.Assign]: '=',
            [TokenType.PlusAssign]: '+=',
            [TokenType.MinusAssign]: '-=',
            [TokenType.StarAssign]: '*=',
            [TokenType.SlashAssign]: '/=',
            [TokenType.DivAssign]: 'div=',
            [TokenType.PercentAssign]: '%=',
            [TokenType.AmpAssign]: '&=',
            [TokenType.PipeAssign]: '|=',
            [TokenType.CaretAssign]: '^=',
            [TokenType.LShiftAssign]: '<<=',
            [TokenType.RShiftAssign]: '>>=',
            [TokenType.URShiftAssign]: '>>>=',
        };

        const currentType = this.current().type;
        if (currentType in assignOps) {
            if (expr.type !== 'IdentifierExpression') {
                this.error('Invalid assignment target');
            }
            const op = assignOps[currentType] as AssignmentExpression['operator'];
            this.advance();
            const right = this.parseAssignmentExpression();
            return { type: 'AssignmentExpression', operator: op, left: expr as IdentifierExpression, right, loc: expr.loc };
        }

        return expr;
    }

    // expr ? expr : expr
    private parseConditionalExpression(): Expression {
        const expr = this.parseLogicalOrExpression();
        if (this.check(TokenType.Question)) {
            this.advance();
            const consequent = this.parseAssignmentExpression();
            this.expect(TokenType.Colon);
            const alternate = this.parseAssignmentExpression();
            return { type: 'ConditionalExpression', test: expr, consequent, alternate, loc: expr.loc };
        }
        return expr;
    }

    // || operator
    private parseLogicalOrExpression(): Expression {
        let left = this.parseLogicalAndExpression();
        while (this.check(TokenType.PipePipe)) {
            this.advance();
            const right = this.parseLogicalAndExpression();
            left = { type: 'BinaryExpression', operator: '||', left, right, loc: left.loc };
        }
        return left;
    }

    // && operator
    private parseLogicalAndExpression(): Expression {
        let left = this.parseBitwiseOrExpression();
        while (this.check(TokenType.AmpAmp)) {
            this.advance();
            const right = this.parseBitwiseOrExpression();
            left = { type: 'BinaryExpression', operator: '&&', left, right, loc: left.loc };
        }
        return left;
    }

    // | operator
    private parseBitwiseOrExpression(): Expression {
        let left = this.parseBitwiseXorExpression();
        while (this.check(TokenType.Pipe)) {
            this.advance();
            const right = this.parseBitwiseXorExpression();
            left = { type: 'BinaryExpression', operator: '|', left, right, loc: left.loc };
        }
        return left;
    }

    // ^ operator
    private parseBitwiseXorExpression(): Expression {
        let left = this.parseBitwiseAndExpression();
        while (this.check(TokenType.Caret)) {
            this.advance();
            const right = this.parseBitwiseAndExpression();
            left = { type: 'BinaryExpression', operator: '^', left, right, loc: left.loc };
        }
        return left;
    }

    // & operator
    private parseBitwiseAndExpression(): Expression {
        let left = this.parseEqualityExpression();
        while (this.check(TokenType.Ampersand)) {
            this.advance();
            const right = this.parseEqualityExpression();
            left = { type: 'BinaryExpression', operator: '&', left, right, loc: left.loc };
        }
        return left;
    }

    // == !=
    private parseEqualityExpression(): Expression {
        let left = this.parseRelationalExpression();
        while (this.check(TokenType.EqualEqual) || this.check(TokenType.NotEqual)) {
            const op = this.advance().value as '==' | '!=';
            const right = this.parseRelationalExpression();
            left = { type: 'BinaryExpression', operator: op, left, right, loc: left.loc };
        }
        return left;
    }

    // < > <= >=
    private parseRelationalExpression(): Expression {
        let left = this.parseShiftExpression();
        while (this.check(TokenType.LessThan) || this.check(TokenType.GreaterThan) ||
               this.check(TokenType.LessEqual) || this.check(TokenType.GreaterEqual)) {
            const op = this.advance().value as '<' | '>' | '<=' | '>=';
            const right = this.parseShiftExpression();
            left = { type: 'BinaryExpression', operator: op, left, right, loc: left.loc };
        }
        return left;
    }

    // << >> >>>
    private parseShiftExpression(): Expression {
        let left = this.parseAdditiveExpression();
        while (this.check(TokenType.LShift) || this.check(TokenType.RShift) || this.check(TokenType.URShift)) {
            const op = this.advance().value as '<<' | '>>' | '>>>';
            const right = this.parseAdditiveExpression();
            left = { type: 'BinaryExpression', operator: op, left, right, loc: left.loc };
        }
        return left;
    }

    // + -
    private parseAdditiveExpression(): Expression {
        let left = this.parseMultiplicativeExpression();
        while (this.check(TokenType.Plus) || this.check(TokenType.Minus)) {
            const op = this.advance().value as '+' | '-';
            const right = this.parseMultiplicativeExpression();
            left = { type: 'BinaryExpression', operator: op, left, right, loc: left.loc };
        }
        return left;
    }

    // * / div %
    private parseMultiplicativeExpression(): Expression {
        let left = this.parseUnaryExpression();
        while (this.check(TokenType.Star) || this.check(TokenType.Slash) ||
               this.check(TokenType.Div) || this.check(TokenType.Percent)) {
            const tok = this.advance();
            const op = tok.value as '*' | '/' | 'div' | '%';
            const right = this.parseUnaryExpression();
            left = { type: 'BinaryExpression', operator: op, left, right, loc: left.loc };
        }
        return left;
    }

    // prefix: ++ -- + - ~ ! typeof isvalid
    private parseUnaryExpression(): Expression {
        const l = this.loc();

        if (this.check(TokenType.PlusPlus) || this.check(TokenType.MinusMinus)) {
            const op = this.advance().value as '++' | '--';
            const arg = this.parseUnaryExpression();
            if (arg.type !== 'IdentifierExpression') {
                this.error('Invalid prefix update target');
            }
            return { type: 'UpdateExpression', operator: op, prefix: true, argument: arg as IdentifierExpression, loc: l };
        }

        if (this.check(TokenType.Plus)) {
            this.advance();
            const operand = this.parseUnaryExpression();
            return { type: 'UnaryExpression', operator: '+', operand, loc: l };
        }
        if (this.check(TokenType.Minus)) {
            this.advance();
            const operand = this.parseUnaryExpression();
            return { type: 'UnaryExpression', operator: '-', operand, loc: l };
        }
        if (this.check(TokenType.Tilde)) {
            this.advance();
            const operand = this.parseUnaryExpression();
            return { type: 'UnaryExpression', operator: '~', operand, loc: l };
        }
        if (this.check(TokenType.Exclaim)) {
            this.advance();
            const operand = this.parseUnaryExpression();
            return { type: 'UnaryExpression', operator: '!', operand, loc: l };
        }
        if (this.check(TokenType.Typeof)) {
            this.advance();
            const operand = this.parseUnaryExpression();
            return { type: 'TypeofExpression', operand, loc: l };
        }
        if (this.check(TokenType.Isvalid)) {
            this.advance();
            const operand = this.parseUnaryExpression();
            return { type: 'IsvalidExpression', operand, loc: l };
        }

        return this.parsePostfixExpression();
    }

    // postfix: expr++ expr--
    private parsePostfixExpression(): Expression {
        const expr = this.parseCallExpression();
        if (this.check(TokenType.PlusPlus) || this.check(TokenType.MinusMinus)) {
            const op = this.advance().value as '++' | '--';
            if (expr.type !== 'IdentifierExpression') {
                this.error('Invalid postfix update target');
            }
            return { type: 'UpdateExpression', operator: op, prefix: false, argument: expr as IdentifierExpression, loc: expr.loc };
        }
        return expr;
    }

    // function calls: name(args), Lib.func(args), Alias#func(args)
    private parseCallExpression(): Expression {
        const l = this.loc();
        const primary = this.parsePrimaryExpression();

        // Check for Lib.method(args) or Alias#func(args) or just func(args)
        if (primary.type === 'IdentifierExpression') {
            const name = primary.name;

            // Library call: Identifier.method(args)
            if (this.check(TokenType.Dot)) {
                this.advance();
                const method = this.expectMethodName();
                this.expect(TokenType.LeftParen);
                const args = this.parseArgumentList();
                this.expect(TokenType.RightParen);
                return { type: 'LibraryCallExpression', library: name, method: method.value, arguments: args, loc: l };
            }

            // External call: Alias#func(args)
            if (this.check(TokenType.Hash)) {
                this.advance();
                const funcName = this.expectIdentifier();
                this.expect(TokenType.LeftParen);
                const args = this.parseArgumentList();
                this.expect(TokenType.RightParen);
                return { type: 'ExternalCallExpression', scriptAlias: name, functionName: funcName.value, arguments: args, loc: l };
            }

            // Local function call: func(args)
            if (this.check(TokenType.LeftParen)) {
                this.advance();
                const args = this.parseArgumentList();
                this.expect(TokenType.RightParen);
                return { type: 'CallExpression', callee: name, arguments: args, loc: l };
            }
        }

        return primary;
    }

    private parseArgumentList(): Expression[] {
        const args: Expression[] = [];
        if (!this.check(TokenType.RightParen)) {
            args.push(this.parseAssignmentExpression());
            while (this.match(TokenType.Comma)) {
                args.push(this.parseAssignmentExpression());
            }
        }
        return args;
    }

    private parsePrimaryExpression(): Expression {
        const l = this.loc();
        const tok = this.current();

        switch (tok.type) {
            case TokenType.IntegerLiteral: {
                this.advance();
                let value: number;
                if (tok.value.startsWith('0x') || tok.value.startsWith('0X')) {
                    value = parseInt(tok.value, 16);
                } else if (tok.value.startsWith('0') && tok.value.length > 1) {
                    value = parseInt(tok.value, 8);
                } else {
                    value = parseInt(tok.value, 10);
                }
                return { type: 'IntegerLiteral', value, loc: l };
            }
            case TokenType.FloatLiteral:
                this.advance();
                return { type: 'FloatLiteral', value: parseFloat(tok.value), loc: l };

            case TokenType.StringLiteral:
                this.advance();
                return { type: 'StringLiteral', value: tok.value, loc: l };

            case TokenType.True:
                this.advance();
                return { type: 'BooleanLiteral', value: true, loc: l };

            case TokenType.False:
                this.advance();
                return { type: 'BooleanLiteral', value: false, loc: l };

            case TokenType.Invalid:
                this.advance();
                return { type: 'InvalidLiteral', loc: l };

            case TokenType.Identifier:
            case TokenType.Url:
            case TokenType.Name:
            case TokenType.Path:
            case TokenType.Domain:
            case TokenType.Access:
            case TokenType.Agent:
            case TokenType.Meta:
            case TokenType.Http:
            case TokenType.Equiv:
            case TokenType.User:
            case TokenType.Header:
                this.advance();
                return { type: 'IdentifierExpression', name: tok.value, loc: l };

            case TokenType.LeftParen: {
                this.advance();
                const expr = this.parseExpression();
                this.expect(TokenType.RightParen);
                return expr;
            }

            default:
                this.error(`Unexpected token: '${tok.value}'`);
        }
    }
}
