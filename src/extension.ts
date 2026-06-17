import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import Parser from 'web-tree-sitter';

// 分類カテゴリの定義
type DataFlowCategory = '入力' | '出力' | '定義' | 'コメント' | 'その他';

// 検索キーワードの一致情報を表すインターフェース
interface GrepMatch {
    fileUri: vscode.Uri;
    line: number;
    charStart: number;
    charEnd: number;
    content: string; // 該当行のテキスト
    category: DataFlowCategory;
}

// Webviewに受け渡すためのシリアライズ可能な一致情報インターフェース
interface GrepMatchSerializable {
    fileUriStr: string;
    line: number;
    charStart: number;
    charEnd: number;
    content: string;
    category: DataFlowCategory;
}

// ASTの各ノードから検索クエリに一致する識別子やコメント等を抽出し、データフロー分類を行う
function findMatchesInTree(
    node: Parser.SyntaxNode,
    query: string,
    fileUri: vscode.Uri,
    lines: string[],
    matchWholeWord: boolean
): GrepMatch[] {
    const matches: GrepMatch[] = [];
    // クエリに構造体や配列のアクセス演算子が含まれているか判定
    const hasOperator = query.includes('.') || query.includes('->') || query.includes('[');

    function escapeRegExp(str: string): string {
        return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    }

    const escapedQuery = escapeRegExp(query);
    const wholeWordRegex = new RegExp(`\\b${escapedQuery}\\b`);

    function traverse(currentNode: Parser.SyntaxNode) {
        // コメントノード内のテキスト部分一致 / 単語全体一致
        if (currentNode.type === 'comment') {
            const isMatch = matchWholeWord ? wholeWordRegex.test(currentNode.text) : currentNode.text.includes(query);
            if (isMatch) {
                matches.push({
                    fileUri,
                    line: currentNode.startPosition.row,
                    charStart: currentNode.startPosition.column,
                    charEnd: currentNode.endPosition.column,
                    content: lines[currentNode.startPosition.row],
                    category: 'コメント'
                });
                return; // コメントの子ノードは探索不要
            }
        }

        // 構造体メンバーアクセスや配列アクセスの判定 (クエリに記号が含まれる場合のみ)
        if (hasOperator && (currentNode.type === 'field_expression' || currentNode.type === 'subscript_expression')) {
            const isMatch = matchWholeWord ? (currentNode.text === query) : currentNode.text.includes(query);
            if (isMatch) {
                const category = classifyIdentifier(currentNode);
                matches.push({
                    fileUri,
                    line: currentNode.startPosition.row,
                    charStart: currentNode.startPosition.column,
                    charEnd: currentNode.endPosition.column,
                    content: lines[currentNode.startPosition.row],
                    category
                });
                // 重複して子ノード（オブジェクト名やメンバー名単体）がヒットするのを防ぐため、巡回をスキップ
                return;
            }
        }

        // 識別子、構造体メンバー名、またはマクロ引数値ノードの部分一致 / 完全一致
        if (
            currentNode.type === 'identifier' ||
            currentNode.type === 'field_identifier' ||
            currentNode.type === 'preproc_arg'
        ) {
            const isMatch = matchWholeWord ? (currentNode.text === query) : currentNode.text.includes(query);
            if (isMatch) {
                const category = classifyIdentifier(currentNode);
                matches.push({
                    fileUri,
                    line: currentNode.startPosition.row,
                    charStart: currentNode.startPosition.column,
                    charEnd: currentNode.endPosition.column,
                    content: lines[currentNode.startPosition.row],
                    category
                });
            }
        }

        // 文字列リテラル内のテキスト部分一致 / 単語全体一致 (入力として扱う)
        if (currentNode.type === 'string_literal') {
            const isMatch = matchWholeWord ? wholeWordRegex.test(currentNode.text) : currentNode.text.includes(query);
            if (isMatch) {
                matches.push({
                    fileUri,
                    line: currentNode.startPosition.row,
                    charStart: currentNode.startPosition.column,
                    charEnd: currentNode.endPosition.column,
                    content: lines[currentNode.startPosition.row],
                    category: '入力'
                });
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

// ノードが対象ノード（親ノードなど）の物理的配下にあるかを判定する
function isDescendantOf(node: Parser.SyntaxNode, target: Parser.SyntaxNode): boolean {
    return target.startIndex <= node.startIndex && node.endIndex <= target.endIndex;
}

// 識別子ノードのコンテキスト（祖先ノードの関係性）からデータフロー分類を行う
function classifyIdentifier(node: Parser.SyntaxNode): DataFlowCategory {
    let current: Parser.SyntaxNode | null = node;

    while (current) {
        const parent: Parser.SyntaxNode | null = current.parent;
        if (!parent) {
            break;
        }

        // --- 1. 出力 (Output - 書き込み) の優先判定 ---
        if (parent.type === 'assignment_expression') {
            const left = parent.childForFieldName('left');
            if (left && isDescendantOf(node, left)) {
                return '出力';
            }
        }
        if (parent.type === 'update_expression') {
            return '出力';
        }
        if (parent.type === 'pointer_expression') {
            const operator = parent.child(0);
            if (operator && operator.text === '&') {
                return '出力';
            }
        }

        // --- 2. 入力 (Input - 参照) の優先判定 ---
        if (parent.type === 'assignment_expression') {
            const right = parent.childForFieldName('right');
            if (right && isDescendantOf(node, right)) {
                return '入力';
            }
        }
        if (parent.type === 'init_declarator') {
            const value = parent.childForFieldName('value');
            if (value && isDescendantOf(node, value)) {
                return '入力';
            }
        }
        if (parent.type === 'if_statement' || parent.type === 'while_statement' || parent.type === 'for_statement') {
            const condition = parent.childForFieldName('condition');
            if (condition && isDescendantOf(node, condition)) {
                return '入力';
            }
        }
        if (parent.type === 'argument_list') {
            return '入力';
        }
        if (
            [
                'binary_expression',
                'return_statement',
                'switch_statement',
                'case_statement'
            ].includes(parent.type)
        ) {
            return '入力';
        }

        // --- 3. 定義 (Definition) の判定 ---
        if (parent.type === 'type_definition') {
            const declarator = parent.childForFieldName('declarator');
            if (declarator && isDescendantOf(node, declarator)) {
                return '定義';
            }
        }
        if (parent.type === 'enumerator') {
            return '定義';
        }
        if (parent.type === 'preproc_params') {
            return '定義';
        }
        if (parent.type === 'declaration' || parent.type === 'parameter_declaration') {
            const typeNode = parent.childForFieldName('type');
            if (!(typeNode && isDescendantOf(node, typeNode))) {
                return '定義';
            }
        }
        if (parent.type === 'init_declarator') {
            const declarator = parent.childForFieldName('declarator');
            if (declarator && isDescendantOf(node, declarator)) {
                return '定義';
            }
        }
        if (parent.type === 'ERROR' && parent.parent && parent.parent.type === 'declaration') {
            return '定義';
        }
        if (parent.type === 'function_definition') {
            const declarator = parent.childForFieldName('declarator');
            if (declarator && isDescendantOf(node, declarator)) {
                return '定義';
            }
        }
        if (parent.type === 'preproc_def' || parent.type === 'preproc_function_def') {
            const nameNode = parent.childForFieldName('name');
            if (nameNode && nameNode.text === node.text) {
                return '定義';
            }
        }
        if (parent.type === 'struct_specifier' || parent.type === 'union_specifier' || parent.type === 'enum_specifier') {
            const nameNode = parent.childForFieldName('name');
            if (nameNode && nameNode.text === node.text) {
                return '定義';
            }
        }
        if (parent.type === 'field_declaration') {
            return '定義';
        }

        current = parent;
    }

    return 'その他';
}

// Webview View のプロバイダー定義
class GrepWebviewViewProvider implements vscode.WebviewViewProvider {
    public static readonly viewType = 'cGrepClassifierView';
    private _view?: vscode.WebviewView;

    constructor(
        private readonly _extensionUri: vscode.Uri,
        private readonly _parser: Parser,
        private readonly _searchHighlightDecorationType: vscode.TextEditorDecorationType
    ) {}

    public resolveWebviewView(
        webviewView: vscode.WebviewView,
        context: vscode.WebviewViewResolveContext,
        _token: vscode.CancellationToken
    ) {
        this._view = webviewView;

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
                case 'search': {
                    const query = data.query;
                    const matchWholeWord = !!data.matchWholeWord;
                    if (!query) {
                        return;
                    }
                    const rawMatches = await this._performSearch(query, matchWholeWord);
                    // Webviewに渡すシリアライズ形式への変換
                    const matches: GrepMatchSerializable[] = rawMatches.map(m => ({
                        fileUriStr: m.fileUri.toString(),
                        line: m.line,
                        charStart: m.charStart,
                        charEnd: m.charEnd,
                        content: m.content,
                        category: m.category
                    }));
                    webviewView.webview.postMessage({ type: 'results', matches, query, matchWholeWord });
                    break;
                }
                case 'openFile': {
                    const { fileUriStr, line, charStart, charEnd } = data;
                    try {
                        const uri = vscode.Uri.parse(fileUriStr);
                        const doc = await vscode.workspace.openTextDocument(uri);
                        const editor = await vscode.window.showTextDocument(doc);
                        
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
                    // バイナリとして読み込む
                    const buffer = fs.readFileSync(file.fsPath);
                    // VS Codeの設定から文字コードを取得し正規化
                    const vscodeEncoding = vscode.workspace.getConfiguration('files', file).get<string>('encoding') || 'utf8';
                    const encoding = this._getNormalizedEncoding(vscodeEncoding);
                    // 指定された文字コードでデコード
                    const decoder = new TextDecoder(encoding);
                    const content = decoder.decode(buffer);

                    // パフォーマンス最適化のため、まずは高速に簡易チェック（部分一致しなければ完全一致もしない）
                    if (!content.includes(query)) {
                        continue;
                    }
                    const tree = this._parser.parse(content);
                    const lines = content.split(/\r?\n/);
                    const fileMatches = findMatchesInTree(tree.rootNode, query, file, lines, matchWholeWord);
                    allMatches.push(...fileMatches);
                } catch (err) {
                    console.error(`ファイルの解析に失敗しました: ${file.fsPath}`, err);
                }
            }
        });

        return allMatches;
    }

    // Webviewに表示するHTMLを構築
    private _getHtmlForWebview(webview: vscode.Webview): string {
        const nonce = getNonce();

        return `<!DOCTYPE html>
<html lang="ja">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource} 'unsafe-inline'; script-src 'nonce-${nonce}';">
    <style>
        body {
            padding: 8px 10px;
            color: var(--vscode-foreground);
            font-family: var(--vscode-font-family);
            font-size: var(--vscode-font-size);
            background-color: var(--vscode-sideBar-background);
        }
        
        /* 検索コンテナの配置 */
        .search-container {
            display: flex;
            margin-bottom: 12px;
            position: sticky;
            top: 0;
            background-color: var(--vscode-sideBar-background);
            z-index: 10;
            padding-bottom: 6px;
            border-bottom: 1px solid var(--vscode-sideBar-border, rgba(128, 128, 128, 0.2));
        }
        .input-wrapper {
            position: relative;
            display: flex;
            flex-grow: 1;
            align-items: center;
        }
        .search-input {
            flex-grow: 1;
            padding: 4px 28px 4px 6px;
            font-size: var(--vscode-font-size);
            font-family: var(--vscode-font-family);
            color: var(--vscode-input-foreground);
            background-color: var(--vscode-input-background);
            border: 1px solid var(--vscode-input-border, transparent);
            border-radius: 2px;
            outline: none;
        }
        .search-input:focus {
            border-color: var(--vscode-focusBorder);
        }
        .toggle-button {
            position: absolute;
            right: 4px;
            width: 20px;
            height: 20px;
            display: flex;
            align-items: center;
            justify-content: center;
            border: 1px solid transparent;
            background: transparent;
            color: var(--vscode-input-foreground);
            opacity: 0.6;
            cursor: pointer;
            border-radius: 2px;
            padding: 0;
            outline: none;
        }
        .toggle-button:hover {
            opacity: 0.8;
            background-color: rgba(128, 128, 128, 0.1);
        }
        .toggle-button.active {
            opacity: 1;
            background-color: var(--vscode-inputOption-activeBackground, rgba(0, 122, 204, 0.2));
            border-color: var(--vscode-inputOption-activeBorder, #007acc);
            color: var(--vscode-inputOption-activeForeground, var(--vscode-input-foreground));
        }
        
        /* カテゴリアコーディオン */
        .category-container {
            margin-bottom: 6px;
            border-radius: 2px;
            overflow: hidden;
            border: 1px solid var(--vscode-sideBar-border, rgba(128, 128, 128, 0.1));
        }
        .category-header {
            display: flex;
            justify-content: space-between;
            align-items: center;
            padding: 6px 8px;
            font-weight: bold;
            cursor: pointer;
            user-select: none;
            background-color: var(--vscode-sideBarSectionHeader-background, rgba(128, 128, 128, 0.1));
            color: var(--vscode-sideBarSectionHeader-foreground);
        }
        .category-header:hover {
            background-color: var(--vscode-list-hoverBackground);
        }
        .category-title {
            display: flex;
            align-items: center;
            gap: 6px;
        }
        .category-count {
            background-color: var(--vscode-badge-background);
            color: var(--vscode-badge-foreground);
            padding: 1px 5px;
            border-radius: 10px;
            font-size: 0.85em;
        }
        
        .category-items {
            display: none;
            padding: 2px 0;
            background-color: rgba(128, 128, 128, 0.02);
        }
        .category-items.expanded {
            display: block;
        }
        
        /* ファイルヘッダー */
        .file-container {
            margin-bottom: 2px;
        }
        .file-header {
            display: flex;
            justify-content: space-between;
            align-items: center;
            padding: 4px 8px 4px 8px;
            font-size: 0.9em;
            cursor: pointer;
            user-select: none;
            color: var(--vscode-foreground);
        }
        .file-header:hover {
            background-color: var(--vscode-list-hoverBackground);
        }
        .file-title {
            display: flex;
            align-items: center;
            gap: 6px;
        }
        .file-name {
            font-weight: bold;
            color: var(--vscode-textLink-foreground);
        }
        .file-count {
            opacity: 0.6;
            font-size: 0.85em;
        }
        .file-items {
            display: none;
            padding-left: 10px;
            border-left: 1px solid var(--vscode-sideBar-border, rgba(128, 128, 128, 0.1));
            margin-left: 10px;
        }
        .file-items.expanded {
            display: block;
        }
        
        /* 一致項目 (コンパクト表示) */
        .match-item {
            display: flex;
            align-items: center;
            padding: 3px 6px;
            cursor: pointer;
            gap: 8px;
            border-radius: 2px;
        }
        .match-item:hover {
            background-color: var(--vscode-list-hoverBackground);
        }
        .match-line-number {
            color: var(--vscode-editorLineNumber-foreground, #858585);
            min-width: 20px;
            text-align: right;
            font-family: var(--vscode-editor-font-family, monospace);
            font-size: 0.85em;
            user-select: none;
        }
        .match-code {
            font-family: var(--vscode-editor-font-family, monospace);
            font-size: 0.85em;
            white-space: pre;
            overflow: hidden;
            text-overflow: ellipsis;
            opacity: 0.9;
            flex-grow: 1;
        }
        
        .info-text {
            text-align: center;
            opacity: 0.6;
            margin-top: 20px;
            font-size: 0.95em;
        }
        
        /* カテゴリ毎の左線ボーダーワンポイント */
        .cat-input { border-left: 3px solid var(--vscode-charts-blue, #3794ff); }
        .cat-output { border-left: 3px solid var(--vscode-charts-red, #e06c75); }
        .cat-def { border-left: 3px solid var(--vscode-charts-green, #98c379); }
        .cat-comment { border-left: 3px solid var(--vscode-charts-gray, #7f848e); }
        .cat-other { border-left: 3px solid var(--vscode-charts-orange, #abb2bf); }
    </style>
</head>
<body>
    <div class="search-container">
        <div class="input-wrapper">
            <input type="text" id="search-input" class="search-input" placeholder="検索キーワードを入力（Enterで検索）..." />
            <button id="whole-word-toggle" class="toggle-button" title="単語全体に一致 (Match Whole Word)">
                <svg width="14" height="14" viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg">
                    <rect x="1.5" y="2.5" width="13" height="11" rx="1.5" stroke="currentColor" stroke-width="1.2"/>
                    <text x="3" y="11" font-family="monospace" font-size="8" font-weight="bold" fill="currentColor">ab</text>
                </svg>
            </button>
        </div>
    </div>
    
    <div id="results-container">
        <div class="info-text">キーワードを入力して検索してください。</div>
    </div>

    <script nonce="${nonce}">
        const vscode = acquireVsCodeApi();
        const searchInput = document.getElementById('search-input');
        const wholeWordToggle = document.getElementById('whole-word-toggle');
        const resultsContainer = document.getElementById('results-container');
        let matchWholeWord = false;

        // 前回の状態を復元
        const previousState = vscode.getState();
        if (previousState) {
            if (previousState.query) {
                searchInput.value = previousState.query;
            }
            if (previousState.matchWholeWord) {
                matchWholeWord = previousState.matchWholeWord;
                wholeWordToggle.classList.toggle('active', matchWholeWord);
            }
            if (previousState.html) {
                resultsContainer.innerHTML = previousState.html;
            }
        }

        function triggerSearch() {
            const query = searchInput.value.trim();
            if (query) {
                resultsContainer.innerHTML = '<div class="info-text">分析中...</div>';
                vscode.postMessage({ 
                    type: 'search', 
                    query: query,
                    matchWholeWord: matchWholeWord
                });
            }
        }

        searchInput.addEventListener('keydown', (e) => {
            if (e.key === 'Enter') {
                triggerSearch();
            }
        });

        wholeWordToggle.addEventListener('click', () => {
            matchWholeWord = !matchWholeWord;
            wholeWordToggle.classList.toggle('active', matchWholeWord);
            saveState();
            triggerSearch();
        });

        // 拡張機能本体からのデータ受取
        window.addEventListener('message', event => {
            const message = event.data;
            if (message.type === 'results') {
                renderResults(message.matches, message.query);
            }
        });

        // アコーディオンの展開・折りたたみ
        function toggleCategory(id) {
            const items = document.getElementById(id);
            if (items) {
                items.classList.toggle('expanded');
                // 矢印の向きを切り替える
                const header = items.previousElementSibling;
                if (header) {
                    const arrow = header.querySelector('.arrow');
                    if (arrow) {
                        arrow.textContent = items.classList.contains('expanded') ? '▼' : '▶';
                    }
                }
                // 状態を維持するためにHTML全体をステートに記録
                saveState();
            }
        }

        // 一致箇所クリック時の処理
        function openFile(fileUriStr, line, charStart, charEnd) {
            vscode.postMessage({
                type: 'openFile',
                fileUriStr: fileUriStr,
                line: line,
                charStart: charStart,
                charEnd: charEnd
            });
        }

        // イベントデリゲーションによるクリックの検知と処理
        resultsContainer.addEventListener('click', (e) => {
            const target = e.target.closest('[data-action]');
            if (!target) {
                return;
            }

            const action = target.getAttribute('data-action');
            if (action === 'toggle') {
                const targetId = target.getAttribute('data-target');
                toggleCategory(targetId);
            } else if (action === 'open') {
                const uriStr = target.getAttribute('data-uri');
                const line = parseInt(target.getAttribute('data-line'), 10);
                const charStart = parseInt(target.getAttribute('data-start'), 10);
                const charEnd = parseInt(target.getAttribute('data-end'), 10);
                openFile(uriStr, line, charStart, charEnd);
            }
        });

        // ステートの保存
        function saveState() {
            vscode.setState({
                query: searchInput.value.trim(),
                matchWholeWord: matchWholeWord,
                html: resultsContainer.innerHTML
            });
        }

        // 検索結果のHTML生成と描画
        function renderResults(matches, query) {
            if (!matches || matches.length === 0) {
                resultsContainer.innerHTML = '<div class="info-text">一致する箇所が見つかりませんでした。</div>';
                saveState();
                return;
            }

            const cats = {
                '入力': { class: 'cat-input', list: [] },
                '出力': { class: 'cat-output', list: [] },
                '定義': { class: 'cat-def', list: [] },
                'コメント': { class: 'cat-comment', list: [] },
                'その他': { class: 'cat-other', list: [] }
            };

            matches.forEach(m => {
                if (cats[m.category]) {
                    cats[m.category].list.push(m);
                }
            });

            let html = '';
            let catIndex = 0;
            
            for (const catName in cats) {
                const cat = cats[catName];
                const count = cat.list.length;
                if (count === 0) continue;

                const catListId = 'cat-items-' + catIndex;
                html += \`
                <div class="category-container \${cat.class}">
                    <div class="category-header" data-action="toggle" data-target="\${catListId}">
                        <div class="category-title">
                            <span>\${catName}</span>
                            <span class="category-count">\${count}</span>
                        </div>
                        <span class="arrow">▶</span>
                    </div>
                    <div id="\${catListId}" class="category-items">
                \`;

                // ファイルごとにグループ化
                const filesGroup = {};
                cat.list.forEach(m => {
                    const uriStr = m.fileUriStr;
                    if (!filesGroup[uriStr]) {
                        const decodedUri = decodeURIComponent(uriStr);
                        const fileName = decodedUri.substring(decodedUri.lastIndexOf('/') + 1);
                        filesGroup[uriStr] = {
                            fileName: fileName,
                            matches: []
                        };
                    }
                    filesGroup[uriStr].matches.push(m);
                });

                // ファイル名でソートした配列を作成
                const sortedFiles = Object.keys(filesGroup).map(uriStr => ({
                    uriStr: uriStr,
                    fileName: filesGroup[uriStr].fileName,
                    matches: filesGroup[uriStr].matches
                })).sort((a, b) => a.fileName.localeCompare(b.fileName));

                let fileIndex = 0;
                sortedFiles.forEach(fileGroup => {
                    const uriStr = fileGroup.uriStr;
                    const fileCount = fileGroup.matches.length;
                    const fileListId = \`\${catListId}-file-\${fileIndex}\`;
                    
                    html += \`
                        <div class="file-container">
                            <div class="file-header" data-action="toggle" data-target="\${fileListId}">
                                <div class="file-title">
                                    <span class="arrow">▼</span>
                                    <span class="file-name">\${fileGroup.fileName}</span>
                                </div>
                                <span class="file-count">\${fileCount}</span>
                            </div>
                            <div id="\${fileListId}" class="file-items expanded">
                    \`;

                    // 一致箇所を行番号順にソート
                    fileGroup.matches.sort((a, b) => a.line - b.line);

                    fileGroup.matches.forEach(m => {
                        const codeSnippet = m.content.trim();
                        html += \`
                                <div class="match-item" data-action="open" data-uri="\${uriStr}" data-line="\${m.line}" data-start="\${m.charStart}" data-end="\${m.charEnd}">
                                    <span class="match-line-number">\${m.line + 1}</span>
                                    <span class="match-code">\${escapeHtml(codeSnippet)}</span>
                                </div>
                        \`;
                    });

                    html += \`
                            </div>
                        </div>
                    \`;
                    fileIndex++;
                });

                html += \`
                    </div>
                </div>
                \`;
                catIndex++;
            }

            resultsContainer.innerHTML = html;
            saveState();
        }

        // HTML特殊文字のエスケープ
        function escapeHtml(str) {
            return str
                .replace(/&/g, "&amp;")
                .replace(/</g, "&lt;")
                .replace(/>/g, "&gt;")
                .replace(/"/g, "&quot;")
                .replace(/'/g, "&#039;");
        }
    </script>
</body>
</html>`;
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

    // 検索コマンドの登録（ショートカット押下時にサイドバーをフォーカス）
    const searchCommand = vscode.commands.registerCommand('c-grep-classifier.search', async () => {
        await vscode.commands.executeCommand('cGrepClassifierView.focus');
    });

    context.subscriptions.push(searchCommand, searchHighlightDecorationType);
}

export function deactivate() {}
