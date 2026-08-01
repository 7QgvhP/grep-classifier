# C-Grep Classifier データフロー分類 技術仕様書

本ドキュメントは、C-Grep Classifier 拡張機能が検索キーワードの出現箇所をどのようにデータフロー分類しているかを詳細に説明します。

---

## 概要

本拡張機能は、C言語ソースファイル（`.c`, `.h`）に対して [tree-sitter](https://tree-sitter.github.io/tree-sitter/) による構文解析（AST: 抽象構文木）を実行し、検索キーワードが出現する各箇所を以下の **5つのカテゴリ** に分類します。

| カテゴリ | 意味 | 色 |
|---|---|---|
| **入力** | 値が読み取られている箇所（参照） | 🔵 青 |
| **出力** | 値が書き込まれている箇所（代入） | 🔴 赤 |
| **定義** | 変数・関数・型などが宣言・定義されている箇所 | 🟢 緑 |
| **コメント** | コメント内に出現している箇所 | ⚪ 灰 |
| **その他** | 上記のいずれにも該当しない箇所 | 🟠 橙 |

---

## 分類の全体フロー

```mermaid
flowchart TD
    A["ファイル本文をテキスト検索し\n全出現位置を列挙（grepと同一）"] --> B["各出現位置について\ndescendantForIndex でASTノードを特定"]
    B --> C{"ノードの種類は？"}
    C -->|"comment"| D["🗨️ コメント として分類"]
    C -->|"string_literal / char_literal\nsystem_lib_string など"| E["📥 入力 として分類"]
    C -->|"上記以外すべて"| F["classifyIdentifier で分類"]
    F --> G{"祖先ノードを\n下から上へ走査"}
    G -->|"出力パターンに合致"| H["📤 出力"]
    G -->|"入力パターンに合致"| I["📥 入力"]
    G -->|"定義パターンに合致"| J["📝 定義"]
    G -->|"どれにも合致せず\nルートに到達"| K["❓ その他"]
```

> [!IMPORTANT]
> 分類の優先順位は **出力 → 入力 → 定義 → その他** の順です。祖先ノードを下から上へ辿り、最初に合致したパターンで分類が確定します。

---

## フェーズ1: 出現位置の列挙

検索対象の特定は **テキスト起点** で行います。まずファイル本文に対して純粋なテキスト検索を行い、キーワードの出現位置をすべて列挙します。

- **部分一致モード**: `indexOf` による走査
- **単語全体一致モード**: 単語境界 `\b` で囲んだ正規表現による走査

> [!IMPORTANT]
> この処理は VS Code 標準の検索（grep）と同一です。そのため **検索結果の件数は標準検索のヒット件数と必ず一致します**。分類できない箇所が結果から消えることはなく、「その他」に分類されます。

### 位置からASTノードへの変換

列挙した各出現位置について、`descendantForIndex()` により **その位置を含む最小のASTノード** を特定し、フェーズ2の分類に渡します。

```c
int temp = hoge_array[0];
//         ^^^^                    位置を列挙
//         └→ identifier "hoge_array" を特定 → 分類へ
```

### ノード種別による確定分類

特定したノード（およびその祖先）が以下の種別に該当する場合、その時点でカテゴリが確定します。

| ノード種別 | 分類 | 例 |
|---|---|---|
| `comment` | 🗨️ コメント | `// hogeの説明`、`/* hoge */` |
| `string_literal` / `string_content` | 📥 入力 | `printf("hogeの値")` |
| `char_literal` / `character` | 📥 入力 | `c = 'h';` |
| `escape_sequence` | 📥 入力 | `"\then"` |
| `system_lib_string` | 📥 入力 | `#include <hoge.h>` |

上記以外のノードは、すべてフェーズ2の `classifyIdentifier` によってコンテキストから分類されます。識別子・型名・数値定数・ラベルなど、ノードの種類による区別はありません。

> [!NOTE]
> 出現位置1件につき結果も必ず1件です。同一行に複数回出現する場合や、コメントと識別子が同居する場合でも、重複や取りこぼしは原理的に発生しません。

### ハイライト範囲

選択・ハイライトされるのは **一致した文字列そのもの** です。部分一致で `hoge` が `hoge_max` にヒットした場合、`hoge` の部分のみが選択されます（VS Code 標準検索と同じ挙動）。

---

## フェーズ2: データフロー分類の詳細 (`classifyIdentifier`)

フェーズ1で抽出されたノード（`comment` と `string_literal` を除く）は、`classifyIdentifier` 関数によって **祖先ノードを下から上へ辿る** ことでカテゴリが決定されます。

### 2.1 出力（📤 書き込み）

出力として分類される条件は以下の3パターンです。**最も優先度が高い**判定です。

---

#### パターン1: 代入式の左辺 (`assignment_expression` の `left`)

```c
hoge = 10;           // hoge → 出力
hoge += value;       // hoge → 出力（複合代入も含む）
s.member = 5;        // s.member → 出力
```

検索キーワードが代入演算子（`=`, `+=`, `-=`, `*=`, `/=`, `%=`, `<<=`, `>>=`, `&=`, `|=`, `^=`）の **左辺** に位置している場合。

> [!IMPORTANT]
> ただし **配列添字（`subscript_expression` の index 部分）に位置する場合は除外** し、「入力」として扱います。書き込まれるのは配列本体であり、添字は読み取られているためです。
>
> ```c
> hoge[i] = 0;        // hoge → 出力（配列本体への書き込み）
> arr[hoge] = 0;      // hoge → 入力（添字としての読み取り）
> arr[hoge + 1] = 0;  // hoge → 入力
> hoge[hoge] = 0;     // 左の hoge → 出力 / 右の hoge → 入力
> ```

---

#### パターン2: インクリメント/デクリメント (`update_expression`)

```c
hoge++;              // hoge → 出力
--hoge;              // hoge → 出力
```

`++` または `--` 演算子の対象となっている場合。前置・後置の両方が該当します。

---

#### パターン3: アドレス取得演算子 (`pointer_expression` で `&`)

```c
scanf("%d", &hoge);  // hoge → 出力
func(&hoge);         // hoge → 出力
```

`&` 演算子でアドレスが取得されている場合。関数にポインタとして渡される場面で、変数の値が書き換えられる可能性があるため「出力」として扱います。

> [!NOTE]
> ポインタのデリファレンス（`*ptr`）はこのパターンには該当しません。`*` 演算子の場合は出力とは判定されず、後続の入力や定義の判定に進みます。

---

### 2.2 入力（📥 読み取り・参照）

出力パターンに合致しなかった場合、入力として分類される条件が評価されます。

---

#### パターン1: 代入式の右辺 (`assignment_expression` の `right`)

```c
result = hoge;       // hoge → 入力
result = hoge + 1;   // hoge → 入力
```

代入演算子の **右辺** に位置している場合。値が読み取られていることを意味します。

---

#### パターン2: 初期化式の値部分 (`init_declarator` の `value`)

```c
int result = hoge;   // hoge → 入力
int arr[] = {hoge};  // hoge → 入力
```

変数宣言時の初期化値として参照されている場合。

---

#### パターン3: 条件式内 (`if`, `while`, `for` の `condition`)

```c
if (hoge > 0) { }       // hoge → 入力
while (hoge != 0) { }   // hoge → 入力
for (i = 0; i < hoge; i++) { }  // hoge → 入力
```

制御構文の条件部分で値が評価（読み取り）されている場合。

---

#### パターン4: 関数引数 (`argument_list`)

```c
printf("%d", hoge);  // hoge → 入力
func(hoge, 10);      // hoge → 入力
```

関数呼び出しの引数として渡されている場合。

> [!NOTE]
> `&hoge` のようにアドレスが渡されている場合は、先に出力パターン3（アドレス取得）で捕捉されるため、ここには到達しません。

---

#### パターン5: 二項演算式 (`binary_expression`)

```c
int x = a + hoge;    // hoge → 入力
if (a == hoge) { }   // hoge → 入力（条件式内の判定より先にヒットすることもある）
```

加減乗除や比較演算の一部として値が参照されている場合。

---

#### パターン6: return文 (`return_statement`)

```c
return hoge;         // hoge → 入力
return hoge + 1;     // hoge → 入力
```

`return` で値が返される際に参照されている場合。

---

#### パターン7: switch/case文 (`switch_statement`, `case_statement`)

```c
switch (hoge) { }    // hoge → 入力
case hoge: break;    // hoge → 入力
```

`switch` の評価対象や `case` のラベル値として参照されている場合。

---

### 2.3 定義（📝 宣言・定義）

出力にも入力にも合致しなかった場合、定義として分類される条件が評価されます。

---

#### パターン1: typedef の宣言子 (`type_definition` の `declarator`)

```c
typedef int hoge;            // hoge → 定義
typedef struct { } hoge_t;   // hoge_t → 定義
```

`typedef` で新しい型名が定義されている場合。

---

#### パターン2: enum定数メンバー (`enumerator`)

```c
enum Color { RED, GREEN, BLUE };
//           ^^^  ^^^^^  ^^^^  すべて → 定義
```

`enum` の各定数名として定義されている場合。

---

#### パターン3: マクロ引数 (`preproc_params`)

```c
#define FUNC(hoge, arg2) ((hoge) + (arg2))
//           ^^^^  ^^^^  マクロ引数 → 定義
```

関数マクロのパラメータとして定義されている場合。

---

#### パターン4: 変数宣言 (`declaration`, `parameter_declaration`)

```c
int hoge;                    // hoge → 定義
int hoge = 10;               // hoge → 定義（※初期化値の中のhogeは入力）
void func(int hoge) { }     // hoge → 定義（関数引数）
extern int hoge;             // hoge → 定義
static int hoge;             // hoge → 定義
```

変数やパラメータが宣言されている場合。ただし、型名部分（`int`, `char` など）に検索キーワードが含まれる場合は除外されます。

> [!IMPORTANT]
> `int hoge = hoge_init;` のような初期化付き宣言では、左辺の `hoge` は「定義」、右辺の `hoge_init` は「入力」として、それぞれ正しく分離されます。

---

#### パターン5: 初期化宣言子の宣言部分 (`init_declarator` の `declarator`)

```c
int hoge = 10;               // hoge → 定義（declarator部分）
```

`int hoge = 10;` において、`hoge` は `init_declarator` の `declarator` フィールドに位置するため「定義」と判定されます（`10` 側は `value` フィールドのため入力パターン2で先に捕捉されます）。

---

#### パターン6: 構文エラー内の宣言救済 (`ERROR` ノード配下の `declaration`)

```c
GLOBAL SBYTE hoge;           // hoge → 定義（パーサーがGLOBALを認識できずERRORになる場合）
```

前置マクロなどにより tree-sitter がパース失敗（`ERROR` ノード生成）した場合でも、その親が `declaration` であれば「定義」として救済します。

---

#### パターン7: 関数定義の宣言子 (`function_definition` の `declarator`)

```c
void hoge(int a) { }        // hoge → 定義
int main(void) { }          // main → 定義
```

関数が定義されている場合。関数名部分が「定義」として分類されます。

---

#### パターン8: マクロ定義名 (`preproc_def`, `preproc_function_def` の `name`)

```c
#define HOGE 100             // HOGE → 定義
#define FUNC(x) ((x) * 2)   // FUNC → 定義
```

`#define` で定義されるマクロの名前部分。

---

#### パターン9: 構造体・共用体・列挙型の名前 (`struct_specifier`, `union_specifier`, `enum_specifier` の `name`)

```c
struct hoge { int x; };      // hoge → 定義
union hoge { int a; float b; };  // hoge → 定義
enum hoge { A, B, C };       // hoge → 定義
```

構造体・共用体・列挙型のタグ名として定義されている場合。

---

#### パターン10: 構造体メンバー宣言 (`field_declaration`)

```c
struct Point {
    int x;                   // x → 定義
    int y;                   // y → 定義
};
```

構造体や共用体の内部でメンバー変数が宣言されている場合。

---

#### パターン11: ファイルスコープの式文（前置マクロ宣言の救済）

```c
typedef union { BYTE a; } HOGE_T;
GLOBAL HOGE_T hoge2;         // hoge2 → 定義

GLOBAL union hogestruct {
    BYTE a;
} hoge3;                     // hoge3 → 定義
```

C言語ではファイルスコープに式文は存在し得ないため、**関数の外**に現れた `expression_statement` 配下の識別子は、宣言の解釈失敗とみなして「定義」として救済します。

前置マクロ（`GLOBAL` など）と、`union` / `struct` の本体付き定義や `typedef` が組み合わさると、tree-sitter がこれらの宣言を `declaration` ではなく `expression_statement` として解釈する場合があります。

ファイルスコープかどうかは、祖先ノードに `compound_statement`（関数本体）が現れないことで判定します。親が `translation_unit` かどうかでは判定しません。ヘッダのインクルードガードや `#ifdef` で囲まれている場合、宣言は `preproc_ifdef` 配下に置かれるためです。

```c
#ifndef HOGO_H
#define HOGO_H
GLOBAL SBYTE deftmp_real_es;   // hoge → 定義（expression_statement > preproc_ifdef > translation_unit）
#endif
```

> [!NOTE]
> 関数内の式文（`compound_statement` 配下）はこの救済の対象外です。関数内の代入や参照は、より優先度の高い出力・入力のパターンで判定されます。

---

### 2.4 その他（❓ 未分類）

上記のすべてのパターンに合致せず、ASTのルートノードまで辿りきった場合に「その他」として分類されます。

```c
// 具体例（稀なケース）
#define HOGE 100
//           ^^^ マクロの置き換え値のうち、preproc_argとして処理されなかった場合
```

通常の C 言語コードでは「その他」に分類されるケースは稀です。

---

## フェーズ3: サブ分類（詳細分類）

設定 `cGrepClassifier.detailLevel` を `detailed` にすると、大分類の下に **どの文脈で使われているか** を表すサブ分類が追加されます。分類の判定自体はフェーズ2と同一で、合致した規則の名前をそのままサブ分類として使用します。

| 大分類 | サブ分類 | 例 |
|---|---|---|
| 📥 入力 | 条件判定 | `if (hoge > 0)`, `while (hoge != 0)`, `switch (hoge)`, `case hoge:` |
| | 代入の右辺 | `b = hoge;`, `b = a + hoge;` |
| | 初期化値 | `int x = hoge;` |
| | 関数引数 | `func(hoge)`, `func(a + hoge)` |
| | 戻り値 | `return hoge;` |
| | 参照 | `a + hoge;`（上記のいずれにも属さない演算） |
| | 文字列 | `puts("hoge")`, `'h'`, `#include <hoge.h>` |
| 📤 出力 | 代入 | `hoge = 1;`, `hoge += 1;` |
| | インクリメント | `hoge++`, `--hoge` |
| | アドレス渡し | `func(&hoge)` |
| 📝 定義 | 変数宣言 / 関数引数 / 関数定義 / 型定義 / 構造体メンバ / マクロ定義 / マクロ引数 / enum定数 / タグ名 | 2.3 の各パターンに対応 |

コメントと「その他」はサブ分類を持ちません。

### 文脈の優先（二項演算の扱い）

フェーズ2の判定は祖先ノードを下から辿るため、`if (hoge > 0)` では `binary_expression` が先に合致します。このままではサブ分類が「参照」になってしまうため、**汎用的な「参照」と判定された場合に限り、より外側に具体的な文脈がないか改めて探索**します。

```c
if (a == hoge + 1) { }   // 「参照」ではなく「条件判定」
b = a + hoge;            // 「参照」ではなく「代入の右辺」
a + hoge;                // 具体的な文脈がないため「参照」
```

> [!NOTE]
> この再探索はサブ分類の特定にのみ使用され、**大分類の判定結果には影響しません**。

---

## 分類の優先順位まとめ

祖先ノードを下から上へ辿る過程で、**最初に合致した**パターンが採用されます。同一のノードが複数のパターンに該当しうる場合、以下の優先順位で判定されます。

```
出力（書き込み） > 入力（読み取り） > 定義（宣言） > その他
```

### 優先順位が影響する具体例

```c
hoge = hoge + 1;
```

| 箇所 | 祖先ノード | 判定結果 |
|---|---|---|
| 左辺の `hoge` | `assignment_expression` の `left` | **出力** |
| 右辺の `hoge` | `assignment_expression` の `right` → `binary_expression` | **入力** |

```c
int hoge = value;
```

| 箇所 | 祖先ノード | 判定結果 |
|---|---|---|
| `hoge` | `init_declarator` の `declarator` | **定義** |
| `value` | `init_declarator` の `value` | **入力** |

---

## 補足: 検索モード

判定はファイル本文に対するテキスト検索で行うため、ノードの種類による違いはありません。

### 部分一致モード（デフォルト）
- 本文に検索キーワードが **部分文字列として含まれている** 位置がすべてヒットします。
- 例: キーワード `hoge` で `hoge_max` の一部にもヒットします（`hoge` の部分のみが選択されます）。

### 単語全体一致モード（トグルボタン ON）
- 検索キーワードの前後が **単語文字と非単語文字の境界** になっている位置のみヒットします（正規表現の `\b` と同じ意味）。
- 例: キーワード `hoge` で `hoge_max` はヒットしません。
- 単語文字の定義は **Unicode 対応**（`[\p{L}\p{N}\p{M}_]`）です。JavaScript の `\b` は単語文字を ASCII に限定するため使用していません。これにより、日本語を含む検索語でも VS Code の検索（ripgrep）と同じ結果になります。
  - 例: `温度` は `室内温度` や `温度センサ` にはヒットせず、単独の `温度` のみヒットします。

---

## 補足: 検索結果の網羅性

フェーズ1の出現位置の列挙が VS Code 標準検索と同一の処理であるため、以下が保証されます。

- **取りこぼしがない**: 本文に出現するキーワードは、必ずいずれかのカテゴリに分類されて表示されます。
- **重複がない**: 出現位置1件につき、結果も必ず1件です。
- **件数が一致する**: 検索範囲（対象ファイルと除外設定）を揃えれば、VS Code 標準検索のヒット件数と一致します。

> [!NOTE]
> 型名・数値定数・`goto` ラベルなど、値の読み書きに該当しない箇所は「その他」に分類されます。これらは分類の対象外なのではなく、**「その他」として必ず表示されます**。
