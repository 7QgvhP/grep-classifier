import * as vscode from 'vscode';
import Parser from 'web-tree-sitter';
import { classifyIdentifier } from './classifier';
import { DataFlowCategory, GrepMatch } from './types';

// 正規表現のメタ文字をエスケープする
function escapeRegExp(str: string): string {
    return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
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
    const collectOccurrences = (lineContent: string, line: number, category: DataFlowCategory): void => {
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
                    category
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
                    category
                });
                idx = lineContent.indexOf(query, idx + query.length);
            }
        }
    };

    // ノードの範囲そのものを一致箇所として登録する
    const pushNodeMatch = (target: Parser.SyntaxNode, category: DataFlowCategory): void => {
        matches.push({
            fileUri,
            line: target.startPosition.row,
            charStart: target.startPosition.column,
            charEnd: target.endPosition.column,
            content: lines[target.startPosition.row],
            category
        });
    };

    function traverse(currentNode: Parser.SyntaxNode) {
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
                    collectOccurrences(lineContent, actualLine, 'コメント');
                } else {
                    matches.push({
                        fileUri,
                        line: actualLine,
                        charStart: 0,
                        charEnd: commentLine.length,
                        content: commentLine,
                        category: 'コメント'
                    });
                }
            });
            return; // コメントの子ノードは探索不要
        }

        // 構造体メンバーアクセスや配列アクセスの判定 (クエリに記号が含まれる場合のみ)
        if (hasOperator && (currentNode.type === 'field_expression' || currentNode.type === 'subscript_expression')) {
            if (isNodeMatch(currentNode.text)) {
                pushNodeMatch(currentNode, classifyIdentifier(currentNode));
                // 重複して子ノード（オブジェクト名やメンバー名単体）がヒットするのを防ぐため、巡回をスキップ
                return;
            }
        }

        // 識別子、構造体メンバー名の部分一致 / 完全一致
        if (currentNode.type === 'identifier' || currentNode.type === 'field_identifier') {
            if (isNodeMatch(currentNode.text)) {
                pushNodeMatch(currentNode, classifyIdentifier(currentNode));
            }
        }

        // マクロ定義の置き換え値（右辺）の部分一致 / 単語全体一致（複数マッチに対応）
        if (currentNode.type === 'preproc_arg' && containsMatch(currentNode.text)) {
            const row = currentNode.startPosition.row;
            const lineContent = lines[row];
            if (lineContent) {
                collectOccurrences(lineContent, row, classifyIdentifier(currentNode));
            }
        }

        // 文字列リテラル内のテキスト部分一致 / 単語全体一致 (入力として扱う、複数マッチに対応)
        if (currentNode.type === 'string_literal' && containsMatch(currentNode.text)) {
            const row = currentNode.startPosition.row;
            const lineContent = lines[row];
            if (lineContent) {
                collectOccurrences(lineContent, row, '入力');
            }
        }

        // 子ノードを再帰的に走査
        for (let i = 0; i < currentNode.childCount; i++) {
            traverse(currentNode.child(i)!);
        }
    }

    traverse(node);
    return matches;
}
