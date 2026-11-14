# Console の ChimeraX dialect (ChX console)

console plugin の ChimeraX dialect (呼び名は「ChX console」、prompt `ChX>`、dialect id `chimerax`、
UI の表示は「ChimeraX」) の仕様。ChimeraX のコマンド言語に**部分互換**のコマンドを、ChimeraX の
名前・引数・atom specification で受け付ける。完全互換は目標にしない。
dialect の一覧、`DialectSyntax`、runtime (1 submit = 1 txn、Stop、script、log) は
[op-catalog.md](op-catalog.md) §5 にある。ここには ChX にしか無い部分を書く。
まだ無いコマンドの候補は [残りの計画](../plans/261103-chimerax-console-plan.md) にある。

ChimeraX のソース (`~/ext/ChimeraX/src/bundles/`) のうち、写したものの出どころ:

| ChimeraX | ChX |
|---|---|
| `core/src/commands/cli.py` (コマンド名・引数・型) | `worker/cli/` |
| `core/src/commands/_atomspec.peg`、`atomspec.py` | `worker/spec/` |
| `atomic/src/selectors.py`、`std_commands/src/selectors.py` | `spec/selectors.ts` |
| `core/src/colors.py` (CSS4 の色名)、`atomic/src/colors.py` (Jmol の元素色) | `colorTables.ts` (生成したデータ) |
| `std_commands/bundle_info.xml` (コマンドの登録順) | `commands/registry.ts` |

## 1. 位置づけ

- built-in plugin `chimerax-console` (表示名「ChX console」、既定オン) として、console plugin に dialect を足す
  ([op-catalog.md](op-catalog.md) §5)。パーサとコマンドは TS で Web Worker に置く (`plugins/chimerax-console/worker/`)。
  plugin をオフにすると、console の切り替えと `tritium_cli` から消える。
- **コマンドは ChimeraX の文法を読み、op catalog の op の列に変える層**。op は `invokeOp` で呼ぶ
  (`display.ts` の `runOp`、`opContextOf(cc, 'chx')`)。agent・MCP・native console と同じ操作の定義を通るので、
  引数と selection の検査、ファイルの書き込み先の制限、操作の記録 (action log に native の op として残る) が揃う。
  ChX 独自の記録形式は無い。
- worker service を直接呼ぶのは、op にしない読み取り専用の補助 ([op-catalog.md](op-catalog.md) §3.1) だけ:
  renderer の property の読み取り (`props/read`)、paint の状態 (`coloring/panelList`)、file の reader 判定
  (`file/getCompatibleRendererNames`)、selection のコンパイル (`helpers/makeSel`)、scene の取得
  (`helpers/sceneResolver`)、object の一覧 (`scene/listSceneObjects`)。
- 意味が一致するものだけ移す。近いもので違う結果を出すより、理由を言って断る。読めるが未対応の
  keyword は受け付けて `<cmd>: <keyword> is not supported yet; ignored` と warn し、スクリプトを先へ進める。
- **断ったものは飛ばして最後まで続ける。想定外の誤りだけで止める**。ChimeraX の script を流したときに、未対応の
  1 か所でそれ以降が止まると見た目の再現がそこで途切れるため。
  - 想定内の未対応 (断るキーワード・値・コマンド、ChX の atom spec で断る書き方、ChimeraX にあって ChX に無い
    コマンド) は、結果に `unsupported` の印を付けて返す (`commands/warn.ts` の `unsupported()`、spec は
    `SpecError` / `ArgError` の `unsupported`)。console 共通の実行部 (`runtime/runCommand.ts` の `runLines`) が
    `Warning: <理由>; skipped` と出して次のコマンドへ進む。
  - ChimeraX にあって ChX に無いコマンドは、ChimeraX 1.12 のソースの bundle の metadata から生成した名前の一覧
    (`chimeraxCommands.ts`。先頭の語 203 と、複数語の名前 233) で判定する (dialect の `unsupportedCommand`)。完全一致か、
    ChimeraX と同じく曖昧でない前方一致 (`fit` → `fitmap`)。ChX にある語で始まる行は、ChimeraX にその 2 語の
    コマンド (`alphafold match`) があるときだけ飛ばす。
  - 想定外 (書式の誤り、atom spec の誤り、存在しない model、ChimeraX にも無い名前、実行時の失敗) は今どおり止める。
    飛ばしたコマンドが作るはずだった model を後のコマンドが指した場合 (`molmap` を飛ばした後の `vol #3 ...`) も、
    参照の誤りとして止める。
  - `volume` の断るキーワード (`encloseVolume` など) は、他のキーワードと独立した表示設定なので、そのキーワード
    だけ warn して飛ばし、残り (`color` など) は適用する。出力そのものが変わるキーワード (`save` の
    `selectedOnly`、`align` の `each` など) は、コマンドごと飛ばす。
- **分離**: console の内部は `@plugins/console/worker/dialect-api` (と `shared/dialectMeta`) からしか使わず、
  PyMOL の plugin とは互いを import しない。console も この plugin を import しない (登録を通して受け取る)。
  eslint (`eslint.config.mjs`) が、この向きと worker service の許可リストを検査する。ChX を外すには、
  `plugins/chimerax-console/` と `plugins/index.ts` の 1 行を消せばよい。

### `DialectMeta` の値 (`plugins/chimerax-console/shared/meta.ts`)

| 項目 | 値 |
|---|---|
| `prompt` / `label` | `ChX>` / `ChimeraX` |
| `txnPrefix` / `actionSource` | `chx: ` / `chx` |
| `historyKey` | `cuemol.console.history.chimerax` |
| `scripts` | `.cxc` (`submit: 'text'`: `tritium_cli` は中身を ChX の submit として送る) |

## 2. 行の読み方 (`cli/`)

- **split** (`cli/syntax.ts` の `splitLines`): 改行と、引用符の外の `;` で分ける。コマンド名の位置の `#` から行末は
  コメント。引数の中の `#` は model (`#1`) か色 (`#ff0000`)。行末 `\` の継続は無い (Windows パスが壊れるため)。
- **コマンド名** (`resolveWords`。cli.py の `_find_command_name`): 語ごとに完全一致、無ければ**登録順で最初の
  前方一致**を採る。ambiguous の error にはしない (`col` -> `color`、`del` -> `delete`、`c` -> `camera`、`car` -> `cartoon`)。続く語を
  sub-command として探し (`cartoon hide`)、当たらない語でコマンド名は終わる。打った語の大文字小文字は変えずに
  比べる (cli.py の `subcommands.get(word)` / `startswith(word)`): `select C & :sti` の `C` (炭素) は `select clear` の
  省略にならず、`Open` は知らないコマンド (ChimeraX と同じ)。registry は ChimeraX の登録順に並べ、
  `help` は名前順に出す。
- **引数** (`bindLine`。cli.py:3010-3080): 必須の位置引数 -> 任意の位置引数 -> keyword の順。
  - 任意の位置引数は、読めない語か、keyword の前方一致の語で終わる。ただし atom specification の引数
    (`mayBeEmpty`。cli.py の `Or(ObjectsArg, EmptyArg)`) は、無くても次の任意の引数へ進む (`color red`、`col byh`)。
  - keyword は前方一致。打った語の大文字小文字は変えず、keyword そのものか keyword を小文字にしたものが打った語で
    始まれば当たる (cli.py の `_start_of_keywords`: 「`show O` を直すため」)。`color C & :ber red` の `C` や `show O` の
    `O` は、`color` / `objects` の省略ではなく spec になる。候補が 1 つならそれ、複数なら camelCase の語数が最少の
    ものが 1 つならそれ。
    同じ keyword を 2 回書くと error。snake_case で打った語 (`bg_color`) は、ChimeraX の `user_kw` と同じく camelCase
    (`bgColor`) に直してから照合する (`_` で分け、2 語目以降の頭を大文字に)。
  - 失敗は行の下に caret を付けて示す。
- **型** (`cli/argTypes.ts`): `StringArg` (escape を処理する)、`FileNameArg` (引用符を外すだけで escape を処理しない。
  cli.py:1208 と同じく `"C:\Users\x.png"` を壊さない)、`FileNamesArg` (次の keyword までファイル名を続けて読む。
  cli.py の `OpenFileNamesArg`。`repeats` の型で、値は `\n` でつないで渡し `splitRepeated` で分ける)、`BoolArg`、
  `IntArg` / `FloatArg`、`EnumOf` (完全一致を優先、一意な前方一致、ambiguous は error)、`Or`、`ListOf` (カンマ区切り。
  cli.py の `Aggregate.parse` と同じく、まず引用符の外の次のカンマまでを切り出し、その部分だけを中の型に読ませる。
  語全体を読む `EnumOf` に `atoms,ribbon` を 1 語として渡さないため)、`NoArg`、`ColorArg`、`SpecArg`、`RestOfLine`。
  値は正規化した文字列で `run` に渡る (enum は正式名、bool は `true` / `false`、色は `#rrggbb`、spec はその文字列)。
- **色** (`colors.ts`): builtin の色名 (大小無視、`spring green` のように空白入りも。3 語まで) と `#rgb` /
  `#rrggbb` / `#rrggbbaa` (alpha は捨てる)。`rgb()` / `hsl()` と利用者定義の色名はまだ読まない。
- **Tab** (`cli/complete.ts`): 1 語目はコマンド名、以降はそのコマンドの keyword と、引数の型が持つ値 (enum、色名、
  selector 名) とファイル。選んだ値の後には空白を付ける (keyword は語として書く。`name=` や `, ` は書かない)。
  空白を含むファイル名は引用符で囲む。
- atom specification を取る引数で `#` か `#1` まで打って Tab を押すと、今の scene の model 番号を名前付きで並べる
  (`#1 1crn`)。番号を振っていない object にはここで振る (§4)。`#1/A:10` と続けることが多いので、後に空白を付けない。

## 3. atom specification の翻訳 (`spec/`)

- `parse.ts` は `_atomspec.peg` の再帰下降。spec は 1 つの引数なので、spec として読めるところまで読み、どこで
  止まったかを返す。`#ff0000` (16 進の数字が続く `#`) は model ではなく色、selector でない語 (`red`) で spec は終わる。
- 演算子 `&` `|` `~` と括弧は ChimeraX と同じく優先順位が無く右結合。空白で区切った項は和 (`#1 #2`)。model の部分を間を空けずに続けた項も和 (`#1/k#2/o`。`_atomspec.peg` の `hier+`)。
- `emit.ts` は木を**object ごと**に、その object の model 番号で CueMol の式にする。別の model を指す部分はその
  object では `none` になり、式が `none` の object には何もしない。`#1/A | #2/B` は #1 では `chain A`、#2 では
  `chain B` (両方で `chain A or chain B` にはしない)。全項を括弧で包む。

| ChimeraX | CueMol |
|---|---|
| `#1`、`#1,3-5` (model)、`#!1` | model 番号で object を選ぶ。`#!1` (sub-model を含まない model 1) は、CueMol の object に sub-model が無いので `#1` と同じ |
| `/A,B` | `chain A,B` |
| `/a-h` (chain の範囲) | その model に実在する chain ID のうち範囲に入るもの (`chain a,b,...`)。ChimeraX と同じく文字列として比べ (`atomspec.py` の `string_matcher`)、大文字小文字は、構造に小文字の chain ID があるときだけ区別する (`structure.py` の `lower_case_chains`) |
| `:10-20,30`、`:10A`、`:10A-20B` | `resi 10:20`、`resi 30`、`resi 10A`、`resi 10A:20B` |
| `:ALA`、`:5HT` | `resn ALA`、`resn 5HT` |
| `@CA,CB` | `name CA,CB` |
| `all` / `protein` / `nucleic` / `ligand` / `solvent` / `helix` / `strand` / `coil` | `*` / `protein` / `nucleic` / `ligand` / `water` / `helix` / `sheet` / `coil` |
| `sel` (今の選択) | 各分子の今の選択 (object の `sel`) の式。選択の無い分子では `none`。選択を書き換えるコマンド (`select sel ...`) でも、書き換える前の値から読む |
| `selAtoms` (ChimeraX `shortcuts.py`) | scene のどこかに選択があれば `sel` と同じ式、どの分子にも選択が無ければ全原子 (`*`) |
| ChX の名前 (`name X spec` で定義したもの) | その spec の文字列を、使う場所で object ごとに翻訳したもの (下記「名前」) |
| scene の名前付き selection の名前 (GUI などで作ったもの) | その名前 (CueMol の参照)。行を読む直前に、runtime が `bind` に渡す scene から名前の一覧を読む (`names.ts`、`withSceneSelectors`)。同じ名前が ChX の名前にもあれば、ChX の名前を使う |
| `backbone` / `mainchain`、`sidechain` / `sideonly` | 原子名で展開した式 |
| `ions` (近似) | ligand の残基の金属とハロゲンの原子 (`atomClasses.ts`。ChimeraX は 1 原子のイオンの残基を構造から決める) |
| `HC` (近似) | protein の炭素に付いた水素を、標準残基の極性水素の名前の裏で (`atomClasses.ts` の `NONPOLAR_H`。ChimeraX は IDATM 型) |
| 元素記号 (`C`、`Fe`) | `elem Fe` |

- 残基番号か残基名かは `atomspec.py` の `_Part._parse_as_res_id` と同じ: 範囲の両端が `[-+]?数字[英字1つ]?` なら
  残基番号 (末尾の英字は insertion code)、そうでなければ残基名。数字は整数に直して書く (CueMol の `SEL_INSRES` は
  `010A` を受け付けない)。範囲の端の `start` / `end` は `-99999` / `99999` にする (CueMol に開いた範囲は無い)。
- **wildcard** (`*` `?` `[...]`、`[!...]`): chain・残基名・原子名で、CueMol の正規表現 (PCRE) にする。`@C*` は
  `name /(?i)^C.*$/`。ChimeraX の名前の照合は大文字小文字を区別しないが、CueMol の正規表現は区別するので `(?i)` を付ける。
  `/` は `\/` に逃がす。文字としての `*` を CueMol の名前にそのまま渡すと、何にも当たらない (CueMol の名前の照合は
  完全一致) ので、必ず正規表現にする。
- **zone** (`X @< 5`、`atomspec.py` の `_ZoneSelector`): ChimeraX と同じく全 model を探す。model m では
  `(X_m) expand d` に、他の model k ごとの `(X_k) around d ["name_k"]` を足したもの (W とする) を使う。`expand` は
  基準の原子も含む (ChimeraX の `<` と同じ)。

  | ChimeraX | CueMol |
  |---|---|
  | `@< d` / `@> d` | `W` / `not (W)` |
  | `:< d` / `:> d` | `byres (W)` / `not (byres (W))` |
  | `/< d` / `/> d` | W に当たる原子の chain を worker で読んで `chain A,B` / その否定 |
  | `#< d` / `#> d` | W が何かに当たれば `*`、でなければ `none` / その逆 |

  境界は ChimeraX が `<=`、CueMol が `<` (距離がちょうど d の原子だけが違う)。model の名前が重なると、`around` の
  対象が別の model になりうる。chain・model 単位の zone の読み取りは `display.ts` の `emitContext` (原子を数えるだけ)。
- **属性 test** (`@@` 原子、`::` 残基、`//` chain、`##` model。`,` で並べたものは全部を満たすもの):

  | ChimeraX | CueMol |
  |---|---|
  | `@@bfactor` / `@@occupancy` の `>` `<` `=` | `bfac > v` などそのまま |
  | `>=` / `<=` / `!=` | `not (bfac < v)` / `not (bfac > v)` / `not (bfac = v)` (CueMol の比較は `=` `<` `>` だけ) |
  | `@@name`、`@@element`、`::name`、`::chain_id`、`//chain_id` | `name`、`elem`、`resn`、`chain`。`=` は大文字小文字を区別しない wildcard の照合、`==` は区別する完全一致 (正規表現)、`!=` / `!==` はその否定 |
  | `::number` の比較 | `resi` の範囲 (`>=100` は `resi 100:99999`) |
  | `::polymer_type=0/1/2`、`::ss_type=0/1/2` | `not (protein or nucleic)` / `protein` / `nucleic`、`coil` / `helix` / `sheet` |
  | `::is_helix`、`::is_strand` (`^` で否定) | `helix`、`sheet` |
  | `::kdHydrophobicity` の比較 | 値が条件を満たす標準アミノ酸の残基名の列 (`resn ILE,VAL,...`)。Kyte-Doolittle の値は残基名ごとの表なので、名前の列に直せる。標準でない残基は値が無いので当たらない |
  | `##name=...` | object の名前を worker で照合して `*` / `none` |

  CueMol に無い属性 (`serial_number`、`alt_loc`、`idatm_type`、`radius`、`insertion_code` など) は断る。
- **名前** (`chxNames.ts`): ChimeraX の `name X spec` は spec の**文字列**に名前を付け、使うたびに評価し直す (model
  番号も使うときに解決する)。CueMol の名前付き selection は分子ごとに評価する 1 つの式で、「この分子だけ」を書けない
  (`SelNodes.hpp` に分子の node が無い) ので、ChX は scene ごとに「名前 -> spec の文字列」の表を worker のメモリに持つ
  (model 番号・alias と同じく、scene の状態ではなく、保存も undo もされない。消えた scene の表は、次に表を読むときに
  捨てる)。spec の中の名前は、object ごとに翻訳するときにその文字列を読んで同じ object で翻訳する (`emit.ts` の
  `expandName`) ので、`name ALC1 #2/k,l` は #2 だけに当たり、名前の中で名前を使える。自分自身を使う名前 (`name a b`、
  `name b a`) と 10 段より深い入れ子は、翻訳の誤りとして断る。
- 未対応のもの (sub-model `#1.2`、上の表に無い属性、引用符付きの名前、CueMol に無い selector (`ions`、
  IDATM 型など)) は、caret 付きの「not supported yet」で断る。

## 4. model 番号 (`models.ts`)

- ChimeraX は新しい model に使われていない最小の番号を振る (`core/models.py` の `Models.next_id`)。close した
  model の番号は次に開いたものが使う (`#1 #2 #3` から `#2` を閉じて開くと `#2`)。開いている model の番号は
  変わらない。scene ごとに `objUid -> N` を worker のメモリに持つ。これは scene の状態ではない、名前の付け方の補助表。
- 初見の object (GUI で開いたもの、undo / redo で戻ったもの、開き直した scene のもの) には scene 内の順で空いて
  いる最小の番号を振る。scene に無い uid の entry は先に捨てて番号を空ける (undo で消えた object を指さない)。
- 制約: scene を保存して開き直すと番号は振り直しになる (ChimeraX の session とは違う)。

## 5. 表示の状態 (`display.ts`)

ChimeraX は原子ごとに display と style、残基ごとに ribbon の表示を持つ。ChX はこれを molecule ごとの自前の
renderer で表し、**その selection と paint が表示の状態そのもの**とする。メモリにも別の保存先にも写しを持たない。

| renderer | 種類 | style | selection の意味 |
|---|---|---|---|
| `chx:stick` | `ballstick` | `StickBallStick,DefaultCPKColoring` | stick で表示中の原子 |
| `chx:ball` | `ballstick` | `DefaultBallStick,DefaultCPKColoring` | ball で表示中の原子 |
| `chx:sphere` | `cpk` | `DefaultCPK,DefaultCPKColoring` | sphere で表示中の原子 |
| `chx:cartoon` | `ribbon` (helix を円柱にする間は `cartoon`) | `DefaultRibbon,DefaultHSCPaint` | ribbon を表示する残基 (`protein` に限る) |
| `chx:nucl` | `tube` (pivot P、断面は DefaultNucl の形を property で) | `DefaultHSCPaint` | 同 (`nucleic` に限る)。主鎖の tube |
| `chx:nuclbase` | `nucl` (`show_tube=false`) | `DefaultNucl` | 塩基の板 / ladder を描く残基。cartoon と同じに動く (`nucleic` に限る) |

- 6 つは、ChX が molecule に最初に触れたときにまとめて作る (表示しない間の selection は `none`)。名前が `chx:` で
  ない renderer には触らない。
- コマンドのたびに今の selection を読み、組み合わせて、`set_renderer_selection` で書き戻す。show は OR、hide は
  AND NOT (PyMOL dialect と同じ考え方)。どれも submit の undo txn の中の op なので:
  - undo / redo (console からでも GUI の Cmd+Z からでも) で scene が戻れば、次のコマンドが読む状態も戻る。
    ChX 用の undo の仕組みは無い。
  - GUI で `chx:` renderer の selection や paint を変えれば、それが次の ChX コマンドの出発点になる。
  - qax に書き出して再生すれば、ChX で作った表示がそのまま再現する。
- `show <spec> atoms`: spec の原子のうち、まだどの atom renderer にも無いものを `chx:stick` に足す。
  `hide <spec> atoms`: 3 つから引く。`style <spec> <s>`: 表示中の原子のうち spec に当たるものを他の 2 つから引いて
  `<s>` に足す。`cartoon` / `cartoon hide`: ribbon の 2 つと `chx:nuclbase` に足す / 引く。`show` / `hide ... models` は object の
  `set_visible`。
- `show <spec> <what> only` (show.py の `only`): 指定した分子の中で、同じ種類の表示を spec 以外から引いてから spec を
  足す (atoms は 3 つの atom renderer、cartoons は ribbon の 2 つ、surfaces は `showsel`)。`models` を含むときは、
  ChimeraX の `show_models` と同じく、scene の指定外の object を `set_visible` で隠す (spec を省いたときは全部が
  指定なので隠すものは無い)。`hide` に `only` は無い (ChimeraX と同じ)。
- **色**: target の atom 系 (a / b) は 3 つの atom renderer に**同じ** paint entry を、cartoon 系 (c / r) は ribbon の
  2 つに入れる (`add_paint_at` で先頭に。後から入れた色が勝つ)。renderer をまとめて作ってあるので、`color red
  target a` の後に style を変えても赤のまま。paint への切り替え (`set_renderer_coloring` の `paint-type-paint`) は、
  まだ PaintColoring でない renderer にだけ行う (`ensurePaint`。renderer の coloring の class を見る。GUI のパネルの
  `canPaint` は分子に選択が無いと false になるので、判定に使うと選択の無いときに毎回切り替えてしまう)。`setRendererColoring` は呼ぶたびに新しい表を作るので、
  毎回切り替えると `color /A red; color /B blue` の 2 回目で A の赤が消える。
- 分子全体 (spec が `#1` や省略で、その分子の式が `*`) を全原子に当たる色 (単色、`bychain`、`bymodel`) で塗るときは、
  先に対象の renderer の paint を `clear_paint` で消してから入れる。前の entry はもう表に出ないので、同じ分子に
  `color` を繰り返しても表が伸び続けない (表が長いほど paint の操作と描画が重くなる)。炭素を残す `byhetero` /
  `byelement` と、spec が分子の一部のときは消さずに重ねる (どの entry が隠れたかの判定はしない)。
- `byhetero` は炭素以外、`byelement` は炭素も、元素ごとの entry (Jmol の色) を入れる。atom の renderer だけに入れ、
  cartoon の色は変えない (ChimeraX と同じ)。entry を作る元素は生体分子と ligand に多いものに限る (`PAINTED_ELEMENTS`)。
- `bychain` / `bymodel` は atom・cartoon・surface のどれにも入れる (`colorSchemes.ts`)。
  - `bychain`: spec の触れる chain ごとに `chain X` との積の entry。色は ChimeraX の表 (`atomic/colors.py`
    `chain_colors`、a-z と 0-9、大文字小文字を区別しない)。表に無い chain id には、ChimeraX は id を seed にした Python の
    乱数で色を作るので再現できない。同じ範囲 (128-255) の色を id の hash から作り、違うことを warn する。
  - `bymodel`: model の色 (`atomic_color_names`: #1 tan、sky blue、plum、light green、salmon、light gray、deep pink、
    gold、dodger blue、purple)。11 番目以降は表を回して warn する (ChimeraX は他と見分けやすい色を作る)。
  - `bynucleotide`: 核酸の残基を塩基の種類で塗る (ChimeraX の `nucleotide_colors`、NDB の色を薄めたもの: A 赤、T 青、
    G 緑、C 黄、U 水色、I 深緑、PSU 薄灰、その他は灰色)。残基名の選択 (`resn A,DA` など) の entry。核酸以外は塗らない
    ので、分子全体でも表を消さずに重ねる。
  - `bypolymer` / `byidentity` は「not supported yet」(配列ごとのランダムな色。ランダムに色を付ける機能自体を作らない)。
  - `random` は断る。ChimeraX は原子ごとの乱数の色で、paint では原子 (残基で近似しても残基) の数だけ entry が要る。
    約 2000 残基の分子で 1 万回の `add_paint_at` になり、GUI が長く busy になった。使われる場面も少ない。
- `rainbow` は palette に沿って補間した色の entry を入れる。`residues` (既定) は chain ごとに spec の polymer 残基を順に
  並べ、位置 (0..1) を 64 段に量子化し、同じ色の連続した残基を `resi a:b` の 1 つの entry にまとめる (1 chain あたり最大
  64 entry)。`chains` は model ごとに chain id 順、`structures` は model ごとに 1 色。palette は組み込みの名前
  (`rainbow` (既定、青から赤) `grayscale` `red-white-blue` `blue-white-red` `cyan-white-maroon` `cyan-gray-maroon`
  `lipophilicity` と別名)、`c1:c2:...`、位置付きの `v1,c1:v2,c2:...`、先頭の `^` で反転 (`colorarg.py` `ColormapArg`)。
  組み込みの名前には、値の位置を持つもの (`core/colors.py` の `_builtin_colormaps`) もある: `alphafold` (pLDDT
  0,50,70,90,100)、`esmfold` (0〜1)、`pae` / `paegreen` (0〜30)、`paecontacts` (0〜20) (`colorSchemes.ts` の
  `VALUE_PALETTES`)。位置付きと同じく、`range` を省けばその値の範囲で塗る。
- `color byattribute bfactor|occupancy` と `color bfactor` (その別名) は、原子の値を palette (既定 `blue-white-red`) に
  沿って塗る。**色だけを段に分けた paint** で近似する (ChX の方針の例外。後から `color /A red` のように一部を塗り直す
  操作と両立させるため): range を 50 段に分け、`(spec) and (bfac > t)` の entry を低い順に先頭へ入れる
  (`colorSchemes.ts` の `valueEntries`)。分子の coloring (`BfacColoring` の多色のグラデーション) は使わず、`mol.coloring` にも触らない。選ぶ原子と range は近似しない:
  - range は `range lo,hi` があればそれ、palette が位置付き (`v1,c1:...`) ならその値、無ければ
    **全対象の model の spec に当たる原子をまとめて**最小・最大を 1 回求める (ChimeraX の `_value_colors`)。
    model ごとに求めると同じ値が model で別の色になり、分子全体から求めると `color bfactor /A` で chain A が palette の
    一部の色になる。値が 1 つしか無ければ ChimeraX と同じく前後に 1 広げる。`range full` は値の最小・最大。
  - cartoon は、paint の selection が原子で決まるので、残基の代表原子の値で塗られる (ChimeraX は残基の平均)。
    target に c / r を含むと warn する。
  - 属性は `bfactor` / `occupancy` (`a:` の接頭辞も可) だけ。`average` `noValueColor` `transparency` `key` は warn。
- **surface** (`surface.ts`): ChimeraX と同じく chain ごとに 1 つ、`dsurface` の `chx:surface:<chain>` を、surface に
  触れたとき (`surface`、`show ... surfaces`) に作る。接している chain どうしをまとめて計算すると、chain の間の面が消える
  ため。表面を作る原子 (`sel` = `(chain X) and (protein or nucleic)`) と表示する原子 (`showsel`。含まれない原子の頂点は
  描かない) を分け、表示・非表示は `showsel` だけを `set_node_prop` で書く。`sel` は変えないので表面は計算し直さない。
  新しく作った surface の `showsel` は `none` から始める (`showsel` が空だと全部を描く)。`surface enclose` は指定した
  原子群を囲む別の renderer `chx:surface:enclose` にする。`surface close` は spec の触れる chain の surface (と enclose)
  を `delete_node` する。patch の境界の細部は ChimeraX と違いうる。
- **塩基の板の色**: `color` の target `f` (既定の `acsbpf` も) は `chx:nuclbase` に入れる (ChimeraX の ring の色)。
  `chx:nuclbase` の板は残基の pivot (P) 原子の色で塗られる。
- **surface の色・透明度**: `color` の target `s` (既定の `acsbpf` も) は、**ある** `chx:surface:*` に atom と同じ paint
  entry を入れる (色を付けるだけで surface は作らない)。surface の色付けは `colormode=molecule` で、その renderer の
  paint を使う。透明度は renderer の `alpha` (§6 `transparency`)。
- **新しい surface の色**: ChimeraX は新しい chain の表面を ribbon の色で塗る (`molsurf.py` `surface_initial_color`)
  ので、新しい `chx:surface:*` には、その分子の `chx:cartoon` の paint 表を順番どおりにコピーする (`display.ts` の
  `readPaint` / `replacePaint`。読み取りは `list_paint` op)。cartoon が paint でなければ atom renderer の表を使う。
  ChimeraX は chain ごとに平均色 1 色、こちらは残基ごとの色なので、`color bychain` の後は同じ絵、`rainbow` などの後は
  違う絵になる (近似)。コピー元が無い分子 (GUI で開いた分子) では、コピー先には何もせず既定の色付け
  (`DefaultCPKColoring`: 炭素は分子の色、他は元素色) のまま残す。
- **`color <spec> fromcartoons` / `fromribbons`**: `fromatoms` と同じで、コピー元が `chx:cartoon` (無ければ `chx:nucl`)。
- **`color <spec> fromatoms`**: spec が届く surface に、atom renderer の paint 表を一度だけコピーする (ChimeraX も一度
  だけで、以後は連動しない)。分子全体なら置き換え、一部なら各 entry を spec と交わらせて表の先頭に差し込む
  (`prependPaint`。最初に合った entry が勝つ)。paint でない surface への一部の `fromatoms` は、paint に切り替えると
  既定の二次構造別の表が種として入って他の部分の色まで変わるので、surface を変えずに warn する。atom renderer が
  paint でない分子も warn して飛ばす。
- **ラベル**: 残基ラベルは `chx:label:residues`、原子ラベルは `chx:label:atoms` (`*namelabel`)。種類ごとに renderer を
  分けるのは、`label delete` で種類を省いたとき両方から、指定したときその種類からだけ外すため (1 つの renderer では、
  残基ラベルを消すと同じ原子の原子ラベルまで消える)。CueMol のラベルは原子に付くので、残基ラベルは残基ごとの代表原子
  (`CA`、無ければ `C4'`、どちらも無い ligand・水・イオンは残基の最初の原子) に `aid` の selection で付ける。原子を指す
  spec (`/A:10@CB`) も先に残基に広げる (`byres`)。ChimeraX の既定の位置 (残基の中心) とは異なり、ラベルは代表原子の
  位置に出る。
  - spec を省いた `label` は新しいラベルを作らない (ChimeraX の `label3d.py` と同じ。1 つも無ければ "label command
    requires an atom specifier to create labels")。色・大きさ・`font` (`font_name`)・`height` は今あるラベル renderer に
    書く。`text` / `attribute` は、今あるラベルの原子 (`NameLabelRenderer.getLabelAtomIDsJSON`) だけに
    `set_atom_labels` で書き直す (ChX のラベルはラベルごとに書式を持ち、renderer の `format` より優先されるため)。
  - `height` (Å): CueMol のラベルは pixel で描くので、今の view の中心の Å/pixel (`camera.ts` の `pixelSize`) で
    `font_size` に換算する (係数 1.25 は 1crn の `label height 1.0` を ChimeraX と並べて決めた)。後で zoom すると Å の
    高さは保たれないので warn する。
- **核酸の塩基** (`nucleotides`): 主鎖は `chx:nucl` (P を通る tube)、塩基は `chx:nuclbase` (`nucl` の板)。
  `chx:nuclbase` は cartoon と同じに動き (`show` / `hide ... cartoons`)、塩基の表現は `chx:nuclbase` を表示するか
  (slab / ladder) 隠すか (atoms) と、その `base_type` (`detail1` が板: fill・slab・tube/slab、`basepair` が ladder:
  ladder・stubs) で決める。原子には触らない。ChimeraX との違い (近似): ChimeraX は板の表示を塩基の原子の表示に
  結び付けるので、cartoon を隠しても板が残り、原子を隠すと板が消える。ChX では cartoon を隠すと板も消え、原子を
  隠しても板は残る。板の形 (ChimeraX の箱・楕円) と寸法は `nucl` のもの。`base_type` は renderer に 1 つなので、
  spec が分子の核酸の一部だけのときは warn して飛ばす。
- **`open` の auto style** (`autoStyle.ts`、ChimeraX の `structure.py` `apply_auto_styling`): 開いた molecule を
  polymer の chain 数・原子数・polymer の残基数で分け (閾値は ChimeraX と同じ)、5 つの renderer の selection と paint を
  書く。

  | 分類 | 条件 | 表示 | 色 |
  |---|---|---|---|
  | non-polymer | polymer の chain が無い | 全原子 stick | model の色、炭素以外は元素の色 |
  | small polymer | chain 5 未満、原子 20 万未満、残基 5000 未満 | cartoon (protein / nucleic)、ligand と金属から 3.6 A 以内の残基を stick (`byres ((L) expand 3.6)`)、その中の金属とイオンは sphere、炭素に付いた水素は隠す。残基が 10 以下 (短いペプチド) なら全原子 stick で cartoon 無し | 同上 (cartoon も model の色) |
  | medium polymer | chain 250 未満、原子 100 万未満 | 全原子 sphere、ligand は stick、水は ball | 全 chain が同じ配列なら chain の色、ligand と水は元素の色 |
  | large polymer | それ以外 | 全原子 sphere | model の色 |

  CueMol で区別できないものは近似する: イオンはハロゲンと金属の原子 (ChimeraX は 1 原子の残基)、炭素に付いた水素は
  標準残基の極性水素の名前の裏 (ChimeraX は結合から決める IDATM 型 `HC`)。medium / large で配列の違う chain があると、
  ChimeraX は配列ごとの色にするが、CueMol では model の色のまま warn する。small polymer の核酸は、ChimeraX と同じく
  100 残基以下なら板 (slab)、2000 残基以下なら ladder で塩基を描き、塩基を `bynucleotide` の色で塗る (主鎖は model の色)。
  ChimeraX の lighting の切り替えと、糖鎖の SNFG 表示は行わない。
- **制約**:
  - **原子の表示状態** (`atomDisplayState.ts`、`displayState.ts`): ChimeraX は原子ごとに表示フラグと描き方 (style) を
    別に持つ。CueMol は renderer の selection にある原子だけを描くので、ChX は分子ごとに「原子 ID → 表示するか・style」
    の状態を持ち、原子の 3 枠 (`chx:stick` / `chx:ball` / `chx:sphere`) の selection をそこから書く。
    - `show` / `hide` は表示だけを、`style` は表示中も非表示の原子も style だけを変える。`show ... only` は spec の分子の中で
      spec 以外の原子を隠す。`nospheres` は sphere の polymer と溶媒を、表示に関係なく stick にする。open と Initial Styles は
      状態を作り直す (表示する原子と、全原子の style を auto style で決める。前の状態は引き継がない)。
    - したがって `style :ALA sphere` -> `hide :ALA atoms` -> `show :ALA atoms` は sphere で出る。隠している間の `style` も効く。
    - spec が原子に当たらない分子は変えず、ChX の renderer も作らない (`show ... only` がその分子の原子を全部隠さないように)。
    - 状態は scene の app-data に、汎用の一時的な入れ物 (`TransientStrData`、キー `chx:display:<分子の UID>`) で置く。
      コマンドの undo の txn の中で書くので、console からも GUI からも undo / redo で renderer と一緒に戻る。scene には
      保存しない ([scene app data](scene-app-data.md))。
    - 状態が無いとき (ChX がまだ触っていない分子、ファイルから開いた scene、最初のコマンドの undo の後) は、今の 3 枠の
      selection から作る: 描かれている原子はその style で表示、それ以外は auto style の style (`initialStylesOf`) で非表示。
      状態が知らない原子 (後から足された原子) も同じ規則で取り込む。状態が変わらないコマンドは何も書かない (redo を消さない)。
    - 3 枠の selection は ChX が管理する。GUI で直接変えても、原子を変える次の ChX コマンドで状態どおりに戻る。
    - selection は原子 ID (`aid`) ではなく、chain・残基番号・原子名・alt の式で書く (`MolCoord.toAtomNameSel`、
      [selection 式の簡単化](selection-simplify.md) の 4 節)。scene を保存して開き直すと原子 ID は振り直されるが、描かれる
      原子は変わらない。
    - 保存・再読込の後: 表示中の原子はそのまま戻る。非表示の原子の、隠す前の style は保存されないので、auto style の style に
      なる (例: 初期 style が stick の原子を sphere にして隠し、保存して開き直してから `show` すると stick で出る)。
  - cartoon などの selection の式は、組み合わせた後、書き込む前に簡単にする (`writeSel`、[selection 式の簡単化](selection-simplify.md))。
    `show` / `hide` / `style` を繰り返しても伸びないが、最短になるとは限らない。

## 6. コマンド

**断る・無視する前に確かめること** (ChimeraX の機能を「CueMol に無い」と誤って断った例があったため):

1. 相当する機能が無いか、CueMol の renderer の type と property (.qif)、style、既存の op / service を確かめる。今の
   renderer の type に property が無くても、別の type にあることがある (例: `chx:cartoon` は `ribbon` だが、円柱の helix は
   `cartoon` が描く。塩基の板は `nucl` の `base_type`)。
2. 名前が同じでも意味の違う処理は流用しない。計算方法・単位・閾値の意味・作られるもの (表示だけか model か) を確かめ、
   近似として使うなら何が違うかを warn と本書に書く (例: `sdLevel` を `siglevel` に入れない。EM の地図では上位の割合)。
3. 断る理由は事実に合わせる。作れるが今は作らないものは「not supported yet」とし、「CueMol has no ...」と書かない。
4. renderer に 1 つしかない値 (`base_type`、`ring`、`bondw` など) を、分子の一部への指定で変えない (対象外まで変わる)。
   一部だけを指す指定は実行前に検出して warn する。見た目を合わせるためだけに同じ type の renderer を重ねない。

| コマンド | 引数 | op | 備考 |
|---|---|---|---|
| `open` | `names` (空白で区切って複数。次の keyword まで)、`name`、`format`、`fromDatabase` | `fetch_entry`、`fetch_url`、`fetch_emdb`、`load_file`、`create_renderer`、`set_renderer_styles`、`set_renderer_selection`、`set_renderer_coloring`、`add_paint_at` | 4 文字の PDB id、`db:id` (`pdb` `pdbe` `pdbj` `redo` `alphafold` `pubchem` `ccd` `emdb` ほか)、`id fromDatabase db`、http(s) の URL はデータベースから取得する ([database-fetch](database-fetch.md) §3。ファイルとの優先順位は ChimeraX と同じ)。AlphaFold は開いた後に pLDDT で塗る。`.cxc` は script として実行。`.qsc` は scene として開く (txn の外、行に単独)。molecule は ribbon (`chx:cartoon`) で読み、ChimeraX の auto style で表示と色を決める (§5)。molecule でないもの (map) は File > Open と同じに開く。`Opened <name> as #N` と言う。複数の名前は順に開き、1 つ失敗したらそこで止める。`name` は名前が 1 つのときだけ、`.qsc` は単独のときだけ。`eds` は PDBe の 2Fo-Fc の地図を `fetch_map_url` で ([database-fetch](database-fetch.md) §3)。名前は ChimeraX と同じ `eds <id>`、表示は ChimeraX の X 線の地図の既定 (`volume` の下記)。視点は「**open の視点**」 |
| `open ... from rcsb_bio / pdbe_bio` | `maxAssemblies` | `fetch_url` | 生物学的会合体を 1 番から順に、無くなるまで (`maxAssemblies` があればその数まで) 別の model として開く (ChimeraX の `pdb_bio/fetch_pdb_bio.py`)。1 番が取れなければ error、2 番以降で取れなくなったらそこで終わる。URL は `dbSources.ts` の `assemblyFetch` ([database-fetch](database-fetch.md) §3)。`from pdb_nmr` (NMR-STAR の拘束) は reader が無いので断る |
| `alphafold fetch` | `uniprotId`、`pae` (warn)、`alignTo` `trim` `ignoreCache` `version` (無視) | `open alphafold:<id>` と同じ | pLDDT の色も同じ。UniProt の entry 名 (`O51E2_HUMAN`) は UniProt の REST (`rest.uniprot.org/uniprotkb/search?query=id:...`) で accession を引いてから開き、model の名前を `AlphaFold <entry 名>` にする |
| `close` | `[models]` | `delete_node` | spec が無ければ全部 |
| `close session` | | `delete_node` | 全 object を閉じる。ChimeraX は設定も戻すが、CueMol に session ごとの設定は無いので戻さない |
| `delete` | `atoms`、`attachedHyds` (無視) | `delete_atoms` | |
| `show` / `hide` (別名 `display`、`~show` / `~display`) | `[spec] [what]`、`target`、`only` (show だけ) | `set_renderer_selection`、`set_visible`、`create_renderer`・`set_node_prop` (surface) | what: `atoms` `bonds` `cartoons` `ribbons` `surfaces` `models` (`pseudobonds` は warn)。target の文字 `a b c r m s p`。surface は §5。`models` は、spec が model の番号だけで名指す地図 (`wholeMapsOf`) にも効く。what も target も無いときは、spec が原子に届けば atoms、届かなければ models (`show.py` の `what_objects`。地図への `show #1` は地図を出す)。別名は ChimeraX と同じく同じコマンド (`std_commands/__init__.py`) で、`di` が `distance` のままになるよう `distance` の後に登録する |
| `cartoon` / `cartoon hide` | `[spec]`、`smooth` (無視)、`suppressBackboneDisplay` | `set_renderer_selection` | ChX は cartoon で主鎖の原子を隠さないので、`suppressBackboneDisplay false` は黙って受け、`true` だけ not supported yet と warn |
| `cartoon style` | `[spec]`、`width`、`thickness`、`xsection`、`modeHelix`、`radius`、`arrows`、`arrowsHelix`、`arrowScale`、`sides`、`divisions`、`barScale` `barSides` `worm` (無視) | `set_node_prop` (`helix.*` `sheet.*` `coil.*` `section.*`)、`set_renderer_type`、`reset_prop` | 下記。option が無ければ今の断面を ChimeraX の名前で出す |
| `nucleotides` | `[spec] atoms\|fill\|slab\|tube/slab\|ladder\|stubs`、`shape` `dimensions` など (無視) | `set_node_prop` (`base_type`)、`set_visible` | §5 の「核酸の塩基」。核酸に当たらなければ何もしない (ChimeraX と同じ) |
| `style` | `[spec] stick\|ball\|sphere`、`ringFill on\|off\|thin\|thick`、`dashes` (無視) | `set_renderer_selection`、`set_node_prop` (`ring` `thickness` `ringcolor`) | `ringFill` は `chx:stick` / `chx:ball` の環の板 (`ring`、色は `$molcol`)。thin は厚さ 0.05 Å、thick は renderer の `bondw` (ChimeraX の thick は stick の幅に合わせる)。`thickness=0` は環を描かなくなるので使わない。renderer に 1 つの値なので model 全体だけ (一部なら warn) |
| `color` | `[spec] [色 \| byhetero \| byelement \| bychain \| bymodel \| bynucleotide \| fromatoms \| fromcartoons]`、`target`、`transparency` (地図だけ)、`halfbond` / `what` (無視) | `set_renderer_coloring`、`clear_paint`、`add_paint_at`、`set_map_contour` (地図) | target の既定は ChimeraX と同じ `acsbpf` (`s` はある surface に塗る)。target に `s` があり色が普通の色なら、model の番号だけで名指した地図 (`wholeMapsOf`) の等値面 (mesh も) にも塗り、`transparency` (percent) か色の alpha を不透明度にする (`color.py` の `_set_model_colors`)。分子の原子・cartoon・分子表面の `transparency` は warn して無視 (`transparency` コマンドを使う)。色は名前、hex (`#rgb` から 16 桁まで、alpha 付きも)、`rgb()` `rgba()` `hsl()` `hsla()` `gray()` (数値は整数なら 0-255、小数点付きなら 0-1、`%`、色相は `deg` / `rad` / `grad` / `turn`)、`r,g,b[,a]` の百分率 (`colors.ts`)。CueMol の paint は alpha を持たないので、色が alpha を述べていれば warn して不透明で塗る |
| `color zone` | | | not supported yet。地図の等値面には近くの原子の色で塗る色付け (`colormode molecule`) があるが、その色付けにすると CueMol の画像の書き出し (`ImgSceneExporter::write`) が例外になり、以後の `save` がすべて失敗する (C++ の不具合。直るまで使わない) |
| `color modify` | `[spec] adjuster [+\|-\|*] [number] [what]`、`target` | `add_paint_at` | `hue` `saturation` `lightness` (HLS)、`whiteness` `blackness` (HWB)、`red` `green` `blue` を ChimeraX の `color_modify` と同じ式で変える (`colorModify.ts`。ChimeraX は float32 で計算するので、0.5 付近の成分は 1 違いうる)。ChimeraX は原子ごとの色を変えるが、ここでは target が届く renderer の paint の entry を、色を変えて spec と交わらせ、同じ順で表の先頭に差し込む (atom は元の entry の色を変えた色になる)。paint でない renderer は変えずに warn。`$molcol` の行 (AlphaFold のモデルの pLDDT。原子ごとに色が違う) は変えずに warn。`contrast` は not supported yet |
| `color list` | `[all\|custom\|builtin]` | (読み取り) | ChimeraX の書式 (`148 builtin colors: aliceblue, ... and yellowgreen.`)。custom の色は持たないので `No custom colors.` |
| `color byattribute` / `color bfactor` | `attrName` (byattribute だけ)、`[spec] [what]`、`target`、`palette`、`range`、`average` `noValueColor` `transparency` `key` (無視) | `set_renderer_coloring`、`clear_paint`、`add_paint_at` | §5。`N atoms, atom bfactor range lo to hi` と出す |
| `colour` | `color` と同じ | | ChimeraX の英綴りの別名 |
| `rainbow` | `[spec] [residues\|chains\|structures]`、`target`、`palette`、`transparency` (無視) | `set_renderer_coloring`、`add_paint_at` | §5。`polymers` は not supported yet (配列を比べない)。palette には ChimeraX の組み込みの名前のほか、ColorBrewer の名前 (`pastel2-4`、数を省くと既定の数。`colorBrewer.ts` は ChimeraX の `colorbrewer.json` から作った表) と、COLOURlovers の palette の番号 (`palette 130451`。worker の `fetch` で `colourlovers.com/api/palette/<id>` を取る。取れなければ error) を受ける (`color byattribute` も同じ) |
| `view` | `[spec \| 名前] [frames]`、`clip`、`cofr`、`orient`、`pad` (無視) | `set_view`、`apply_camera` | 下記。`orient` は向きを初期値 (`rotation: [1,0,0,0]`) に戻してから合わせる (ChimeraX の `initial_camera_view`) |
| `view initial` | `[models]` | | 何もしないことを 1 行で言う (ChX は model を動かさないので、既に最初の位置) |
| `view name` / `view list` / `view delete` | `name` / `name\|all` | `save_camera`、`list_cameras`、`delete_camera` | ChimeraX の予約語 (`clip` `cofr` `delete` `list` `matrix` ...) を前方一致で含む名前は断る。CueMol のカメラは視点だけで、ChimeraX のように model の位置は戻さない |
| `view matrix` | `camera M` (12 数値)、`models` / `coordinateSystem` は断る | `set_view` ×2、`set_projection` | 下記 |
| `turn` | `[axis] [angle] [frames]` (既定 y、90°)、`rock` `wobble` `wobbleAspect` | `set_view` (`rotation`)。frames / rock / wobble があれば `add_anim` ほか | 下記。`center` `coordinateSystem` `models` `atoms` は断る |
| `roll` / `rock` / `wobble` / `stop` | `turn.py` と同じ引数 | `add_anim`、`set_anim_time`、`set_anim_prop`、`set_anim_options`、`animate` | animation element に置き換えて timeline に足す。[rock-spin-anim.md](rock-spin-anim.md) |
| `move` | `axis [distance] [frames]` (Å、既定 1) | `set_view` (`center`) | 下記。`coordinateSystem` `models` `atoms` は断る |
| `cofr` | 引数無し / `centerOfView` | (読み取り) | `Center of rotation: x y z  center of view` と出す。CueMol は view の中心で回すので、対象や点を指定する形は「視点が動いてしまう」として断り、`view <spec>` を案内する |
| `zoom` | `[factor] [frames]`、`pixelSize` | `set_view` (`zoom`) | CueMol の zoom は view の高さ (Å) なので `zoom / factor`。1 pixel = zoom / 高さ (px) Å。引数無しは `Pixel size at center of rotation is ...`。`frames` は warn (ChimeraX は倍率を frames 全体で達成するので掛けない) |
| `set` | `bgColor`、`silhouettes` `silhouetteWidth` `silhouetteColor` | `set_node_prop` | 引数無しは背景色を出す。他の keyword は warn |
| `graphics` | `bgColor` (`backgroundColor` も) | `set_node_prop` | `set bgColor` と同じ。引数無しは背景色を出す (`std_commands/graphics.py`) |
| `wait` | `[frames]` | | 何もしない (console はコマンドを一度に適用するので、待つ動きが無い) |
| `graphics silhouettes` | `[true\|false]`、`width` `color`、`depthJump` (無視) | `set_node_prop` (`egtype` `eglinew` `egcolor`) | 下記 |
| `lighting model` | `models ...` | | not supported yet (CueMol の照明は scene 全体の 1 つの設定で、model ごとに持てない) |
| `lighting` | `[default\|simple\|soft\|gentle\|full\|flat]`、`multiShadow`、`shadows`、`depthCue`、光源の向き・強さ・色 (無視) | `set_node_prop` (scene の `aoEnabled`)、輪郭線は `graphics silhouettes` と同じ | 下記 (ChX の方針の例外: 近似) |
| `camera` | `[mono\|ortho]`、`fieldOfView`、`eyeSeparation` など (無視) | `set_projection`、`set_view` | 引数無しは今の投影を出す。他の mode (`360` `stereo` `dome` など) は断る。`fieldOfView` (水平の角度) は、CueMol の透視投影が見える高さ `zoom` を目から `distance` の所に置くので、zoom を保ったまま `distance = zoom x 縦横比 / (2 tan(fov/2))` を書く (`view matrix` の換算の逆)。正投影の間は効かないと warn |
| `ribbon` / `~ribbon` | `cartoon` / `cartoon hide` と同じ | (中のコマンドの op) | ChimeraX の alias (`std_commands/ribbon.py`)。行の残りを付けて `cartoon ...` として実行する |
| `preset` | `[category] name` | (中のコマンドの op) | 下記 |
| `unitcell outline` | `[spec]`、`close`、`origin` (無視) | `show_unit_cell` / `delete_node` | 結晶の情報を持つ object (構造でも地図でも) に単位胞の枠 (`*unitcell` renderer) を描く。`close true` はその renderer を消す。情報の無い object は飛ばす (全部無ければ error) |
| `unitcell` | `[structures]`、`outline`、`cells` `offset` `origin` `symFromFile` `spacegroup` `ncs` `pack` (無視) | `show_symmetry` (`extent: null`、`unitCell`) | **表示だけ**の近似。ChimeraX は結晶の対称のコピーを新しい model として開いて単位胞を埋める (`unit_cell/unitcellcmd.py`)。CueMol の `show_symmetry` は symm renderer で単位胞を埋めて描くだけで model を作らないので、毎回 warn する。後のコマンドがコピーの model 番号を指すと、参照の誤りとして止まる |
| `unitcell delete` | `[structures]`、`outline` | `delete_node` | `*symm` renderer を消す (`outline true` なら `*unitcell` も) |
| `volume` | `[spec]`、`level`、`sdLevel`、`rmsLevel`、`style mesh\|surface`、`color`、`transparency`、`step`、`region all`、`capFaces`、`show` / `hide` | `set_node_prop` (`level` `lod` `region_mode`)、`set_map_contour`、`set_renderer_type`、`set_visible` | 下記 |
| `volume zone` / `volume unzone` | `volumes nearAtoms range`、`newMap` `invert` は断る | `set_node_prop` (`bndry_*` `region_mode`) | 下記 |
| `volume <演算>` (`gaussian` `subtract` `add` `scale` `box` `cover` `morph` `resample` ほか) | | | 新しい地図を作る演算なので断る (知らないコマンドのままにしない) |
| `select` | `[spec]`、`residues`、`minimumLength` などは warn | `set_mol_selection`、`count_selection` | 各分子の選択を置き換え、spec の届かない分子の選択は消す (ChimeraX の選択は全体で 1 つ)。`N atoms selected` と出す |
| `select zone` | `near range [find]`、`extend`、`residues` | `set_mol_selection`、`count_selection` | 下記 |
| `select up` / `select down` | | `set_mol_selection`、`count_selection` | 下記 |
| `select add` / `subtract` / `intersect` / `clear`、`~select` | `[spec]` (`intersect` は必須) | `set_mol_selection` | 今の選択と和・差・積を取って書く。spec が無ければ `add` は全部、`subtract` は全部を引く |
| `name` | `name spec` / `name name` (定義を出す) | `define_selection`、`remove_selection` | spec を ChX の名前の表に入れ (§3「名前」)、一度翻訳して誤りが無いことを確かめる (誤りなら表を元に戻す)。行の残り全体が 1 つの spec でなければ断る (途中までしか読めない spec を黙って短く名付けない)。全部の分子で同じ式になるときは、今までどおり CueMol の名前付き selection も作る (GUI に出て、scene に保存される)。分子ごとに違う式 (model を指す、model をまたぐ zone) は ChX の表だけに持ち、「scene には保存されない (この session だけ)」と 1 行で言う (同じ名前の CueMol の名前付き selection があれば消す)。`all`・`sel`・組み込みの selector (`protein`、元素記号など) は名前にできない |
| `name delete` / `name list`、`name frozen` | `name\|all` | `remove_selection` | ChX の表と CueMol の名前付き selection の両方が対象。`name list` は ChX の名前を spec の文字列で、ChX の表に無い CueMol の名前付き selection を式で出す。`name frozen` は断る (今の原子の集合を固定する手段が無い) |
| `info`、`info models` / `chains` / `residues` / `atoms` | `[spec]`、`attribute`、`saveFile` (無視) | (読み取り) | ChimeraX の書式 (`#1, 1crn, shown`、`chain id #1/A chain_id A`、`residue id #1/A:12 name ALA`、`atom id #1/A:12@CA`)。結合の数と IDATM 型 (`info atoms` の既定の attribute) は CueMol に無いので出さない。atom の attribute は name・element・bfactor・occupancy |
| `alias` / `alias list` / `alias delete` / `~alias` | `name text`、`$1`-`$9`・`$*` | (中のコマンドの op) | 下記 |
| `surface` | `[spec]`、`enclose`、`probeRadius`、`color`、`transparency`、`gridSpacing` `resolution` `visiblePatches` など (無視) | `create_renderer`、`set_node_prop` (`showsel` `proberad` `alpha`)、`add_paint_at` | spec の触れる chain ごとの surface に spec の patch を足す (§5) |
| `surface hidePatches` / `~surface`、`surface close` | `[spec]` | `set_node_prop` (`showsel`) / `delete_node` | |
| `surface zone` / `surface unzone` | `surfaces nearAtoms [distance]` (既定 2)、`maxComponents` (warn)、`bondPointSpacing` `update` (無視) | `set_node_prop` (`showsel`、地図では `bndry_*`) | 地図の表面は、`volume zone` / `unzone` と同じ地図の renderer の境界 (`mapCommands.ts` の `zoneMaps` / `unzoneMaps`)。分子の `chx:surface:*` の `showsel` を「今の `showsel` と、`nearAtoms` から `distance` 以内の原子 (同じ分子は `expand`、別の分子は `around`)」の積にする。ChimeraX は角がすべて距離内の三角形を残すが、dsurface は原子ごとの patch なので原子の中心の距離で決まる (近似)。`maxComponents` (大きい連結成分だけ残す) は連結成分の処理が無いので warn して距離の zone だけ当てる。`unzone` は zone の前に表示していた patch を覚えていないので、全部を表示する。表面が無ければ error |
| `transparency` | `[spec] percent [what]`、`target` (既定 `s`) | `set_node_prop` (`alpha`) | `alpha = 1 - percent/100`。target の a / b は 3 つの atom renderer、c / r は ribbon の 2 つ、s は surface。CueMol の透明度は renderer 単位で原子ごとではないので、spec が model の一部のときは断る |
| `size` | `[spec]`、`stickRadius`、`atomRadius` / `ballScale` は断る、`pseudobondRadius` `verbose` (無視) | `set_node_prop` (`bondw` `sphr`) | stick の太さ (Å) を `chx:stick` と `chx:ball` の `bondw` に、stick の原子は結合と同じ太さなので `chx:stick` の `sphr` にも書く。renderer に 1 つの値なので model 全体だけ (一部なら断る)。`ballScale` (原子半径への倍率) は CueMol の ball の球が元素によらない一定の半径なので、`atomRadius` は原子ごとの半径を置く先が無いので断る。`pseudobondRadius` だけの行は warn して何もしない (エラーにしない) |
| `label` | `[spec] [atoms\|residues]` (既定 residues)、`text`、`attribute`、`color`、`size` (`font_size`)、`onTop` (`label_on_top`)、`height`、`font` (`font_name`)、`bgColor` `offset` (無視) | `set_atom_labels`、`set_node_prop` | 書式は残基 `{resn} {resi}`、原子 `{name}`。`text` は文字どおり (`{` `}` は escape)。`attribute` は残基の `name` `number` `chain_id`、原子の `name` `element` `bfactor` `occupancy` `alt_loc`。実数は ChimeraX の `%.3g` に合わせて `{bfac:.3g}`。`pseudobonds` `bonds` `models` のラベルは断る |
| `label delete` / `~label` | `[spec] [atoms\|residues]` | `set_atom_labels` (`format: null`) | 種類を省くと両方を消す (ChimeraX と同じ)。残基ラベルは spec の残基の全原子から外す (付いているのは代表原子だけ) |
| `distance` | `objects` (ちょうど 2 原子)、`decimalPlaces` (既定 3)、`color`、`radius`、`dashes`、`symmetry` `signed` `monitor` (無視) | `measure_geometry`、`set_node_prop` | 最初の原子の molecule の `chx:distance` (`atomintr`) に描く。model をまたぐときは 2 つ目の object を uid で渡す (同名の model があるため)。`Distance between /A ARG 10 CA and /A GLY 20 CA: 15.598Å` (model が複数なら `#1/A ...`)。値は `measure_geometry` の `data.exactValue` (丸めない値) を `decimalPlaces` で整形する。3D のラベルは CueMol の書式のまま。原子が 3 つ以上 (ChimeraX は min/avg/max を出す) は断る。`color` と `radius` (円柱の半径 = `width`) は `chx:distance` 全体に効く (1 本ずつは変えられない) と warn する。`dashes 0` は実線 (stipple を 0 以下に)。正の `dashes` は ChimeraX では 1 本ごとの dash の数だが、CueMol の stipple は線に沿った長さで線の長さによって数が変わるので、warn して破線のまま |
| `distance delete` / `~distance` | `[spec]` | `delete_node` / `list_interactions`・`remove_interaction` | 引数無しは全 molecule の `chx:distance` を消す。2 原子を指定すると、その対の測定だけを消す (`list_interactions` の原子の表記 `A ARG 10 CA` で照合) |
| `align` | `atoms toAtoms atoms`、`move` (structures だけ)、`each` `matchChainIds` `cutoffDistance` などは断る | `superpose` (`LSQ`) | 原子を順に対にする最小二乗。両側がそれぞれ 1 model で、原子数が同じで 3 以上であることを先に確かめる。RMSD は重ねた後の座標から計算し、`RMSD between N atom pairs is x angstroms` と出す |
| `dssp` | `[atoms]`、`energyCutoff` `minHelixLen` `minStrandLen` `report` (無視) | `set_secondary_structure` | spec の届く分子ごとに、座標から二次構造を計算し直す (CueMol の DSSP 風の割り当て。ChimeraX も構造ごと) |
| `matchmaker` / `mmaker` | `atoms to spec`、`pairing` `alg` `matrix` `cutoffDistance` `showAlignment` `computeSS` など (無視) | `superpose` (`USalign`) | 基準 (1 model) 以外の model ごとに重ねる。ChimeraX は配列アラインメントと遠い対の除外の繰り返しで、CueMol は US-align (構造アラインメント) なので、重なり方が違いうることを毎回 warn する。RMSD は出さない (US-align の対が分からない) |
| `save` | `filename`、`format`、`models`、`width` `height` `transparentBackground`、`selectedOnly`、`displayedOnly`、`supersample` `pixelSize` `quality` (無視)、`relModel` `allCoordsets` は断る | `export_scene` / `save_scene` / `save_object` | `.png`: 片方の大きさだけなら view の縦横比で他方を決める。`.qsc`: 行に単独で txn の外 (`outsideTxn`)。`.pdb`: 1 model だけ、`link: false` (object の元のファイルを変えない)。`selectedOnly` は分子の選択、`displayedOnly` は表示中の原子 (`display.ts` の `displayedAtoms`。`@@display` と同じ定義) だけを書く。`.stl`: `export_scene` の stl。`supersample N` は黙って受ける: CueMol の画像の書き出しは常に jitter の supersample で AA する (`OffScreenView` の `m_nSuperSample`、既定 32 サンプル) ので、ChimeraX の普通の `supersample 3` より多い。`supersample 1` (AA 無し) だけ、切れないことを warn。`.cxs` は断って `.qsc` を案内する |
| `undo` / `redo` | | (runtime) | 行に単独のとき txn の外で (`undoStack`) |
| `usage` / `help` | `[command]` | | |

**alias** (`commands/aliasCommands.ts`): worker のメモリに表を持つ (ChimeraX と同じく session の間だけ、全 scene 共通)。

- 定義は `;` を含めて行の残り全部 (alias.py の `WholeRestOfLine`)。`splitLines` は `alias` で始まる行を `;` で分けない。
- 呼び出しは、その行を走らせる直前の `resolve` で表を引く (`resolveChx`)。runtime は submit や `.cxc` の全文を先に
  分けるので、分ける段階で展開すると、同じスクリプトの前の行で定義した alias を使えない。
- 呼び出しは 1 つのコマンドとして bind され、その `run` が `$1`-`$9` / `$*` を展開し、分けて、同じ txn の中で順に
  解決・bind・実行する。alias は自分自身を展開しない。入れ子は 10 段まで。
- txn の外で走るべきコマンド (`undoStack` か `outsideTxn` のもの) を含む alias は、何も実行せずに断る。子の `run` を
  直接呼ぶと runtime の検査が抜け、txn の中で走ってしまうため。

**カメラの向き**: CueMol の view は world の軸 = R(q) × 画面の軸 で、`forward_vec` は画面の +z (手前)。ChimeraX の camera
も -z を向くので、軸は同じ向きで対応する (`camera.ts` の `readCamera`)。

- `turn`: 画面の軸 u (`x` `-y` や 3 数値) の周りに scene を回す。今の回転 q に `q · rot(u, -θ)` を掛けて `set_view` で書く
  (`turnedRotation`)。`rotate_view` は ChimeraX と逆向きに回るので使わない。
- `move`: 画面の軸を world に直し、中心を `-d·軸` 動かす (scene が +d に動いて見える)。
- `frames`: `move` はアニメーションしない。有限の数は、ChimeraX が毎 frame 同じ距離を繰り返すので掛けて一度に動かし、
  `forever` は断る。`turn` の frames は animation element (SimpleSpin) にして 1 回再生する
  ([rock-spin-anim.md](rock-spin-anim.md))。
- `view matrix camera M`: 3×4 行列を行ごとに (列 0-2 が軸、列 3 が目の位置)。ChimeraX の camera は位置だけを持つが、CueMol は
  目の前 `distance` の中心の周りに回り、その前後 `slab` だけを描く。そこで、中心は視線が表示中の分子の中心を通る点に置き、
  distance はそこまでの距離にする。zoom は ChimeraX の水平の視野角 30° になる高さ (`2·d·tan15°/縦横比`)、投影は透視投影
  (`set_projection`)、slab は分子に合わせ直す (`set_view` の `fitSlab`)。引数無しは `view matrix camera ...` を `%.5g` で出す。
  model の行列 (`models`) は not supported yet (ChX は model を動かさない。object の `xformMat` で作れる)。
- `graphics silhouettes`: ChimeraX は view 全体の設定、CueMol は renderer ごとの輪郭線なので、面を描く全 renderer
  (Inspector の `NO_EDGE_LINE_TYPES` 以外) に書く。モードは `egtype=edges`: ChimeraX は奥行きが急に変わる場所すべてに
  線を引き (手前の原子と奥の原子の境界も)、これは CueMol の `edges` に当たる。CueMol の `silhouette` は外側の輪郭だけ
  (`test_umbreon_export.cpp` の `SilhouetteModeInksOnlyTheOuterContour`)。on かどうかは `egtype` が `none` 以外かで見る。
  ChimeraX の silhouettes は後から開いた model にも付くので、ChX が renderer を新しく作るとき (`open` の後の
  `adopt`、新しい surface) に、scene に `edges` の renderer があればその `egtype` / `eglinew` / `egcolor` を写す
  (`viewCommands.ts` の `inheritSilhouettes`)。状態は別に持たず scene の renderer から読むので、保存した scene でも同じ。幅は ChimeraX が pixel、CueMol が Å なので、今の zoom で
  換算する。ChX のコマンドが camera の zoom を変えたら (`view`、`zoom`、名前を付けた view、`view matrix` など)、
  `edges` の renderer の `eglinew` を pixel の大きさの比で掛け直し、pixel での太さを保つ (`registry.ts` で全コマンドを
  `keepingSilhouettes` で包む。alias や preset の中のコマンドは外側だけが行う)。GUI のマウスでの zoom には追従しない
  (`width` を指定したときはこのことを warn)。`width` を省いて**新しく有効にする** renderer には、ChimeraX の
  既定の太さ (1 pixel、`graphics/opengl.py` の `Silhouette.thickness`) を今の zoom で換算して書く。CueMol の既定
  (`eglinew` 0.01 Å) は今の zoom で 1 pixel に満たず、ほとんど見えないため。既に有効な renderer の太さは変えない。

**open の視点**: ChimeraX は model が 1 つも無い状態で最初の model を足したときだけ、向きを初期値に戻して全体に
合わせる (`models.py` の `add` -> `View.initial_camera_view`)。ChX の `open` も、開く前の scene に object が無く、何か
追加されたときだけ、`set_view` で `rotation: [1, 0, 0, 0]` にしてから `focus_nodes` (scene pane の Focus ボタンと同じ
`focusOnNodes`) に追加した object を渡す (`fileCommands.ts` の `initialView`)。分子は表示中の原子、地図は表示中の等値面の
範囲に合う ([cryo-em-map-mode](cryo-em-map-mode.md))。2 つ目以降の open は ChimeraX と同じく視点を動かさないので、ChX の
open は `centerView: false` で op を呼ぶ (EMDB と URL の地図は、op 側が毎回地図に合わせるので、そこだけ動く)。
ChimeraX の fit との差 (近似): 余白は CueMol が箱の各辺 20%、ChimeraX が視野角 30° の視錐台に箱の角を収めて窓の 5%
(対象が画面の約 7 割と約 9 割)。CueMol は原子の中心座標、ChimeraX は半径込みの球の範囲。CueMol は slab を箱の奥行きに
設定し、ChimeraX は切らない (near/far を毎フレーム表示中の範囲から決める)。

**view**: ChimeraX の `view` と同じく、向きを変えずに、名指したもの (無ければ全部) が収まるように center・zoom・slab を
1 回の `set_view` で書く。範囲は object ごとの式の原子を、view の軸 (`right_vec` / `up_vec` / `forward_vec`) で読んで求める
(`camera.ts`)。名指したもの (無ければ全部) に地図の object があれば、その表示中の等値面の範囲 (scene pane の Focus と
同じ、`mapFitBox.ts` の `displayedMapFitBox`。余白は付けずに受け取る) も同じ箱に入れる。地図を名指すのは model の番号
だけの指定 (`#1`、`#1-3`) と空の指定で、chain・残基・原子・selector を含む指定 (`/b:16-24` や、それを中に持つ名前) は
原子だけに届き、地図には届かない (ChimeraX の volume は原子を持たない。`display.ts` の `wholeMapsOf`)。隠した object
(`hide ... models`) は数えない (ChimeraX も表示中のものに合わせる)。何も残らなければ「nothing to show」のエラーで、
視点は変えない。その箱は view の回転後の座標で、
原子を view の軸に投影した座標と同じ (`View::convXYTrans` / `convZTrans`) ので、そのまま合わせ、余白は最後に 1 回だけ
足す。等値面を表示していない地図は数えない。計算は `MolCoord::fitView` (`MolCoordGeomImpl.cpp`) と同じ: 各辺 20% 広げ、4 A より細い軸は 4 A に、zoom は
幅か高さを view の縦横比で、slab は奥行き。既存の op を使わないのは、`focus_node` は node 1 つ、`focus_selection` は molecule
1 つ、`focus_nodes` (複数 node の和に fit) は node 単位で object ごとの原子式を取らないため。camera の変更は undo しない。

- 最初の位置引数は、ChimeraX と同じく spec か、読めなければ名前付き view (`Or(ObjectsArg, NamedViewArg)`)。
  spec として読めない語で、その名前の view も無ければ error。
- `clip` (既定 true) は収めた範囲に slab を合わせる (今までどおり)。`clip false` は ChimeraX では near / far の面を外すが、
  CueMol は slab を外せないので slab を変えない (近似)。名前付き view では ChimeraX と同じく使わない。
- `cofr true` (ChimeraX の既定) は普通の `view`。`cofr false` (画面に収め直すが回転の中心は保つ) は、CueMol が常に
  view の中心のまわりで回り、収め直すと回転の中心も動くので再現できず、理由を言って断る。
- `frames` は、名前付き view でも spec でも、すぐに切り替えて無視すると warn する (CueMol に camera を補間する経路が無い)。

**`select zone`** (zonesel.py の `zone_items`): 順序が意味を決めるので ChimeraX と同じ順に組む。対象 (`find`、省略時は
全部) から `near` を除き、`near` から `range` 以内の原子 (原子単位の zone、`@<`) を取り、`extend` なら `near` を足し、
最後に `residues` なら残基全体に広げる (`byres`)。spec の木を組んで (`and` / `not` / `zone` / `or`) から分子ごとに
式にする (`display.ts` の `readSpec` / `targetsOfNode`)。`residues` を `:<` (残基単位の zone) に置き換えてから
`find` との積を取ると、`find` が残基の一部 (`@CB`) のとき CB しか残らず、ChimeraX (距離内の CB を含む残基の
全原子) と違う。`near` が何にも当たらなければ error。

**`select up` / `select down`** (ChimeraX の selection の promote / demote): up は今の選択を一段広げる
(原子 -> 残基 -> chain -> 分子全体)。ChimeraX と同じく、広げられる分子のうち最も深い段のものだけを広げる。down は
直前の up の前の選択に戻す。up の履歴は scene ごとに worker のメモリに持つ (model 番号の表と同じく scene の状態では
なく、保存も undo もされない)。選択が他の経路で変わったとき (今の選択が履歴の最後の up の後と違う) は、履歴を捨てて
何もしない。

**`cartoon style`** (cartoon.py の `cartoon_style`): ChimeraX と同じく、spec の残基が含む二次構造の種類 (helix、
strand、coil、nucleic) について、その構造全体の断面を変える (残基ごとではない。CueMol の断面も renderer の種類ごとの
設定)。protein は `chx:cartoon` の `helix` / `sheet` / `coil`、nucleic は `chx:nucl` の `section` に書く。

- 寸法: ChimeraX の `width` / `thickness` は断面の全幅・全厚 (Å)。CueMol の断面は第 1 軸が `2 x width`、第 2 軸が
  `2 x width x tuber` で、protein の ribbon では第 2 軸が幅広の側 (DefaultRibbon は `width 0.2`、`tuber 6`)。そこで
  `width = T / 2`、`tuber = W / T`。片方だけ指定されたら、もう一方の今の寸法を保つ。ChimeraX の既定 (2.0 x 0.4) は
  `0.2 / 5` になる。nucleic も同じ換算: ChimeraX は nucleic の断面を protein から 90 度回して持ち (cartoon.py: "Invert
  width and thickness"、ribbon.py: `scale_nucleic = (0.2, 1.0)`)、CueMol の `nucl` も第 2 軸が幅広の側
  (DefaultNucl `width 0.5`、`tuber 2.5`) なので、`width` は同じ第 2 軸に写る。coil は円で、`thickness` が直径
  (`width = T / 2`、`tuber = 1`)。coil は `width` を使わない (ChimeraX と同じ)。
- `xsection`: `oval` / `round` は `elliptical`、`rectangle` / `square` は `rectangle`、`barbell` / `piping` は `fancy1`
  に `sharp = 1/6`。ChimeraX の piping (ribbon.py の `_xsection_piping`) は両端の円柱を、その半分 (`ratio 0.5`) の厚みの
  板が円周の `asin(0.5) = 30` 度の位置でつなぐ形で、CueMol の `fancy1` (`TubeSection::setupMolScrSection`、板が
  `180 x sharp` 度でつながる) は同じ作り方なので `sharp = 30 / 180`。piping は ChimeraX と同じく coil には使わない。
- 報告 (option 無し) は、種類ごとに `xsection` (ChimeraX の名前。CueMol だけの形はその名前) と全幅・全厚を出す。
- `arrows` / `arrowsHelix` (true で `arrow`、false で `smooth`): strand の先端 `sheethead.type`、helix の先端 (`ribbon` は
  `helixhead.type`、`cartoon` は `ribhelix_head.type`)。`arrowScale`: 矢の幅の strand の幅に対する比 (`sheethead.arrow`、
  CueMol の既定 1.8、ChimeraX 2.0)。`sides`: 断面の周の点の数 (各断面の `detail`)。`divisions`: 残基あたりの点の数
  (`axialdetail`)。どれも renderer に 1 つの値。
- `modeHelix tube [radius r]`: helix を円柱で描く。`ribbon` には円柱が無く、`cartoon` (Ribbon2Renderer) が
  `helix_ribbon=false` で描くので、`chx:cartoon` を `set_renderer_type` で `cartoon` にする (selection と paint は
  引き継がれる。uid は変わる)。円柱は断面を丸 (`helix.type elliptical`、`helix.tuber 1`) にし、太さは `helix_width`
  (`radius` があれば `helix_width_mode const`)。ChimeraX と同じく、円柱の helix には `width` / `thickness` を書かない。
  `modeHelix default` (と `wrap`、warn) は `ribbon` に戻し、helix の断面を style の値に戻す (`reset_prop`)。renderer に
  1 つの設定なので、spec が分子の protein の一部だけなら warn して飛ばす。

**`volume`** (`commands/mapCommands.ts`、ChimeraX の `map/volumecommand.py`): 地図は File > Open で付いた renderer
(`contour` が mesh、`isosurf` が surface) をそのまま使い、`chx:` の renderer は作らない。spec の object のうち地図の
renderer を持つものの、その renderer 全部に書く (spec を省くと全地図)。

- `level`: renderer の `level` (地図の値そのもの。書くと CueMol が `siglevel` に換算する)。ChimeraX は等値面を複数持てるが、
  CueMol の renderer は 1 つなので、`surfaceLevels` などの複数指定は断る。
- `sdLevel x` / `rmsLevel x`: ChimeraX と同じく地図の値に換算して `level` に書く。平均 μ (`den_mean`)・標準偏差 σ
  (`den_sigma`) から `μ + xσ`、`x·√(μ² + σ²)` (`volumecommand.py` の `level_and_color_settings`)。CueMol の `siglevel` には
  入れない (EM の地図では上位の割合で、σ ではない)。統計は地図全体で、ChimeraX は今の表示範囲と step の格子 (地図全体を
  描いていれば同じ)。`level` と同時には指定できない。
- `capFaces true|false`: surface の renderer の `cap_mode` (`on` / `off`)。
- `style mesh|surface`: `set_renderer_type` で `contour` と `isosurf` を切り替える (XML で書き出して種類だけ変えて読み直す
  ので、level や色は保たれる。uid は変わる)。`image` は断る。
- `color`、`transparency` (0-1): `set_map_contour` の `color` と `alpha = 1 - t`。色の alpha は warn して捨てる。
- `step` (1・2・4・8、3 軸で同じもの): renderer の `lod`。`lod` が効くのは `isosurf` と、全体を描く (`region_mode` が
  `full`、EM の地図の `auto` を含む) `contour` だけ (`MapMeshRenderer::generate` は box の範囲では間引きを 1 に固定する)。
  結晶の地図の box の `contour` に `step > 1` を書いても何も変わらないので、書く前に断る (同じ行の `region all` か
  `style surface` があれば受ける)。
- `region all`: `region_mode = full`。格子の範囲の指定は warn して飛ばす (CueMol は中心 +- extent の箱か全体だけ)。
- `show` / `hide`: renderer の `set_visible`。`showOutlineBox true` は warn して飛ばし、`subdivide` など見た目の細部は warn。
- **EDS の地図の既定** (`open <id> from eds`): ChimeraX が取得した X 線の地図の見せ方 (`eds_fetch.py`) に合わせ、地図の
  renderer に `region_mode = full`、色 `#b2b2b2` (ChimeraX の最初の地図の色)、メッシュの線の太さ `width = 0.5`
  (CueMol の既定は 1。CueMol のメッシュは lighting しない一様な線なので、1 pixel では地図全体が塊に見える。ChimeraX の
  lighting された柱のようなメッシュには合わせない)、level = 上位 1% の格子点を囲む値
  (`DensityMap.getLevelAtTopFraction(0.01)`、`volume.py` の `initial_surface_levels`) を書く (`mapCommands.ts` の
  `applyXrayMapDefaults`)。GUI の X 線の地図の既定 (青、1σ 前後、視点のまわりの箱) はモデル構築向けなので変えない。
- `volume zone`: 地図の renderer の分子の境界 (`bndry_molname` / `bndry_sel` / `bndry_rng`) に書く。表示範囲 (`region_mode`)
  には触らない (ChimeraX の zone も region を変えない)。境界は 1 つの molecule の選択式なので、`nearAtoms` が 2 つ以上の
  molecule にまたがれば断る。境界は molecule を名前で引くが、C++ は同じ名前の地図などを飛ばして分子を選ぶ
  (`Scene::getObjectByNameAs`)。`newMap true` と `invert` は断る (飛ばして続ける)。
- `volume unzone`: `bndry_molname` を空にする (`MapRenderer::setupMolBndry` は名前が空のときだけ境界を外す。CueMol の
  空の選択式は「全原子」なので、`bndry_sel` を空にしても分子全体の周りに広がるだけ)。ChimeraX と同じく表示範囲も全体に
  戻す (`region_mode = full`)。
- 表示範囲が全体 (full) の地図は周期の折り返しをしないので、地図のデータの範囲の外にある原子の周りは、zone を掛けても
  描かない (ChimeraX も同じ: 周期の隣まで描くのは `volume cover` だけ)。box の表示範囲は、結晶の地図なら PBC で
  折り返すので描ける。1a0m の EDS の地図 (単位胞 1 つ分) では、分子の一部 (水 HOH 20 など) がデータの範囲の外にある。

**`lighting`** (`commands/lookCommands.ts`、ChimeraX の `std_commands/lighting.py`): **ChX の方針 (意味が一致しないものは
断る) の、明示した例外**。CueMol の scene が持つのは画面空間の ambient occlusion (`aoEnabled`) と renderer の輪郭線だけで、
光源の向き・強さ・影は無い。断ると tutorial の 19 行が止まり、見た目を寄せる以外に使い道の無いコマンドなので、AO の on / off
で近似し、近似するものでは必ず違いを warn する。

| ChimeraX | ChX | warn |
|---|---|---|
| `default` / `simple` | AO を切る | しない (CueMol の既定の照明に最も近い) |
| `soft` / `gentle` (key・fill の光を 0 にして multishadow) | AO を入れる | 方向のある光を消せず陰影が残る |
| `full` (影 + multishadow) | AO を入れる | 影が無く、光源の強さも変えられない |
| `flat` (陰影なし + 輪郭線) | AO を切り、輪郭線を入れる | 陰影を消せない |

`multiShadow n` は `n > 0` で AO を入れ (方向の数は使えないと warn)、`0` で切る。`shadows true` は warn して無視。
`depthCue true` は何もしない (CueMol の fog は slab と連動して常に効いている、`GUIView::computeSlabPlanes`)。
`depthCue false` は fog を切れないので warn。引数無しは AO の on / off を出す。

**`preset`** (`commands/lookCommands.ts`): ChimeraX の preset (`preset_mgr`) はコマンドの列を実行する仕組みなので、ChX も
既にある ChX のコマンドを、alias と同じ仕組み (`runChxLines`。同じ txn の中で順に解決・実行し、txn の外で走るべき
コマンドは先に断る) で実行する。名前の照合は `preset_mgr/cmd.py` の `text_match` と同じ (完全一致 -> 前方一致 -> 部分一致、
大文字小文字を区別しない。category を付けると、その中で照合する)。`preset pub` は ChimeraX と同じく 2 つに当たって error。

| category | preset | ChX |
|---|---|---|
| Initial Styles | Original Look、Sticks、Cartoon、Space-Filling (chain colors / single color) | ChimeraX の `atomic/presets.py` と同じく、表面を隠してから (`chx:surface:*` の `showsel` を `none`)、auto style を当てる (`autoStyle.ts`。Original Look は大きさから決め、他は non-polymer / small / medium / large polymer を指定する。指定したときは短いペプチドでも cartoon にする (ChimeraX の `explicit_style`))。auto style の最初の色は分子全体を塗るので、paint の表を空にしてから入れる |
| Molecular Surfaces | ghostly white、chain ID coloring (opaque) | sphere の polymer と溶媒の原子を stick にし (`nospheres`)、`surface`、`color ... target s`、`transparency ... target s` を実行 |
| | atomic coloring (transparent) | `surface; color fromatoms target s; transparency 70 target s` |
| Cartoons/Nucleotides | ribbons/slabs、cylinders/stubs、licorice/ovals | `nospheres` の後、ChimeraX の `preset_mgr/builtin.py` のコマンド列 (略記を書き下し、`~worm` は除く) を実行する。`show nucleic; hide protein \| solvent \| H; surface hidePatches; cartoon; cartoon style ...` に続けて、ribbons/slabs は `nucleotides tube/slab`、cylinders/stubs は `cartoon style protein modeHelix tube radius 2` と `nucleotides stubs`、licorice/ovals は `nucleotides tube/slab`。`arrows` `sides` など `cartoon style` が受けない値は warn |
| Overall Look | publication 1 / 2、interactive | `set bgColor`、`graphics silhouettes`、`lighting depthCue` を実行 (`interactive` の背景は ChimeraX の既定の黒) |

利用者定義の preset と、`nih_presets` の preset は無い (名前が当たらない)。

## 7. テスト

`plugins/chimerax-console/worker/`:

- `cli/syntax.test.ts`: `ListOf(EnumOf)` がカンマ区切りを 1 つずつ読むこと (`hide atoms,ribbon`)、`open` の複数の
  ファイル名、`;` と `#` の分け方、登録順の前方一致と sub-command、spec の省略と keyword の前方一致・
  重複、ファイル名の `\` を escape しないこと、元素記号で始まる spec を keyword や sub-command の省略と取り違えない
  こと (`color C & :ber red`、`show O`、`select C & :sti`)
- `commands/viewCommands.test.ts`: spec を付けた `view` が `set_view` に引数を欠かさず渡すこと (欠けた引数は op に
  `undefined` で届き、`rotation` が足されたときに `view sel` が例外で落ちた)、zoom を変えたコマンドの後に輪郭線の
  `eglinew` が pixel の大きさの比で掛け直されること
- `spec/translate.test.ts`: 階層・insertion code・残基名・演算子の翻訳、model ごとの評価、16 進の色を spec にしないこと、
  未対応の語を断ること
- `display.test.ts`: show / hide / style / cartoon の合成 (式は小さな原子の集合で評価して比べる)、他の renderer に
  触らないこと、非表示の原子が style を保つこと (隠している間の `style`、`show ... only` を含む)、spec が原子に当たらない
  分子を変えず renderer も作らないこと、状態が無ければ今の selection から始め、何も変えないコマンドは何も書かないこと
  (状態が知る原子を削除した後も)、書き込みの途中で失敗したら書いた selection を戻すこと、style を変えても色が残り
  paint への切り替えは 1 度だけであること、地図に届くのは model の番号だけの指定であること
- `atomDisplayState.test.ts`: 状態の保存形式の往復、削除した原子の ID を保ちつつ描かないこと、新しい原子を取り込むこと
- `models.test.ts`: 番号を詰めず、使い回さないこと
- `commands/mapCommands.test.ts`: `volume` の `level` が地図の値のまま、`transparency` が `alpha = 1 - t` で書かれ、box の
  `contour` の `step > 1` と 1・2・4・8 以外の `step` を何も書かずに断り、`region all` なら `lod` を書くこと、`volume zone` が
  境界の 3 つを書き、2 つの molecule にまたがれば断り、`unzone` が `bndry_molname` を空にして `region_mode` を `full` にすること
- `commands/lookCommands.test.ts`: `lighting` の preset ごとの AO と、近似する preset が warn し `flat` が輪郭線を入れること、
  `preset` の名前の照合 (`pub` は ambiguous)、Initial Styles が表面を隠してから auto style を当てること
- `commands/fileCommands.test.ts`: `open ... from rcsb_bio` が会合体を順に取り、2 番以降の失敗で止まり、`maxAssemblies` で
  止まり、1 番の失敗は error になること
- `commands/displayCommands.test.ts`: `show #1 models only` が scene の他の model を隠すこと、`cartoon style` の
  width / thickness が CueMol の断面の軸に正しく写り (幅は第 2 軸、`width` は厚みの半分)、piping が coil に入らないこと
- `commands/selectCommands.test.ts` (追加分): `select zone` が `find` から `near` を引いて原子単位で測り、`byres` を
  最後に掛けること、`select up` -> `down` が元の選択に戻り、途中で選択が変わったら down が何もしないこと
- `commands/colorCommands.test.ts` (追加分): `color bfactor` の range を全 model の原子から 1 回求め、palette の端の色に
  なること。AlphaFold のモデルの pLDDT の着色が、分子の coloring が `BfacColoring` なら `("*", $molcol)` の 1 行、
  そうでなければ段に分けた entry になること
- `colorSchemes.test.ts` (追加分): 値の位置を持つ組み込みの palette (`alphafold`) を読み、`range` を省くとその値の範囲に
  なること
- `commands/reprCommands.test.ts`: surface が chain ごとに polymer から作られ `showsel` に spec の patch だけが入ること、
  `hide ... surfaces` が surface を消さず `showsel` を狭めること、`transparency` の target と renderer の対応と model の
  一部を断ること、残基ラベルの代表原子の fallback
- `commands/analysisCommands.test.ts`: `distance` がちょうど 2 原子だけを測ること、`matchmaker` が基準以外の model
  ごとに重ねること
- `colorSchemes.test.ts`: chain の色を大文字小文字を区別せずに引くこと、`rainbow residues` が 64 段以下の範囲にまとめ、
  青から赤で、`^` で逆になること
- `autoStyle.test.ts`: ChimeraX の大きさの閾値、短いペプチドを stick にすること、small polymer の selection の式と、
  非表示の原子も含む全原子の style
- (`cli/syntax.test.ts` の前方一致に、`sel` `su` `tr` `tu` `sa` `la` `di` `mm` `al` の短縮形)
- `chimeraxCommands.test.ts`: ChimeraX にあって ChX に無いコマンド (`sym`、前方一致の `fit`、2 語の `alphafold match`)
  は飛ばし、打ち間違い (`symx`、`alphafold fetchx`) はエラーのままにすること
- `commands/fileCommands.test.ts`: 空の scene への open だけ `set_view` (向きの初期化) → `focus_nodes` を呼び、2 つ目の
  open では呼ばないこと、open が `centerView: false` で op を呼ぶこと
- `commands/reprCommands.test.ts`: 新しい surface に cartoon の paint 表がコピーされ、ChX の renderer が無い分子では
  何もしないこと。`commands/colorCommands.test.ts`: `fromatoms` が paint の surface の先頭に spec と交わった entry を
  差し込み、paint でない surface は変えずに warn すること
- `commands/mapCommands.test.ts`: `volume` の断るキーワードを warn して飛ばし `color` を適用すること、EDS の地図の既定
  (`region_mode full`、細いメッシュ、灰色、上位 1% の level)
- `commands/silhouettes.test.ts`: 輪郭線を `edges` で書き、後から作った renderer に同じ輪郭線を写すこと
- `commands/displayCommands.test.ts` (追加分): `nucleotides` が `chx:nuclbase` の `base_type` と表示だけを変え、核酸の
  一部への指定を飛ばすこと、`hide ... cartoons` が `chx:nuclbase` も狭めること
- `spec/translate.test.ts` (追加分): `@@display` が model ごとの表示中の原子になり、`^display` / `display=false` が否定に
  なること
- `commands/reprCommands.test.ts` (追加分): spec の無い `label` が新しいラベルを作らず、今あるラベルの原子だけを書き直し、
  ラベルが無ければ error にすること
- `commands/mapCommands.test.ts` (追加分): `sdLevel` / `rmsLevel` を平均と標準偏差から地図の値に換算すること
- `spec/translate.test.ts` (追加分): `#!1` が `#1` と同じになること、ChX の名前が使う場所で model ごとに翻訳され
  (model を指す名前、名前の中の名前)、自分自身を使う名前を断ること。`commands/selectCommands.test.ts`: 分子ごとに違う
  名前を ChX の表だけに持ち、同じ名前は CueMol の名前付き selection も作ること
- `camera.test.ts`: `view` の枠に地図の表示中の箱が入り、余白が 1 回だけ足されること。隠した object は数えないこと
- 図の script の段階 B の後の追加分: snake_case の keyword・`graphics bgColor`・`color modify` の演算子の読み方
  (`cli/syntax.test.ts`)、`cartoon style` の `arrows` / `sides` / `divisions` の property (`displayCommands.test.ts`)、
  地図への `surface zone` が `zoneMaps` を呼ぶこと (`reprCommands.test.ts`)、ColorBrewer の名前と `color modify` の色の計算 (`colorSchemes.test.ts`)
- C++ の `src/tests/modules/molstr/test_namelabel.cpp` (`LabelAtomIDsJSON`): ラベルの付いた原子をラベルの順に返すこと
- console 共通の `runtime/runCommand.test.ts`: `unsupported` の結果と `unsupportedCommand` の知らないコマンドを warning
  で飛ばして残りを実行し、1 つの txn にすること

dialect に依存しない基盤 (ダミーの文法の dialect で補完と実行が同じ文法を通ること、別 dialect の script を断る文言) は
`runtime/dialectNeutral.test.ts`。
