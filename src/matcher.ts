import * as vscode from 'vscode';
import Parser from 'web-tree-sitter';
import { classifyIdentifier } from './classifier';
import { DataFlowCategory, GrepMatch } from './types';

// 正規表現のメタ文字をエスケープする
function escapeRegExp(str: string): string {
    return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
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

/**
 * ASTの各ノードから検索クエリに一致する識別子やコメント等を抽出し、データフロー分類を行う
 * @param node 走査を開始するルートノード
 * @param query 検索キーワード
 * @param fileUri 対象ファイルのURI
 * @param lines 対象ファイルを行単位に分割したテキスト
 * @param matchWholeWord 単語全体に一致するもののみを抽出するか
 */
export function findMatchesInTree(
    node: Parser.SyntaxNode,
    query: string,
    fileUri: vscode.Uri,
    lines: string[],
    matchWholeWord: boolean
): GrepMatch[] {
    const matches: GrepMatch[] = [];
    // クエリに構造体や配列のアクセス演算子が含まれているか判定
    const hasOperator = query.includes('.') || query.includes('->') || query.includes('[');

    const escapedQuery = escapeRegExp(query);
    const wholeWordRegex = new RegExp(`\\b${escapedQuery}\\b`);
    const globalWholeWordRegex = new RegExp(`\\b${escapedQuery}\\b`, 'g');

    // テキスト中に一致が存在するかを判定する（コメント・文字列・マクロ値向け：単語境界で評価）
    const containsMatch = (text: string): boolean =>
        matchWholeWord ? wholeWordRegex.test(text) : text.includes(query);

    // ノードのテキストが一致するかを判定する（識別子・アクセス式向け：単語全体一致時は完全一致）
    const isNodeMatch = (text: string): boolean =>
        matchWholeWord ? text === query : text.includes(query);

    /**
     * 指定行の中に現れるすべての出現位置を一致箇所として登録する。
     * コメント・マクロ定義値・文字列リテラルのように、
     * 1行に同じキーワードが複数現れうるノードで共通して使用する。
     */
    const collectOccurrences = (
        lineContent: string,
        line: number,
        category: DataFlowCategory,
        functionName?: string
    ): void => {
        if (matchWholeWord) {
            globalWholeWordRegex.lastIndex = 0;
            let match: RegExpExecArray | null;
            while ((match = globalWholeWordRegex.exec(lineContent)) !== null) {
                matches.push({
                    fileUri,
                    line,
                    charStart: match.index,
                    charEnd: match.index + match[0].length,
                    content: lineContent,
                    category,
                    functionName
                });
                // 空文字に一致した場合の無限ループを防止
                if (match[0].length === 0) {
                    globalWholeWordRegex.lastIndex++;
                }
            }
        } else {
            let idx = lineContent.indexOf(query);
            while (idx !== -1) {
                matches.push({
                    fileUri,
                    line,
                    charStart: idx,
                    charEnd: idx + query.length,
                    content: lineContent,
                    category,
                    functionName
                });
                idx = lineContent.indexOf(query, idx + query.length);
            }
        }
    };

    // ノードの範囲そのものを一致箇所として登録する
    const pushNodeMatch = (target: Parser.SyntaxNode, category: DataFlowCategory, functionName?: string): void => {
        matches.push({
            fileUri,
            line: target.startPosition.row,
            charStart: target.startPosition.column,
            charEnd: target.endPosition.column,
            content: lines[target.startPosition.row],
            category,
            functionName
        });
    };

    /**
     * ASTを再帰的に走査する。
     * @param currentNode 走査中のノード
     * @param functionName 現在走査している位置が属する関数名（関数外では undefined）
     */
    function traverse(currentNode: Parser.SyntaxNode, functionName?: string) {
        // 関数定義に入った時点で、以降の子孫ノードが属する関数名を確定させる
        if (currentNode.type === 'function_definition') {
            const declarator = currentNode.childForFieldName('declarator');
            functionName = (declarator && extractFunctionName(declarator)) || functionName;
        }

        // コメントノード（複数行コメントは行単位に分割し、実際の出現行を特定する）
        if (currentNode.type === 'comment' && containsMatch(currentNode.text)) {
            const startRow = currentNode.startPosition.row;

            currentNode.text.split(/\r?\n/).forEach((commentLine, offset) => {
                if (!containsMatch(commentLine)) {
                    return;
                }
                const actualLine = startRow + offset;
                const lineContent = lines[actualLine];

                if (lineContent) {
                    collectOccurrences(lineContent, actualLine, 'コメント', functionName);
                } else {
                    matches.push({
                        fileUri,
                        line: actualLine,
                        charStart: 0,
                        charEnd: commentLine.length,
                        content: commentLine,
                        category: 'コメント',
                        functionName
                    });
                }
            });
            return; // コメントの子ノードは探索不要
        }

        // 構造体メンバーアクセスや配列アクセスの判定 (クエリに記号が含まれる場合のみ)
        if (hasOperator && (currentNode.type === 'field_expression' || currentNode.type === 'subscript_expression')) {
            if (isNodeMatch(currentNode.text)) {
                pushNodeMatch(currentNode, classifyIdentifier(currentNode), functionName);
                // 重複して子ノード（オブジェクト名やメンバー名単体）がヒットするのを防ぐため、巡回をスキップ
                return;
            }
        }

        // 識別子、構造体メンバー名の部分一致 / 完全一致
        if (currentNode.type === 'identifier' || currentNode.type === 'field_identifier') {
            if (isNodeMatch(currentNode.text)) {
                pushNodeMatch(currentNode, classifyIdentifier(currentNode), functionName);
            }
        }

        // マクロ定義の置き換え値（右辺）の部分一致 / 単語全体一致（複数マッチに対応）
        if (currentNode.type === 'preproc_arg' && containsMatch(currentNode.text)) {
            const row = currentNode.startPosition.row;
            const lineContent = lines[row];
            if (lineContent) {
                collectOccurrences(lineContent, row, classifyIdentifier(currentNode), functionName);
            }
        }

        // 文字列リテラル内のテキスト部分一致 / 単語全体一致 (入力として扱う、複数マッチに対応)
        if (currentNode.type === 'string_literal' && containsMatch(currentNode.text)) {
            const row = currentNode.startPosition.row;
            const lineContent = lines[row];
            if (lineContent) {
                collectOccurrences(lineContent, row, '入力', functionName);
            }
        }

        // 子ノードを再帰的に走査（所属関数名を引き継ぐ）
        for (let i = 0; i < currentNode.childCount; i++) {
            traverse(currentNode.child(i)!, functionName);
        }
    }

    traverse(node);
    return matches;
}
