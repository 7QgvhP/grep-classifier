(function () {
    const vscode = acquireVsCodeApi();

    // 拡張機能本体から注入された分類カテゴリ定義（名称・表示順・CSSクラス）
    const CATEGORIES = window.__CATEGORIES__ || [];

    const searchInput = document.getElementById('search-input');
    const wholeWordToggle = document.getElementById('whole-word-toggle');
    const functionSummaryToggle = document.getElementById('function-summary-toggle');
    const openInEditorButton = document.getElementById('open-in-editor');
    const resultsContainer = document.getElementById('results-container');

    let matchWholeWord = false;
    let activeMatchIndex = -1;
    // 現在描画中の一致情報（状態復元時にこの配列から再描画する）
    let currentMatches = [];
    // 折りたたまれているアコーディオンのID（既定はすべて展開）
    let collapsedIds = new Set();
    // 関数名一覧モード（一致箇所ではなく、出現する関数名のみを表示する）
    let summaryMode = false;
    // 一致箇所ごとに関数名を表示するか（設定 showEnclosingFunction に連動）
    let showFunction = true;

    // ------------------------------------------------------------------
    // 状態の保存と復元
    // ------------------------------------------------------------------

    // 描画結果ではなく元データのみを保存する（HTML全体を保持するより軽量かつ堅牢）
    function saveState() {
        vscode.setState({
            query: searchInput.value.trim(),
            matchWholeWord: matchWholeWord,
            matches: currentMatches,
            collapsedIds: Array.from(collapsedIds),
            activeMatchIndex: activeMatchIndex,
            summaryMode: summaryMode,
            showFunction: showFunction
        });
    }

    function restoreState() {
        const previousState = vscode.getState();
        if (!previousState) {
            return;
        }

        if (previousState.query) {
            searchInput.value = previousState.query;
        }
        matchWholeWord = !!previousState.matchWholeWord;
        wholeWordToggle.classList.toggle('active', matchWholeWord);

        summaryMode = !!previousState.summaryMode;
        functionSummaryToggle.classList.toggle('active', summaryMode);
        showFunction = previousState.showFunction !== false;

        if (Array.isArray(previousState.collapsedIds)) {
            collapsedIds = new Set(previousState.collapsedIds);
        }

        if (Array.isArray(previousState.matches) && previousState.matches.length > 0) {
            // 復元時はエディタを操作せず、見た目の選択状態のみを復帰させる
            renderResults(previousState.matches, previousState.activeMatchIndex);
        }
    }

    // ------------------------------------------------------------------
    // 一致項目の選択とエディタ連携
    // ------------------------------------------------------------------

    // 現在表示されている（アコーディオンが開いている）すべての選択可能項目を取得
    // 通常表示は「カテゴリ→ファイル」配下の一致項目、関数名一覧モードはカテゴリ直下の関数項目
    function getVisibleMatchItems() {
        return Array.from(resultsContainer.querySelectorAll(
            '.category-items.expanded .file-items.expanded .match-item, .category-items.expanded > .function-item'
        ));
    }

    // 指定インデックスの項目にのみ選択スタイルを適用する（エディタ操作は行わない）
    function applySelectionHighlight(index) {
        getVisibleMatchItems().forEach((item, idx) => {
            item.classList.toggle('selected', idx === index);
        });
    }

    // 項目要素が保持する位置情報をもとにエディタでの表示を依頼する
    function requestOpen(item, preserveFocus) {
        vscode.postMessage({
            type: 'openFile',
            fileUriStr: item.getAttribute('data-uri'),
            line: parseInt(item.getAttribute('data-line'), 10),
            charStart: parseInt(item.getAttribute('data-start'), 10),
            charEnd: parseInt(item.getAttribute('data-end'), 10),
            preserveFocus: preserveFocus
        });
    }

    // 指定インデックスのアイテムをアクティブ表示にしてエディタで開く
    function selectMatchItem(index, preserveFocus = true) {
        const visibleItems = getVisibleMatchItems();
        if (visibleItems.length === 0) {
            return;
        }

        if (index < 0) {
            index = 0;
        }
        if (index >= visibleItems.length) {
            index = visibleItems.length - 1;
        }

        activeMatchIndex = index;
        applySelectionHighlight(index);
        visibleItems[index].scrollIntoView({ block: 'nearest' });
        requestOpen(visibleItems[index], preserveFocus);

        saveState();
    }

    // アコーディオンの開閉などで表示項目が変化した際にアクティブ位置を再同期する
    function syncActiveIndex() {
        const currentSelected = resultsContainer.querySelector('.match-item.selected');
        if (!currentSelected) {
            return;
        }
        const idx = getVisibleMatchItems().indexOf(currentSelected);
        if (idx !== -1) {
            activeMatchIndex = idx;
        } else {
            currentSelected.classList.remove('selected');
            activeMatchIndex = -1;
        }
    }

    // ------------------------------------------------------------------
    // アコーディオンの開閉
    // ------------------------------------------------------------------

    function toggleCategory(id) {
        const items = document.getElementById(id);
        if (!items) {
            return;
        }

        const isExpanded = items.classList.toggle('expanded');
        if (isExpanded) {
            collapsedIds.delete(id);
        } else {
            collapsedIds.add(id);
        }

        // 矢印の向きを切り替える
        const header = items.previousElementSibling;
        if (header) {
            const arrow = header.querySelector('.arrow');
            if (arrow) {
                arrow.textContent = isExpanded ? '▼' : '▶';
            }
        }

        syncActiveIndex();
        saveState();
    }

    // ------------------------------------------------------------------
    // 検索結果の描画
    // ------------------------------------------------------------------

    // HTML特殊文字のエスケープ
    function escapeHtml(str) {
        return str
            .replace(/&/g, "&amp;")
            .replace(/</g, "&lt;")
            .replace(/>/g, "&gt;")
            .replace(/"/g, "&quot;")
            .replace(/'/g, "&#039;");
    }

    // 折りたたみ状態に応じたクラス名と矢印を返す
    function accordionState(id) {
        const expanded = !collapsedIds.has(id);
        return { className: expanded ? ' expanded' : '', arrow: expanded ? '▼' : '▶' };
    }

    // 一致情報をファイル単位にグループ化し、ファイル名の辞書順で並べ替える
    function groupByFile(list) {
        const filesGroup = {};
        list.forEach(m => {
            const uriStr = m.fileUriStr;
            if (!filesGroup[uriStr]) {
                const decodedUri = decodeURIComponent(uriStr);
                filesGroup[uriStr] = {
                    uriStr: uriStr,
                    fileName: decodedUri.substring(decodedUri.lastIndexOf('/') + 1),
                    matches: []
                };
            }
            filesGroup[uriStr].matches.push(m);
        });

        return Object.keys(filesGroup)
            .map(uriStr => filesGroup[uriStr])
            .sort((a, b) => a.fileName.localeCompare(b.fileName));
    }

    // ファイル単位のアコーディオンHTMLを生成する
    function buildFileHtml(fileGroup, fileListId) {
        const state = accordionState(fileListId);

        // 一致箇所を行番号順にソート
        const sorted = fileGroup.matches.slice().sort((a, b) => a.line - b.line);
        const itemsHtml = sorted.map(m => {
            // 所属関数が判明している場合のみ関数名を表示する（グローバル定義やマクロでは非表示）
            const functionLabel = showFunction && m.functionName
                ? `<span class="match-function" title="所属関数: ${escapeHtml(m.functionName)}">${escapeHtml(m.functionName)}()</span>`
                : '';
            return `
                                <div class="match-item" data-action="open" data-uri="${fileGroup.uriStr}" data-line="${m.line}" data-start="${m.charStart}" data-end="${m.charEnd}">
                                    <span class="match-line-number">${m.line + 1}</span>${functionLabel}
                                    <span class="match-code">${escapeHtml(m.content.trim())}</span>
                                </div>`;
        }).join('');

        return `
                        <div class="file-container">
                            <div class="file-header" data-action="toggle" data-target="${fileListId}">
                                <div class="file-title">
                                    <span class="arrow">${state.arrow}</span>
                                    <span class="file-name">${escapeHtml(fileGroup.fileName)}</span>
                                </div>
                                <span class="file-count">${fileGroup.matches.length}</span>
                            </div>
                            <div id="${fileListId}" class="file-items${state.className}">${itemsHtml}
                            </div>
                        </div>`;
    }

    // 関数名一覧モードの項目HTMLを生成する（出現順に重複なく関数名を並べる）
    function buildFunctionItemsHtml(list) {
        const functions = new Map();
        list.forEach(m => {
            if (m.functionName && !functions.has(m.functionName)) {
                functions.set(m.functionName, m);
            }
        });

        let html = '';
        functions.forEach((m, name) => {
            html += `
                        <div class="match-item function-item" data-action="open" data-uri="${m.fileUriStr}" data-line="${m.line}" data-start="${m.charStart}" data-end="${m.charEnd}">
                            <span class="match-function" title="最初の一致箇所へジャンプします">${escapeHtml(name)}()</span>
                        </div>`;
        });
        return { html, count: functions.size };
    }

    // 検索結果全体の合計を表す1行を生成する
    function buildTotalSummary() {
        const total = currentMatches.length;
        if (summaryMode) {
            const names = new Set();
            currentMatches.forEach(m => {
                if (m.functionName) {
                    names.add(m.functionName);
                }
            });
            return `合計 ${total} 件 / ${names.size} 関数`;
        }
        const files = new Set(currentMatches.map(m => m.fileUriStr));
        return `合計 ${total} 件 / ${files.size} ファイル`;
    }

    // カテゴリ単位のアコーディオンHTMLを生成する
    function buildCategoryHtml(category, list, catListId) {
        const state = accordionState(catListId);

        let innerHtml;
        let countLabel;
        if (summaryMode) {
            const summary = buildFunctionItemsHtml(list);
            innerHtml = summary.html;
            countLabel = `${list.length}件 / ${summary.count}関数`;
        } else {
            innerHtml = groupByFile(list)
                .map((fileGroup, fileIndex) => buildFileHtml(fileGroup, `${catListId}-file-${fileIndex}`))
                .join('');
            countLabel = String(list.length);
        }

        return `
                <div class="category-container ${category.cssClass}">
                    <div class="category-header" data-action="toggle" data-target="${catListId}">
                        <div class="category-title">
                            <span>${category.name}</span>
                            <span class="category-count">${countLabel}</span>
                        </div>
                        <span class="arrow">${state.arrow}</span>
                    </div>
                    <div id="${catListId}" class="category-items${state.className}">${innerHtml}
                    </div>
                </div>`;
    }

    /**
     * 検索結果を描画する。
     * @param {Array} matches 一致情報の配列
     * @param {number} restoreIndex 状態復元時に選択状態へ戻すインデックス（-1で選択なし）
     */
    function renderResults(matches, restoreIndex = -1) {
        currentMatches = matches || [];
        activeMatchIndex = -1;

        if (currentMatches.length === 0) {
            resultsContainer.innerHTML = '<div class="info-text">一致する箇所が見つかりませんでした。</div>';
            saveState();
            return;
        }

        let html = `<div class="result-summary">${escapeHtml(buildTotalSummary())}</div>`;
        CATEGORIES.forEach((category, catIndex) => {
            const list = currentMatches.filter(m => m.category === category.name);
            if (list.length === 0) {
                return;
            }
            html += buildCategoryHtml(category, list, 'cat-items-' + catIndex);
        });

        resultsContainer.innerHTML = html;

        // 復元時はエディタを開かずに選択状態のみ復帰させる
        if (restoreIndex >= 0 && restoreIndex < getVisibleMatchItems().length) {
            activeMatchIndex = restoreIndex;
            applySelectionHighlight(restoreIndex);
        }

        saveState();
    }

    // ------------------------------------------------------------------
    // 検索の実行
    // ------------------------------------------------------------------

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

    // ------------------------------------------------------------------
    // イベントハンドラ
    // ------------------------------------------------------------------

    // キーボード操作のハンドリング（上下キー、Enterキー）
    window.addEventListener('keydown', (e) => {
        if (e.target === searchInput) {
            return;
        }

        const visibleItems = getVisibleMatchItems();
        if (visibleItems.length === 0) {
            return;
        }

        if (e.key === 'ArrowDown') {
            e.preventDefault();
            selectMatchItem(activeMatchIndex + 1, true);
        } else if (e.key === 'ArrowUp') {
            e.preventDefault();
            if (activeMatchIndex === 0) {
                // 最初の項目でArrowUpを押した場合は入力欄にフォーカスを戻し選択を解除
                activeMatchIndex = -1;
                applySelectionHighlight(-1);
                searchInput.focus();
                searchInput.select();
                saveState();
            } else {
                selectMatchItem(activeMatchIndex - 1, true);
            }
        } else if (e.key === 'Enter') {
            if (activeMatchIndex >= 0 && activeMatchIndex < visibleItems.length) {
                e.preventDefault();
                selectMatchItem(activeMatchIndex, false);
            }
        }
    });

    searchInput.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') {
            triggerSearch();
        } else if (e.key === 'ArrowDown') {
            if (getVisibleMatchItems().length > 0) {
                e.preventDefault();
                searchInput.blur(); // 入力欄からフォーカスを外す
                selectMatchItem(0, true); // 最初の項目を選択
            }
        }
    });

    // 検索結果をテキストドキュメントとしてエディタに表示する
    openInEditorButton.addEventListener('click', () => {
        vscode.postMessage({ type: 'openInEditor' });
    });

    // 保持している結果を描画し直す（検索は実行しない）
    function rerenderCurrentResults() {
        if (currentMatches.length > 0) {
            renderResults(currentMatches);
        } else {
            saveState();
        }
    }

    // 関数名一覧モードの切り替え（エディタの結果ドキュメントにも反映させる）
    functionSummaryToggle.addEventListener('click', () => {
        summaryMode = !summaryMode;
        functionSummaryToggle.classList.toggle('active', summaryMode);
        vscode.postMessage({ type: 'setSummaryMode', enabled: summaryMode });
        rerenderCurrentResults();
    });

    wholeWordToggle.addEventListener('click', () => {
        matchWholeWord = !matchWholeWord;
        wholeWordToggle.classList.toggle('active', matchWholeWord);
        saveState();
        triggerSearch();
    });

    // イベントデリゲーションによるクリックの検知と処理
    resultsContainer.addEventListener('click', (e) => {
        const target = e.target.closest('[data-action]');
        if (!target) {
            return;
        }

        const action = target.getAttribute('data-action');
        if (action === 'toggle') {
            toggleCategory(target.getAttribute('data-target'));
        } else if (action === 'open') {
            const idx = getVisibleMatchItems().indexOf(target);
            if (idx !== -1) {
                // クリック時もフォーカスはWebview（サイドバー）に残し、そのまま上下キーで操作できるようにする
                selectMatchItem(idx, true);
            }
        }
    });

    // 拡張機能本体からのデータ受取
    window.addEventListener('message', event => {
        const message = event.data;
        if (message.type === 'results') {
            // 新しい検索結果はすべて展開した状態で表示する（すぐにキー操作で巡回できるようにするため）
            collapsedIds.clear();
            showFunction = message.showFunction !== false;
            renderResults(message.matches);
        } else if (message.type === 'setSummaryMode') {
            // コマンドによる切り替えをサイドバーの表示にも反映する
            summaryMode = !!message.enabled;
            functionSummaryToggle.classList.toggle('active', summaryMode);
            rerenderCurrentResults();
        } else if (message.type === 'setQueryAndSearch') {
            searchInput.value = message.query;
            triggerSearch();
            // 検索実行後に入力欄にフォーカスを設定し、すぐにキーボード操作を行えるようにする
            searchInput.focus();
            searchInput.select();
        }
    });

    // 初期ロード完了時に検索窓をフォーカス
    window.addEventListener('load', () => {
        searchInput.focus();
    });

    // 前回の状態を復元し、初期化完了を拡張機能本体に通知
    restoreState();
    vscode.postMessage({ type: 'ready' });
}());
