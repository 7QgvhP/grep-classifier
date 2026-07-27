import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { TextDecoder } from 'util';
import Parser from 'web-tree-sitter';
import { findMatchesInTree } from './matcher';
import { CATEGORIES, GrepMatch, GrepMatchSerializable } from './types';

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
        private readonly _searchHighlightDecorationType: vscode.TextEditorDecorationType
    ) {}

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
                    // Webviewに渡すシリアライズ形式への変換
                    const matches: GrepMatchSerializable[] = rawMatches.map(({ fileUri, ...rest }) => ({
                        ...rest,
                        fileUriStr: fileUri.toString()
                    }));
                    webviewView.webview.postMessage({ type: 'results', matches });
                    break;
                }
                case 'openFile': {
                    const { fileUriStr, line, charStart, charEnd, preserveFocus } = data;
                    try {
                        const uri = vscode.Uri.parse(fileUriStr);
                        const doc = await vscode.workspace.openTextDocument(uri);
                        const editor = await vscode.window.showTextDocument(doc, { preserveFocus: !!preserveFocus });

                        const startPos = new vscode.Position(line, charStart);
                        const endPos = new vscode.Position(line, charEnd);
                        editor.selection = new vscode.Selection(startPos, endPos);
                        editor.revealRange(editor.selection, vscode.TextEditorRevealType.InCenter);

                        // 既存のすべての表示中エディタのデコレーションをクリア
                        for (const visibleEditor of vscode.window.visibleTextEditors) {
                            visibleEditor.setDecorations(this._searchHighlightDecorationType, []);
                        }

                        // 新規にデコレーションを設定してハイライト
                        const range = new vscode.Range(startPos, endPos);
                        editor.setDecorations(this._searchHighlightDecorationType, [range]);
                    } catch (err) {
                        vscode.window.showErrorMessage(`ファイルを開くことができませんでした: ${err}`);
                    }
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

    // 単一ファイルを解析して一致箇所を抽出する
    private async _searchInFile(file: vscode.Uri, query: string, matchWholeWord: boolean): Promise<GrepMatch[]> {
        // 指定された文字コードでデコード
        const buffer = await vscode.workspace.fs.readFile(file);
        const content = this._getDecoderFor(file).decode(buffer);

        // パフォーマンス最適化のため、まずは高速に簡易チェック（部分一致しなければ完全一致もしない）
        if (!content.includes(query)) {
            return [];
        }

        const tree = this._parser.parse(content);
        const lines = content.split(/\r?\n/);
        return findMatchesInTree(tree.rootNode, query, file, lines, matchWholeWord);
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
            const files = await vscode.workspace.findFiles('**/*.{c,h}', '**/node_modules/**');
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

    // Webview View Provider のインスタンス化と登録
    const provider = new GrepWebviewViewProvider(
        context.extensionUri,
        parser,
        searchHighlightDecorationType
    );

    context.subscriptions.push(
        vscode.window.registerWebviewViewProvider(GrepWebviewViewProvider.viewType, provider)
    );

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
