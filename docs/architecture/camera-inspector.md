# Camera inspector

Camera pane で選んだ camera を右の inspector に表示・編集する。基本情報、file にリンクしている
camera の path、visibility flags (camera を show/hide 付きで適用したときにどの object / renderer を
表示 / 非表示にするか) を出す。visibility flags の編集は以前は専用の modal dialog
(`EditCameraVisFlagsDialog`、[ADR-0026](../migration/adr/ADR-0026-camera-vis-flags-editor.md)) だったが、
inspector の Visibility section に置き換えて dialog は削除した。

## 開き方と Camera pane との同期

Scene pane と同じく、行を選ぶだけでは inspector は変わらず、**明示的に開く**:

- Camera pane ツールバーの **Property** ボタン (`ui.properties`、行を選んでいるときだけ有効。
  `__current` でも押せる)
- 右クリックメニューの **`Properties…`**
- 右クリックメニューの **`Edit vis flags`**: inspector を開き、Visibility section までスクロールする
  (command `CameraEditVisFlags` は残し、動作だけ付け替えた。dialog ではないので `…` を外した)
- ダブルクリックは **Apply のまま** (UXP と同じ。camera で一番多い操作)

最初の 2 つは command `CameraShowProperties` (`{ name }`) を通り、`showCamera(sceneId, name)` を呼ぶ。

| 同期 | 挙動 |
|---|---|
| pane -> inspector | inspector が active scene の camera を表示している間だけ、pane で別の行を選ぶと inspector も切り替わる。node や animation element を表示中なら変えない |
| inspector -> pane | inspector の target が active scene の camera になったら、pane はその行を選択にする |
| rename | pane の inline rename も inspector の Name も command `CameraRename` を通す。成功時に handler (`useCameraCommands`) が `renameCameraTarget` で inspector の target と scene ごとの記憶を付け替え、上の inspector -> pane の同期で pane の選択も付いてくる。pane の `commitRename` が自分で `setSelected(newName)` する処理は残してある (inspector が閉じているか node を表示中のときは、上の同期が働かないため) |
| 削除・scene の閉鎖 | 取得が `not-found` になったら `clearCamera(sceneId)` で外す (scene と kind で絞るので、他の target は落とさない) |

## 表示内容

`InspectorTarget` に `{ kind: 'camera'; sceneId; name; focus?: 'visibility' }` を足した。camera は uid を
持たないので名前で引く ([ADR-0005](../migration/adr/ADR-0005-camera-name-keyed.md))。`animElement` と
同じく、中身は `features/inspector/CameraInspector.tsx` が自分で取得・編集し、header (名前と
`file` / `embedded`) を provider に報告する。

1. **Camera**: Name (確定は blur / Enter、Escape で戻す)、Source (埋め込みなら `Embedded in the scene`、
   リンクなら path。read-only)。リンクしているときは Reload / Save ボタン (`CameraReload` / `CameraSave`)。
2. **View**: Center、Rotation (quaternion の 4 成分)、Zoom、Distance、Slab、Projection、Center mark。
   **すべて読み取り専用**。視点は 3D view を動かして Save from view で保存するのが自然で、数値入力の
   場面は少ないため (編集可にすると、camera のコピーを `setCamera` で置き直す undo 対応の service と
   rotation の入力形式の決定が要る)。stereo は出さない。
3. **Visibility**: scene の object / renderer を tree 状 (object の下に renderer を字下げ) に並べ、各行に
   「含める」checkbox と目のボタン。名前の無い renderer は Scene pane と同じ `(*selection)` の形で出す。
   見出しの行に含めている数 (`N / M included`)、Capture、Clear。

### `__current`

Camera section だけを出し、Name と Source は read-only、ボタンは Save As だけ。View と Visibility は
出さない。`__current` の値は読まれる直前にしか更新されないので、表示すると古い値に見える。
visibility flags も持たない ([current-camera](current-camera.md))。header に種類ラベルは付けない
(狭い幅で名前が押し出されるため)。

## Visibility の書き込み

- **1 操作 = 1 回の書き込み = 1 undo step**。dialog の OK / Cancel は無く、inspector の他の項目と
  同じく即時反映。書き込みは既存の `setCameraVisFlags` (受け取った全行から set を clear + append で
  作り直す)、Clear は `clearCameraVisFlags`。
- **書き込みから再取得の完了まで、section の操作をすべて無効にする**。`setCameraVisFlags` は全行から
  作り直すので、再取得の前に次の行を操作すると、古い配列から送った 2 回目の書き込みが 1 回目の変更を
  戻してしまう。キューや差分更新の API は足していない。
- **Capture** は全行を含め、scene の今の表示状態で取り直す (視点は変えない)。`getCameraVisFlags` の
  `visible` は含めている行では保存済みの値なので、`VisFlagEntry` に `currentVisible` (scene の今の
  表示状態) を足し、Capture は `{ included: true, visible: currentVisible }` を渡す。含めていない行を
  含めるときと、含めていない行の目の表示も `currentVisible` を使う。`saveViewToCamera` は視点まで
  上書きするので流用しない。
- 字下げ用に `VisFlagEntry` に `depth` も足した。

## 更新の追従と C++ event

`useLiveFetch` で `getCameraDetail` (新 service、`services/camera/cameraDetail.ts`) と
`getCameraVisFlags` を取得し、`SEM_CAMERA` と `SEM_OBJECT | SEM_RENDERER` の event で debounce して
取り直す (Visibility の一覧は scene の node とその表示状態を映すため)。

`Camera::visAppend` / `visRemove` は以前 event を出さず、visibility flags を変えても Undo しても、
inspector や Camera pane の目のバッジが次の camera event まで古いままだった。成功時に
`cameraChanged` (`SEM_CAMERA` / `SEM_CHANGED`、`m_name` = camera 名) を出すようにした
(`src/qsys/Camera.cpp` の `fireVisFlagsChanged`)。undo / redo (`VisSetEditInfo`) も同じ 2 つを
呼ぶので event が出る。

- scene に登録されていない camera (名前が空、または scene の同名 camera が別の instance。qsc の
  読み込み途中や paste 前のコピー) では出さない。
- 1 回の `setCameraVisFlags` で行数ぶん event が出るが、renderer 側の debounce でまとまる。

## テスト

| 内容 | 場所 |
|---|---|
| `visAppend` と、その undo で camera event が出る | `src/tests/qsys/test_scene.cpp` (`CameraVisFlagChangesFireCameraEvents`) |
| Capture が `currentVisible` で全行を含め、再取得まで操作が無効 | `react-gui/src/renderer/__test__/cameraInspector.test.tsx` |
| Property ボタン、camera 表示中だけの選択追従、inspector / pane 両方の rename で選択が残る | `react-gui/src/renderer/__test__/cameraInspectorLink.test.tsx` |
| `getCameraVisFlags` の `currentVisible` / `depth` | `react-gui/src/renderer/__test__/cameraVisFlagsService.test.ts` |

## 関連

- [Camera pane](camera-pane.md)
- [`__current` カメラ](current-camera.md)
- [ADR-0026](../migration/adr/ADR-0026-camera-vis-flags-editor.md) — visibility flags の service (UI は本ページに置き換え)
