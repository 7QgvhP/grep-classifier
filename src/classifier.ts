import Parser from 'web-tree-sitter';
import { DataFlowCategory } from './types';

// ノードが対象ノード（親ノードなど）の物理的配下にあるかを判定する
function isDescendantOf(node: Parser.SyntaxNode, target: Parser.SyntaxNode): boolean {
    return target.startIndex <= node.startIndex && node.endIndex <= target.endIndex;
}

/**
 * ノードがファイルスコープ（関数の外）に位置するかを判定する。
 * 祖先に関数本体が現れなければファイルスコープとみなすため、
 * インクルードガードや `#ifdef` で囲まれていても正しく判定できる。
 */
function isAtFileScope(node: Parser.SyntaxNode): boolean {
    let current: Parser.SyntaxNode | null = node.parent;
    while (current) {
        if (current.type === 'compound_statement' || current.type === 'function_definition') {
            return false;
        }
        current = current.parent;
    }
    return true;
}

/**
 * 出力（書き込み）の判定。
 * 最も優先度が高く、代入の左辺・インクリメント・アドレス取得が該当する。
 * 該当しない場合は null を返し、後続の判定へ委ねる。
 */
function checkOutput(node: Parser.SyntaxNode, parent: Parser.SyntaxNode): DataFlowCategory | null {
    // 代入式の左辺（複合代入も含む）
    if (parent.type === 'assignment_expression') {
        const left = parent.childForFieldName('left');
        if (left && isDescendantOf(node, left)) {
            return '出力';
        }
    }
    // インクリメント／デクリメント（前置・後置の両方）
    if (parent.type === 'update_expression') {
        return '出力';
    }
    // アドレス取得演算子（&hoge）。ポインタのデリファレンス（*ptr）は対象外
    if (parent.type === 'pointer_expression') {
        const operator = parent.child(0);
        if (operator && operator.text === '&') {
            return '出力';
        }
    }
    return null;
}

/**
 * 入力（読み取り・参照）の判定。
 * 出力に該当しなかったノードに対して評価される。
 */
function checkInput(node: Parser.SyntaxNode, parent: Parser.SyntaxNode): DataFlowCategory | null {
    // 代入式の右辺
    if (parent.type === 'assignment_expression') {
        const right = parent.childForFieldName('right');
        if (right && isDescendantOf(node, right)) {
            return '入力';
        }
    }
    // 変数宣言の初期化値部分
    if (parent.type === 'init_declarator') {
        const value = parent.childForFieldName('value');
        if (value && isDescendantOf(node, value)) {
            return '入力';
        }
    }
    // 制御構文の条件式
    if (parent.type === 'if_statement' || parent.type === 'while_statement' || parent.type === 'for_statement') {
        const condition = parent.childForFieldName('condition');
        if (condition && isDescendantOf(node, condition)) {
            return '入力';
        }
    }
    // 関数呼び出しの引数
    if (parent.type === 'argument_list') {
        return '入力';
    }
    // 二項演算・return・switch/case
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
    return null;
}

/**
 * 定義（宣言・定義）の判定。
 * 出力にも入力にも該当しなかったノードに対して評価される。
 */
function checkDefinition(node: Parser.SyntaxNode, parent: Parser.SyntaxNode): DataFlowCategory | null {
    // typedef の宣言子
    if (parent.type === 'type_definition') {
        const declarator = parent.childForFieldName('declarator');
        if (declarator && isDescendantOf(node, declarator)) {
            return '定義';
        }
    }
    // enum の定数メンバー
    if (parent.type === 'enumerator') {
        return '定義';
    }
    // 関数マクロのパラメータ
    if (parent.type === 'preproc_params') {
        return '定義';
    }
    // 変数宣言・関数パラメータ宣言（型名部分に含まれる場合は除外）
    if (parent.type === 'declaration' || parent.type === 'parameter_declaration') {
        const typeNode = parent.childForFieldName('type');
        if (!(typeNode && isDescendantOf(node, typeNode))) {
            return '定義';
        }
    }
    // 初期化宣言子の宣言部分
    if (parent.type === 'init_declarator') {
        const declarator = parent.childForFieldName('declarator');
        if (declarator && isDescendantOf(node, declarator)) {
            return '定義';
        }
    }
    // 前置マクロ等によるパース失敗（ERRORノード）配下の宣言を救済
    if (parent.type === 'ERROR' && parent.parent && parent.parent.type === 'declaration') {
        return '定義';
    }
    // ファイルスコープに式文は存在し得ないため、宣言の解釈失敗とみなして救済する。
    // 例: union の本体付き定義や typedef union のあとに現れる `GLOBAL BYTE hoge;` は、
    //     tree-sitter が declaration ではなく expression_statement として解釈することがある。
    //     インクルードガードや #ifdef で囲まれている場合も対象とするため、
    //     親が translation_unit かどうかではなく「関数の外か」で判定する
    if (parent.type === 'expression_statement' && isAtFileScope(parent)) {
        return '定義';
    }
    // 関数定義の宣言子（関数名）
    if (parent.type === 'function_definition') {
        const declarator = parent.childForFieldName('declarator');
        if (declarator && isDescendantOf(node, declarator)) {
            return '定義';
        }
    }
    // マクロ定義名
    if (parent.type === 'preproc_def' || parent.type === 'preproc_function_def') {
        const nameNode = parent.childForFieldName('name');
        if (nameNode && nameNode.text === node.text) {
            return '定義';
        }
    }
    // 構造体・共用体・列挙型のタグ名
    if (parent.type === 'struct_specifier' || parent.type === 'union_specifier' || parent.type === 'enum_specifier') {
        const nameNode = parent.childForFieldName('name');
        if (nameNode && nameNode.text === node.text) {
            return '定義';
        }
    }
    // 構造体・共用体のメンバー宣言
    if (parent.type === 'field_declaration') {
        return '定義';
    }
    return null;
}

/**
 * 識別子ノードのコンテキスト（祖先ノードの関係性）からデータフロー分類を行う。
 * 祖先ノードを下から上へ辿り、「出力 → 入力 → 定義」の優先順位で
 * 最初に合致したパターンを採用する。どれにも合致しない場合は「その他」。
 */
export function classifyIdentifier(node: Parser.SyntaxNode): DataFlowCategory {
    let current: Parser.SyntaxNode | null = node;

    while (current) {
        const parent: Parser.SyntaxNode | null = current.parent;
        if (!parent) {
            break;
        }

        const category =
            checkOutput(node, parent) ??
            checkInput(node, parent) ??
            checkDefinition(node, parent);

        if (category) {
            return category;
        }

        current = parent;
    }

    return 'その他';
}
