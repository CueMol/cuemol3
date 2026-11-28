# MD trajectory の op (console・MCP・AI agent)

MD trajectory を開く・block を足す / 消す / 並べ替える操作を、op catalog の op として console
(native / PyMOL dialect)、MCP、AI agent に出す仕組み。GUI (Open MD Trajectory dialog、drop、
Trajectory pane) と同じ mdtools plugin の service を通るので、どこから操作しても同じ結果になり、
同じ op として action log に記録される。

関連: [op catalog と console](op-catalog.md)、[action log](action-log.md)、
[MD trajectory を開く](md-trajectory-open-dialog.md)、[drop で trajectory を足す](md-trajectory-attach-on-drop.md)、
[Trajectory pane](md-trajectory-bottom-pane.md)、[PyMOL dialect](console-pymol-dialect.md)。

## 1. plugin から op を足す (`registerPluginOps`)

op catalog は core の op (`catalog/ops/*.ts`) に加えて、plugin が登録した op を持つ。

- plugin の worker モジュールが、service が登録されるとき (worker の起動時) に
  `registerPluginOps(pluginId, ops)` (`renderer/worker/server/catalog/index.ts`) を呼ぶ。
  mdtools は `plugins/mdtools/worker/mdtools.service.ts` で `TRAJ_OPS` (`trajOps.ts`) を登録する。
  plugin から core への向きなので、ESLint の依存の制約 (core は plugin を import しない) に合う。
- 名前が既にある op は登録を断る (例外)。
- 一覧は関数で読む: `allOps()` / `findOp()` / `toolOps()` / `toolsetOps(id)` / `mcpOps()` /
  `consoleCommandOps()`。worker の service は glob の順に評価されるので、console や agent のモジュールは
  mdtools より先に読まれる。一覧を module の評価時に固定すると、後から登録した op が入らない。
  - catalog は登録のたびに一覧を作り直し、次の登録まで同じ配列を返す。native dialect のコマンド表
    (`dialects/native/index.ts` の `nativeTables`) と agent の tool 表 (`plugins/agent/worker/tools/index.ts` の
    `toolTables`) は、catalog の配列が変わったときだけ作り直す。
  - 登録は worker の起動時に済むので、agent の tool 一覧 (cache される prompt の一部) が turn の間に
    変わることはない。
- mdtools の op は plugin の有効・無効に関わらず出る。C++ の mdtools module は常に読み込まれ、plugin の
  切り替えは GUI だけを隠す。

## 2. op

| op | 内容 | 呼ぶ service |
|---|---|---|
| `load_trajectory topology, paths [, reader, nevery, loadSel, rendererType, selection, name, rendererName, preset, centerView]` | topology と trajectory ファイルから Trajectory を新規作成する | `loadTrajectory` |
| `add_traj_block objId, paths [, reader, nevery, loadSel, replace]` | 分子か Trajectory に trajectory ファイルを block として足す。分子は Trajectory に変換し、自分の座標を frame 0 に残す | `attachTrajectory` |
| `list_traj_blocks objId` | block の一覧 (番号・ファイル・形式・frame 数・最初の frame)。読み取りだけ | `getTrajectoryState` |
| `remove_traj_block objId, index` | block を 1 つ消す | `removeTrajectoryBlock` |
| `move_traj_block objId, index, by` | block を `by` 段動かす (負で前、正で後) | `moveTrajectoryBlock` |

- 公開先: console のコマンド、MCP の tool、AI agent の toolset `md` (`enable_toolsets` で有効にする。
  core の tool は上限 21 に達しているため)。help の分類は、読み込み 2 つが `files`、block の操作が `animation`。
- block の番号は 0 から、frame の順 (`list_traj_blocks` の表示と同じ)。
- ファイルの一覧は param 種別 `paths` (下)。1 回の op で全ファイルを 1 つの undo txn で読む。
- `reader`: block reader の名前 (`dcdtraj` / `xtctraj` / `trrtraj` / `ambnetcdftraj` / `amberrst` /
  `namdcoortraj`)。指定すると全ファイルをその reader で読み、拡張子を見ない。省略時は拡張子で決める
  (`TRAJ_READER_BY_EXT`)。
- `nevery`: 各ファイルの N frame ごとに 1 つ読む。1 frame のファイル (restart など) には効かない。
- `loadSel` (読み込む原子の selection): 選ばれなかった原子は分子から取り除かれ、戻らない
  (`Trajectory::applyLoadSel`。最初の block より前にしか適用できない)。
  - `load_trajectory`: topology を読んだ直後、最初の block の前に適用する。
  - `add_traj_block` で分子を変換するとき: 変換直後、frame 0 の block (`structframe` / coord ファイル) の前に適用する。
  - 既に Trajectory の object への `add_traj_block`: frame の有無に関わらず `invalid-args` で断る
    (`replace` で block を外しても、消えた原子は戻らないため)。
- `replace` (`add_traj_block`): true なら既存の frame を置き換える。分子の変換では frame 0 を作らず、
  Trajectory では既存の block を後ろから全部外してから足す。全体を 1 つの undo txn にする。
  null / false は後ろに足す。
- `load_trajectory` の renderer の引数は load op と同じ (`applyRendererArgs`。指定した renderer は必ず作る)。
  未指定なら topology の reader の既定 (分子の preset)。

### `paths` 種別 (param DSL)

`paths(desc)` は複数のファイルを 1 つの引数で受ける (`catalog/params.ts`)。

- JSON Schema は string の配列。strict でない呼び出し元が文字列 1 つを送ったら、1 要素の配列として読む。
  空の配列は不可。
- native console: 引数の単語ごとに 1 ファイル。パターン (`*`, `?`) は展開し、一致しないものは warn する。
  console の cwd から解決する。Tab 補完は全ファイルを出す (File > Open の拡張子を優先しない。trajectory の
  拡張子は File > Open の一覧に無いため)。
- qax: ファイル 1 つにつき同じ名前の `<arg>` を 1 つ書き、読むときに順に集める (node の列と同じ)。
- help の型は `files (one or more, patterns allowed)`。

`load_file` (`load`) の `path` は、今までどおり 1 ファイルを 1 回の op にする (複数を書くと op を繰り返す)。
trajectory の block はまとめて 1 つの txn で読み、`replace` を 1 度だけ効かせるため、別の種別にしている。

## 3. native console の `load` と座標の無い topology

- `load x.dcd` のように trajectory のファイルを単独で開こうとすると、`"<file>" holds MD trajectory frames,
  which cannot be opened on their own. ...` と、`load_trajectory` / `add_traj_block` を案内して断る
  (`catalog/fileLoad.ts` の `trajectoryFramesError`)。
  - 判定: reader の作る object が `TrajBlock` のとき (拡張子・中身・名前のどれで選んだ reader でも)。
    reader が見つからず、拡張子が trajectory reader だけのものであるとき (DCD は中身の判定が無い) も同じ。
- psf / prmtop を座標無しで開いたとき (`noCoords`)、load の結果に `note: No coordinates: every atom is at
  the origin. Add them with add_traj_block <object>, <files>.` を付ける (console はこれを 1 行に出す)。

## 4. PyMOL dialect

`plugins/pymol-console/worker/commands/trajCommands.ts`。PyMOL の `load_traj` (`modules/pymol/importing.py`) に
合わせ、op `add_traj_block` に変換する。

| PyMOL | 対応 |
|---|---|
| `load_traj filename, object, state, format, interval, average, start, stop, max, selection, image, shift, plugin` | `add_traj_block` |
| `object` 省略 | ファイル名 (拡張子なし) と同じ名前の分子、無ければ最後に足された分子 (uid が最大のもの。`_guess_trajectory_object`)。MorphMol は対象外 |
| `state` | 1 (既定) は `replace: true` (PyMOL は state 1 から埋めるので、topology の座標も置き換わる)、0 は後ろに追加。それ以外は 0 として扱い warn |
| `interval` | `nevery` |
| `selection` | `loadSel`。PyMOL の式を CueMol に翻訳し、対象の object 名はその分子全体、ほかの object 名は none として読む (`moleculeSelections` と同じ)。`all` は指定なし |
| `format` | PyMOL の形式名 (`dcd` / `xtc` / `trr` / `nc` / `netcdf` / `rst` / `rst7` / `inpcrd` / `restrt` / `coor` / `namdbin`) を block reader に変換して `reader` に渡す |
| `average` / `start` / `stop` / `max` / `image` / `shift` / `plugin` | 対応が無いので warn して無視する (`max` は -1 と 0 以外のとき) |

- `load` に trajectory の拡張子 (`dcd` / `xtc` / `trr` / `nc` / `rst7` / `inpcrd` / `restrt` / `coor`) を
  `format` 無しで渡すと、`load_traj` と同じ処理で分子に足す。`load` の `state` の既定は 0 なので後ろに追加
  (PyMOL の `load` が DCD を直近の object に足すのと同じ)。このとき `state` は warn しない。
- `frame` / `count_states` は従来どおり Trajectory の `frame` / `nframe` を読み書きする。
- PyMOL dialect と ChimeraX dialect は、Trajectory も分子として扱う (`isMoleculeClass`)。`load_traj` の後の
  object に `color` / `show` / `count_atoms` などが効く。

block の一覧・削除・並べ替えは PyMOL に相当するコマンドが無いので、PyMOL dialect には出さない。

## 5. action log への記録

GUI の service は、自分の undo txn の中で対応する op を記録する (`plugins/mdtools/worker/recordTraj.ts`)。
op から呼ばれたときは op 自体が記録される (`recordOp` は op の実行中は何もしない)。

| service (GUI) | 記録する op |
|---|---|
| `loadTrajectory` (Open MD Trajectory dialog) | `load_trajectory` (renderer の引数は `recordLoadFile` と同じ形。renderer を作る前に記録する) |
| `attachTrajectory` (drop) | `add_traj_block`。変換で object の uid が変わる前に、元の分子を `objId` として記録する |
| `appendTrajectoryBlock` (Trajectory pane の Add) | `add_traj_block` (ファイル 1 つ) |
| `removeTrajectoryBlock` | `remove_traj_block` |
| `moveTrajectoryBlock` | `move_traj_block`。行き先を `by` (動いた段数) で記録する |

## 6. 範囲外

- frame の範囲 (`start` / `stop` / `max`)。C++ の block reader に範囲指定の property が無い。
- DCD の中身による判定、AMBER の ASCII trajectory (`.crd` / `.mdcrd`)、GROMACS の `.top`。
- PyMOL の `intra_fit` / `smooth` / `split_states` など ([260928](../plans/260928-pymconsole-remaining-plan.md))。

## 主要ファイル

| ファイル | 役割 |
|---|---|
| `renderer/worker/server/catalog/index.ts` | `registerPluginOps`、一覧の関数 |
| `renderer/worker/server/catalog/params.ts` | `paths` 種別 |
| `plugins/mdtools/worker/trajOps.ts` | 5 つの op |
| `plugins/mdtools/worker/recordTraj.ts` | GUI の service が記録する op |
| `plugins/mdtools/worker/trajBlocks.ts` | `reader` の指定、`applyLoadSel` |
| `plugins/pymol-console/worker/commands/trajCommands.ts` | PyMOL の `load_traj`、`load` からの振り分け |

## テスト

| テスト | 固定している契約 |
|---|---|
| `plugins/mdtools/worker/trajOps.test.ts` | 後から登録した op が native console・MCP・agent の toolset・`findOp` に出る。名前の重複を断る |
| `plugins/mdtools/worker/attachTrajectory.test.ts` | `replace` が 1 txn で block を外してから足す。`loadSel` は変換で frame 0 の前に適用し、Trajectory には断る |
| `plugins/mdtools/worker/recordTraj.test.ts` | GUI の記録が op の引数として読み戻せる。`by` の形。ファイルの列が qax を通っても順に残る |
| `plugins/pymol-console/worker/commands/trajCommands.test.ts` | 対象の推定、`state` -> `replace`、`interval` -> `nevery`、selection の翻訳、warn。`load` からの振り分け |
