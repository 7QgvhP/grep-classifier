import Parser from 'web-tree-sitter';
import { ClassificationResult } from './types';

/**
 * 具体的な文脈が特定できなかった参照（二項演算など）を表すサブ分類。
 * この値になった場合は、より上位に具体的な文脈がないか改めて探索する。
 */
const INPUT_GENERIC = '参照';

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
 * ノードが配列添字（`subscript_expression` の index 部分）の内側にあるかを判定する。
 * `arr[hoge] = 0;` の `hoge` は書き込み対象ではなく、添字として読まれているため、
 * 代入の左辺に含まれていても「出力」ではなく「入力」として扱う必要がある。
 * @param left 判定範囲の上限となるノード（代入式の左辺）
 */
function isInsideSubscriptIndex(node: Parser.SyntaxNode, left: Parser.SyntaxNode): boolean {
    let current: Parser.SyntaxNode | null = node;
    while (current && isDescendantOf(current, left)) {
        const parent: Parser.SyntaxNode | null = current.parent;
        if (!parent) {
            return false;
        }
        if (parent.type === 'subscript_expression') {
            const index = parent.childForFieldName('index');
            if (index && isDescendantOf(node, index)) {
                return true;
            }
        }
        if (!isDescendantOf(parent, left)) {
            return false;
        }
        current = parent;
    }
    return false;
}

/**
 * 出力（書き込み）の判定。
 * 最も優先度が高く、代入の左辺・インクリメント・アドレス取得が該当する。
 * 該当しない場合は null を返し、後続の判定へ委ねる。
 */
function checkOutput(node: Parser.SyntaxNode, parent: Parser.SyntaxNode): ClassificationResult | null {
    // 代入式の左辺（複合代入も含む）。ただし添字として読まれている場合は除く
    if (parent.type === 'assignment_expression') {
        const left = parent.childForFieldName('left');
        if (left && isDescendantOf(node, left) && !isInsideSubscriptIndex(node, left)) {
            return { category: '出力', detail: '代入' };
        }
    }
    // インクリメント／デクリメント（前置・後置の両方）
    if (parent.type === 'update_expression') {
        return { category: '出力', detail: 'インクリメント' };
    }
    // アドレス取得演算子（&hoge）。ポインタのデリファレンス（*ptr）は対象外
    if (parent.type === 'pointer_expression') {
        const operator = parent.child(0);
        if (operator && operator.text === '&') {
            return { category: '出力', detail: 'アドレス渡し' };
        }
    }
    return null;
}

/**
 * 入力のうち、具体的な文脈（条件判定・代入の右辺など）を判定する。
 * 二項演算のような汎用的な一致はここには含めない。
 */
function inputContextOf(node: Parser.SyntaxNode, parent: Parser.SyntaxNode): string | null {
    // 代入式の右辺
    if (parent.type === 'assignment_expression') {
        const right = parent.childForFieldName('right');
        if (right && isDescendantOf(node, right)) {
            return '代入の右辺';
        }
    }
    // 変数宣言の初期化値部分
    if (parent.type === 'init_declarator') {
        const value = parent.childForFieldName('value');
        if (value && isDescendantOf(node, value)) {
            return '初期化値';
        }
    }
    // 制御構文の条件式
    if (parent.type === 'if_statement' || parent.type === 'while_statement' || parent.type === 'for_statement') {
        const condition = parent.childForFieldName('condition');
        if (condition && isDescendantOf(node, condition)) {
            return '条件判定';
        }
    }
    // 関数呼び出しの引数
    if (parent.type === 'argument_list') {
        return '関数引数';
    }
    // return による値の返却
    if (parent.type === 'return_statement') {
        return '戻り値';
    }
    // switch の評価対象および case のラベル値
    if (parent.type === 'switch_statement' || parent.type === 'case_statement') {
        return '条件判定';
    }
    return null;
}

/**
 * 入力（読み取り・参照）の判定。
 * 出力に該当しなかったノードに対して評価される。
 */
function checkInput(node: Parser.SyntaxNode, parent: Parser.SyntaxNode): ClassificationResult | null {
    const detail = inputContextOf(node, parent);
    if (detail) {
        return { category: '入力', detail };
    }
    // 代入の左辺に含まれていても、配列添字として読まれている場合は書き込みではなく参照
    if (parent.type === 'assignment_expression') {
        const left = parent.childForFieldName('left');
        if (left && isDescendantOf(node, left) && isInsideSubscriptIndex(node, left)) {
            return { category: '入力', detail: INPUT_GENERIC };
        }
    }
    // 二項演算での参照。文脈は後段で改めて特定する
    if (parent.type === 'binary_expression') {
        return { category: '入力', detail: INPUT_GENERIC };
    }
    return null;
}

/**
 * 祖先ノードを辿り、具体的な入力文脈を探す。
 * `if (hoge > 0)` のように二項演算が先に合致してしまう場合に、
 * より外側の文脈（条件判定など）を採用するために使用する。
 */
function findInputContext(node: Parser.SyntaxNode): string | undefined {
    let current: Parser.SyntaxNode | null = node;
    while (current) {
        const parent: Parser.SyntaxNode | null = current.parent;
        if (!parent) {
            break;
        }
        const detail = inputContextOf(node, parent);
        if (detail) {
            return detail;
        }
        current = parent;
    }
    return undefined;
}

/**
 * 定義（宣言・定義）の判定。
 * 出力にも入力にも該当しなかったノードに対して評価される。
 */
function checkDefinition(node: Parser.SyntaxNode, parent: Parser.SyntaxNode): ClassificationResult | null {
    // typedef の宣言子
    if (parent.type === 'type_definition') {
        const declarator = parent.childForFieldName('declarator');
        if (declarator && isDescendantOf(node, declarator)) {
            return { category: '定義', detail: '型定義' };
        }
    }
    // enum の定数メンバー
    if (parent.type === 'enumerator') {
        return { category: '定義', detail: 'enum定数' };
    }
    // 関数マクロのパラメータ
    if (parent.type === 'preproc_params') {
        return { category: '定義', detail: 'マクロ引数' };
    }
    // 変数宣言・関数パラメータ宣言（型名部分に含まれる場合は除外）
    if (parent.type === 'declaration' || parent.type === 'parameter_declaration') {
        const typeNode = parent.childForFieldName('type');
        if (!(typeNode && isDescendantOf(node, typeNode))) {
            return {
                category: '定義',
                detail: parent.type === 'parameter_declaration' ? '関数引数' : '変数宣言'
            };
        }
    }
    // 初期化宣言子の宣言部分
    if (parent.type === 'init_declarator') {
        const declarator = parent.childForFieldName('declarator');
        if (declarator && isDescendantOf(node, declarator)) {
            return { category: '定義', detail: '変数宣言' };
        }
    }
    // 前置マクロ等によるパース失敗（ERRORノード）配下の宣言を救済
    if (parent.type === 'ERROR' && parent.parent && parent.parent.type === 'declaration') {
        return { category: '定義', detail: '変数宣言' };
    }
    // ファイルスコープに式文は存在し得ないため、宣言の解釈失敗とみなして救済する。
    // 例: union の本体付き定義や typedef union のあとに現れる `GLOBAL BYTE hoge;` は、
    //     tree-sitter が declaration ではなく expression_statement として解釈することがある。
    //     インクルードガードや #ifdef で囲まれている場合も対象とするため、
    //     親が translation_unit かどうかではなく「関数の外か」で判定する
    if (parent.type === 'expression_statement' && isAtFileScope(parent)) {
        return { category: '定義', detail: '変数宣言' };
    }
    // 関数定義の宣言子（関数名）
    if (parent.type === 'function_definition') {
        const declarator = parent.childForFieldName('declarator');
        if (declarator && isDescendantOf(node, declarator)) {
            return { category: '定義', detail: '関数定義' };
        }
    }
    // マクロ定義名
    if (parent.type === 'preproc_def' || parent.type === 'preproc_function_def') {
        const nameNode = parent.childForFieldName('name');
        if (nameNode && nameNode.text === node.text) {
            return { category: '定義', detail: 'マクロ定義' };
        }
    }
    // 構造体・共用体・列挙型のタグ名
    if (parent.type === 'struct_specifier' || parent.type === 'union_specifier' || parent.type === 'enum_specifier') {
        const nameNode = parent.childForFieldName('name');
        if (nameNode && nameNode.text === node.text) {
            return { category: '定義', detail: 'タグ名' };
        }
    }
    // 構造体・共用体のメンバー宣言
    if (parent.type === 'field_declaration') {
        return { category: '定義', detail: '構造体メンバ' };
    }
    return null;
}

/**
 * 識別子ノードのコンテキスト（祖先ノードの関係性）からデータフロー分類を行う。
 * 祖先ノードを下から上へ辿り、「出力 → 入力 → 定義」の優先順位で
 * 最初に合致したパターンを採用する。どれにも合致しない場合は「その他」。
 */
export function classifyIdentifier(node: Parser.SyntaxNode): ClassificationResult {
    let current: Parser.SyntaxNode | null = node;

    while (current) {
        const parent: Parser.SyntaxNode | null = current.parent;
        if (!parent) {
            break;
        }

        const result =
            checkOutput(node, parent) ??
            checkInput(node, parent) ??
            checkDefinition(node, parent);

        if (result) {
            // 汎用的な参照と判定された場合、より外側に具体的な文脈があればそちらを採用する
            if (result.category === '入力' && result.detail === INPUT_GENERIC) {
                const context = findInputContext(node);
                if (context) {
                    return { category: '入力', detail: context };
                }
            }
            return result;
        }

        current = parent;
    }

    return { category: 'その他', detail: '' };
}
