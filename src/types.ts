import * as vscode from 'vscode';

/**
 * 分類カテゴリの定義（表示順・配色クラスを一元管理）
 * ここが唯一の定義元であり、Webview 側へは HTML 生成時に JSON として注入される。
 */
export const CATEGORIES = [
    { name: '入力', cssClass: 'cat-input' },
    { name: '出力', cssClass: 'cat-output' },
    { name: '定義', cssClass: 'cat-def' },
    { name: 'コメント', cssClass: 'cat-comment' },
    { name: 'その他', cssClass: 'cat-other' }
] as const;

// 分類カテゴリ名の型（CATEGORIES から導出）
export type DataFlowCategory = typeof CATEGORIES[number]['name'];

/**
 * サブ分類（詳細分類）の一覧と表示順。
 * キーワードが「どの文脈で使われているか」を表す。
 * コメント・その他はサブ分類を持たない。
 */
export const DETAILS: Record<DataFlowCategory, readonly string[]> = {
    '入力': ['条件判定', '代入の右辺', '初期化値', '関数引数', '戻り値', '参照', '文字列'],
    '出力': ['代入', 'インクリメント', 'アドレス渡し'],
    '定義': ['変数宣言', '関数引数', '関数定義', '型定義', '構造体メンバ', 'マクロ定義', 'マクロ引数', 'enum定数', 'タグ名'],
    'コメント': [],
    'その他': []
};

// 分類結果（大分類とサブ分類の組）
export interface ClassificationResult {
    category: DataFlowCategory;
    detail: string; // サブ分類名。持たない場合は空文字
}

// 検索キーワードの一致情報を表すインターフェース
export interface GrepMatch {
    fileUri: vscode.Uri;
    line: number;
    charStart: number;
    charEnd: number;
    content: string; // 該当行のテキスト
    category: DataFlowCategory;
    detail: string; // サブ分類名（コメント・その他は空文字）
    functionName?: string; // 一致箇所が属する関数名（関数外の場合は未設定）
}

// Webviewに受け渡すためのシリアライズ可能な一致情報（fileUri のみ文字列に置換）
export type GrepMatchSerializable = Omit<GrepMatch, 'fileUri'> & { fileUriStr: string };
