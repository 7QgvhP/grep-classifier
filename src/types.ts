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

// 検索キーワードの一致情報を表すインターフェース
export interface GrepMatch {
    fileUri: vscode.Uri;
    line: number;
    charStart: number;
    charEnd: number;
    content: string; // 該当行のテキスト
    category: DataFlowCategory;
    functionName?: string; // 一致箇所が属する関数名（関数外の場合は未設定）
}

// Webviewに受け渡すためのシリアライズ可能な一致情報（fileUri のみ文字列に置換）
export type GrepMatchSerializable = Omit<GrepMatch, 'fileUri'> & { fileUriStr: string };
