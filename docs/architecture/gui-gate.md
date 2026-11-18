# 前面の tab による GUI の有効・無効と、scene の解決 (GUI gate)

main panel の前面の tab が molview でないとき (Settings、または tab が 1 つも無いとき)、scene を前提にする GUI 操作を無効にする。
GUI を通らない入力 (tritium_cli・MCP・agent・shell open) は、直前の molview に戻して実行し、余計な tab を作らない。

以前は次の問題があった。

- Settings が前面でも bottom panel の Console が操作でき、`list_scenes` を実行すると新しい tab と scene ができた。
- Settings が前面のときに Get PDB を使うと、新しい scene ができた。
- メニューの無効化が id の一覧 (`SCENE_REQUIRING_MENU_IDS`) 頼みで、漏れがあった (Undo/Redo、Rendering、Scene メニューなど)。tab が無いときに押すと何も起きなかった。
- ツールバー (`requiresScene`) と plugin のメニュー項目は、別の仕組みか、仕組み無しだった。

## 1. 規則: 前面の tab の種類だけで決める

GUI の操作 (システムメニュー、ツールバー、bottom panel、ドロップ) の有効・無効は、**前面の tab の種類だけ**で決める。
tab がいくつ開いているか、裏に molview tab があるかは見ない。Settings だけが開いている場合も、Settings が前面の場合と同じ扱いになる。

前面の tab の種類 (`GuiGate['tab']`):

- `'molview'`: molview tab が前面にある
- `'other'`: molview 以外の tab (今は Settings だけ) が前面にある
- `'none'`: tab が 1 つも無い

| 操作の種類 (`Availability`) | 主な項目 | molview | other | none |
|---|---|---|---|---|
| `'always'` | New Tab、Open Scene、Open Recent の scene、Close Tab、About、Check for Updates、Preferences / Options、Window の各項目、Cut / Copy / Paste / Select All、Clear Recent、Tool palette | ○ | ○ | ○ |
| `'loadIntoScene'` | Open File、Open Recent の obj、Get PDB、Open MD Trajectory、ドロップ | ○ | × | ○ (scene を作ってから読み込む) |
| 宣言なし | 上記以外すべて (保存、Reload、Undo / Redo、編集、Rendering、Export、Scene、View、Tools など) | ○ | × | × |

- 宣言の無い項目は「molview が必要」になる。宣言を書き忘れても、使えないはずの状態で押せることは無い (安全側に倒れる)。
- New Tab と Open Scene は前面の scene に何も加えないので、常に使える。
- Cut / Copy / Paste / Select All は Settings の入力欄でも使うので、常に使える (中身はフォーカスで振り分ける)。
- Settings だけが開いている状態から作業を始めるには、Settings を閉じればよい。tab が無い状態になり、読み込み系が使える。

## 2. 仕組み

### 2.1 判定は 1 か所 (`shared/guiGate.ts`)

- `isAvailable(availability, gate)` が、上の表をそのまま持つ唯一の判定関数である。
- システムメニュー (main)、React のメニューバーとそのキーバインド、ツールバー、bottom panel、ドロップ、welcome 画面は、すべてこの関数で判定する。各所で `tab === 'molview'` のような条件を書かない。
- `GuiGate` を作るのは renderer の `useGuiGate()` (`state/workspace/WorkspaceProvider.tsx`) だけである。値は `{ tab }` のオブジェクトで、中身が変わったときだけ identity が変わる。
- 状態を足すとき (将来の busy など) は、`GuiGate` のフィールドと `isAvailable` の中を変えれば済み、呼び出し側は書き換えなくてよい。この形は意図して残している。busy での無効化、モーダル dialog 用の `menuBlock.ts` との統合はしていない。

### 2.2 宣言する場所

- システムメニュー: `shared/menuTemplate.ts` の `AppMenuItem.availability`。macOS の app メニュー (`macAppMenuGroup`) の About・Check for Updates・Preferences も `'always'`。
- **gate の対象は、アプリの command を呼ぶ項目 (`ipcChannel` を持つ項目) だけである。** Electron に動作を任せる role だけの項目 (Services・Hide・Hide Others・Show All・Quit・Toggle DevTools) は対象外で、常に使える。対象に含めると、Settings が前面のときに Quit まで無効になる。
- ツールバー: `shell/Toolbar.tsx` の `TOOLBAR_ITEMS[].availability`。Undo / Redo のボタンは、前面の scene の undo 状態 (`useUndoRedo`) で無効になる。
- plugin: `PluginMenuItem.availability` (`shared/types/pluginContrib.ts`、`shared/pluginMenu.ts` が `AppMenuItem` に写す) と `PluginToolbarItem.availability`。Get PDB と Open MD Trajectory は `'loadIntoScene'`。
- 項目そのものの状態 (Perspective の checked、背景色の radio、Undo の可否など) はそのまま残る。有効になるのは、「gate で有効」かつ「項目の状態で有効」のときだけである。

### 2.3 システムメニュー (main)

- renderer は `useGuiGateMenuSync` (`shell/menu/`) で `MENU_UPDATE_STATE` に `{ guiGate }` を送る。以前の `sceneOps: { enabled }` はこれに置き換えた。
- main は、メニューを組むときに、gate の対象の項目を「id → `{ availability, enabled }`」の表 (`gatedItems`、`main/menu.ts`) に登録する。`enabled` は template の既定値である。
- `applyMenuStateTo(menu, state, gated)` (`shared/menuStateApply.ts`) は、呼ばれるたびに対象の全項目の `enabled` を、「項目の状態 (slice、なければ既定値)」と `isAvailable` の積で決め直す。gate が開き直せば、gate が閉じていた項目もすぐに戻る。
- 無効になった項目は、ショートカットキー (Cmd+O、Cmd+S、Cmd+Z など) でも動かない。macOS ではキーを native menu が受けるためである。
- renderer が gate を送るまでは (起動直後に組んだメニュー)、gate では何も無効にしない。

### 2.4 Open Recent

- 各項目は `RecentFileEntry.ftype` で判定する (`recentAvailability`)。`'scene'` は `'always'`、`'obj'` は `'loadIntoScene'` である。
- 拡張子では判定しない。クリック時の振り分け (`useMenuDispatch.ts` の `entry.ftype === 'scene'`) と同じ値を使い、判定と動作を食い違わせない。
- native menu では、recent の各項目に `recent-<index>` の id を付けて `gatedItems` に登録する。`applyMenuStateTo` は次の 3 つの経路のすべてで呼ばれるので、どの経路でも今の gate が反映される。
  - `updateMenuState`: gate が変わったとき (メニューは組み直さない)
  - `buildAndSetMenu`: recent が変わってメニューを組み直したとき
  - `flushPendingRebuild`: modal block が解除されたとき
  - メニューを組むときだけ判定すると、molview から Settings に移っても obj の項目が有効なまま残るため、こうしている。
- React のメニューバーは描画のたびに組み立てるので、`resolveAppMenu.ts` の recent の組み立てで同じ判定をする。

### 2.5 ドロップ

- `useFileDrop` は `'loadIntoScene'` として判定する。gate が閉じているとき (Settings が前面) は、overlay を出さず、`dropEffect = 'none'` で no-drop カーソルにし、drop が来ても何もしない。
- dragover の `preventDefault` は gate が閉じていても続ける。止めると Chromium が file:// へ遷移してしまう。
- shell open (`useShellOpenFiles`) は GUI を通らない入力なので、gate では止めない (§4)。

## 3. bottom panel

- bottom tab の定義に `requiresMolView?: boolean` を書く。plugin は `contributes.bottomTabs` (`PluginBottomTab`)、built-in は `BottomPanel.tsx` の `BUILTIN_BOTTOM_TABS` に書く。
- 宣言しているのは Console・Animation・Sequence・Trajectory である。Output (ログ) は scene と無関係なので宣言せず、常に使える。core は plugin id を特別扱いしない。
- 判定は宣言なし (= molview が必要) の `isAvailable(undefined, gate)` である。無効のときは、panel の中身を描かずに、その tab のアイコンと「Switch to a molecule view tab to use this panel.」を出す (`.bottom-panel-placeholder`、各 panel の空表示と同じ配置)。tab ボタンは押せる。
- Console の入力と出力の履歴、入力中の文字は panel の外 (`consoleSessionStore.ts`) にあるので、中身を描かなくても失われない。Settings が前面の間に tritium_cli で実行した結果も、molview に戻れば見える。
- プランでは、中身を描いたまま `inert` にして薄く表示し、案内を重ねる形にしていた。Sequence などでは各 panel の「No active scene」と案内が二重になり、Console も scene が無いと操作できないだけなので、すべての tab で中身を案内に差し替える形にした。

## 4. GUI を通らない入力と、scene の解決

| 入力 | 扱い |
|---|---|
| tritium_cli・MCP・agent | 直前の molview に切り替えてから実行する。molview tab が 1 つも無ければ、新しく作る。 |
| shell open (Finder でのダブルクリックなど) | 同じ。open target が `'new'` なら、今どおり新しい scene に開く。 |

外部からの入力まで止めると、CLI の script が「たまたま Settings を開いていた」だけで失敗するので、GUI の規則とは分けている。
外部から操作されると、Settings を見ている途中でも画面が molview に切り替わる。外部からの操作は scene を変えるので、結果が見えるほうが自然と判断した。

### 4.1 直前の molview (`lastMolViewTabId`)

- workspace の state が `lastMolViewTabId` を持つ (`workspaceReducer.ts`)。
- 更新は action ごとではなく、reducer の出口の `withLastMolView` 1 か所で行う。
  - action の後の前面の tab が molview なら、その id を記録する。
  - 記録した tab がもう無ければ、消す。
- この形なので、`close` で残った tab が自動で前面になる経路も記録される。例: tab 順が A・B・Settings で、最後に使った molview が A のとき、Settings を閉じると B が前面になり、B が記録される。action を足しても記録が漏れない。

### 4.2 `resolveMolView` と `activateMolView` (`WorkspaceProvider`)

- `resolveMolView()`: 前面の molview、なければ `lastMolViewTabId` の tab、なければ strip 上で最初の molview を返す。前面には出さない。molview tab が無ければ undefined。
- `activateMolView(viewId)`: その view の tab を前面に出し (`activateView` を dispatch)、続けて自分で `cm.activateView(viewId)` を送って返事を待つ。
  - worker の呼び出しは送った順に処理されるので、これを待った後に送る呼び出しは、必ず view の有効化の後に動く。
  - provider の effect も同じ `activateView` を送るが、worker 側の `activateView` は何度呼んでも同じ結果になるので、二重に送っても害はない。そのため、有効化済みの view の記録や、待っている promise の一覧は持たない。
  - 対象の tab が無いとき、または `cm.activateView` が失敗したときは reject し、呼び出し元 (CLI・MCP・agent) に通常のエラーとして返る。待ち続けることは無い。
  - `sceneTabs.ts` の `settle()` は tab の state の反映を待つだけで、worker への送信は待たないので、この順序の保証には使わない。
- これを使うのは、前面にない既存の molview に戻す経路だけである。前面の molview をそのまま使う場合と新しい scene を作る場合は、以前と同じく待たない。

### 4.3 resolver は `makeResolveOpenTarget` 1 つ (`hooks/useEnsureActiveScene.ts`)

- 以前は、`makeEnsureActiveScene` (Get PDB・CLI・MCP・agent) と `makeResolveOpenTarget` (File > Open・ドロップ・shell open) に、同じ判定が重複していた。
- 今は `makeResolveOpenTarget(deps)` が唯一の実装で、依存 (`getActiveSceneInfo`、`resolveMolView`、`activateMolView`、`newScene`、`isSceneJustCreated`) を受け取る。
  - `useResolveOpenTarget()` は、live の provider からこれを組む。
  - `useEnsureActiveScene()` は、`'active'` を即座に commit する薄い wrapper である: `(await resolveOpenTarget('active')).commit()`。
  - `useSceneCommands` は、依存を `useCommandRegistrations` から受け取って組む。
- 解決の順序 (preview と commit は、最初に決めた同じ対象を使う):
  - `'active'`: 前面の molview があればそこ。無ければ `resolveMolView()` の molview を preview にし、commit で `await activateMolView()` してから返す。どちらも無ければ preview は 0 で、commit で新しい scene を作る。
  - `'new'`: 以前と同じ。前面の molview が手つかずならそこを使い、そうでなければ commit で新しい scene を作る。裏の手つかずの scene は使わない。
- 新しい scene を作るのも、tab を切り替えるのも commit のときだけである。option dialog を cancel すれば画面は変わらない。
- Get PDB・agent・MCP・CLI は `'active'` 固定なので、`'new'` の再利用には巻き込まれない。

### 4.4 scene を使わないコマンド (`plugins/console/renderer/runSubmission.ts`)

- `list_scenes`・`create_scene`・`switch_scene`・`close_scene` は、scene を解決せずに実行する。
- 前面に molview が無いとき (tab が無い、または Settings) は、まず scene 無し (`sceneId: 0`) で worker に送る。worker が `not-found` を返したとき (scene が必要なコマンド) にだけ、`ensureActiveScene()` で解決し直して送る。
- これで Settings が前面でも、`list_scenes` で tab が増えたり切り替わったりしない。
- MCP の scene tool は、scene の解決より前に処理しているので、変更していない。

## 5. welcome 画面 (`shell/WelcomePane.tsx`)

- tab が 1 つも無いときに出る画面である。画像は `assets/cuemol3-icon-shadow.png` で、dark テーマ用に描かれている。light テーマでは `--welcome-icon-filter: invert(1)` で反転して使う (dark はそのまま)。
- ショートカットは「アイコン | コマンド名 | ショートカット」の 3 列で並べる。列は `.shortcut-group` の grid が揃える。
- 並べる候補は New Tab・Open File・Open Scene で、ラベルとショートカットは `APP_MENU` から引く。そのうち `isAvailable(item.availability, { tab: 'none' })` を満たすものだけを出すので、tab が無い状態で効かないキーは出ない。

## 6. テスト

- `shared/guiGate.test.ts`: 「種類 × 前面の tab」の表、宣言なしは molview が必要、Open Recent の `ftype` による分類。
- `shared/menuStateApply.test.ts`: gate が molview → other → molview と変わるたびに、対象の項目と recent の項目が判定し直されること。項目自身の状態 (Undo の可否) との積になること。
- `state/workspace/workspaceReducer.test.ts`: `lastMolViewTabId` が、close で前面になった molview も記録し、閉じた tab を指さないこと。
- `__test__/resolveOpenTarget.test.ts`: Settings が前面のとき、`'active'` は commit まで切り替えず、有効化を待ってから返り、失敗したら reject すること。`'new'` は裏の scene を再利用しないこと。
- `plugins/console/renderer/runSubmission.test.ts`: 前面に molview が無いとき、tab コマンドが `ensureActiveScene` を呼ばずに終わること。
- `__test__/welcomePane.test.tsx`: welcome 画面に出すショートカットが、メニューに実在し、tab が無い状態で使えること。
- 無効のときの見た目は目視で確認した。テストは書いていない。
