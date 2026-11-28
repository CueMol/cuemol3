# console (native / PyMOL) からの MD trajectory 操作 計画

Status: **未実装 (着手前)**。

関連:
- [261013 MD trajectory の編集を op として記録する](261013-action-record-coverage-plan.md) -- この計画で全項目が済む
- [261011 op / console / MCP の backlog](261011-op-console-backlog-plan.md) §2 の MD 行
- [260928 PyMOL dialect の残り](260928-pymconsole-remaining-plan.md) §1 の `load_traj` 行
- 実装済みの仕様: [op catalog と console](../architecture/op-catalog.md)、
  [console PyMOL dialect](../architecture/console-pymol-dialect.md)、
  [MD trajectory を開く](../architecture/md-trajectory-open-dialog.md)、
  [drop で trajectory を足す](../architecture/md-trajectory-attach-on-drop.md)、
  [lazy loading](../architecture/md-trajectory-lazy-loading.md)

## Context

console (native / PyMOL dialect) から MD trajectory を読み込む手段が無い。

- native の `load x.xtc` は reader が `target Trajectory not found` で失敗する。`.dcd` は
  content sniff が無いので `No reader can handle` になる。どちらもメッセージが原因を指さない。
- PyMOL dialect の `load` は拡張子から trajectory reader を選んで `load_file` に渡し、同じく失敗する。
  `load_traj` は未実装。
- topology (`psf` / `prmtop` / `gro`) は普通の MolCoord として開ける。psf / prmtop は座標が無い
  (`noCoords`) が、console には何も出ない。
- 読み込みの処理は mdtools plugin の worker (`plugins/mdtools/worker/loadTrajectory.ts` /
  `attachTrajectory.ts` / `trajectory.ts`) にあり、C++ の追加は要らない。
- console は書き込みをすべて op catalog (`runOp`) 経由で行うが、op catalog (`OPS`) は core の op だけの
  閉じた配列で、plugin から op を足す仕組みが無い。core は `@plugins/*` を import できない
  (ESLint `NO_PLUGIN_INTERNALS`)。

GUI では trajectory を開く・block を追加 / 削除 / 並べ替えできるが、console と MCP からはどれもできない。

## 決定事項

- mdtools plugin が op を登録できる仕組みを作り、MD の 4 op を足す。
- 4 op は native / PyMOL の両 dialect、MCP、AI agent に公開する。mdtools plugin の有効・無効に
  関わらず使える (C++ module は常に読み込まれ、plugin の切り替えは GUI だけを gate する)。
- PyMOL の `start` / `stop` / `max` は warning を出して無視する。`interval` は `nevery` に対応させる。
- 既存 frame を残すか置き換えるかは op の `replace` 引数で決め、既定値は dialect ごとに変える。
  PyMOL は `state=1` (既定) で置き換え、`state=0` で後ろに追加。native は既定で追加、`replace=true` で置き換え。

## Phase 0: 着手時

1. ブランチ `feat/console-md-traj` を作る。
2. `bump-rev-build` で revision+1 / build+1 (3.0.6.577 -> 3.0.7.578)。
   `chore(version): bump version 3.0.6.577 -> 3.0.7.578` で最初のコミットにする。

## Phase 1: plugin から op を登録する仕組み (worker 側)

- catalog に `registerPluginOps(pluginId, ops)` を足し、plugin の worker モジュールが起動時に呼ぶ
  (`registerDialect` と同じ形。plugin -> core の向きなので ESLint の制約に合う)。
- module 読み込み時に固定で作っている次を、関数で取得する形に変える (plugin の worker モジュールは
  service の glob 順で評価されるので、固定配列のままだと後から登録した op が入らない):
  - catalog (`catalog/index.ts`): `OPS` / `findOp`、`CONSOLE_COMMAND_OPS`、`TOOL_OPS`、`MCP_OPS`
    (`mcp.service.ts` の `listTools` が参照)
  - native dialect の `GENERATED`
  - AI agent (`plugins/agent/worker/tools/index.ts`): `TOOLSET_TOOLS` / `TOOLSET_OF` / `AGENT_TOOLS` /
    `ALL_AGENT_TOOLS`
- core の tool (`expose.tool: 'core'`) は上限 (`MAX_TOOLS = 21`) に達しているので、MD の 4 op は
  新しい toolset `md` (`ToolsetId` に追加) に入れる。agent は `enable_toolsets` で `md` を有効にしてから使う。
- 記録 (History / Actions / qax) は op の実行側ではなく service 側で行う既存の方式に従う (Phase 2)。

## Phase 2: mdtools の op

| op | 内容 | 主な引数 | 使う既存処理 |
|---|---|---|---|
| `load_trajectory` | topology と trajectory ファイルから Trajectory を新規作成 | topology、trajectory ファイル (複数可、glob 可)、`reader`、`nevery`、`name`、renderer、`loadSel` | `loadTrajectory` |
| `add_traj_block` | 既存の Trajectory に追加。MolCoord なら Trajectory に変換してから追加 | object、ファイル、`reader`、`nevery`、`loadSel`、`replace` | `attachTrajectory` |
| `remove_traj_block` | block を削除 (frame 0 の block も可) | object、block の番号 | `removeTrajectoryBlock` |
| `move_traj_block` | block を並べ替え | object、block の番号、`by` (動かす段数) | `moveTrajectoryBlock` |

- `replace=true`: 変換時に frame 0 を作らない。既に Trajectory なら既存の block を外してから追加する。
  全体を 1 つの undo txn にまとめる。
- `reader` (省略可): trajectory ファイルの reader 名。省略時は今と同じく拡張子から決める
  (`TRAJ_READER_BY_EXT`)。`appendTrajFile` に reader の指定を足す。PyMOL の `format` はこれに変換する。
- `loadSel` は選択外の原子を MolCoord から取り除く不可逆な処理 (`Trajectory::applyLoadSel`) で、
  最初の block より前にしか適用できない。
  - `load_trajectory`: topology を読んだ直後、最初の block の前に適用する。
  - `add_traj_block` で MolCoord を変換するとき: 変換直後、frame 0 の block (`structframe` / `coord`)
    を足す前に適用する。
  - 既存の Trajectory への `add_traj_block`: `replace=true` で block を外しても消えた原子は戻らないので、
    `loadSel` の指定は frame の有無に関わらず `invalid-args` で失敗させる。
- 記録: 次の service の undo txn 内で `recordOp` を呼ぶ。op はこれらの service を呼ぶので、GUI
  (Open MD Trajectory dialog / drop での attach / Trajectory パネル) と console のどちらから操作しても
  同じ op で記録される。
  - `loadTrajectory` -> `load_trajectory`
  - `attachTrajectory`、`appendTrajectoryBlock` (Trajectory パネルの Add) -> `add_traj_block`
  - `removeTrajectoryBlock` -> `remove_traj_block`、`moveTrajectoryBlock` -> `move_traj_block`
- `move_traj_block` の `by` は、ほかの一覧の並べ替え op と同じ記録形式にする。
- native の `load` に trajectory ファイルを単独で渡したら、「topology が必要。`load_trajectory` /
  `add_traj_block` を使う」という分かるエラーにする。
- psf / prmtop を座標無しで開いたとき (`noCoords`) に console へ一言出す。

## Phase 3: PyMOL dialect

PyMOL の仕様 (`pymol-open-source/modules/pymol/importing.py` の `load_traj` /
`_guess_trajectory_object`) に合わせる。

| 項目 | 対応 |
|---|---|
| `load_traj filename, object, state, format, interval, average, start, stop, max, selection, image, shift, plugin` | `add_traj_block` に変換する |
| `object` 省略 | ファイル名 (拡張子なし) と同じ名前の object が無ければ、最後の object |
| `state` | 1 (既定) は `replace=true`、0 は `replace=false`。2 以上は warning を出して後ろに追加 |
| `interval` | `nevery` |
| `selection` | `loadSel` (`all` のときは渡さない) |
| `format` | 拡張子の代わりに reader を決める (`trj` / `netcdf` の別名を含む) |
| `start` / `stop` / `max` / `average` / `image` / `shift` / `plugin` | 無視して warning |
| `load` に trajectory の拡張子 | `load_traj` と同じ経路で直近の object に追加する |

- block の削除・並べ替えは PyMOL に相当コマンドが無いので PyMOL dialect には出さない (native の op で操作する)。

## Phase 4: 検証 (検証チェーンの順)

1. `task build_tritium` / `task run_tritium`、`task run_tritium_cli -- -c '...'` で試す。
   - native: `load_trajectory` -> `add_traj_block` (既定と `replace=true`) -> `remove_traj_block` ->
     `move_traj_block` -> undo / redo
   - PyMOL: `load x.psf` -> `load_traj x.dcd` (`state=1` と `state=0`) -> `count_states` / `frame`
   - GUI の Trajectory tab への反映、History の op の行、MCP の tool 一覧を確かめる
   - GUI (Open MD Trajectory / drop / Trajectory パネルの Add・削除・並べ替え) の操作も History に
     op の行として出て、Save to Actions した qax を別の scene で Run できることを確かめる
2. ユーザーの目視確認。
3. 挙動が確定してからテスト (6 件程度):
   - plugin op が catalog・native コマンド・tool 一覧に出る
   - `add_traj_block` の `replace` が 1 つの undo txn で既存 block を置き換える
   - `load_traj` の引数の対応 (object の推定、state -> replace、interval -> nevery、warning)
   - `load` が trajectory の拡張子を trajectory の経路に回す
   - 4 op の記録の形 (`actionLog.test.ts` の表)
4. `tsc` (web / node) と `task lint_tritium_style`。

## Phase 5: ドキュメント

- architecture へ書き起こす: `op-catalog.md` (plugin op)、`console-pymol-dialect.md` (`load_traj`)、
  `md-trajectory-*.md` (op の経路)、`action-log.md` §2.2 / §2.3 (記録の形)。
- 済んだ項目を plan から消す: 260928 の `load_traj` 行、261013 はファイルごと削除、261011 の MD 行。
  この plan も削除し、`_index.md` の行を消す。

## 範囲外 (別タスク候補)

- console からできない GUI 操作のうち MD 以外 (261011 §2: style / scene / レンダリング 2 件 / symm の Center)
- frame 範囲の指定 (start / stop) の C++ 対応
- DCD の content sniff、`.crd` / `.mdcrd` reader、GROMACS の `.top`
- `intra_fit` / `smooth`
