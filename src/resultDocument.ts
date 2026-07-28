import * as vscode from 'vscode';
import { CATEGORIES, GrepMatch } from './types';

// 検索結果ドキュメントのURIスキーム
export const RESULT_SCHEME = 'cgrep-result';

// 検索結果ドキュメントのURI。常に同一のため、再検索時は同じタブが更新される
export const RESULT_URI = vscode.Uri.parse(`${RESULT_SCHEME}:C-Grep 検索結果.cgrep`);

// 関数名を表示する際の最大文字数
const FUNCTION_NAME_MAX = 24;

// 検索結果ドキュメント上の1行と、対応するソース上の位置
export interface ResultLocation {
    uri: vscode.Uri;
    line: number;
    charStart: number;
    charEnd: number;
}

// 長い文字列を省略記号付きで切り詰める
function truncate(text: string, max: number): string {
    return text.length > max ? text.slice(0, max - 1) + '…' : text;
}

/**
 * 検索結果からドキュメント本文を組み立て、
 * あわせて「本文の行番号 → ソース上の位置」の対応表を作成する。
 */
function buildContent(
    query: string,
    matchWholeWord: boolean,
    matches: GrepMatch[]
): { content: string; locations: Map<number, ResultLocation> } {
    const locations = new Map<number, ResultLocation>();
    const lines: string[] = [];

    // 1行追加する。位置情報を伴う行は対応表にも登録する
    const push = (text: string, location?: ResultLocation): void => {
        if (location) {
            locations.set(lines.length, location);
        }
        lines.push(text);
    };

    const fileCount = new Set(matches.map(m => m.fileUri.toString())).size;
    push(`C-Grep Classifier   検索: "${query}"   (${matchWholeWord ? '単語全体に一致' : '部分一致'})`);
    push(`${matches.length} 件の一致 / ${fileCount} ファイル`);
    push('');

    if (matches.length === 0) {
        push('一致する箇所が見つかりませんでした。');
        return { content: lines.join('\n'), locations };
    }

    push('Enter または Ctrl+クリックで該当箇所へジャンプします。');
    push('');

    for (const category of CATEGORIES) {
        const list = matches.filter(m => m.category === category.name);
        if (list.length === 0) {
            continue;
        }

        push(`■ ${category.name} (${list.length})`);
        push('');

        // ファイル単位にまとめ、ファイル名の辞書順に並べる
        const groups = new Map<string, GrepMatch[]>();
        for (const match of list) {
            const key = match.fileUri.toString();
            const group = groups.get(key);
            if (group) {
                group.push(match);
            } else {
                groups.set(key, [match]);
            }
        }

        const sortedGroups = Array.from(groups.values())
            .map(items => ({ items, label: vscode.workspace.asRelativePath(items[0].fileUri) }))
            .sort((a, b) => a.label.localeCompare(b.label));

        for (const group of sortedGroups) {
            push(`  ${group.label} (${group.items.length})`);

            const items = [...group.items].sort((a, b) => a.line - b.line || a.charStart - b.charStart);
            // 行番号と関数名の桁幅を揃えて読みやすくする
            const numberWidth = Math.max(...items.map(item => String(item.line + 1).length));
            const functionWidth = Math.min(
                FUNCTION_NAME_MAX,
                Math.max(0, ...items.map(item => (item.functionName ? item.functionName.length + 2 : 0)))
            );

            for (const item of items) {
                const number = String(item.line + 1).padStart(numberWidth);
                const functionLabel = functionWidth > 0
                    ? '  ' + truncate(item.functionName ? `${item.functionName}()` : '', functionWidth).padEnd(functionWidth)
                    : '';
                push(`    ${number}:${functionLabel}  ${item.content.trim()}`, {
                    uri: item.fileUri,
                    line: item.line,
                    charStart: item.charStart,
                    charEnd: item.charEnd
                });
            }
            push('');
        }
    }

    return { content: lines.join('\n'), locations };
}

/**
 * 検索結果を読み取り専用のテキストドキュメントとして提供する。
 * URIを固定しているため、再検索時は開いているタブの内容が更新される。
 */
export class ResultDocumentProvider implements vscode.TextDocumentContentProvider {
    private readonly _onDidChange = new vscode.EventEmitter<vscode.Uri>();
    public readonly onDidChange = this._onDidChange.event;

    private _content = '検索が実行されていません。';
    private _locations = new Map<number, ResultLocation>();
    private _hasResult = false;

    // 検索結果を受け取り、本文と行対応表を再構築して開いているタブへ反映する
    public update(query: string, matchWholeWord: boolean, matches: GrepMatch[]): void {
        const { content, locations } = buildContent(query, matchWholeWord, matches);
        this._content = content;
        this._locations = locations;
        this._hasResult = true;
        this._onDidChange.fire(RESULT_URI);
    }

    // 一度でも検索が実行されているか
    public get hasResult(): boolean {
        return this._hasResult;
    }

    public provideTextDocumentContent(): string {
        return this._content;
    }

    // 指定行に対応する一致箇所を返す（見出しや空行の場合は undefined）
    public getLocationAt(line: number): ResultLocation | undefined {
        return this._locations.get(line);
    }

    public dispose(): void {
        this._onDidChange.dispose();
    }
}
