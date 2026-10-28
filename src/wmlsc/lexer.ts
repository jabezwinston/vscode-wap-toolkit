/**
 *
 *  Copyright (C) 2026 Jabez Winston
 * 
 *  SPDX-License-Identifier: Apache-2.0
 *
 *  Date : 18-March-2026
 *  
 *  WMLScript Lexer — Tokenizes WMLScript source code
 *  Based on WAP-193-WMLScript specification
 */

export enum TokenType {
    // Literals
    IntegerLiteral,
    FloatLiteral,
    StringLiteral,

    // Identifier
    Identifier,

    // Keywords
    Access,
    Agent,
    Break,
    Continue,
    Div,        // integer division operator keyword
    Domain,
    Else,
    Equiv,
    Extern,
    For,
    Function,
    Header,
    Http,
    If,
    Isvalid,
    Meta,
    Name,
    Path,
    Return,
    Typeof,
    Use,
    User,
    Var,
    While,
    Url,

    // Boolean & special literals
    True,
    False,
    Invalid,

    // Operators
    Plus,           // +
    Minus,          // -
    Star,           // *
    Slash,          // /
    Percent,        // %
    Ampersand,      // &
    Pipe,           // |
    Caret,          // ^
    Tilde,          // ~
    Exclaim,        // !
    LessThan,       // <
    GreaterThan,    // >
    Assign,         // =
    Dot,            // .
    Hash,           // #
    Semicolon,      // ;
    Comma,          // ,
    Question,       // ?
    Colon,          // :
    LeftParen,      // (
    RightParen,     // )
    LeftBrace,      // {
    RightBrace,     // }

    // Multi-character operators
    PlusPlus,       // ++
    MinusMinus,     // --
    PlusAssign,     // +=
    MinusAssign,    // -=
    StarAssign,     // *=
    SlashAssign,    // /=
    DivAssign,      // div=
    PercentAssign,  // %=
    AmpAssign,      // &=
    PipeAssign,     // |=
    CaretAssign,    // ^=
    LShiftAssign,   // <<=
    RShiftAssign,   // >>=
    URShiftAssign,  // >>>=
    EqualEqual,     // ==
    NotEqual,       // !=
    LessEqual,      // <=
    GreaterEqual,   // >=
    AmpAmp,         // &&
    PipePipe,       // ||
    LShift,         // <<
    RShift,         // >>
    URShift,        // >>>

    // Special
    EOF,
    Error,
}

export interface Token {
    type: TokenType;
    value: string;
    line: number;
    column: number;
    offset: number;
}

const KEYWORDS: Record<string, TokenType> = {
    'break':     TokenType.Break,
    'continue':  TokenType.Continue,
    'div':       TokenType.Div,
    'else':      TokenType.Else,
    'extern':    TokenType.Extern,
    'for':       TokenType.For,
    'function':  TokenType.Function,
    'if':        TokenType.If,
    'isvalid':   TokenType.Isvalid,
    'return':    TokenType.Return,
    'typeof':    TokenType.Typeof,
    'use':       TokenType.Use,
    'var':       TokenType.Var,
    'while':     TokenType.While,
    'url':       TokenType.Url,
    'true':      TokenType.True,
    'false':     TokenType.False,
    'invalid':   TokenType.Invalid,
    'access':    TokenType.Access,
    'agent':     TokenType.Agent,
    'domain':    TokenType.Domain,
    'equiv':     TokenType.Equiv,
    'http':      TokenType.Http,
    'meta':      TokenType.Meta,
    'name':      TokenType.Name,
    'path':      TokenType.Path,
    'user':      TokenType.User,
};

export class Lexer {
    private source: string;
    private pos = 0;
    private line = 1;
    private column = 1;
    private tokens: Token[] = [];

    constructor(source: string) {
        this.source = source;
    }

    tokenize(): Token[] {
        while (this.pos < this.source.length) {
            this.skipWhitespaceAndComments();
            if (this.pos >= this.source.length) { break; }

            const ch = this.source[this.pos];

            if (this.isDigitStart(ch)) {
                this.readNumber();
            } else if (this.isIdentStart(ch)) {
                this.readIdentifier();
            } else if (ch === '"' || ch === "'") {
                this.readString(ch);
            } else {
                this.readOperator();
            }
        }

        this.tokens.push({
            type: TokenType.EOF,
            value: '',
            line: this.line,
            column: this.column,
            offset: this.pos,
        });

        return this.tokens;
    }

    private emit(type: TokenType, value: string, line: number, column: number, offset: number): void {
        this.tokens.push({ type, value, line, column, offset });
    }

    private peek(offset = 0): string {
        return this.source[this.pos + offset] ?? '';
    }

    private advance(): string {
        const ch = this.source[this.pos++];
        if (ch === '\n') {
            this.line++;
            this.column = 1;
        } else {
            this.column++;
        }
        return ch;
    }

    private skipWhitespaceAndComments(): void {
        while (this.pos < this.source.length) {
            const ch = this.source[this.pos];

            if (ch === ' ' || ch === '\t' || ch === '\r' || ch === '\n') {
                this.advance();
                continue;
            }

            // Single-line comment
            if (ch === '/' && this.peek(1) === '/') {
                this.advance(); this.advance();
                while (this.pos < this.source.length && this.source[this.pos] !== '\n') {
                    this.advance();
                }
                continue;
            }

            // Multi-line comment
            if (ch === '/' && this.peek(1) === '*') {
                this.advance(); this.advance();
                while (this.pos < this.source.length) {
                    if (this.source[this.pos] === '*' && this.peek(1) === '/') {
                        this.advance(); this.advance();
                        break;
                    }
                    this.advance();
                }
                continue;
            }

            break;
        }
    }

    private isDigitStart(ch: string): boolean {
        if (ch >= '0' && ch <= '9') { return true; }
        // .5 style float literals
        if (ch === '.' && this.peek(1) >= '0' && this.peek(1) <= '9') { return true; }
        return false;
    }

    private isDigit(ch: string): boolean {
        return ch >= '0' && ch <= '9';
    }

    private isHexDigit(ch: string): boolean {
        return (ch >= '0' && ch <= '9') || (ch >= 'a' && ch <= 'f') || (ch >= 'A' && ch <= 'F');
    }

    private isOctDigit(ch: string): boolean {
        return ch >= '0' && ch <= '7';
    }

    private isIdentStart(ch: string): boolean {
        return (ch >= 'a' && ch <= 'z') || (ch >= 'A' && ch <= 'Z') || ch === '_';
    }

    private isIdentPart(ch: string): boolean {
        return this.isIdentStart(ch) || this.isDigit(ch);
    }

    private readNumber(): void {
        const startLine = this.line;
        const startCol = this.column;
        const startOffset = this.pos;
        let isFloat = false;

        // Handle 0x (hex) or 0 (octal) prefixes
        if (this.source[this.pos] === '0' && this.pos + 1 < this.source.length) {
            const next = this.source[this.pos + 1];
            if (next === 'x' || next === 'X') {
                // Hex literal
                this.advance(); this.advance();
                while (this.pos < this.source.length && this.isHexDigit(this.source[this.pos])) {
                    this.advance();
                }
                this.emit(TokenType.IntegerLiteral, this.source.substring(startOffset, this.pos), startLine, startCol, startOffset);
                return;
            }
            if (this.isOctDigit(next)) {
                // Octal literal
                this.advance();
                while (this.pos < this.source.length && this.isOctDigit(this.source[this.pos])) {
                    this.advance();
                }
                this.emit(TokenType.IntegerLiteral, this.source.substring(startOffset, this.pos), startLine, startCol, startOffset);
                return;
            }
        }

        // Decimal or float
        if (this.source[this.pos] === '.') {
            isFloat = true;
        } else {
            while (this.pos < this.source.length && this.isDigit(this.source[this.pos])) {
                this.advance();
            }
        }

        // Fractional part
        if (this.pos < this.source.length && this.source[this.pos] === '.') {
            isFloat = true;
            this.advance();
            while (this.pos < this.source.length && this.isDigit(this.source[this.pos])) {
                this.advance();
            }
        }

        // Exponent
        if (this.pos < this.source.length && (this.source[this.pos] === 'e' || this.source[this.pos] === 'E')) {
            isFloat = true;
            this.advance();
            if (this.pos < this.source.length && (this.source[this.pos] === '+' || this.source[this.pos] === '-')) {
                this.advance();
            }
            while (this.pos < this.source.length && this.isDigit(this.source[this.pos])) {
                this.advance();
            }
        }

        const value = this.source.substring(startOffset, this.pos);
        this.emit(isFloat ? TokenType.FloatLiteral : TokenType.IntegerLiteral, value, startLine, startCol, startOffset);
    }

    private readIdentifier(): void {
        const startLine = this.line;
        const startCol = this.column;
        const startOffset = this.pos;

        while (this.pos < this.source.length && this.isIdentPart(this.source[this.pos])) {
            this.advance();
        }

        const value = this.source.substring(startOffset, this.pos);

        // Check for 'div=' compound assignment (keyword-based operator)
        if (value === 'div' && this.pos < this.source.length && this.source[this.pos] === '=') {
            this.advance();
            this.emit(TokenType.DivAssign, 'div=', startLine, startCol, startOffset);
            return;
        }

        const kwType = Object.prototype.hasOwnProperty.call(KEYWORDS, value) ? KEYWORDS[value] : undefined;
        if (kwType !== undefined) {
            this.emit(kwType, value, startLine, startCol, startOffset);
        } else {
            this.emit(TokenType.Identifier, value, startLine, startCol, startOffset);
        }
    }

    private readString(quote: string): void {
        const startLine = this.line;
        const startCol = this.column;
        const startOffset = this.pos;

        this.advance(); // opening quote
        let value = '';

        while (this.pos < this.source.length) {
            const ch = this.source[this.pos];
            if (ch === quote) {
                this.advance(); // closing quote
                this.emit(TokenType.StringLiteral, value, startLine, startCol, startOffset);
                return;
            }
            if (ch === '\\') {
                this.advance();
                if (this.pos >= this.source.length) { break; }
                const esc = this.source[this.pos];
                switch (esc) {
                    case 'n':  value += '\n'; break;
                    case 't':  value += '\t'; break;
                    case 'r':  value += '\r'; break;
                    case 'b':  value += '\b'; break;
                    case 'f':  value += '\f'; break;
                    case '\\': value += '\\'; break;
                    case "'":  value += "'"; break;
                    case '"':  value += '"'; break;
                    case '/':  value += '/'; break;
                    case 'x': {
                        // Hex escape \xNN
                        let hex = '';
                        this.advance();
                        if (this.pos < this.source.length && this.isHexDigit(this.source[this.pos])) {
                            hex += this.source[this.pos];
                            this.advance();
                        }
                        if (this.pos < this.source.length && this.isHexDigit(this.source[this.pos])) {
                            hex += this.source[this.pos];
                        } else {
                            this.pos--;
                        }
                        value += String.fromCharCode(parseInt(hex, 16));
                        break;
                    }
                    case 'u': {
                        // Unicode escape \uNNNN: any Unicode character (WAP-193 §7:
                        // "any Unicode character may also be expressed as a
                        // Unicode escape sequence")
                        let hex = '';
                        for (let i = 0; i < 4; i++) {
                            this.advance();
                            if (this.pos < this.source.length && this.isHexDigit(this.source[this.pos])) {
                                hex += this.source[this.pos];
                            }
                        }
                        const codePoint = parseInt(hex, 16);
                        value += String.fromCharCode(codePoint);
                        break;
                    }
                    default:
                        // Octal or just literal
                        if (this.isOctDigit(esc)) {
                            let oct = esc;
                            for (let i = 0; i < 2; i++) {
                                if (this.pos + 1 < this.source.length && this.isOctDigit(this.source[this.pos + 1])) {
                                    this.advance();
                                    oct += this.source[this.pos];
                                }
                            }
                            value += String.fromCharCode(parseInt(oct, 8));
                        } else {
                            value += esc;
                        }
                }
                this.advance();
            } else if (ch === '\n') {
                // Unterminated string
                break;
            } else {
                value += ch;
                this.advance();
            }
        }

        // Unterminated string — emit as error
        this.emit(TokenType.Error, value, startLine, startCol, startOffset);
    }

    private readOperator(): void {
        const startLine = this.line;
        const startCol = this.column;
        const startOffset = this.pos;
        const ch = this.advance();

        switch (ch) {
            case '+':
                if (this.peek() === '+') { this.advance(); this.emit(TokenType.PlusPlus, '++', startLine, startCol, startOffset); }
                else if (this.peek() === '=') { this.advance(); this.emit(TokenType.PlusAssign, '+=', startLine, startCol, startOffset); }
                else { this.emit(TokenType.Plus, '+', startLine, startCol, startOffset); }
                break;
            case '-':
                if (this.peek() === '-') { this.advance(); this.emit(TokenType.MinusMinus, '--', startLine, startCol, startOffset); }
                else if (this.peek() === '=') { this.advance(); this.emit(TokenType.MinusAssign, '-=', startLine, startCol, startOffset); }
                else { this.emit(TokenType.Minus, '-', startLine, startCol, startOffset); }
                break;
            case '*':
                if (this.peek() === '=') { this.advance(); this.emit(TokenType.StarAssign, '*=', startLine, startCol, startOffset); }
                else { this.emit(TokenType.Star, '*', startLine, startCol, startOffset); }
                break;
            case '/':
                if (this.peek() === '=') { this.advance(); this.emit(TokenType.SlashAssign, '/=', startLine, startCol, startOffset); }
                else { this.emit(TokenType.Slash, '/', startLine, startCol, startOffset); }
                break;
            case '%':
                if (this.peek() === '=') { this.advance(); this.emit(TokenType.PercentAssign, '%=', startLine, startCol, startOffset); }
                else { this.emit(TokenType.Percent, '%', startLine, startCol, startOffset); }
                break;
            case '&':
                if (this.peek() === '&') { this.advance(); this.emit(TokenType.AmpAmp, '&&', startLine, startCol, startOffset); }
                else if (this.peek() === '=') { this.advance(); this.emit(TokenType.AmpAssign, '&=', startLine, startCol, startOffset); }
                else { this.emit(TokenType.Ampersand, '&', startLine, startCol, startOffset); }
                break;
            case '|':
                if (this.peek() === '|') { this.advance(); this.emit(TokenType.PipePipe, '||', startLine, startCol, startOffset); }
                else if (this.peek() === '=') { this.advance(); this.emit(TokenType.PipeAssign, '|=', startLine, startCol, startOffset); }
                else { this.emit(TokenType.Pipe, '|', startLine, startCol, startOffset); }
                break;
            case '^':
                if (this.peek() === '=') { this.advance(); this.emit(TokenType.CaretAssign, '^=', startLine, startCol, startOffset); }
                else { this.emit(TokenType.Caret, '^', startLine, startCol, startOffset); }
                break;
            case '<':
                if (this.peek() === '<') {
                    this.advance();
                    if (this.peek() === '=') { this.advance(); this.emit(TokenType.LShiftAssign, '<<=', startLine, startCol, startOffset); }
                    else { this.emit(TokenType.LShift, '<<', startLine, startCol, startOffset); }
                }
                else if (this.peek() === '=') { this.advance(); this.emit(TokenType.LessEqual, '<=', startLine, startCol, startOffset); }
                else { this.emit(TokenType.LessThan, '<', startLine, startCol, startOffset); }
                break;
            case '>':
                if (this.peek() === '>') {
                    this.advance();
                    if (this.peek() === '>') {
                        this.advance();
                        if (this.peek() === '=') { this.advance(); this.emit(TokenType.URShiftAssign, '>>>=', startLine, startCol, startOffset); }
                        else { this.emit(TokenType.URShift, '>>>', startLine, startCol, startOffset); }
                    }
                    else if (this.peek() === '=') { this.advance(); this.emit(TokenType.RShiftAssign, '>>=', startLine, startCol, startOffset); }
                    else { this.emit(TokenType.RShift, '>>', startLine, startCol, startOffset); }
                }
                else if (this.peek() === '=') { this.advance(); this.emit(TokenType.GreaterEqual, '>=', startLine, startCol, startOffset); }
                else { this.emit(TokenType.GreaterThan, '>', startLine, startCol, startOffset); }
                break;
            case '=':
                if (this.peek() === '=') { this.advance(); this.emit(TokenType.EqualEqual, '==', startLine, startCol, startOffset); }
                else { this.emit(TokenType.Assign, '=', startLine, startCol, startOffset); }
                break;
            case '!':
                if (this.peek() === '=') { this.advance(); this.emit(TokenType.NotEqual, '!=', startLine, startCol, startOffset); }
                else { this.emit(TokenType.Exclaim, '!', startLine, startCol, startOffset); }
                break;
            case '~':
                this.emit(TokenType.Tilde, '~', startLine, startCol, startOffset);
                break;
            case '.':
                this.emit(TokenType.Dot, '.', startLine, startCol, startOffset);
                break;
            case '#':
                this.emit(TokenType.Hash, '#', startLine, startCol, startOffset);
                break;
            case ';':
                this.emit(TokenType.Semicolon, ';', startLine, startCol, startOffset);
                break;
            case ',':
                this.emit(TokenType.Comma, ',', startLine, startCol, startOffset);
                break;
            case '?':
                this.emit(TokenType.Question, '?', startLine, startCol, startOffset);
                break;
            case ':':
                this.emit(TokenType.Colon, ':', startLine, startCol, startOffset);
                break;
            case '(':
                this.emit(TokenType.LeftParen, '(', startLine, startCol, startOffset);
                break;
            case ')':
                this.emit(TokenType.RightParen, ')', startLine, startCol, startOffset);
                break;
            case '{':
                this.emit(TokenType.LeftBrace, '{', startLine, startCol, startOffset);
                break;
            case '}':
                this.emit(TokenType.RightBrace, '}', startLine, startCol, startOffset);
                break;
            default:
                this.emit(TokenType.Error, ch, startLine, startCol, startOffset);
        }
    }
}
