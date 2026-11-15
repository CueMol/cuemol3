# `__current` カメラ (いま見ている視点)

`__current` は scene の「いま見ている視点」を表す camera で、qsc の保存時に書かれ、読み込み時に
view に適用される。`AnimMgr.startcam` の既定値でもあり、画像出力・render・view 追加でも使われる。
UXP では必要になった処理がそれぞれ保存しているだけだったが、tritium (と libcuemol2) では次の
位置づけの camera として扱う。

- **scene ができた時点から存在し、消せない。**
- **undo の対象ではない。** 作成も変更も undo の履歴に残らず、undo / redo / rollback で巻き戻らない
  (視点そのものが undo の対象でないのと同じ)。
- **視点 (camera の状態) だけを持ち、visibility flags は持たない。** visibility は視点ではなく、
  animation の開始カメラも視点しか使わない (`AnimMgr` は `loadVisSettings()` を呼ばない)。
- **値は、読む処理の直前に active view の視点で更新する** (読まれる直前に必ず最新にする)。
  カメラが変わるたびに更新するのではない。

## 運用の前提 (animation の開始カメラ)

- `startcam` が `__current` の animation は、今の視点からすぐに rockspin させるような一時的な用途に使う。
  実行を始めたときに視点が急に変わらないことを優先する。
- 決まった視点から始める必要がある animation (movie rendering するものなど) では、ユーザーが
  名前付きカメラを `startcam` に指定する。
- そのため、`__current` から始まる animation の起点が変わること (下記) は許容する仕様である。

## libcuemol2 (C++)

名前の定数は `qsys::CURRENT_CAMERA_NAME` (`src/qsys/Camera.hpp`)。

| 場所 | 振る舞い |
|---|---|
| `Scene::setCamera()` | 名前が `__current` なら undo に何も記録しない (作成・変更とも)。登録前に camera の visibility flags を空にする (`resetVisSettings()`、読み込み前の `<visibilities>` ノードも含む)。追加・変更のイベントは通常どおり出す |
| `Camera::visAppend()` | 自分の名前が `__current` なら何もしない。UXP の「Save from scene (with vis flags)」で `__current` に保存しても視点だけが入る |
| `Scene::destroyCamera()` | 名前が `__current` なら `IllegalArgumentException` を投げる。イベント発火・undo 記録・削除より前に判定する |
| `Scene::isJustCreated()` | camera の数から `__current` を除いて数える (`__current` だけの scene も「作られたばかり」) |
| `Scene::saveCameraTo()` | (従来どおり) `__current` はファイルを書くだけで、source の変更も undo の記録もしない |
| `UndoManager::commitTxn()` | 何も記録されなかった txn の commit では Redo を消さない。記録があれば従来どおり消す |

設計上の要点:

- **削除を false ではなく例外で拒否する理由**: UXP の `onRenameCamera()` は戻り値を見ずに
  `destroyCamera(name)` -> `setCamera(res, cam)` を呼ぶ。false では後続の登録が走り、同じ camera が
  別名でも登録されて内部の名前まで変わる。例外なら後続が止まり、既存の catch で txn が rollback される。
  なお、別の camera を `__current` に Rename する経路は無い (UXP は変更先の名前があると止まり、
  `__current` は常にある)。
- **visibility flags を持たせない理由**: undo の対象でない snapshot が、undo の対象である object の
  表示状態を持つと、「非表示にする -> `__current` に保存 -> Undo -> 表示に戻す -> `__current` を
  visibility 付きで Apply」のように、履歴のどこにも無い状態を復元できてしまう。
- **空の commit で Redo を残す理由**: `__current` だけを更新した txn は空になる。従来の commitTxn は
  空でも Redo を消したので、「編集 -> Undo -> 現在の視点をファイルに保存 -> Redo」で Redo が失われた。
  何も記録しなかった txn は何もしなかったのと同じ扱いにし、txn の外で undo 対象外の変更をしたときと揃えた。
- scene のクリア (`Scene::clearAllData()`) は `destroyCamera()` を使わずに camera 表を空にするので、
  削除の禁止に阻まれない。

## tritium (worker)

`__current` を書くのは `syncCurrentCam(scene, viewId)`
(`worker/server/services/camera/currentCam.ts`) だけ。中身は `scene.saveViewToCam(viewId, '__current')`
で、失敗は握りつぶして false を返す (camera の問題で保存や出力を止めない)。C++ が記録しないので、
undo txn の中から呼んでもよい (console・AI agent の op は外側の txn の中で service を呼ぶ)。
**今後 `__current` を読む処理を足すときは、その直前にこの関数を呼ぶ。**

同期する場所:

| 場所 | タイミング |
|---|---|
| `scene/createNewSceneAndView.ts` | 最初の view を作った直後 |
| `file/loadScene.ts` (`loadScene` / `openSceneFile`) | 読み込み後、`__current` が無ければ最初の view から作る (読み込みに失敗して空になった scene も)。あれば従来どおり各 view に適用する |
| `anim/transport.ts` (`play` / `goTime`) | AnimMgr が停止状態で `startcam === '__current'` のときだけ、開始の直前。一時停止中の再開や seek では同期しない。GUI からでも `animate` op からでも同じ |
| `scene/saveScene.ts`、`scene/exportImage.ts`、`renderjob/renderJob.service.ts` (`renderStart`)、`scene/createViewInScene.ts` | qsc 保存・画像出力・render 開始・view 追加の前 |
| `camera/cameraFile.ts` (`saveCameraToFile`) | 名前が `__current` なら `viewId` を必須にし、同期してからファイルを書く。txn は開かず、op も記録しない |
| `anim/edit.ts` (`ensureStartCam`) | element の Add で `startcam` が空なら `'__current'` にするだけ。値は保存しない (Play 時に同期される)。`__current` が無い scene では作る |

animation の起点について (許容している挙動):

- 停止状態から始めるので、今見ている視点から始まり、実行開始時に視点は飛ばない。
- `AnimMgr::goTime()` は seek のたびに、ループ再生は周回のたびに開始カメラを読み直す。途中で qsc 保存や
  画像出力を挟むと、その時点の視点が `__current` に入り、以降の起点が変わる。
- 停止すると view は最終フレームの視点のまま残り、次の Play はそこから始まる。
- `renderjob/movieJob.ts` の `overrideStartCamForRender` は、`startcam` が空か存在しない camera を
  指すとき `__current` を使う。運用前提の外にある fallback なので、そのままにしている。

### 予約名の保護

通常のカメラ操作の service は、`__current` (前後の空白を除いて比較) を
`'"__current" is reserved'` で拒否し、scene も undo も変えない。console の op はこれらの service を
呼ぶので、`delete_camera __current` なども同じく拒否される。

- `camera/cameraOps.ts`: `createCamera`、`saveViewToCamera`、`destroyCamera`、`renameCamera`
  (変更前・変更後のどちらか)、`applyCameraToView`、`clearCameraVisFlags`
- `camera/cameraVisFlags.ts`: `setCameraVisFlags`
- `camera/cameraFile.ts`: `saveCameraToCurrentSrc`、`reloadCameraFromSrc`
- Apply を拒否するのは、`__current` は常に今の視点で、適用しても最後に同期した時点 (たとえば scene
  作成直後) の視点に戻るだけだから。
- ファイルからの読み込み (`loadCameraFromFile`) とペーストは、既存の重複回避で
  `copy1___current` のような別名になるので、`__current` を上書きしない。

`save_camera_file` op は `mutates: false` で、名前付きカメラの保存が成功したときだけ
`oc.markMutated()` を呼ぶ。`mutates: true` のままだと、`invokeOp()` が `__current` の保存も外側の txn の
操作履歴に記録してしまう (同じ txn に通常の編集があると、その行に残る)。

### 操作履歴 (action log)

`actions/actionLog.ts` の `txnEnd()` は、commit で undo stack が増えたときだけ Redo 側の行を切り捨てる。
空の commit では行を残すので、C++ の Redo と JS の履歴 (op と引数) が食い違わない。

### UI

- Camera pane: 新しい scene でも最初から `__current` 行が先頭に固定表示される。この行を選んでいるときは
  上書き 2 種・Apply 2 種・Delete のボタン、ダブルクリック、Delete キー、F2、Copy / Cut が効かない。
- 右クリックメニュー: `__current` 行で使えるのは New Camera・Paste・Load・Save As だけ
  (`cameraInfo.reserved`、`shared/sceneCtxMenu/sceneCtxTemplates.ts`)。Copy は同期せずに古い値を
  写すので止めている。
- 新規カメラのダイアログ: 名前に `__current` を入れるとエラーを表示して確定できない
  (`TextPromptDialog` の `validate`)。
- 「現在の視点をファイルに保存」(SaveCurrentView): 保存先を選んだあとに
  `saveCameraToFile(__current, viewId)` だけを呼ぶ。scene は「変更あり」にならず、Redo も残る。

## テスト

- gtest `SceneTest.CurrentCameraIsOutsideUndoAndCannotBeDestroyed` (`src/tests/qsys/test_scene.cpp`):
  just created の判定、txn の中での作成・変更・`saveVisSettings()` が undo に残らず Redo も残ること、
  visibility flags が空のままであること、削除が例外になること。
- gtest `UndoManagerTest.EmptyTxnIsDiscarded`: 空の commit で Redo が残ること。
- Vitest:
  - `animationService.test.ts`: 停止状態からの play / seek でだけ同期すること。
  - `cameraOpsService.test.ts`: 予約名の拒否。
  - `actionLog.test.ts`: 空の commit で Redo 側の行が残ること、`save_camera_file __current` が
    同じ txn の編集の行に記録されないこと。
  - `loadSceneService.test.ts`: 読み込みに失敗した scene にも `__current` が作られること。
  - `fileCommands.test.tsx`: SaveCurrentView が `saveCameraToFile` だけを使うこと。
