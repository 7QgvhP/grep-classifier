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

// ツリービューで表示するカスタムツリーアイテム
class GrepTreeItem extends vscode.TreeItem {
    constructor(
        public readonly label: string,
        public readonly collapsibleState: vscode.TreeItemCollapsibleState,
        public readonly contextValue: string,
        public readonly match?: GrepMatch
    ) {
        super(label, collapsibleState);
        if (match) {
            this.tooltip = match.content.trim();
            this.description = path.basename(match.fileUri.fsPath);
            // アイテムクリック時に該当箇所を選択して開くコマンドを設定
            this.command = {
                command: 'c-grep-classifier.openFile',
                title: 'ファイルを開く',
                arguments: [match.fileUri, match.line, match.charStart, match.charEnd]
            };
        }
    }
}

// ツリービューにデータを提供するデータプロバイダー
class GrepResultProvider implements vscode.TreeDataProvider<GrepTreeItem> {
    private _onDidChangeTreeData: vscode.EventEmitter<GrepTreeItem | undefined | null | void> = new vscode.EventEmitter<GrepTreeItem | undefined | null | void>();
    readonly onDidChangeTreeData: vscode.Event<GrepTreeItem | undefined | null | void> = this._onDidChangeTreeData.event;

    // カテゴリごとの検索結果
    private categories: Record<DataFlowCategory, GrepMatch[]> = {
        '入力': [],
        '出力': [],
        '定義': [],
        'コメント': [],
        'その他': []
    };

    // 検索結果の更新
    refresh(matches: GrepMatch[]): void {
        this.categories = {
            '入力': [],
            '出力': [],
            '定義': [],
            'コメント': [],
            'その他': []
        };
        for (const m of matches) {
            this.categories[m.category].push(m);
        }
        this._onDidChangeTreeData.fire();
    }

    getTreeItem(element: GrepTreeItem): vscode.TreeItem {
        return element;
    }

    getChildren(element?: GrepTreeItem): Thenable<GrepTreeItem[]> {
        if (!element) {
            // ルート階層：各カテゴリの件数を表示
            const items = (Object.keys(this.categories) as DataFlowCategory[]).map(cat => {
                const count = this.categories[cat].length;
                return new GrepTreeItem(`${cat} (${count}件)`, vscode.TreeItemCollapsibleState.Collapsed, 'category');
            });
            return Promise.resolve(items);
        } else if (element.contextValue === 'category') {
            // カテゴリ階層：一致箇所のファイル名と行番号を表示
            const catName = element.label.split(' (')[0] as DataFlowCategory;
            const matches = this.categories[catName] || [];
            const items = matches.map(m => {
                const fileName = path.basename(m.fileUri.fsPath);
                const label = `${fileName}:${m.line + 1} - ${m.content.trim()}`;
                return new GrepTreeItem(label, vscode.TreeItemCollapsibleState.None, 'match', m);
            });
            return Promise.resolve(items);
        }
        return Promise.resolve([]);
    }
}

// ASTの各ノードから検索クエリに一致する識別子やコメント等を抽出し、データフロー分類を行う
function findMatchesInTree(
    node: Parser.SyntaxNode,
    query: string,
    fileUri: vscode.Uri,
    lines: string[]
): GrepMatch[] {
    const matches: GrepMatch[] = [];

    function traverse(currentNode: Parser.SyntaxNode) {
        // コメントノード内のテキスト部分一致
        if (currentNode.type === 'comment') {
            if (currentNode.text.includes(query)) {
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

        // 識別子ノードの部分一致
        if (currentNode.type === 'identifier') {
            if (currentNode.text.includes(query)) {
                const category = classifyIdentifier(currentNode, currentNode.text);
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

        // 文字列リテラル内のテキスト部分一致 (入力として扱う)
        if (currentNode.type === 'string_literal') {
            if (currentNode.text.includes(query)) {
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

// 識別子ノードのコンテキスト（祖先ノードの関係性）からデータフロー分類を行う
function classifyIdentifier(node: Parser.SyntaxNode, identifierText: string): DataFlowCategory {
    let current: Parser.SyntaxNode | null = node;

    while (current) {
        const parent: Parser.SyntaxNode | null = current.parent;
        if (!parent) {
            break;
        }

        // 1. 定義 (Definition) の判定
        // 変数宣言、初期化宣言、引数宣言
        if (parent.type === 'declaration' || parent.type === 'init_declarator' || parent.type === 'parameter_declaration') {
            const declarator = parent.childForFieldName('declarator');
            if (declarator && declarator.text.includes(identifierText)) {
                return '定義';
            }
        }
        // 関数定義の関数名部分
        if (parent.type === 'function_definition') {
            const declarator = parent.childForFieldName('declarator');
            if (declarator && declarator.text.includes(identifierText)) {
                return '定義';
            }
        }
        // マクロ定義の名前
        if (parent.type === 'preproc_def' || parent.type === 'preproc_function_def') {
            const nameNode = parent.childForFieldName('name');
            if (nameNode && nameNode.text === identifierText) {
                return '定義';
            }
        }
        // 構造体・共用体・列挙型の定義およびフィールド宣言
        if (parent.type === 'struct_specifier' || parent.type === 'union_specifier' || parent.type === 'enum_specifier') {
            const nameNode = parent.childForFieldName('name');
            if (nameNode && nameNode.text === identifierText) {
                return '定義';
            }
        }
        if (parent.type === 'field_declaration') {
            return '定義';
        }

        // 2. 出力 (Output - 書き込み) の判定
        // 代入式の左辺 (例: hoge = 1, hoge[0] = 1, hoge.val = 1 など)
        if (parent.type === 'assignment_expression') {
            const left = parent.childForFieldName('left');
            if (left && left.text.includes(identifierText)) {
                return '出力';
            }
        }
        // インクリメント/デクリメント (例: hoge++, --hoge)
        if (parent.type === 'update_expression') {
            return '出力';
        }
        // アドレス参照 (例: &hoge)
        if (parent.type === 'pointer_expression') {
            const operator = parent.child(0);
            if (operator && operator.text === '&') {
                return '出力';
            }
        }

        // 3. 入力 (Input - 参照) の判定
        // 代入式の右辺
        if (parent.type === 'assignment_expression') {
            const right = parent.childForFieldName('right');
            if (right && right.text.includes(identifierText)) {
                return '入力';
            }
        }
        // 条件文、ループの条件式 (例: if (hoge), while (hoge))
        if (parent.type === 'if_statement' || parent.type === 'while_statement' || parent.type === 'for_statement') {
            const condition = parent.childForFieldName('condition');
            if (condition && condition.text.includes(identifierText)) {
                return '入力';
            }
        }
        // その他一般的な式の中での参照 (二項演算、リターン文、関数の実引数など)
        if (
            [
                'binary_expression',
                'return_statement',
                'switch_statement',
                'case_statement',
                'argument_list'
            ].includes(parent.type)
        ) {
            return '入力';
        }

        // 次の祖先へ
        current = parent;
    }

    return 'その他';
}

// 拡張機能のアクティベート処理
export async function activate(context: vscode.ExtensionContext) {
    const provider = new GrepResultProvider();
    vscode.window.registerTreeDataProvider('cGrepClassifierView', provider);

    // web-tree-sitterの初期化とC言語パーサーのロード
    let parser: Parser;
    try {
        await Parser.init({
            locateFile(scriptName: string) {
                return path.join(context.extensionPath, 'bin', scriptName);
            }
        });
        const cLangWasmPath = path.join(context.extensionPath, 'bin', 'tree-sitter-c.wasm');
        const cLang = await Parser.Language.load(cLangWasmPath);
        parser = new Parser();
        parser.setLanguage(cLang);
    } catch (err) {
        vscode.window.showErrorMessage(`Parserの初期化に失敗しました。WASMファイルが正しく配置されているか確認してください: ${err}`);
        return;
    }

    // 検索分類コマンドの登録
    const searchCommand = vscode.commands.registerCommand('c-grep-classifier.search', async () => {
        const query = await vscode.window.showInputBox({
            prompt: 'データフロー分類するキーワード（変数名など）を入力してください',
            placeHolder: '例: hoge'
        });

        if (!query) {
            return;
        }

        const workspaceFolders = vscode.workspace.workspaceFolders;
        if (!workspaceFolders) {
            vscode.window.showInformationMessage('ワークスペースが開かれていません。');
            return;
        }

        vscode.window.withProgress({
            location: vscode.ProgressLocation.Notification,
            title: "C言語ファイルを分析中...",
            cancellable: false
        }, async () => {
            const files = await vscode.workspace.findFiles('**/*.{c,h}', '**/node_modules/**');
            const allMatches: GrepMatch[] = [];

            for (const file of files) {
                try {
                    const content = fs.readFileSync(file.fsPath, 'utf-8');
                    // 1. パフォーマンス最適化のため、まずは高速テキスト検索でキーワードが含まれるかチェック
                    if (!content.includes(query)) {
                        continue;
                    }

                    // 2. キーワードが含まれるファイルのみ Tree-sitter でパース
                    const tree = parser.parse(content);
                    const lines = content.split(/\r?\n/);
                    const fileMatches = findMatchesInTree(tree.rootNode, query, file, lines);
                    allMatches.push(...fileMatches);
                } catch (err) {
                    console.error(`ファイルの解析に失敗しました: ${file.fsPath}`, err);
                }
            }

            // 結果を表示
            provider.refresh(allMatches);
            vscode.window.showInformationMessage(`分析完了: ${allMatches.length} 件の一致が見つかりました。`);
        });
    });

    // ファイルを開き、該当キーワード部分を選択状態にするコマンド
    const openFileCommand = vscode.commands.registerCommand(
        'c-grep-classifier.openFile',
        async (uri: vscode.Uri, line: number, charStart: number, charEnd: number) => {
            const doc = await vscode.workspace.openTextDocument(uri);
            const editor = await vscode.window.showTextDocument(doc);
            
            // 該当箇所の選択範囲を設定してスクロール
            const startPos = new vscode.Position(line, charStart);
            const endPos = new vscode.Position(line, charEnd);
            editor.selection = new vscode.Selection(startPos, endPos);
            editor.revealRange(editor.selection, vscode.TextEditorRevealType.InCenter);
        }
    );

    context.subscriptions.push(searchCommand, openFileCommand);
}

export function deactivate() {}
