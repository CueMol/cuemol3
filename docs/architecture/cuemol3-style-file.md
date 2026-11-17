# CueMol3 のスタイルファイルとシーンの Look (`cuemol3_style.xml` / `cuemol3_look.xml`)

CueMol3 (tritium) と CueMol2 (UXP) は同じ libcuemol2 と同じ `data/default_style.xml` を使う。
CueMol3 だけのスタイル定義は 2 つのファイルに分けて持つ。

- **`cuemol3_style.xml`**: 新しい名前の**追加**だけ。CueMol3 が global に読む。
- **`cuemol3_look.xml`**: 既存スタイルの**上書き** (CueMol3 の見た目)。global には読まず、**シーンごと**に
  scene の style set として入れる。

上書きをシーン単位にしているのは、qsc が renderer のスタイルを名前 (`DefaultRibbon` など) で持つからである。
上書きを global に読むと、CueMol2 で作った qsc を CueMol3 で開いたときにも上書きが効き、CueMol2 と違う見た目に
なる。シーンに `cuemol3_look` があるかどうかで決めれば、CueMol2 で作った qsc (scene に何も入っていない) は
`default_style.xml` だけで解決され、CueMol2 と同じ見た目のままになる。

## ファイルと読み込み

| ファイル | 読み方 | 中身 |
|---|---|---|
| `data/sysconfig.xml` | CueMol2 | `style_file` = `default_style.xml` |
| `data/sysconfig_cuemol3.xml` | CueMol3 | `style_file` = `default_style.xml`, `cuemol3_style.xml` (この順) |
| `data/default_style.xml` (`<styles id="system">`) | 両方 global | 共通のスタイル。CueMol2 の見た目はこのファイルで決まる |
| `data/cuemol3_style.xml` (`<styles id="cuemol3">`) | CueMol3 global | 追加だけ: `DefaultPymRendPreset`、`default_paint` パレットと `<テーマ>_<n>` の色、`AlphaFoldPlddtColoring` |
| `data/cuemol3_look.xml` (`<styles id="cuemol3_look">`) | **シーンごと** (scene の style set、readonly) | 上書き: `DefaultRibbon` (helix / sheet の幅 0.18・tuber 6.5、coil の幅 0.2)、`DefaultNucl` (base_size / base_thick 0.3、骨格は roundsquare で幅 0.4) |

- `qsys.cpp` の `loadStyleFile` は `style_file` を書いた順に読み、読んだセットはリストの先頭に積まれる
  (`StyleFile::loadFile` の `push_front`)。CueMol3 の global の並びは「ユーザースタイル (`user`) -> `cuemol3` -> `system`」。
- スタイルの解決は scene の set -> global の順 (`StyleMgr::getStyleNodeImpl`)。`cuemol3_look` を持つシーンでは
  `DefaultRibbon` などが CueMol3 の値になる。renderer の作り方 (既定スタイル、プリセット、console / MCP) には
  手を入れていない。
- 今後 CueMol3 の既定の見た目を変えるときは `cuemol3_look.xml` に書く。CueMol2 と共通にしたいものは
  `default_style.xml`、新しい名前の追加は `cuemol3_style.xml` に置く。

## 上書きはプロパティ単位

- renderer のスタイルはプロパティごとに解決する (`StyleSheet::resolveStyleSheet` -> `StyleMgr::getStyleNode2`)。
- セットを先頭から順に見て、同名のスタイルがあってもそのプロパティを定義していなければ次のセットへ進む。
- そのため `cuemol3_look.xml` には変える属性だけを書けばよい。書いていない `helix.type` などは
  `default_style.xml` の値になる。
- 同じ ID のセットを同じスコープに 2 度読むとエラーになる (`StyleFile::loadFile`)。

## シーンの Look

シーンの Look は「そのシーンの style set に `cuemol3_look` があるか」で表す。別の状態は持たない
(qsc にもこの set の有無として残る)。tritium 側の定義は `worker/shared/sceneLook.ts`。

| | `cuemol3_look` あり (CueMol3) | なし (CueMol2 / Legacy mode) |
|---|---|---|
| 見た目 | 細い ribbon、小さい base | `default_style.xml` (CueMol2 と同じ) |
| 既定の塗り | パレット色 ([default-paint-palette.md](default-paint-palette.md)) | CueMol2 の 4 色 |

- 見た目は名前で解決されるので、Look を切り替えるとそのシーンの既存の renderer の見た目もすぐ変わる。
  既定の塗りは、以後に分子を読むとき・Paint -> Default を選ぶときに効く (塗ってある分子の色は変えない)。
- CueMol2 で作った qsc に CueMol3 で renderer を足しても CueMol2 の見た目になる。1 シーンの中で見た目は混ざらない。

### 新しいシーン

- 入れる場所は worker の `createNewSceneAndView` だけ。New Tab ダイアログ、起動時のシーン、ファイルのドロップで
  作るシーンはどれも `useNewSceneAction` を通ってここに来る。
- `StyleMgr::loadStyleSetFromFileAt(scene, "%%CONFDIR%%/data/cuemol3_look.xml", readonly=true, append=true)` で
  読む。**undo txn の外**で行う (`applyInitialSceneProps` と同じ)。txn の中だと、作っただけのシーンが変更ありに
  なり、閉じるときに保存を聞かれ、`isSceneJustCreated` による「その場で qsc を読む」経路も使えなくなる。
- 入らない経路: `openSceneFile` (`createScene` を直接呼ぶ)、`loadScene` (`clearAllData` が `destroyContext` で
  scene の set を消す)。
- 新しいシーンの Look は `NewSceneDefaults.look` (`'cuemol3' | 'cuemol2'`、既定 `cuemol3`) で決まる。
  AA / AO / 背景色と同じく electron-store (`UiState.newSceneDefaults`) に保存され、再起動後も引き継がれる。
  変更できるのは New Tab ダイアログの「Legacy mode (CueMol2 look)」と、Settings -> Display -> Compatibility の
  「Legacy mode for new scenes」で、どちらも同じ保存値を書く。既定値を変えても開いているシーンは変わらない。

### 開いているシーンの切り替え

- Scene Properties の一番下の **Compatibility** セクションに「Legacy mode (CueMol2 look)」スイッチがある
  (`features/inspector/rows/SceneLookRow.tsx`)。値は worker の `getSceneLook` で読み、scene の style イベントで
  読み直すので、undo / redo にも追随する。
- worker service `setSceneLook({ sceneId, look })` (`services/scene/sceneLook.ts`) が、undo txn
  「Change scene look」の中で `cuemol3_look` を読み込む (末尾、readonly) か外す (`destroyStyleSet`)。
  同じ Look への切り替えは何も記録しない。埋め込みで読み直した `cuemol3_look` も名前で見つけて外す。
- 名前付き選択や色の保存先 (`saveSelDef.ts` の `findWritableSceneSet`) は `cuemol3_look` を選ばない。
  埋め込みで読み直した set は readonly でないので、名前でも除いている。

## シーン内の優先順位

`cuemol3_look` は scene の set の中で**最下位**に置く。ユーザーがそのシーンで `DefaultRibbon` などを編集した
set (`default` など) が優先されるようにするためである。挿入位置の規則:

- **通常の set の新規作成は先頭** (同じスコープの最高優先度)。`StyleMgr::createStyleSet` はファイルの読み込みと
  同じく `push_front` する。後から作るユーザーの set は常に既存の set より優先される。
- **`cuemol3_look` の導入は末尾**。`StyleMgr::loadStyleSetFromFileAt(..., bAppend=true)` が読んだ set を末尾へ移す。
  readonly や参照の有無で判定しないのは、埋め込みで読み直した `cuemol3_look` (readonly でも参照でもない) でも
  同じ規則が成り立つようにするためである。
- **qsc の読み込みは保存された順序を復元する**。qsc は優先順の逆順に書かれ (`Scene::stylesWriteTo` の reverse)、
  `loadFile` の先頭追加で元の順に戻る。
- undo / redo は `StyleCreateEditInfo` が記録した位置へ `registerStyleSet` で戻す。記録値は挿入位置と同じ
  (`createStyleSet` = `0`、末尾への読み込み = `-1`、先頭への読み込み = `0`、`destroyStyleSet` = 削除前の位置)。
- `loadStyleSetFromFile` / `loadStyleSetFromFileAt` はパスの先頭の `%%CONFDIR%%` を `SysConfig::convPathName` で
  展開する。

## qsc での持ち方

### 読み込み

`Scene::stylesReadFrom` は、`src` が `%%CONFDIR%%` で始まるときは `SysConfig::convPathName` で展開して読む
(それ以外は従来どおり qsc の場所からの相対パスと `alt_src`)。`config_dir` は sysconfig のあるディレクトリ
(CueMol3 は `share/`)。

### 書き出し: 互換先で参照と埋め込みを書き分ける

`Scene::stylesWriteTo` は、`src` を持つ set のうち **config dir の下のファイル**
(set の絶対パスと `config_dir` の前方一致で判定。`cuemol3_look` 専用の印は持たない) を次のように書く。
そのファイル自体へは書き戻さない。

| 互換先 (`SceneXMLWriter.compat`) | 書き方 |
|---|---|
| 3.0 以降 | `<styles src="%%CONFDIR%%/data/cuemol3_look.xml" readonly="true"/>` (`alt_src` は書かない) |
| それより前 (既定) | 中身を埋め込む (`writeToDataNode`)。メモリ上の set は参照を持ったまま |

- 互換先は `SceneXMLWriter` の `compat` プロパティ (`"2.2"` / `"2.3"` / `"3.0"`)。メジャー版が 3 以上なら参照。
  既存の `version` (`QDF0` / `QDF1`) は埋め込みデータのバイナリ形式の版なので別の値にしている。
  `version` と同じく `<qsc_opts>` に保存され、上書き保存 (`setDefaultOpts`) で前回の選択が引き継がれる。
  writer は書き出しの間だけ `Scene::setStyleConfRef` で Scene に伝える。
- **C++ 側の既定は古い版 (埋め込み)**。tritium の `saveScene` は、シーンに互換先の記録が無ければ `3.0` を渡す。
  Save As の `QscWriterOptionDialog` の Compatibility は「Ver 3.0 or later」(既定、QDF1 + compat 3.0) /
  「Ver 2.3 or later」(QDF1) / 「Ver 2.2 or later」(QDF0) の 3 つ。コンソールの `save` で QDF0 を指定したときも
  `compat: '2.2'` で埋め込む。
- 「Embed possible」(`embedAll` -> `Scene::forceEmbed`) は config dir の下の set の参照を消さない。埋め込むか
  どうかは互換先だけで決まる。
- 一度埋め込んで保存した qsc を開き直すと、その set は参照を持たない普通の set になり、以後は中身のまま保存される。
- UXP GUI (今回の libcuemol2 でビルドしたもの) も `%%CONFDIR%%` 参照を読める。UXP のビルドは `share/data/*` を
  `data/` にコピーする (`uxp_gui/cuemol2/components/jsmods/moz.build`) ので `cuemol3_look.xml` も同梱される。
  UXP GUI の保存ダイアログには Ver 3.0 が無いので、UXP GUI で作った qsc は埋め込みで書かれる。

### 既知の制約

- 互換先は `<qsc_opts>` に保存され UXP GUI も `setDefaultOpts` で引き継ぐので、CueMol3 が Ver 3.0 で保存した qsc を
  UXP GUI で再保存すると、QDF0 を選んでも参照形式のまま書かれることがある。新しい UXP GUI は参照を読めるので、
  読めないのは変更前の CueMol2 だけである。CueMol2 のサポートは縮小していく方針なので、UXP GUI 側の追随
  (互換先を明示的に設定する) はしていない。
- CueMol3 の qsc を変更前の CueMol2 で開いたときの見た目、`cuemol3_look` 導入前に CueMol3 で保存した qsc の
  見た目はケアしていない。

## sysconfig の指定元

両アプリとも libcuemol2 のインストール先 (`share/`) にある 2 つの sysconfig から選ぶ。

| | CueMol3 | CueMol2 |
|---|---|---|
| 開発版 | `tritium/core/CMakeLists.txt` の `DEFAULT_SYSCONFIG_PATH` (`share/sysconfig_cuemol3.xml`)。アドオンに埋め込む | ビルド時に `share/sysconfig.xml` と `share/data/*` をコピー (`uxp_gui/cuemol2/components/jsmods/moz.build`) |
| パッケージ版 | main の `getSysConfigPath()` (`main/handlers/appPath.ts`) が `Resources/cuemol2/share/sysconfig_cuemol3.xml` を返す | 同上 |

- `tritium/packaging/collect-cuemol2-runtime.sh` は `share/` をまるごと同梱し、`sysconfig_cuemol3.xml`、
  `cuemol3_style.xml`、`cuemol3_look.xml` の存在を検査する。
- CueMol2 にも `cuemol3_style.xml` がコピーされるが、`sysconfig.xml` が参照しないので読まれない。

## スタイル一覧の重複

- `StyleMgr::getStyleNamesJSON` は全セットのスタイルを並べるので、上書きしたスタイルは 2 回出る。
- tritium の `fetchStyleEntries` (`worker/server/services/helpers/styleEntries.ts`) は、同名のうち最後の 1 件
  (全体を定義している最下層のセット) だけを残す。renderer の Style メニューなどでは `desc` と並び順が
  `default_style.xml` のとおりになる。

## その他の qsc の互換

- **色**: CueMol3 の見た目のシーンで保存した qsc は、塗りに使ったパレット色の定義を scene の style set に持つ
  (`defPaintColoring.ts` の `ensureSceneColor`)。CueMol2 で開いてもパレットの定義なしで解決できる。
- **プリセット**: プリセット名は qsc に残らない。残るのはグループと、子 renderer の `sel` と `style`
  (`DefaultRibbon` など、どれも `default_style.xml` にある) である。

## テスト

- gtest (`src/tests/qsys/test_cuemol3_style.cpp`): `cuemol3_look.xml` の上書きがプロパティ単位で効くこと、
  互換先 3.0 で `%%CONFDIR%%` 参照・古い版で埋め込みになり、どちらも読み直すと同じ値に解決し、埋め込みで
  読み直した look の後に作った set が優先されること。
- gtest (`src/tests/qsys/test_styleeditinfo.cpp` の `RedoRestoresListPosition`): 先頭に作った set と末尾に読んだ
  set が undo -> redo で同じ位置に戻ること。
- Vitest: `createNewSceneAndViewService.test.ts` (Look の set を txn の外で末尾・readonly に読む / CueMol2 では
  読まない)、`sceneLook.test.ts` (`setSceneLook` が 1 undo step で付け外しする)、`selectionServices.test.ts`
  (`cuemol3_look` に書かない)、`defPaintColoring.test.ts` (Legacy の 4 色)、`newSceneDefaults.test.ts`
  (`look` の保存値の fallback)。
