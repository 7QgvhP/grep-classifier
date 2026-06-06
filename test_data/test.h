#ifndef TEST_H
#define TEST_H

// マクロ定義のテスト
#define HOGE_MAX_SIZE 100
#define SUCCESS_CODE 0

typedef struct {
    int id;
    char name[50];
    int score;
} HogeStruct;

// 関数宣言
void update_hoge(HogeStruct* ptr);
int get_hoge_score(const HogeStruct* ptr);

#endif // TEST_H
