# MD trajectory: 落としたファイルを既存の分子に付ける (tritium / libcuemol2)

trajectory のファイル (`.xtc` / `.dcd` / `.trr` / `.nc`) や 1 frame の座標のファイル (AMBER restart `.rst7` /
`.inpcrd` / `.restrt`、NAMD `.coor`) を window に落とすと、付け先の分子を選ぶダイアログが出て、その分子に付ける。PyMOL で topology を開いた後に trajectory を `load` する操作に当たる。UXP には無い
新規機能なので、migration ではなくここに置く。

- 普通の分子 (`MolCoord` など) を選ぶと、`Trajectory` に変換してから付ける。元の座標は frame 0 に残り、trajectory の
  frame がその後ろに続く (PyMOL の drop / `load` の既定 `state=0` と同じ)。座標の無い分子 (topology だけの `prmtop` /
  PSF) は、落としたファイルの最初の frame から始まる。topology と座標のファイルの扱いは
  [md-topology-coordinate-files.md](md-topology-coordinate-files.md)。
- 既存の `Trajectory` を選ぶと、後ろに block として足す。
- topology の形式は問わない。GROMACS が書き出した (水素も入り原子数が一致する) PDB に `.xtc`、`.gro` に `.dcd`、の
  ように組み合わせられる。座標の単位は block の reader が持つ (xtc / trr は nm -> Å、dcd はそのまま)。

UI は built-in plugin `mdtools` (既定オフ) の一部。File > Open MD Trajectory... (topology と trajectory をまとめて
新しく開く、[md-trajectory-open-dialog.md](md-trajectory-open-dialog.md)) の挙動は変えていない。そちらでは topology の
座標は frame に残らない。

## 前提

- `Trajectory` は編集する分子として扱わない。qsc は trajectory のファイルを外部参照で持ち、座標を埋め込む手段は無い。
- 原子 ID (aid) は変換で保たない (selection にも aid をなるべく持たない方針)。

## drop から plugin へ: `contributes.fileOpeners` (core)

plugin の manifest は、扱う拡張子と command を `contributes.fileOpeners` で宣言する
([contributions.md](tritium_plugin/contributions.md#fileopeners))。mdtools は block の reader がある拡張子 (`.xtc` /
`.dcd` / `.trr` / `.nc` / `.rst7` / `.inpcrd` / `.restrt` / `.coor`、`trajFormats.ts` の `TRAJ_DOT_EXTS`) を
`plugin.mdtools.attachTrajectory` に割り当てている。

drop の batch (`features/file-io/useOpenFilePaths.ts`) は次の順で処理する:

1. 有効な plugin が宣言した拡張子のファイルを、`OpenObjByPath` に流す列から外す (opener ごとにまとめる)。
2. 残りのファイルを今まで通り 1 つずつ開く。
3. その後で、opener の command に `{ paths, sceneId }` を渡して await する。`sceneId` は、同じ batch で開いたファイルが
   入った scene、無ければ active scene。

- `.gro` と `.xtc` を一緒に落とすと、`.gro` が先に開くので、開いたばかりの分子が付け先の候補に入る。
- ドロップ先の設定が「新しい scene」(`dropOpenTarget: 'new'`) でも、opener には active scene を渡す。opener は scene に
  あるものに付け加えるもので、新しい空の scene では付け先が無い。
- batch は command の完了まで次の drop を受け付けないので、command はダイアログと読み込みが終わるまで settle しない
  Promise を返す。
- plugin が無効なら拡張子は引き取られず、今まで通り `OpenObjByPath` に流れて「MD Tools を有効にする」案内が出る
  (`useSceneCommands.ts` の `MDTOOLS_PLUGIN_ID`。案内文は、有効にした後は drop で付けられることも書く)。
- File > Open (普通のファイル選択) から trajectory を開く経路は無い (trajectory の reader は filter から外してある)。

## 付け先のダイアログ (`AttachTrajectoryDialog`)

`useAttachTrajCommand` が service `listAttachTargets` で候補を取り、ダイアログを出し、選ばれたら `attachTrajectory`
を呼ぶ。

- **候補は原子数が合う分子だけ**。各ファイルのヘッダから原子数を読み (§C++ の `getFileAtomCount`)、すべてのファイルで
  一致したらその数の分子だけを出す。普通の分子は `getAtomSize()`、`Trajectory` は topology の全原子数
  (`getAllAtomSize()`、読み込み時の原子の選択で一部しか持っていなくても全原子) と比べる。
  - ヘッダが読めないファイルがあると絞り込まない (付けるときの native のチェックに任せる)。
  - ファイルどうしで原子数が違うと、どの分子も候補にならない。
- `MorphMol` は出さない (変換すると morph の frame が引き継がれず、アニメーションが消える)。
- 普通の分子のうち、次のものは灰色で「Cannot attach: 理由」と出し、選べない (理由は service から来る):
  - `xformMat` が単位行列でない (Superpose などで動かした)。`Trajectory::setXformMatrix` が行列を捨て、位置が変わる。
  - `modified` (編集された)。qsc で embed される分子で、`Trajectory` は編集される分子として扱わない。
  - 元のファイルが無い (`srctype` が空、`src` / `alt_src` が `datachunk:` か URL か存在しないパス)。frame 0 の block は
    元のファイルを参照するので作れない。
  - 座標のファイル (sub-stream `coord`) を指定して開いた分子で、そのファイルが無くなっている。
- 座標の無い分子 (`hasNoCoords`、[md-topology-coordinate-files.md](md-topology-coordinate-files.md)) は行に
  「no coordinates」と出る (選べる)。
- 選べる候補が 1 つならそれを選んでおく。普通の分子を選ぶと「trajectory に変換され、座標は最初の frame に残る」と示す
  (座標の無い分子では「下のファイルの最初から始まる」)。
- ファイルは落とした順に並べるが、1 frame の座標のファイル (restart / `.coor`) を先に置く (frame 0 にするため。
  `singleFrameFirst`)。
- ファイルの順序付きリスト (Add / Remove / Up / Down) は OpenMdTrajDialog と共通の `TrajFileListSection`。間引き
  (nevery) は `SliderField` (`slider={false}`)。
- 候補が無いときはダイアログの代わりに案内を出す:
  - 原子数で外れた分子があり、ファイルの原子数が分かる: 「この scene に N 原子の分子が無い」。
  - ファイルどうしで原子数が違う: その旨。
  - それ以外 (分子が無い、scene が無い): 「先に topology を開く」。
- 付けるのに成功したら、Trajectory の bottom タブを前に出し (`revealBottomTab`)、付けた trajectory を選んで全体を fit
  する。fit は panel が付けた後の frame 数を見てから行う (`trajFocus.ts` の一回きりの要求。既存の `Trajectory` に足した
  ときも増えた後の frame 数で fit し直す)。

## worker service `attachTrajectory`

すべて 1 つの undo txn ("Attach MD trajectory", `undoTxnResult`) で行う。

1. 断る付け先 (`fail(..., 'unsupported')`、ダイアログを通らない呼び出しでも断る): `MorphMol`、上の 3 つの理由の
   どれかがある普通の分子。拡張子に reader が無いファイルも txn の前に断る (`unsupportedTrajFormat`)。
2. 普通の分子は `convertToMorphMol` と同じ骨格で変換する: `toXML2(mol, 'Trajectory')` -> `fromXML()`、名前を引き継ぎ、
   `destroyObject(old)` -> `addObject(new)`。`ui_order` は `nopersist` なので元の値を戻す (scene tree の位置を保つ)。
3. 変換したときは、元の座標を frame 0 の block として最初に `append` する。分子の開き方で 3 通り:
   - topology + 座標のファイル (`amberprm` / `psf` の sub-stream `coord`、`getSubSrcPath('coord')`): XML を
     `toXML2NoSubSrc` で作って topology を main のファイルだけで読み直し、座標のファイルを 1 frame の block
     (`amberprm` -> `amberrst`、`psf` -> `namdcoortraj`) として付ける。topology を単独で開いて座標のファイルと
     trajectory を落としたときと同じ qsc になる。
   - 座標の無い分子: frame 0 の block を作らない。
   - それ以外: 元の構造ファイルの `structframe` block (次節)。
4. 各ファイルを block として読み、順に `append` する (`trajBlocks.ts` の `appendTrajFile`。`loadTrajectory` と
   `appendTrajectoryBlock` と共通。1 frame の block の reader には間引きを掛けない)。
5. 座標の無い分子に付けたら、commit の後に scene の全 view を付けた `Trajectory` に合わせる
   (`focusAllViewsOnNode`、記録しない)。無表示から表示ありになるため。座標のある分子や既存の `Trajectory` では view を
   動かさない。

原子数が合わないなどの失敗は、native のチェック (reader の NATOM と `Trajectory::append`) が throw し、txn ごと戻る
(変換も戻る)。成功すると `{ objId, nframe }` を返す。

## 元の座標の block: `structframe` (C++)

`Trajectory` の frame はすべて block から来る (`Trajectory::append()` は最初の block で `primeInitialFrame()` を呼び、
元の座標を frame 0 で上書きする)。元の座標を frame として残すため、構造ファイルを 1 frame の trajectory として読む
block reader `StructFrameReader` (nickname `structframe`、`src/modules/mdtools/StructFrameReader.*`) がある。

- property `struct_type`: 中で使う molecule reader の名前 (元の分子の `srctype`)。既定値を持たないので、C++ から設定
  しても必ず qsc に書かれる (既定値があると「既定のまま」と見なされて保存されない)。
- `read()` は `struct_type` の reader で一時的な `MolCoord` を読み、aid の順に座標を取り出して 1 frame の block に
  詰める (scale 1。molecule reader が Å にしている)。trajectory の `srctype` が `struct_type` と同じなら、その reader
  option (`ropts`) も使う。原子数は topology の全原子数と照合する。
- qsc では、`src` (元のファイル)・`srctype` (`structframe`)・`struct_type` を持つ普通のファイル参照の block として
  保存され、他の block と同じ順番・同じ経路で読み直される。
- 費用: qsc を開くたびに、元の構造ファイルを topology と block で 2 回読む。
- Trajectory パネルでは 1 frame の block として出て、消すこともできる (消すと trajectory の最初の frame から始まる)。

## ファイルの原子数をヘッダだけで読む (C++)

`TrajBlockReader::getFileAtomCount()` は、`setPath()` したファイルのヘッダだけを読んで原子数を返す (読めなければ
-1)。target の attach は要らない。中身は各 reader の `readFileAtomCount(InStream&)` で、既存のヘッダ読み込みを使う:
DCD は `readHeaderFields` (ヘッダの読み込みと topology との照合を分けた)、XTC / TRR は最初の frame header、
AMBER NetCDF は `Netcdf3InStream::parseHeader`。scriptable method として dcd / xtc / trr / nc の各 reader の qif に
出している。`Trajectory` には `getAllAtomSize()` も scriptable method として出している。どちらも property ではない
ので、qsc の互換性には関わらない。

## Undo -> Redo で renderer が残る (`ObjLoadEditInfo`)

XML の往復で作った object は、renderer が付いたまま scene に入る。「object を作った」記録 (`OLEI_OBJ_CREATE`) の Undo
は `Scene::destroyObject()` を呼び、付いている renderer を外すが、Undo 中なので外した renderer の記録は残らない。
renderer の作成も記録されていない (`Object::registerRendererImpl` は scene の無い object では記録しない)。そのため以前
は、Redo で object だけが戻り renderer が消えていた (`convertToMorphMol` も同じ)。

今は、Undo で `destroyObject()` の前に付いている renderer を `m_stashRends` に持ち、Redo で `registerObjectImpl()` の
後に `registerRendererImpl()` で付け直す。普通の操作 (object を入れてから renderer を作る) では renderer の作成が別に
記録され、逆順の Undo で先に外れるので、持つ一覧は空になり二重には付かない。

## Trajectory のインスペクタ

Trajectory を選ぶと、インスペクタの Properties に「Trajectory」セクションがあり、`frame_aver_size` を
「Frame averaging (±)」で設定できる (`features/inspector/schema/trajectory.ts`)。表示中の frame と前後 N frame
ずつ、最大 2N+1 frame の平均を表示する。範囲は 0-10 (21 frame の窓。それ以上は動きのほうがぼやける)。setter が今の
frame をすぐに計算し直す。

object のページはクラス名で引く。以前は worker がクラス名を wrapper に無い `className` から読んでいたため、どの object
も "Object" になり、object のページ (DensityMap の Map type も) が一度も出ていなかった。今は `getClassName()` で取る
(`worker/server/services/props/read.ts`)。インスペクタの見出しの型名もクラス名になる。

## 既知の制約

- **他の分子の距離測定** は、置き換え前の object を参照し続けて古い座標を読む (`convertToMorphMol` と共通)。
  `AtomIntrElem` は相手の分子を UID のキャッシュ (`nMolID`) と名前 (`molName`) で持ち、実行中は `nMolID` を引く。名前で
  引き直すのは `nMolID` が `invalid_uid` のときだけで、画面で足した測定は UID だけを持つ。古い object は undo の記録が
  持っているので、エラーにもならない。直し方の案: `evalMol` でキャッシュの UID の object が scene にいなければ名前で
  引き直し、画面で足すときも `molName` を入れる (aid が変わる点は残る)。
- 編集された分子・元のファイルが無い分子には付けられない。付けるには、元の座標を datachunk で持ち読み込みを遅らせる
  仕組みが要る。
- PDB の残基番号の折り返し (GROMACS の大きな系の PDB で原子が落ちる) は未対処。

## 主要ファイル

| ファイル | 役割 |
|---|---|
| `react-gui/src/renderer/plugin-host/types.ts`, `pluginSelect.ts` | `PluginFileOpener` / `FileOpenerArgs`、寄与の収集 |
| `react-gui/src/renderer/features/file-io/useOpenFilePaths.ts` | drop の振り分け (`splitByOpener`) と opener の呼び出し |
| `react-gui/src/renderer/plugin-host/bottomTabReveal.ts` | `revealBottomTab` (plugin から bottom タブを前に出す) |
| `react-gui/src/renderer/h3-kit/list/ListRow.tsx` | `disabled` (選べない行) |
| `react-gui/src/plugins/mdtools/manifest.ts` | `fileOpeners`、`ATTACH_TRAJ_COMMAND`、`TRAJECTORY_TAB_ID` |
| `react-gui/src/plugins/mdtools/renderer/useAttachTrajCommand.ts` | 候補の取得、ダイアログ、付ける、タブを出す |
| `react-gui/src/plugins/mdtools/renderer/AttachTrajectoryDialog.tsx`, `TrajFileListSection.tsx` | ダイアログと共通のファイルリスト |
| `react-gui/src/plugins/mdtools/renderer/trajFocus.ts`, `TrajectoryPanel.tsx` | 付けた後の選択と fit |
| `react-gui/src/plugins/mdtools/worker/attachTrajectory.ts` | `listAttachTargets` / `attachTrajectory` |
| `react-gui/src/plugins/mdtools/worker/trajBlocks.ts` | 拡張子 -> reader、block の追加、ヘッダの原子数 |
| `src/modules/mdtools/StructFrameReader.*` | `structframe` block reader |
| `src/modules/mdtools/TrajBlock.*` と各 reader | `getFileAtomCount` / `readFileAtomCount` |
| `src/qsys/ObjLoadEditInfo.*` | Undo -> Redo で renderer を戻す |

## テスト

- `useOpenFilePaths.test.tsx`: opener が引き取ったファイルが、普通のファイルの後に batch の scene で command に渡ること、
  単独なら「新しい scene」の設定でも active scene が渡ること。
- `plugins/mdtools/worker/attachTrajectory.test.ts`: 変換が 1 つの txn で、frame 0 の `structframe` が trajectory の前に
  付くこと。座標のファイルで開いた分子は `toXML2NoSubSrc` と座標のファイルの block、座標の無い分子は frame 0 の block
  無しで commit の後に view を合わせること。読み込みの失敗で全体が戻ること。候補の原子数による絞り込みと、断る理由 (MorphMol を出さない、行列・編集・
  ファイル無し)。
- `genericPropsService.test.ts`: object の型名がクラス名であること。
- `test_trajio.cpp`: renderer の付いた object を足す -> Undo -> Redo で renderer が残ること
  (`AddedObjectKeepsPreattachedRendererAcrossUndoRedo`)。`structframe` の block を持つ `Trajectory` を qsc に保存して
  読み直しても frame 0 が元の座標であること、DCD のヘッダだけで原子数が読めること
  (`StructFrameBlockKeepsStructureAsFrameZeroAcrossQsc`)。
