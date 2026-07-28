import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { TextDecoder } from 'util';
import Parser from 'web-tree-sitter';
import { findMatchesInTree } from './matcher';
import { RESULT_SCHEME, RESULT_URI, ResultDocumentProvider, ResultLocation } from './resultDocument';
import { CATEGORIES, GrepMatch, GrepMatchSerializable } from './types';

/**
 * 一致箇所をエディタで開き、選択とハイライトを適用する。
 * サイドバーからの遷移と検索結果ドキュメントからの遷移で共通して使用する。
 */
async function revealMatch(
    location: ResultLocation,
    decorationType: vscode.TextEditorDecorationType,
    preserveFocus: boolean
): Promise<void> {
    try {
        const doc = await vscode.workspace.openTextDocument(location.uri);
        const editor = await vscode.window.showTextDocument(doc, { preserveFocus });

        const startPos = new vscode.Position(location.line, location.charStart);
        const endPos = new vscode.Position(location.line, location.charEnd);
        editor.selection = new vscode.Selection(startPos, endPos);
        editor.revealRange(editor.selection, vscode.TextEditorRevealType.InCenter);

        // 既存のすべての表示中エディタのデコレーションをクリア
        for (const visibleEditor of vscode.window.visibleTextEditors) {
            visibleEditor.setDecorations(decorationType, []);
        }

        // 新規にデコレーションを設定してハイライト
        editor.setDecorations(decorationType, [new vscode.Range(startPos, endPos)]);
    } catch (err) {
        vscode.window.showErrorMessage(`ファイルを開くことができませんでした: ${err}`);
    }
}

// Webview View のプロバイダー定義
class GrepWebviewViewProvider implements vscode.WebviewViewProvider {
    public static readonly viewType = 'cGrepClassifierView';
    private _view?: vscode.WebviewView;
    private _isReady = false;
    private _pendingQuery?: string;
    // 文字コードごとのデコーダを再利用するためのキャッシュ
    private readonly _decoderCache = new Map<string, TextDecoder>();

    constructor(
        private readonly _extensionUri: vscode.Uri,
        private readonly _parser: Parser,
        private readonly _searchHighlightDecorationType: vscode.TextEditorDecorationType,
        private readonly _resultDocument: ResultDocumentProvider
    ) {}

    // 検索結果をテキストドキュメントとしてエディタに表示する
    public async showResultsInEditor(): Promise<void> {
        if (!this._resultDocument.hasResult) {
            vscode.window.showInformationMessage('先に検索を実行してください。');
            return;
        }
        const doc = await vscode.workspace.openTextDocument(RESULT_URI);
        await vscode.window.showTextDocument(doc, { preview: false });
    }

    // 選択テキストによる検索をトリガーするメソッド
    public searchForSelection(query: string) {
        if (this._view) {
            this._view.show(true);
            if (this._isReady) {
                // Webviewの準備ができている場合はクエリを送信して検索実行
                this._view.webview.postMessage({ type: 'setQueryAndSearch', query });
            } else {
                // 準備ができていない場合はペンディングとして保持
                this._pendingQuery = query;
            }
        } else {
            // ビューがまだ作成されていない場合はペンディングとして保持し、フォーカスを要求
            this._pendingQuery = query;
            vscode.commands.executeCommand('cGrepClassifierView.focus');
        }
    }

    public resolveWebviewView(
        webviewView: vscode.WebviewView,
        context: vscode.WebviewViewResolveContext,
        _token: vscode.CancellationToken
    ) {
        this._view = webviewView;
        this._isReady = false; // 初期化

        // Webviewのオプション設定（JSの有効化とルートパスの制限）
        webviewView.webview.options = {
            enableScripts: true,
            localResourceRoots: [this._extensionUri]
        };

        // 初期HTMLの設定
        webviewView.webview.html = this._getHtmlForWebview(webviewView.webview);

        // Webview側からのメッセージ受信時のイベントリスナー
        webviewView.webview.onDidReceiveMessage(async (data) => {
            switch (data.type) {
                case 'ready': {
                    this._isReady = true;
                    if (this._pendingQuery) {
                        const query = this._pendingQuery;
                        this._pendingQuery = undefined;
                        // ペンディングされていたクエリを送信して検索実行
                        webviewView.webview.postMessage({ type: 'setQueryAndSearch', query });
                    }
                    break;
                }
                case 'search': {
                    const query = data.query;
                    const matchWholeWord = !!data.matchWholeWord;
                    if (!query) {
                        return;
                    }
                    const rawMatches = await this._performSearch(query, matchWholeWord);
                    // 所属関数の表示が無効な場合は関数名を送信しない
                    const showFunction = vscode.workspace.getConfiguration('cGrepClassifier')
                        .get<boolean>('showEnclosingFunction') ?? true;
                    // Webviewに渡すシリアライズ形式への変換
                    const matches: GrepMatchSerializable[] = rawMatches.map(({ fileUri, functionName, ...rest }) => ({
                        ...rest,
                        functionName: showFunction ? functionName : undefined,
                        fileUriStr: fileUri.toString()
                    }));
                    webviewView.webview.postMessage({ type: 'results', matches });
                    // エディタ表示用の検索結果ドキュメントも更新する
                    this._resultDocument.update(query, matchWholeWord, rawMatches);
                    break;
                }
                case 'openFile': {
                    const { fileUriStr, line, charStart, charEnd, preserveFocus } = data;
                    await revealMatch(
                        { uri: vscode.Uri.parse(fileUriStr), line, charStart, charEnd },
                        this._searchHighlightDecorationType,
                        !!preserveFocus
                    );
                    break;
                }
                case 'openInEditor': {
                    await this.showResultsInEditor();
                    break;
                }
            }
        });
    }

    // VS Codeのエンコーディング形式名から TextDecoder が認識できる名前に変換する
    private _getNormalizedEncoding(vscodeEncoding: string): string {
        const map: Record<string, string> = {
            'utf8': 'utf-8',
            'shiftjis': 'shift_jis',
            'eucjp': 'euc-jp',
            'utf16le': 'utf-16le',
            'utf16be': 'utf-16be',
            'iso2022jp': 'iso-2022-jp',
            'cp1252': 'windows-1252'
        };
        return map[vscodeEncoding.toLowerCase()] || vscodeEncoding;
    }

    // 対象ファイルの文字コード設定（files.encoding）に対応するデコーダを取得する
    private _getDecoderFor(file: vscode.Uri): TextDecoder {
        const vscodeEncoding = vscode.workspace.getConfiguration('files', file).get<string>('encoding') || 'utf8';
        const encoding = this._getNormalizedEncoding(vscodeEncoding);

        let decoder = this._decoderCache.get(encoding);
        if (!decoder) {
            decoder = new TextDecoder(encoding);
            this._decoderCache.set(encoding, decoder);
        }
        return decoder;
    }

    /**
     * 対象ファイルのテキストを取得する。
     * エディタで開かれており未保存の編集がある場合は、
     * ディスク上の内容ではなくエディタ側の内容を優先する。
     */
    private async _getFileContent(file: vscode.Uri): Promise<string> {
        const dirtyDocument = vscode.workspace.textDocuments.find(
            doc => doc.isDirty && doc.uri.toString() === file.toString()
        );
        if (dirtyDocument) {
            return dirtyDocument.getText();
        }

        // 指定された文字コードでデコード
        const buffer = await vscode.workspace.fs.readFile(file);
        return this._getDecoderFor(file).decode(buffer);
    }

    // 単一ファイルを解析して一致箇所を抽出する
    private async _searchInFile(file: vscode.Uri, query: string, matchWholeWord: boolean): Promise<GrepMatch[]> {
        const content = await this._getFileContent(file);

        // パフォーマンス最適化のため、まずは高速に簡易チェック（部分一致しなければ完全一致もしない）
        if (!content.includes(query)) {
            return [];
        }

        const tree = this._parser.parse(content);
        const lines = content.split(/\r?\n/);
        return findMatchesInTree(tree.rootNode, query, file, lines, matchWholeWord);
    }

    /**
     * 設定から検索対象・除外パターンを組み立てる。
     * 除外パターンの戻り値は findFiles の仕様に合わせ、
     * undefined（VS Code標準の除外を適用）／null（除外なし）を使い分ける。
     */
    private _getSearchPatterns(): { include: string; exclude: string | null | undefined } {
        const config = vscode.workspace.getConfiguration('cGrepClassifier');
        const include = config.get<string>('includePattern')?.trim() || '**/*.{c,h}';
        const useDefaultExcludes = config.get<boolean>('useDefaultExcludes') ?? true;

        const excludes = [...(config.get<string[]>('excludePatterns') || [])];
        if (useDefaultExcludes) {
            // VS Code標準の除外設定のうち、有効化されているパターンを取り込む
            for (const section of ['files', 'search']) {
                const patterns = vscode.workspace.getConfiguration(section).get<Record<string, unknown>>('exclude') || {};
                for (const [pattern, enabled] of Object.entries(patterns)) {
                    // when条件付きの除外は評価できないため対象外とする
                    if (enabled === true) {
                        excludes.push(pattern);
                    }
                }
            }
        }

        const uniqueExcludes = Array.from(new Set(excludes.map(p => p.trim()).filter(p => p.length > 0)));

        if (uniqueExcludes.length === 0) {
            // 標準の除外を使う設定であれば undefined（VS Codeの既定動作）に委ねる
            return { include, exclude: useDefaultExcludes ? undefined : null };
        }
        // 複数パターンは中括弧でグループ化して1つのglobにまとめる
        const exclude = uniqueExcludes.length === 1 ? uniqueExcludes[0] : `{${uniqueExcludes.join(',')}}`;
        return { include, exclude };
    }

    // C言語ファイルへのGrep検索とデータフロー分類の実行
    private async _performSearch(query: string, matchWholeWord: boolean): Promise<GrepMatch[]> {
        const workspaceFolders = vscode.workspace.workspaceFolders;
        if (!workspaceFolders) {
            vscode.window.showInformationMessage('ワークスペースが開かれていません。');
            return [];
        }

        const allMatches: GrepMatch[] = [];

        await vscode.window.withProgress({
            location: vscode.ProgressLocation.Notification,
            title: "C言語ファイルを分析中...",
            cancellable: false
        }, async () => {
            const { include, exclude } = this._getSearchPatterns();
            const files = await vscode.workspace.findFiles(include, exclude);
            for (const file of files) {
                try {
                    allMatches.push(...await this._searchInFile(file, query, matchWholeWord));
                } catch (err) {
                    console.error(`ファイルの解析に失敗しました: ${file.fsPath}`, err);
                }
            }
        });

        return allMatches;
    }

    // Webviewに表示するHTMLを構築（media配下のテンプレートを読み込みプレースホルダを置換）
    private _getHtmlForWebview(webview: vscode.Webview): string {
        const nonce = getNonce();
        const mediaUri = vscode.Uri.joinPath(this._extensionUri, 'media');
        const styleUri = webview.asWebviewUri(vscode.Uri.joinPath(mediaUri, 'main.css'));
        const scriptUri = webview.asWebviewUri(vscode.Uri.joinPath(mediaUri, 'main.js'));

        const template = fs.readFileSync(path.join(mediaUri.fsPath, 'webview.html'), 'utf8');

        // 置換値に $ が含まれても特殊解釈されないよう関数形式で置換する
        const replacements: Record<string, string> = {
            '{{cspSource}}': webview.cspSource,
            '{{nonce}}': nonce,
            '{{styleUri}}': styleUri.toString(),
            '{{scriptUri}}': scriptUri.toString(),
            '{{categoriesJson}}': JSON.stringify(CATEGORIES)
        };

        return template.replace(/\{\{\w+\}\}/g, (placeholder) =>
            placeholder in replacements ? replacements[placeholder] : placeholder
        );
    }
}

// セキュリティ検証用 nonce の生成
function getNonce() {
    let text = '';
    const possible = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
    for (let i = 0; i < 32; i++) {
        text += possible.charAt(Math.floor(Math.random() * possible.length));
    }
    return text;
}

// 拡張機能のアクティベート処理
export async function activate(context: vscode.ExtensionContext) {
    // 検索ヒット箇所をハイライトするためのデコレーション（テーマ色に連動）
    const searchHighlightDecorationType = vscode.window.createTextEditorDecorationType({
        backgroundColor: new vscode.ThemeColor('editor.findMatchHighlightBackground'),
        border: '1px solid',
        borderColor: new vscode.ThemeColor('editor.findMatchHighlightBorder'),
        borderRadius: '3px'
    });

    // web-tree-sitterの初期化とC言語パーサーのロード
    let parser: Parser;
    try {
        await Parser.init();
        const cLangWasmPath = path.join(context.extensionPath, 'bin', 'tree-sitter-c.wasm');
        const wasmBuffer = fs.readFileSync(cLangWasmPath);
        const cLang = await Parser.Language.load(wasmBuffer);

        parser = new Parser();
        parser.setLanguage(cLang);
    } catch (err) {
        vscode.window.showErrorMessage(`Parserの初期化に失敗しました。WASMファイルが正しく配置されているか確認してください: ${err}`);
        return;
    }

    // 検索結果をテキストドキュメントとして提供するプロバイダーの登録
    const resultDocument = new ResultDocumentProvider();
    context.subscriptions.push(
        resultDocument,
        vscode.workspace.registerTextDocumentContentProvider(RESULT_SCHEME, resultDocument),
        // Ctrl+クリック（定義へ移動）で該当箇所へジャンプできるようにする
        vscode.languages.registerDefinitionProvider({ scheme: RESULT_SCHEME }, {
            provideDefinition(document, position) {
                const location = resultDocument.getLocationAt(position.line);
                if (!location) {
                    return undefined;
                }
                return new vscode.Location(
                    location.uri,
                    new vscode.Range(location.line, location.charStart, location.line, location.charEnd)
                );
            }
        })
    );

    // Webview View Provider のインスタンス化と登録
    const provider = new GrepWebviewViewProvider(
        context.extensionUri,
        parser,
        searchHighlightDecorationType,
        resultDocument
    );

    context.subscriptions.push(
        vscode.window.registerWebviewViewProvider(GrepWebviewViewProvider.viewType, provider)
    );

    // 検索結果をエディタで開くコマンド
    const showResultsCommand = vscode.commands.registerCommand('c-grep-classifier.showResultsInEditor', async () => {
        await provider.showResultsInEditor();
    });

    // 検索結果ドキュメント上でカーソル行の一致箇所を開くコマンド（Enterキーに割り当て）
    const openResultCommand = vscode.commands.registerCommand('c-grep-classifier.openResultAtCursor', async () => {
        const editor = vscode.window.activeTextEditor;
        if (!editor || editor.document.uri.scheme !== RESULT_SCHEME) {
            return;
        }
        const location = resultDocument.getLocationAt(editor.selection.active.line);
        if (!location) {
            return;
        }
        await revealMatch(location, searchHighlightDecorationType, false);
    });

    context.subscriptions.push(showResultsCommand, openResultCommand);

    // 検索コマンドの登録（選択テキストがあれば検索、なければサイドバーをフォーカス）
    const searchCommand = vscode.commands.registerCommand('c-grep-classifier.search', async () => {
        const editor = vscode.window.activeTextEditor;
        let selectedText = '';
        if (editor) {
            const selection = editor.selection;
            if (!selection.isEmpty) {
                selectedText = editor.document.getText(selection).trim();
            }
        }

        if (selectedText) {
            provider.searchForSelection(selectedText);
        } else {
            await vscode.commands.executeCommand('cGrepClassifierView.focus');
        }
    });

    context.subscriptions.push(searchCommand, searchHighlightDecorationType);
}

export function deactivate() {}
