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
    matches: GrepMatch[],
    showFunction: boolean
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
            // 関数名を表示しない設定の場合は列自体を出力しない
            const functionWidth = showFunction
                ? Math.min(
                    FUNCTION_NAME_MAX,
                    Math.max(0, ...items.map(item => (item.functionName ? item.functionName.length + 2 : 0)))
                )
                : 0;

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
 * キーワードが出現する関数名のみを集約して一覧化した本文を組み立てる。
 * 行番号やコードは出力せず、「どの関数がこの変数を扱っているか」を俯瞰する用途。
 */
function buildSummaryContent(
    query: string,
    matchWholeWord: boolean,
    matches: GrepMatch[]
): { content: string; locations: Map<number, ResultLocation> } {
    const locations = new Map<number, ResultLocation>();
    const lines: string[] = [];

    const push = (text: string, location?: ResultLocation): void => {
        if (location) {
            locations.set(lines.length, location);
        }
        lines.push(text);
    };

    const fileCount = new Set(matches.map(m => m.fileUri.toString())).size;
    push(`C-Grep Classifier   検索: "${query}"   (${matchWholeWord ? '単語全体に一致' : '部分一致'})   [関数名一覧]`);
    push(`${matches.length} 件の一致 / ${fileCount} ファイル`);
    push('');

    if (matches.length === 0) {
        push('一致する箇所が見つかりませんでした。');
        return { content: lines.join('\n'), locations };
    }

    push('Enter または Ctrl+クリックで、その関数内の最初の一致箇所へジャンプします。');
    push('');

    for (const category of CATEGORIES) {
        const list = matches.filter(m => m.category === category.name);
        if (list.length === 0) {
            continue;
        }

        // 関数名を出現順に重複なく集め、それぞれ最初の一致箇所を保持する
        const functions = new Map<string, GrepMatch>();
        for (const match of list) {
            if (match.functionName && !functions.has(match.functionName)) {
                functions.set(match.functionName, match);
            }
        }

        push(`■ ${category.name} (${list.length}件 / ${functions.size}関数)`);
        for (const [name, match] of functions) {
            push(`    ${name}()`, {
                uri: match.fileUri,
                line: match.line,
                charStart: match.charStart,
                charEnd: match.charEnd
            });
        }
        push('');
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

    // 最後に実行した検索の内容（表示モード切替時の再構築に使用する）
    private _query = '';
    private _matchWholeWord = false;
    private _matches: GrepMatch[] = [];
    private _showFunction = true;
    private _summaryMode = false;

    // 検索結果を受け取り、本文と行対応表を再構築して開いているタブへ反映する
    public update(query: string, matchWholeWord: boolean, matches: GrepMatch[], showFunction: boolean): void {
        this._query = query;
        this._matchWholeWord = matchWholeWord;
        this._matches = matches;
        this._showFunction = showFunction;
        this._hasResult = true;
        this._rebuild();
    }

    // 一度でも検索が実行されているか
    public get hasResult(): boolean {
        return this._hasResult;
    }

    // 関数名一覧モードで表示しているか
    public get summaryMode(): boolean {
        return this._summaryMode;
    }

    // 関数名一覧モードの切り替え（検索を実行し直さずに本文だけを作り直す）
    public setSummaryMode(enabled: boolean): void {
        if (this._summaryMode === enabled) {
            return;
        }
        this._summaryMode = enabled;
        if (this._hasResult) {
            this._rebuild();
        }
    }

    // 現在のモードに応じて本文と行対応表を作り直し、開いているタブへ反映する
    private _rebuild(): void {
        const { content, locations } = this._summaryMode
            ? buildSummaryContent(this._query, this._matchWholeWord, this._matches)
            : buildContent(this._query, this._matchWholeWord, this._matches, this._showFunction);
        this._content = content;
        this._locations = locations;
        this._onDidChange.fire(RESULT_URI);
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
