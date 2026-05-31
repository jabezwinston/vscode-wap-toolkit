/**
 *
 *  Copyright (C) 2026 Jabez Winston
 * 
 *  SPDX-License-Identifier: Apache-2.0
 *
 *  Date : 18-March-2026
 *   
 *  WMLScript AST Node Types
 *  Defines the Abstract Syntax Tree for parsed WMLScript programs.
 */

export interface SourceLocation {
    line: number;
    column: number;
    offset: number;
}

// === Top Level ===

export interface CompilationUnit {
    type: 'CompilationUnit';
    externalDeclarations: ExternalDeclaration[];
    functions: FunctionDeclaration[];
    loc: SourceLocation;
}

export interface ExternalDeclaration {
    type: 'ExternalDeclaration';
    url: string;
    alias: string;
    loc: SourceLocation;
}

export interface AccessControlPragma {
    type: 'AccessControlPragma';
    domain?: string;
    path?: string;
    loc: SourceLocation;
}

export type MetaKind = 'name' | 'httpequiv' | 'useragent';

export interface MetaPragma {
    type: 'MetaPragma';
    kind: MetaKind;
    propertyName: string;
    content: string;
    scheme?: string;
    loc: SourceLocation;
}

export interface CompilationUnit {
    type: 'CompilationUnit';
    externalDeclarations: ExternalDeclaration[];
    accessControl?: AccessControlPragma;
    metaPragmas: MetaPragma[];
    functions: FunctionDeclaration[];
    loc: SourceLocation;
}

export interface FunctionDeclaration {
    type: 'FunctionDeclaration';
    name: string;
    params: string[];
    body: BlockStatement;
    isExtern: boolean;
    loc: SourceLocation;
}

// === Statements ===

export type Statement =
    | BlockStatement
    | VariableStatement
    | ExpressionStatement
    | IfStatement
    | WhileStatement
    | ForStatement
    | BreakStatement
    | ContinueStatement
    | ReturnStatement
    | EmptyStatement;

export interface BlockStatement {
    type: 'BlockStatement';
    body: Statement[];
    loc: SourceLocation;
}

export interface VariableDeclarator {
    type: 'VariableDeclarator';
    name: string;
    init: Expression | null;
    loc: SourceLocation;
}

export interface VariableStatement {
    type: 'VariableStatement';
    declarations: VariableDeclarator[];
    loc: SourceLocation;
}

export interface ExpressionStatement {
    type: 'ExpressionStatement';
    expression: Expression;
    loc: SourceLocation;
}

export interface IfStatement {
    type: 'IfStatement';
    test: Expression;
    consequent: Statement;
    alternate: Statement | null;
    loc: SourceLocation;
}

export interface WhileStatement {
    type: 'WhileStatement';
    test: Expression;
    body: Statement;
    loc: SourceLocation;
}

export interface ForStatement {
    type: 'ForStatement';
    init: VariableStatement | Expression | null;
    test: Expression | null;
    update: Expression | null;
    body: Statement;
    loc: SourceLocation;
}

export interface BreakStatement {
    type: 'BreakStatement';
    loc: SourceLocation;
}

export interface ContinueStatement {
    type: 'ContinueStatement';
    loc: SourceLocation;
}

export interface ReturnStatement {
    type: 'ReturnStatement';
    argument: Expression | null;
    loc: SourceLocation;
}

export interface EmptyStatement {
    type: 'EmptyStatement';
    loc: SourceLocation;
}

// === Expressions ===

export type Expression =
    | AssignmentExpression
    | ConditionalExpression
    | BinaryExpression
    | UnaryExpression
    | UpdateExpression
    | CallExpression
    | LibraryCallExpression
    | ExternalCallExpression
    | IdentifierExpression
    | IntegerLiteral
    | FloatLiteral
    | StringLiteral
    | BooleanLiteral
    | InvalidLiteral
    | CommaExpression
    | TypeofExpression
    | IsvalidExpression;

export interface AssignmentExpression {
    type: 'AssignmentExpression';
    operator: '=' | '+=' | '-=' | '*=' | '/=' | 'div=' | '%=' | '&=' | '|=' | '^=' | '<<=' | '>>=' | '>>>=';
    left: IdentifierExpression;
    right: Expression;
    loc: SourceLocation;
}

export interface ConditionalExpression {
    type: 'ConditionalExpression';
    test: Expression;
    consequent: Expression;
    alternate: Expression;
    loc: SourceLocation;
}

export interface BinaryExpression {
    type: 'BinaryExpression';
    operator: '+' | '-' | '*' | '/' | 'div' | '%' | '&' | '|' | '^'
        | '<<' | '>>' | '>>>' | '==' | '!=' | '<' | '<=' | '>' | '>='
        | '&&' | '||';
    left: Expression;
    right: Expression;
    loc: SourceLocation;
}

export interface UnaryExpression {
    type: 'UnaryExpression';
    operator: '+' | '-' | '~' | '!';
    operand: Expression;
    loc: SourceLocation;
}

export interface TypeofExpression {
    type: 'TypeofExpression';
    operand: Expression;
    loc: SourceLocation;
}

export interface IsvalidExpression {
    type: 'IsvalidExpression';
    operand: Expression;
    loc: SourceLocation;
}

export interface UpdateExpression {
    type: 'UpdateExpression';
    operator: '++' | '--';
    prefix: boolean;
    argument: IdentifierExpression;
    loc: SourceLocation;
}

export interface CallExpression {
    type: 'CallExpression';
    callee: string;
    arguments: Expression[];
    loc: SourceLocation;
}

export interface LibraryCallExpression {
    type: 'LibraryCallExpression';
    library: string;
    method: string;
    arguments: Expression[];
    loc: SourceLocation;
}

export interface ExternalCallExpression {
    type: 'ExternalCallExpression';
    scriptAlias: string;
    functionName: string;
    arguments: Expression[];
    loc: SourceLocation;
}

export interface IdentifierExpression {
    type: 'IdentifierExpression';
    name: string;
    loc: SourceLocation;
}

export interface IntegerLiteral {
    type: 'IntegerLiteral';
    value: number;
    loc: SourceLocation;
}

export interface FloatLiteral {
    type: 'FloatLiteral';
    value: number;
    loc: SourceLocation;
}

export interface StringLiteral {
    type: 'StringLiteral';
    value: string;
    loc: SourceLocation;
}

export interface BooleanLiteral {
    type: 'BooleanLiteral';
    value: boolean;
    loc: SourceLocation;
}

export interface InvalidLiteral {
    type: 'InvalidLiteral';
    loc: SourceLocation;
}

export interface CommaExpression {
    type: 'CommaExpression';
    expressions: Expression[];
    loc: SourceLocation;
}
