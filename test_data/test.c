#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include "test.h"

// グローバル定義のテスト
int global_hoge_val = 42;
int hoge_max;
int hoge;

void update_hoge(HogeStruct* ptr) {
    // 構造体メンバへの代入（出力）のテスト
    ptr->score = 100;
}

int get_hoge_score(const HogeStruct* ptr) {
    // 構造体メンバの参照（入力）のテスト
    return ptr->score;
}

int main(void) {
    // 1. 変数の定義 (Definition) のテスト
    int hoge_array[5] = {0};
    HogeStruct hoge_data;
    
    // 2. コメント (Comment) のテスト
    // ここは hoge のコメント行です。
    /* ブロック内の hoge もコメントになります。 */

    // 3. 出力 (Output - 書き込み) のテスト
    hoge_array[0] = 10;          // 配列への書き込み
    hoge_data.id = 1;            // 構造体メンバへの書き込み
    global_hoge_val = 99;        // グローバル変数への書き込み

    // &によるアドレス渡し（出力）のテスト
    update_hoge(&hoge_data); 

    // 4. 入力 (Input - 参照) のテスト
    int temp = hoge_array[0];    // 配列の読み出し（右辺）
    int val = hoge_data.id;      // 構造体の読み出し（右辺）
    
    if (global_hoge_val > 50) {  // 条件式の中での参照
        printf("Hoge is high\n");
    }

    hoge_max = hoge;

    int score = get_hoge_score(&hoge_data); // 関数の引数としての参照

    // 5. その他
    // (通常は式全体に含まれない型定義や、対象外の構文)

    return SUCCESS_CODE;
}
