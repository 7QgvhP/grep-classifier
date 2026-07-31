import * as vscode from 'vscode';
import Parser from 'web-tree-sitter';
import { classifyIdentifier } from './classifier';
import { ClassificationResult, GrepMatch } from './types';

/**
 * 無条件に「入力」として扱うノード種別。
 * 文字列リテラル・文字定数・`#include <...>` のパスが該当する。
 */
const INPUT_NODE_TYPES = new Set([
    'string_literal',
    'string_content',
    'char_literal',
    'character',
    'escape_sequence',
    'system_lib_string'
]);

// 正規表現のメタ文字をエスケープする
function escapeRegExp(str: string): string {
    return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * ファイル本文から検索キーワードの出現位置をすべて列挙する。
 * ここがVS Code標準検索（grep）と同一の処理であり、
 * 以降の分類は「列挙された位置」に対して行うため、取りこぼしが起きない。
 */
function collectOffsets(content: string, query: string, matchWholeWord: boolean): number[] {
    const offsets: number[] = [];
    if (query.length === 0) {
        return offsets;
    }

    if (matchWholeWord) {
        const regex = new RegExp(`\\b${escapeRegExp(query)}\\b`, 'g');
        let match: RegExpExecArray | null;
        while ((match = regex.exec(content)) !== null) {
            offsets.push(match.index);
            // 空文字に一致した場合の無限ループを防止
            if (match[0].length === 0) {
                regex.lastIndex++;
            }
        }
    } else {
        let idx = content.indexOf(query);
        while (idx !== -1) {
            offsets.push(idx);
            idx = content.indexOf(query, idx + query.length);
        }
    }
    return offsets;
}

// 各行の開始オフセットを求める（オフセットから行番号を引くための索引）
function buildLineStarts(content: string): number[] {
    const starts = [0];
    for (let i = 0; i < content.length; i++) {
        if (content[i] === '\n') {
            starts.push(i + 1);
        }
    }
    return starts;
}

// 行頭オフセット配列に対する二分探索で、指定オフセットの行番号を求める
function rowAt(lineStarts: number[], offset: number): number {
    let low = 0;
    let high = lineStarts.length - 1;
    while (low < high) {
        const mid = Math.ceil((low + high) / 2);
        if (lineStarts[mid] <= offset) {
            low = mid;
        } else {
            high = mid - 1;
        }
    }
    return low;
}

/**
 * 関数定義の宣言子から関数名を取り出す。
 * `void *func(int a)` のようにポインタ宣言子が入れ子になる場合があるため、
 * declarator を辿って最初に現れる識別子を関数名とみなす。
 */
function extractFunctionName(declarator: Parser.SyntaxNode): string | undefined {
    let current: Parser.SyntaxNode | null = declarator;
    while (current) {
        if (current.type === 'identifier') {
            return current.text;
        }
        current = current.childForFieldName('declarator');
    }
    return undefined;
}

// 一致箇所が属する関数の名前を祖先ノードから取得する（関数外の場合は undefined）
function findEnclosingFunctionName(node: Parser.SyntaxNode): string | undefined {
    let current: Parser.SyntaxNode | null = node;
    while (current) {
        if (current.type === 'function_definition') {
            const declarator = current.childForFieldName('declarator');
            const name = declarator ? extractFunctionName(declarator) : undefined;
            if (name) {
                return name;
            }
        }
        current = current.parent;
    }
    return undefined;
}

/**
 * 一致位置に対応するノードから分類カテゴリを決定する。
 * コメント・文字列は種別だけで確定し、それ以外は
 * 祖先ノードのコンテキストによるデータフロー分類に委ねる。
 */
function categorizeNode(node: Parser.SyntaxNode): ClassificationResult {
    let current: Parser.SyntaxNode | null = node;
    while (current) {
        if (current.type === 'comment') {
            return { category: 'コメント', detail: '' };
        }
        if (INPUT_NODE_TYPES.has(current.type)) {
            return { category: '入力', detail: '文字列' };
        }
        current = current.parent;
    }
    return classifyIdentifier(node);
}

/**
 * 検索キーワードの全出現位置を列挙し、それぞれをデータフロー分類する。
 *
 * 出現位置の列挙はテキスト検索で行うため、件数はVS Code標準検索と一致する。
 * 分類できない箇所は結果から消えるのではなく「その他」に分類される。
 *
 * @param tree 解析済みの構文木
 * @param query 検索キーワード
 * @param fileUri 対象ファイルのURI
 * @param content 対象ファイルの本文
 * @param lines 対象ファイルを行単位に分割したテキスト
 * @param matchWholeWord 単語全体に一致するもののみを抽出するか
 */
export function findMatches(
    tree: Parser.Tree,
    query: string,
    fileUri: vscode.Uri,
    content: string,
    lines: string[],
    matchWholeWord: boolean
): GrepMatch[] {
    const offsets = collectOffsets(content, query, matchWholeWord);
    if (offsets.length === 0) {
        return [];
    }

    const lineStarts = buildLineStarts(content);
    const matches: GrepMatch[] = [];

    for (const offset of offsets) {
        // 一致範囲を含む最小のノードを特定する
        const node = tree.rootNode.descendantForIndex(offset, offset + query.length - 1);
        const row = rowAt(lineStarts, offset);
        const { category, detail } = categorizeNode(node);

        matches.push({
            fileUri,
            line: row,
            charStart: offset - lineStarts[row],
            charEnd: offset - lineStarts[row] + query.length,
            content: lines[row],
            category,
            detail,
            functionName: findEnclosingFunctionName(node)
        });
    }

    return matches;
}
