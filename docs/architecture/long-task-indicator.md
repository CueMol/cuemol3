# 時間がかかる処理の表示 (長い処理インジケータ)

時間がかかる worker の処理の間、「何を・何秒」処理しているかを、どのタブにいても見える位置に表示する。
以前は status bar の右下に小さく「Busy」が出るだけで、固まったのか続いているのかが分からなかった。

C++ も undo の仕組みも変えていない。入力は止めない。

## 1. 背景: なぜ「固まった」ように見えるか

- 長い処理の間、C++ は worker スレッドを同期で占有する。描画も worker で行うので、3D ビューが止まる。
- main スレッドの UI (パネル、メニュー) は動く。この「ビューだけ止まる」状態が「固まった」に見える。
- C++ を 1 回呼んでいる間は JS に戻らないので、worker から途中経過を送れるのは JS の切れ目だけである。

## 2. 仕組み

### 2.1 worker: 呼び出しごとの `ctx.reportTask`

- `WorkerService._buildContext(seqno)` は、呼び出しごとに `WorkerContext` を作り、`reportTask(state)` を持たせる。
  - `reportTask` は `[TASK_PROGRESS_CHANNEL, { seq, ...state }]` を post する。
  - `TaskState` は `{ label?, detail?, step?, total? }` (`worker/shared/taskProgress.ts`)。
- 通知先は、その ctx を作った呼び出しの seq に固定される。
  - worker の service は直列化されていない。async の service が `await` している間に、別の呼び出しが割り込める。
  - それでも report は自分の呼び出しに付く。worker 全体で共有する「実行中の seq」は持たない。
- 返事の無い呼び出し (`NO_REPLY_SEQ`) と、worker 内部の呼び出し (`pumpAnimProgress` など) は、何も送らない。
- service 側は `services/helpers/taskReport.ts` の `reportTask(ctx, state)` を使う (ctx に `reportTask` が無ければ何もしない)。
- 送るのは状態が変わったときだけで、間引きはしない。
  - **重い同期処理に入る前に送る。** C++ を呼んでいる間は、後から送ることも遅れて送ることもできない。
  - 送る場所は、ファイル単位などの低頻度の切り替わりに限る。経過秒数は renderer 側で数えるので、毎秒の通信はしない。

### 2.2 名乗る service (opt-in)

表示の対象になるのは、`reportTask` で名乗った呼び出しだけである。tracked な呼び出しすべてに出すわけではない。
対象は、worker を同期で占有し、キャンセルできず、既存の進捗表示が無い処理に限った。

| 処理 | service | 文言 | detail |
|---|---|---|---|
| シーンの保存 | `saveScene` | Saving scene | ファイル名 |
| qsc を開く | `openSceneFile` / `loadScene` | Opening scene | ファイル名 |
| ファイルを開く | `loadObject` | Opening file | ファイル名 |
| 表面生成 | `makeMolSurf` / `regenMolSurf` | Generating surface / Regenerating surface | 表面の名前 |
| シーンの書き出し | `exportScene` | Exporting scene | ファイル名 |
| オブジェクトの保存 | `saveObjectToFile` | Saving object | ファイル名 |
| MD trajectory | mdtools の `loadTrajectory` / `attachTrajectory` | Loading MD trajectory / Attaching MD trajectory | ファイル名、段階 |

- 文言は service が自分で持つ。undo の txn 名と共通化はしない。
  - undo の helper に progress を組み込むと、ctx の受け渡しやネスト時の抑制が要り、undo 側の変更範囲が広がる。
  - 用途が違うので、文言が重複しても許容する。
- trajectory は、各ファイルの C++ 呼び出しの前に、`step` (1 始まりで、いま処理中の段) と `total` を送る。
  - `loadTrajectory` は topology を 1 段、trajectory ファイルを 1 つずつ 1 段と数える。
  - `attachTrajectory` は、付けるファイルを 1 つずつ 1 段と数える。
- **対象外:**
  - Get PDB (`streamLoadFromUrl`) と EMDB map の取得: network を `await` し、独自の進捗 dialog とキャンセルを持つ。
  - APBS とレンダリング: worker を塞がない job で、既存の進捗表示 (`APBS_PROGRESS_CHANNEL`、`RENDER_PROGRESS_CHANNEL`) がある。

### 2.3 まとめて実行する入口では名乗らない

複数の操作を 1 回の呼び出しでまとめて実行する入口は、下に渡す ctx から `reportTask` を外す (`withoutTaskReport(ctx)`)。

- `invokeOp` (`catalog/opRuntime.ts`): console の catalog コマンド、qax マクロ、agent、MCP、PyMOL の ray が通る。
- console の `runCommand`: dialect (PyMOL / ChimeraX) は op を通らずに service を呼ぶことがあるので、入口でも外す。

理由は次の 2 つである。

- 表示の寿命は、transport の返事で決まる。1 回の `runCommand` の中で対象の service が終わっても、`runCommand` の返事までは表示が消えない (次のコマンドが network fetch でも「Opening file」が残る)。
- 秒数も、`runCommand` 全体の時間になってしまう。

これらの入口では、表示は今までどおり Busy だけになる。MCP・agent・console の起動 script はもともと `quiet` なので、transport も追わない。

### 2.4 renderer: `WorkerTransport`

- tracked な呼び出しごとに `{ seq, name, startedAt, state }` を持つ (`_tracked`)。
  - `task-progress` が届くと、その呼び出しの `state` にマージする。
  - 返事・失敗・crash・terminate のどれでも、その呼び出しを消す (`_endTracked`)。
- 該当する呼び出しが無い report (quiet で追っていない、返事が先に着いた) は捨てる。
- `getLongTasks()` は、名乗った未完了の呼び出しのうち最も古いものと、その件数を返す。
- `subscribeLongTasks(cb)` は、名乗ったとき・状態が変わったとき・名乗った呼び出しが終わったときに通知する。`AsyncCueMol` から公開している。
- `isBusy()` / `subscribeBusy()` (status bar の Busy と待ちカーソル) は変えていない。

### 2.5 renderer: `useLongTask` (`hooks/cuemol/useLongTask.ts`)

- タイミングだけを扱う。何を描くかは呼び出し側が決める。
- 名乗った呼び出しが開始から **0.8 s** (`LONG_TASK_THRESHOLD_MS`) を超えたら表示する。短く終われば出ないので、普段の操作ではちらつかない。
- 表示を始めたら、最低 **0.3 s** (`LONG_TASK_MIN_SHOW_MS`) は出す。
- 経過秒数は main スレッドの timer (500 ms ごと) で数える。
  - これは呼び出しを送ってからの時間で、worker が正常に進んでいる証明ではない。
- `onFinished` は、表示した task が終わったときに一度だけ、所要時間とともに呼ばれる。
- `longTaskFraction(task)` は、determinate のバーの割合を `(step - 1) / total` で返す。
  - 段が無ければ null を返す。
  - 処理中の段はまだ終わっていないので数えない。「5 / 5 を処理中」は 80% で、100% にはしない。
- `longTaskTitle(task)` は「Saving scene — 1abc.qsc」を返す。label が無ければ「Working…」にする。

## 3. 表示

### 3.1 カード (`shell/LongTaskIndicator.tsx`)

- `ContentArea` の中に 1 つだけ置く。タブ列のすぐ下の中央に出るので、molview でも Settings でも見える。
- 中身は次のとおり。
  - 文言
  - detail
  - Blueprint の `ProgressBar` (段が無ければ縞の indeterminate、あれば determinate)
  - 段階「2 / 5」
  - 経過秒数
  - 他にも名乗った呼び出しが待っていれば「+N more」
- **入力は止めない。**
  - 層 (`.long-task-layer`) は `pointer-events: none` で、scrim で覆わない。
  - 長い処理の間の操作は、今までどおり worker の待ち行列に積まれる。
- スタイルは `styles/_long-task.css` にあり、notification と同じトークンを使う。
- プランでは「カード + 画面上端の細いバー」としていたが、表示が二重になるので、バーはカードの中だけにした。

### 3.2 status bar

- 名乗った task が表示されている間は、Busy の代わりに spinner・文言・秒数を出す。全文は hover で見られる。
- 名乗っていない呼び出しの間は、今までどおりの Busy を出す。

### 3.3 終わったとき

- 表示した task が 5 s 以上かかったら、終了時に status bar のメッセージに所要時間を一度だけ出す。例: 「Saving scene — 1abc.qsc: 13 s」。
- 失敗は、今までどおり呼び出し側がダイアログなどで出す。
- 完了のたびに右下に溜まるのは煩いので、トーストは使わない。

## 4. やっていないこと

- **入力の抑止 (scrim、keydown の遮断、native menu の制御):** macOS の Cmd+Z / Cmd+S などは main の native menu が受け取るので、renderer の keydown を止めても防げない。表示を入れて使ってみて、それでも誤操作が問題になるなら別件で検討する。
- **キャンセル:** C++ が同期で動いている間は止められない。worker を止めると、シーンごと失う。
- **1 回の C++ 呼び出しの中の進捗率** (1 つの大きなファイルの読み込み率など): C++ から JS の callback で push する仕組みが要る。trajectory も、1 ファイルが大きいとその段の間はバーが止まる (秒数は進む)。
- **MCP / AI agent への展開:** task の状態は `subscribeLongTasks` から読めるので、次のものは後から足せる。
  - MCP の `notifications/progress`
  - busy で断るときに、実行中の処理の文言を返すこと
  - MCP の status アイコンやチャットへの表示

## 5. 計測メモ: シーンの保存と圧縮

GroEL (1AON) と、その表面 (埋め込み約 50 MB) のシーンを保存したときの時間とサイズ:

| 圧縮 | 時間 | サイズ |
|---|---|---|
| なし | 0.7 s | 53 MB |
| gzip | 2.8 s | 32 MB |
| xz (既定) | 13.5 s | 25 MB |

保存時間の大半は xz 圧縮である。圧縮形式の既定や xz の preset の見直しは、別件として扱う。

## 6. テスト

`renderer/__test__/longTaskProgress.test.ts`:

- report が、`await` をはさんでも自分の呼び出しの seq に付くこと。
- transport が、report を pending の間だけ持つこと。返事の後に着いたものと quiet の呼び出しのものは捨てること。
- `invokeOp` の op に `reportTask` が渡らないこと。
- `longTaskFraction` が「処理中の段は数えない」こと。

`plugins/mdtools/worker/loadTrajectory.test.ts`:

- 各ファイルの read の前に、その段の report を送ること。
