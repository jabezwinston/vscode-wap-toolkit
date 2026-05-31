/**
 *  Copyright (C) 2026 Jabez Winston
 * 
 *  SPDX-License-Identifier: Apache-2.0
 *
 *  Date : 17-March-2026
 * 
 *  Code completion provider for WML & WMLScript
 */

import * as vscode from 'vscode';

/** WML tag definitions for IntelliSense */
interface WmlTagDef {
    name: string;
    description: string;
    attributes: WmlAttrDef[];
    selfClosing?: boolean;
}

interface WmlAttrDef {
    name: string;
    description: string;
    values?: string[];
    required?: boolean;
}

const WML_TAGS: WmlTagDef[] = [
    {
        name: 'wml',
        description: 'Root element of a WML deck',
        attributes: [
            { name: 'xml:lang', description: 'Language of the deck' },
        ],
    },
    {
        name: 'card',
        description: 'A single card within a WML deck',
        attributes: [
            { name: 'id', description: 'Unique card identifier', required: true },
            { name: 'title', description: 'Card title displayed in browser' },
            { name: 'newcontext', description: 'Clear browser context on entry', values: ['true', 'false'] },
            { name: 'ordered', description: 'Content entry order hint', values: ['true', 'false'] },
            { name: 'onenterforward', description: 'URL for forward navigation event' },
            { name: 'onenterbackward', description: 'URL for backward navigation event' },
            { name: 'ontimer', description: 'URL when timer expires' },
            { name: 'xml:lang', description: 'Language of the card' },
            { name: 'class', description: 'WCSS class name' },
            { name: 'id', description: 'Element identifier' },
        ],
    },
    {
        name: 'head',
        description: 'Deck-level information (access control, meta)',
        attributes: [],
    },
    {
        name: 'template',
        description: 'Deck-level event bindings applied to all cards',
        attributes: [
            { name: 'onenterforward', description: 'URL for forward navigation event' },
            { name: 'onenterbackward', description: 'URL for backward navigation event' },
            { name: 'ontimer', description: 'URL when timer expires' },
        ],
    },
    {
        name: 'access',
        description: 'Deck-level access control',
        attributes: [
            { name: 'domain', description: 'Domain restriction', required: true },
            { name: 'path', description: 'Path restriction' },
        ],
        selfClosing: true,
    },
    {
        name: 'meta',
        description: 'Metadata information',
        attributes: [
            { name: 'http-equiv', description: 'HTTP header name' },
            { name: 'name', description: 'Meta property name' },
            { name: 'content', description: 'Meta content value', required: true },
            { name: 'forua', description: 'Whether meta is for user agent', values: ['true', 'false'] },
            { name: 'scheme', description: 'Scheme for interpreting content' },
        ],
        selfClosing: true,
    },
    {
        name: 'p',
        description: 'Paragraph - primary content container',
        attributes: [
            { name: 'align', description: 'Text alignment', values: ['left', 'center', 'right'] },
            { name: 'mode', description: 'Line wrapping mode', values: ['wrap', 'nowrap'] },
            { name: 'class', description: 'WCSS class name' },
            { name: 'id', description: 'Element identifier' },
            { name: 'xml:lang', description: 'Language' },
        ],
    },
    {
        name: 'do',
        description: 'User-triggerable action binding',
        attributes: [
            { name: 'type', description: 'Type of do element', values: ['accept', 'prev', 'help', 'reset', 'options', 'delete', 'unknown', 'vnd.'], required: true },
            { name: 'label', description: 'Display label for the soft key' },
            { name: 'name', description: 'Name for do element (for shadowing)' },
            { name: 'optional', description: 'Whether rendering is optional', values: ['true', 'false'] },
            { name: 'class', description: 'WCSS class name' },
            { name: 'id', description: 'Element identifier' },
            { name: 'xml:lang', description: 'Language' },
        ],
    },
    {
        name: 'onevent',
        description: 'Intrinsic event handler',
        attributes: [
            { name: 'type', description: 'Event type', values: ['onenterforward', 'onenterbackward', 'ontimer', 'onpick'], required: true },
            { name: 'class', description: 'WCSS class name' },
            { name: 'id', description: 'Element identifier' },
        ],
    },
    {
        name: 'go',
        description: 'Navigate to a URL',
        attributes: [
            { name: 'href', description: 'Target URL', required: true },
            { name: 'method', description: 'HTTP method', values: ['get', 'post'] },
            { name: 'sendreferer', description: 'Send HTTP Referer header', values: ['true', 'false'] },
            { name: 'accept-charset', description: 'Character encoding for form data' },
            { name: 'cache-control', description: 'Cache directive', values: ['no-cache'] },
            { name: 'class', description: 'WCSS class name' },
            { name: 'id', description: 'Element identifier' },
        ],
    },
    {
        name: 'prev',
        description: 'Navigate to previous card in history',
        attributes: [
            { name: 'class', description: 'WCSS class name' },
            { name: 'id', description: 'Element identifier' },
        ],
        selfClosing: true,
    },
    {
        name: 'refresh',
        description: 'Refresh the current card with updated variables',
        attributes: [
            { name: 'class', description: 'WCSS class name' },
            { name: 'id', description: 'Element identifier' },
        ],
    },
    {
        name: 'noop',
        description: 'No operation (used to shadow template do elements)',
        attributes: [],
        selfClosing: true,
    },
    {
        name: 'anchor',
        description: 'Inline anchor with task',
        attributes: [
            { name: 'title', description: 'Advisory title' },
            { name: 'accesskey', description: 'Shortcut key' },
            { name: 'class', description: 'WCSS class name' },
            { name: 'id', description: 'Element identifier' },
            { name: 'xml:lang', description: 'Language' },
        ],
    },
    {
        name: 'a',
        description: 'Hyperlink (simplified anchor)',
        attributes: [
            { name: 'href', description: 'Target URL', required: true },
            { name: 'title', description: 'Advisory title' },
            { name: 'accesskey', description: 'Shortcut key' },
            { name: 'class', description: 'WCSS class name' },
            { name: 'id', description: 'Element identifier' },
            { name: 'xml:lang', description: 'Language' },
        ],
    },
    {
        name: 'input',
        description: 'Text input field',
        attributes: [
            { name: 'name', description: 'Variable name for input value', required: true },
            { name: 'type', description: 'Input type', values: ['text', 'password'] },
            { name: 'value', description: 'Default value' },
            { name: 'format', description: 'Input format mask (e.g., *M, NNN-NNNN)' },
            { name: 'emptyok', description: 'Allow empty input', values: ['true', 'false'] },
            { name: 'size', description: 'Display width in characters' },
            { name: 'maxlength', description: 'Maximum input length' },
            { name: 'title', description: 'Input label/prompt' },
            { name: 'tabindex', description: 'Tab order index' },
            { name: 'accesskey', description: 'Shortcut key' },
            { name: 'class', description: 'WCSS class name' },
            { name: 'id', description: 'Element identifier' },
            { name: 'xml:lang', description: 'Language' },
        ],
        selfClosing: true,
    },
    {
        name: 'select',
        description: 'Selection list',
        attributes: [
            { name: 'name', description: 'Variable name for selected value' },
            { name: 'value', description: 'Default value(s)' },
            { name: 'iname', description: 'Variable name for selected index' },
            { name: 'ivalue', description: 'Default index value' },
            { name: 'multiple', description: 'Allow multiple selections', values: ['true', 'false'] },
            { name: 'title', description: 'Selection list title' },
            { name: 'tabindex', description: 'Tab order index' },
            { name: 'class', description: 'WCSS class name' },
            { name: 'id', description: 'Element identifier' },
            { name: 'xml:lang', description: 'Language' },
        ],
    },
    {
        name: 'option',
        description: 'Selection option',
        attributes: [
            { name: 'value', description: 'Option value', required: true },
            { name: 'title', description: 'Option title' },
            { name: 'onpick', description: 'URL when option is picked' },
            { name: 'class', description: 'WCSS class name' },
            { name: 'id', description: 'Element identifier' },
            { name: 'xml:lang', description: 'Language' },
        ],
    },
    {
        name: 'optgroup',
        description: 'Option group',
        attributes: [
            { name: 'title', description: 'Group title', required: true },
            { name: 'class', description: 'WCSS class name' },
            { name: 'id', description: 'Element identifier' },
            { name: 'xml:lang', description: 'Language' },
        ],
    },
    {
        name: 'fieldset',
        description: 'Group of related fields',
        attributes: [
            { name: 'title', description: 'Fieldset title', required: true },
            { name: 'class', description: 'WCSS class name' },
            { name: 'id', description: 'Element identifier' },
            { name: 'xml:lang', description: 'Language' },
        ],
    },
    {
        name: 'img',
        description: 'Image (WBMP format)',
        attributes: [
            { name: 'src', description: 'Image source URL', required: true },
            { name: 'alt', description: 'Alternative text', required: true },
            { name: 'localsrc', description: 'Local image identifier' },
            { name: 'height', description: 'Image height' },
            { name: 'width', description: 'Image width' },
            { name: 'vspace', description: 'Vertical whitespace' },
            { name: 'hspace', description: 'Horizontal whitespace' },
            { name: 'align', description: 'Image alignment', values: ['top', 'middle', 'bottom'] },
            { name: 'class', description: 'WCSS class name' },
            { name: 'id', description: 'Element identifier' },
            { name: 'xml:lang', description: 'Language' },
        ],
        selfClosing: true,
    },
    {
        name: 'table',
        description: 'Data table',
        attributes: [
            { name: 'columns', description: 'Number of columns', required: true },
            { name: 'align', description: 'Column alignment (L/C/R/D per column)' },
            { name: 'title', description: 'Table title' },
            { name: 'class', description: 'WCSS class name' },
            { name: 'id', description: 'Element identifier' },
            { name: 'xml:lang', description: 'Language' },
        ],
    },
    { name: 'tr', description: 'Table row', attributes: [{ name: 'class', description: 'WCSS class name' }, { name: 'id', description: 'Element identifier' }] },
    { name: 'td', description: 'Table cell', attributes: [{ name: 'class', description: 'WCSS class name' }, { name: 'id', description: 'Element identifier' }, { name: 'xml:lang', description: 'Language' }] },
    {
        name: 'timer',
        description: 'Timer (value in 1/10 seconds)',
        attributes: [
            { name: 'value', description: 'Timer duration in 1/10 seconds', required: true },
            { name: 'name', description: 'Variable name for timer value' },
            { name: 'class', description: 'WCSS class name' },
            { name: 'id', description: 'Element identifier' },
        ],
        selfClosing: true,
    },
    {
        name: 'setvar',
        description: 'Set a variable value',
        attributes: [
            { name: 'name', description: 'Variable name', required: true },
            { name: 'value', description: 'Variable value', required: true },
            { name: 'class', description: 'WCSS class name' },
            { name: 'id', description: 'Element identifier' },
        ],
        selfClosing: true,
    },
    {
        name: 'postfield',
        description: 'Form field submitted with go task',
        attributes: [
            { name: 'name', description: 'Field name', required: true },
            { name: 'value', description: 'Field value', required: true },
            { name: 'class', description: 'WCSS class name' },
            { name: 'id', description: 'Element identifier' },
        ],
        selfClosing: true,
    },
    { name: 'b', description: 'Bold text', attributes: [{ name: 'class', description: 'WCSS class name' }, { name: 'id', description: 'Element identifier' }, { name: 'xml:lang', description: 'Language' }] },
    { name: 'big', description: 'Large text', attributes: [{ name: 'class', description: 'WCSS class name' }, { name: 'id', description: 'Element identifier' }, { name: 'xml:lang', description: 'Language' }] },
    { name: 'em', description: 'Emphasized text', attributes: [{ name: 'class', description: 'WCSS class name' }, { name: 'id', description: 'Element identifier' }, { name: 'xml:lang', description: 'Language' }] },
    { name: 'i', description: 'Italic text', attributes: [{ name: 'class', description: 'WCSS class name' }, { name: 'id', description: 'Element identifier' }, { name: 'xml:lang', description: 'Language' }] },
    { name: 'small', description: 'Small text', attributes: [{ name: 'class', description: 'WCSS class name' }, { name: 'id', description: 'Element identifier' }, { name: 'xml:lang', description: 'Language' }] },
    { name: 'strong', description: 'Strong emphasis', attributes: [{ name: 'class', description: 'WCSS class name' }, { name: 'id', description: 'Element identifier' }, { name: 'xml:lang', description: 'Language' }] },
    { name: 'u', description: 'Underlined text', attributes: [{ name: 'class', description: 'WCSS class name' }, { name: 'id', description: 'Element identifier' }, { name: 'xml:lang', description: 'Language' }] },
    { name: 'br', description: 'Line break', attributes: [{ name: 'class', description: 'WCSS class name' }, { name: 'id', description: 'Element identifier' }], selfClosing: true },
    { name: 'pre', description: 'Preformatted text', attributes: [{ name: 'class', description: 'WCSS class name' }, { name: 'id', description: 'Element identifier' }, { name: 'xml:lang', description: 'Language' }] },
];

export class WmlCompletionProvider implements vscode.CompletionItemProvider {
    provideCompletionItems(
        document: vscode.TextDocument,
        position: vscode.Position
    ): vscode.CompletionItem[] {
        const lineText = document.lineAt(position).text;
        const lineUntilCursor = lineText.substring(0, position.character);

        // Check if we're inside a tag (for attribute completion)
        const insideTagMatch = lineUntilCursor.match(/<(\w+)\s+[^>]*$/);
        if (insideTagMatch) {
            return this.getAttributeCompletions(insideTagMatch[1]);
        }

        // Check if we're typing an attribute value
        const attrValueMatch = lineUntilCursor.match(/<(\w+)\s+.*?(\w+)\s*=\s*"([^"]*$)/);
        if (attrValueMatch) {
            return this.getAttributeValueCompletions(attrValueMatch[1], attrValueMatch[2]);
        }

        // Check for escape mode completion after $(varname:
        const escapeModeMatch = lineUntilCursor.match(/\$\([A-Za-z_][A-Za-z0-9_]*:([A-Za-z]*)$/);
        if (escapeModeMatch) {
            return this.getEscapeModeCompletions();
        }

        // Check for variable completion after $
        if (lineUntilCursor.endsWith('$') || lineUntilCursor.endsWith('$(')) {
            return this.getVariableCompletions(document);
        }

        // Tag completion after <
        if (lineUntilCursor.endsWith('<')) {
            return this.getTagCompletions();
        }

        return [];
    }

    private getTagCompletions(): vscode.CompletionItem[] {
        return WML_TAGS.map(tag => {
            const item = new vscode.CompletionItem(tag.name, vscode.CompletionItemKind.Property);
            item.detail = `WML <${tag.name}>`;
            item.documentation = new vscode.MarkdownString(tag.description);

            // Build snippet
            const requiredAttrs = tag.attributes.filter(a => a.required);
            let attrSnippet = '';
            let tabStop = 1;
            for (const attr of requiredAttrs) {
                if (attr.values && attr.values.length > 0) {
                    attrSnippet += ` ${attr.name}="\${${tabStop}|${attr.values.join(',')}|}"`;
                } else {
                    attrSnippet += ` ${attr.name}="\${${tabStop}:}"`;
                }
                tabStop++;
            }

            if (tag.selfClosing) {
                item.insertText = new vscode.SnippetString(`${tag.name}${attrSnippet}/>`);
            } else {
                item.insertText = new vscode.SnippetString(`${tag.name}${attrSnippet}>\n\t\${${tabStop}}\n</${tag.name}>`);
            }

            return item;
        });
    }

    private getAttributeCompletions(tagName: string): vscode.CompletionItem[] {
        const tag = WML_TAGS.find(t => t.name === tagName.toLowerCase());
        if (!tag) { return []; }

        return tag.attributes.map(attr => {
            const item = new vscode.CompletionItem(attr.name, vscode.CompletionItemKind.Property);
            item.detail = attr.required ? '(required)' : '(optional)';
            item.documentation = new vscode.MarkdownString(attr.description);

            if (attr.values && attr.values.length > 0) {
                item.insertText = new vscode.SnippetString(`${attr.name}="\${1|${attr.values.join(',')}|}"`);
            } else {
                item.insertText = new vscode.SnippetString(`${attr.name}="\${1}"`);
            }

            return item;
        });
    }

    private getAttributeValueCompletions(tagName: string, attrName: string): vscode.CompletionItem[] {
        const tag = WML_TAGS.find(t => t.name === tagName.toLowerCase());
        if (!tag) { return []; }

        const attr = tag.attributes.find(a => a.name === attrName);
        if (!attr || !attr.values) { return []; }

        return attr.values.map(value => {
            const item = new vscode.CompletionItem(value, vscode.CompletionItemKind.Value);
            item.detail = `${attrName} value`;
            return item;
        });
    }

    private getEscapeModeCompletions(): vscode.CompletionItem[] {
        const modes = [
            { name: 'escape', description: 'URL-encode the variable value (spaces → %20, etc.)' },
            { name: 'noesc', description: 'No conversion (default behavior)' },
            { name: 'unesc', description: 'URL-decode the variable value (%20 → spaces, etc.)' },
        ];
        return modes.map(mode => {
            const item = new vscode.CompletionItem(mode.name, vscode.CompletionItemKind.EnumMember);
            item.detail = 'WML escape mode';
            item.documentation = new vscode.MarkdownString(mode.description);
            return item;
        });
    }

    private getVariableCompletions(document: vscode.TextDocument): vscode.CompletionItem[] {
        // Scan document for variable declarations (setvar, input names, select names)
        const text = document.getText();
        const vars = new Set<string>();

        // setvar name="..."
        const setvarRegex = /setvar\s+name="([^"]*)"/gi;
        let match;
        while ((match = setvarRegex.exec(text)) !== null) {
            vars.add(match[1]);
        }

        // input name="..."
        const inputRegex = /input\s+[^>]*name="([^"]*)"/gi;
        while ((match = inputRegex.exec(text)) !== null) {
            vars.add(match[1]);
        }

        // select name="..."
        const selectRegex = /select\s+[^>]*name="([^"]*)"/gi;
        while ((match = selectRegex.exec(text)) !== null) {
            vars.add(match[1]);
        }

        return Array.from(vars).map(varName => {
            const item = new vscode.CompletionItem(varName, vscode.CompletionItemKind.Variable);
            item.detail = 'WML variable';
            return item;
        });
    }
}

/** WMLScript Completion Provider */
export class WmlScriptCompletionProvider implements vscode.CompletionItemProvider {
    private static readonly STDLIB: Record<string, string[]> = {
        'Lang': ['abs', 'min', 'max', 'parseInt', 'parseFloat', 'isInt', 'isFloat', 'maxInt', 'minInt', 'float', 'exit', 'abort', 'random', 'seed', 'characterSet'],
        'Float': ['int', 'floor', 'ceil', 'pow', 'round', 'sqrt', 'maxFloat', 'minFloat'],
        'String': ['length', 'isEmpty', 'charAt', 'subString', 'find', 'replace', 'elements', 'elementAt', 'removeAt', 'replaceAt', 'insertAt', 'squeeze', 'trim', 'compare', 'toString', 'format'],
        'URL': ['isValid', 'getScheme', 'getHost', 'getPort', 'getPath', 'getParameters', 'getQuery', 'getFragment', 'getBase', 'getReferer', 'resolve', 'escapeString', 'unescapeString', 'loadString'],
        'WMLBrowser': ['getVar', 'setVar', 'go', 'prev', 'newContext', 'getCurrentCard', 'refresh'],
        'Dialogs': ['prompt', 'confirm', 'alert'],
        'Console': ['print', 'println'],
    };

    provideCompletionItems(
        document: vscode.TextDocument,
        position: vscode.Position
    ): vscode.CompletionItem[] {
        const lineText = document.lineAt(position).text;
        const lineUntilCursor = lineText.substring(0, position.character);

        // Check for Library.method completion
        const libMatch = lineUntilCursor.match(/\b(\w+)\.\s*$/);
        if (libMatch) {
            const libName = libMatch[1];
            const methods = WmlScriptCompletionProvider.STDLIB[libName];
            if (methods) {
                return methods.map(method => {
                    const item = new vscode.CompletionItem(method, vscode.CompletionItemKind.Method);
                    item.detail = `${libName}.${method}()`;
                    return item;
                });
            }
        }

        // Standard library class names
        const items: vscode.CompletionItem[] = [];
        for (const lib of Object.keys(WmlScriptCompletionProvider.STDLIB)) {
            const item = new vscode.CompletionItem(lib, vscode.CompletionItemKind.Class);
            item.detail = 'WMLScript Standard Library';
            items.push(item);
        }

        // Keywords
        const keywords = ['var', 'function', 'extern', 'if', 'else', 'while', 'for', 'break', 'continue', 'return', 'typeof', 'isvalid', 'true', 'false', 'invalid'];
        for (const kw of keywords) {
            const item = new vscode.CompletionItem(kw, vscode.CompletionItemKind.Keyword);
            items.push(item);
        }

        return items;
    }
}
