# Console の履歴の検索 (Ctrl-R)

console panel (GUI) と `tritium_cli` (CLI) は、zsh の `history-incremental-search-backward`
(emacs キーマップの `Ctrl-R`) と同じように履歴を検索できる。native・PyMOL・ChimeraX のどの dialect でも同じ。

## キー

| キー | 動き |
|---|---|
| `Ctrl-R` | 検索を始める (prompt の上 (GUI) / 下 (CLI) に `bck-i-search: _`)。検索中に押すと、次に古い一致へ。検索語が空なら前回の検索語で探す |
| 文字 | 検索語を伸ばし、今の一致から古い方へ、検索語を含む最初の行を出す (今の行もまだ候補) |
| `Backspace` | 直前の一歩 (1 文字、または `Ctrl-R` の移動) を取り消す。新しい方へ戻るのもこれ |
| `Enter` | 出ている行を実行する |
| `Esc`、`Ctrl-G` (CLI は `Ctrl-C` も) | 検索をやめ、始める前の行に戻す |
| その他の編集キー (矢印、`Tab` など) | 出ている行を残して検索を終え、そのキーの動作をする |

- 一致が無いときは `failing bck-i-search: abc` と出し、行は最後の一致のまま。
- caret は一致の先頭に置く。GUI は一致した部分を選択状態にして示す (zsh の強調の代わり)。
- 検索の対象は、GUI は今の dialect の履歴 (`commandHistory.ts`)、CLI は `~/.tritium_cli_history`
  (readline の `history`、dialect をまたいで 1 本)。大文字小文字は区別する (zsh の既定)。

zsh と変えた点:

- `Ctrl-S` (前向きの検索) は無い。zsh も割り当てているが、端末のフロー制御 (XON/XOFF) が先に受け取るので、
  macOS の既定の zsh では効かない。また Windows / Linux の app では Save Scene なので、console でも保存できる
  ほうを残した。
- 1 つの行に検索語が何度出ても、その行で止まるのは 1 回。
- `Esc` も検索をやめる操作 (補完の一覧でも `Esc` は「戻る」)。zsh では meta の前置き。

## 分担

| どこ | 何をするか |
|---|---|
| `tritium/console-kit/src/historySearch.ts` | 検索の状態と遷移 (`startSearch` / `typeSearch` / `repeatSearch` / `backspaceSearch`) と表示 (`searchLine`: 行・caret・一致の長さ、`searchPrompt`)。DOM も端末も知らない純粋な関数 |
| GUI `plugins/console/renderer/ConsolePanel.tsx` | キーを遷移に変え、prompt と上の帯に出す |
| CLI `tritium/cli/src/tritium_cli.ts` (`installCompletion`) | 同上を端末で。補完と同じ `_ttyWrite` の包みの中 |

前回の検索語は client が持ち、検索語が空でないときだけ更新する (空のまま抜けても消さない)。

## GUI

- `Enter` は `TextAreaField` が `onKeyDown` より先に受け取って `onSubmit` を呼ぶので、検索の終わりは `submit` の
  先頭で扱う。
- 検索を終えるキー (矢印、`End`、`Tab` など) は、`handleKeyDown` の中で同期的に選択を解いてから通す。一致の
  選択は `requestAnimationFrame` で付けるので、まだ来ていない frame は取り消す (残すと、キーの後で caret が
  一致の位置へ戻される)。
- 検索を終えた後の `Up` / `Down` は、一致した行から続ける (zsh と同じ)。`RecallState` の `index` を一致の番号に、
  `stashedDraft` を検索を始める前の行にする。同じ keydown の中で続けて `Up` を処理するので、その値を直接渡す。
- IME の確定やペーストで行が変わったとき (`handleChange`)、dialect を切り替えたときは、検索をやめる。
- **Windows / Linux のメニューのキー**: `Ctrl-R` は Reload Scene の accelerator で、`useMenuKeyBindings` が window の
  capture phase で先に受け取る。prompt を包む要素に `data-own-keys="ctrl+r"` を付け、handler は target (か祖先) が
  そのキーを持つときは何もしない (`keyClaimedByTarget`。書き方は修飾キー + キー、小文字、空白区切り)。console の
  外では今までどおり Reload Scene。macOS はメニューが `Cmd` なので衝突しない。

## CLI

- 補完と検索は 1 つの `_ttyWrite` の包みの中にある。prompt の下の行 (`rows` / `clear` / `draw`) と、自分で行を
  書く間の印 (`writing`) を共有する。別々に包むと、どちらを外にしても Tab・下の行・自分の書き込みを取り合う。
- 補完の一覧が出ているときの `Ctrl-R` は、一覧を閉じて検索を始める。検索中の `Tab` は、検索を終えてから補完する
  (caret は一致の先頭なので、その前の文字列を補完する)。
- 検索中の `Ctrl-C` は検索をやめるだけ。通すと、空の prompt から始めた検索では `SIGINT` の handler が
  `tritium_cli` を終了してしまう。
- 検索を終えた後の `Up` は、一致した行からは続けない (先頭から)。Node の readline は `Up` で caret より前の文字列を
  接頭辞にした検索を自分で始めるので、履歴の位置だけ合わせても、行の途中で一致した行では古い行が飛ばされる。

## テスト

- `console-kit/src/historySearch.test.ts`: 一致のたどり方、`Ctrl-R` の繰り返し、`Backspace`、失敗中、前回の検索語
- `ConsolePanel.test.tsx`: `Ctrl-R` → 文字 → `Enter` で一致した行を実行、`Esc` で元の行
- `__test__/menuKeyBindings.test.tsx`: `data-own-keys` の中の `Ctrl+R` はメニューを呼ばない
