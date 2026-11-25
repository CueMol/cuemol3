# 分子の既定の色分け (パレットのテーマ)

読み込んだ分子に最初に付く色分け (MolCoord の `coloring` に入る PaintColoring) の仕様。
UXP の `createDefPaintColoring` は helix / sheet / nucleic / coil を固定の 4 色
(SteelBlue / khaki / yellow / FloralWhite) で塗っていた。tritium はこれを、パレットの
テーマから分子ごとに 1 色を割り当てる方式に変えた。既定のテーマは色覚の多様性に配慮した
Okabe-Ito。

実装: `tritium/react-gui/src/renderer/worker/server/services/helpers/defPaintColoring.ts`
(`createDefPaintColoring`)。呼び出し元:

- 分子を新しく作ったとき (`molPostProc`)。`setupRenderer` の `newObj` が true の経路だけ: ファイルを開く、
  fetch、対称分子の作成、MD trajectory の読み込み。既存の分子に renderer を足すとき (New Renderer ダイアログ、
  `create_renderer` / `create_preset_renderer` の op。どれも `createRendererOnObject` を通る) は false で、
  `mol.coloring` を変えない。既存の renderer は `$molcol` でこの coloring から色を引くので、置き換えると
  ユーザーが編集した paint などが黙って消える (UXP も New Renderer では `result.new_obj = false`)。
- op `set_renderer_coloring` の mode `paint-type-paint` で `paintColor` を省略したとき (`applyColoring.ts` の
  `paint-type-paint`)。GUI のメニューには「自動」の項目は無い (下の「Paint coloring メニュー」)。
- Paint coloring メニューで主色を選んだとき。`choice` 引数に、テーマの色名か `cuemol2` / `cuemol1` を渡す。

## シーンの Look による分岐

パレットで塗るのは、シーンの Look が CueMol3 (scene の style set に `cuemol3_look` がある) のときだけ
([cuemol3-style-file.md](cuemol3-style-file.md) の「シーンの Look」)。Look が CueMol2 (Legacy mode。CueMol2 で
作った qsc や、Legacy mode で作ったシーン) のときは、UXP と同じ固定の 4 色で塗る (`LEGACY_PAINT_ENTRIES`):

| sel | 色 |
|---|---|
| `sheet` | `SteelBlue` |
| `helix` | `khaki` |
| `nucleic` | `yellow` |
| `*` (coil など) | `FloralWhite` |

- どれも CueMol2 にもある標準の色名なので、`default_paint` パレットを引かず、scene の style set への色の
  コピー (`ensureSceneColor`) もしない。
- 分岐は `createDefPaintColoring` の中にあり、主色を指定しない呼び出し (読み込み時と op の自動) に効く。
  Look を切り替えても、塗り済みの分子の色は変わらない (以後に読む分子に効く)。メニューで選んだ主色は
  Look によらずその色で塗る。

## テーマ

`data/cuemol3_style.xml` (CueMol3 だけが読む。[cuemol3-style-file.md](cuemol3-style-file.md)) に、テーマごとに `<テーマ名>_<番号>` の named color で定義する。
色数はテーマごとに違ってよい。

| テーマ名 | 出典 | 色数 |
|---|---|---|
| `okabeito` (既定) | Okabe-Ito (Color Universal Design)、黒を除く | 7 |
| `tolbright` / `tolvibrant` | Paul Tol bright / vibrant | 7 |
| `tolmuted` / `tollight` | Paul Tol muted / light | 9 |
| `brewerset2` / `brewerdark2` | ColorBrewer Set2 / Dark2 | 8 |
| `tableau10` | Tableau 10 | 10 |

どのテーマで塗るかは style の文字列データ `<palette id="default_paint" value="okabeito"/>`
で決まる (`getStrData('palette', 'default_paint', sceneUid)`)。scene の style set の定義が
あればそれ、無ければ全体の定義を使う。既定のテーマを切り替える GUI やコマンドは無く、手で書き換える
(分子ごとに色を選ぶのは下の「Paint coloring メニュー」):

- 全体の既定を変える: ユーザーの style ファイルに同じタグを書く。
- その scene だけ変える: scene の style set に同じタグを置く (qsc の `<styles>` 内)。

テーマ名に当たる色が 1 つも無いときは `okabeito` を使う。

テーマはこれから読み込む分子の塗り方だけを決める。テーマを変えても、塗り済みの分子は
そのまま。1 つの scene に複数のテーマの色が混ざってよい (色名がテーマごとに違う)。

## 色の決め方

- scene の中で n 番目の分子 (`isMoleculeClass` に当たる object を uid 順、つまり読み込み順に
  数える。`Trajectory` も含む。[molecule-object-class.md](molecule-object-class.md)) が、テーマの n 番目の色を主色にする。色数を超えたら先頭に戻る。同じ分子に
  自動の色分けを付け直しても同じ色になる。メニューでテーマの色を選んだときは、その色が主色になる。
- 各構造の色は主色に NamedColor の修飾子を付けたもの (`DEFAULT_PAINT_ENTRIES`):

  | sel | 色 (主色が `okabeito_2` の例) | 意味 |
  |---|---|---|
  | `sheet` | `okabeito_2` | 主色そのまま |
  | `helix` | `okabeito_2` | 主色そのまま |
  | `nucleic` | `okabeito_2{mod_h:15}` | 色相を +15 度ずらす |
  | `*` (coil など) | `okabeito_2{mod_s:-0.6;mod_b:0.1}` | 白っぽくする |

  helix と sheet は形が違うので同じ色にする。核酸は色相でずらす: 3D 表示では陰影
  (lighting / AO) がすでに明暗を変えているので、彩度や明度の差は「同じ色の陰」と区別
  されにくく、別の色として認識させるには色相の差が要る。5 度では見分けられず、15 度で
  分子の色の系統を保ったまま違いが分かる。coil は白背景でも陰影で見える。

修飾子の注意: 彩度と明度の修飾子は足し算で、結果は 0-1 に丸められる。同じ値でも主色の
彩度・明度によって効き方が違う (`mod_s:-0.6` は彩度 1.0 の orange を 0.4 の淡い色に、
彩度 0.63 の sky blue をほぼ灰白色にする)。色相の修飾子 (`mod_h`) は正の値で書く
(-10 度は `350`)。C++ の `decodeModSet` は色相を `fmod` で戻すので、負の値は負のまま残り、
正しい色にならない。

## scene への色の複製

paint は主色を名前で参照する。名前の解決先を全体 (global) の定義だけにすると、この名前を
持たない古い CueMol / UXP 版で qsc を開いたとき解決できず、半透明の灰色になる。そこで
paint を作る前に `ensureSceneColor` が、使う色の名前を、全体の定義の値 (hex) で scene の
書き込み可能な style set (`ensureWritableSceneSet`。無ければ `default` を作る) に
`setColor` で定義する。

- コピーするのはその分子が使う色だけ。scene に同じ名前の定義がすでにあれば上書きしない。
  ユーザーが scene 内で変えた色や、開いた qsc の色はそのまま残る。
- 外部ファイルを参照しない style set は `Scene::stylesWriteTo` が qsc に埋め込む。qsc には
  色の定義 (`<styles id="default"><color id="okabeito_1" value="#E69F00"/>...`) と、
  それを参照する paint (`<paint sel="nucleic" color="okabeito_1{mod_h:15}"/>`) の両方が入る。
- 名前は scene の定義が全体より優先して解決される。全体の値を後から変えても、保存済みの
  図の色は変わらない。scene の定義を書き換えれば (`define_color okabeito_1, ...`)、その色を
  使う分子がまとめて塗り変わる。

修飾子付きの名前は保存と読み込みで保たれる (`NamedColor::toString` が
`名前{修飾子}` を書き出す)。保存 -> 開き直し -> 再保存で paint と color の行が変わらず、
開き直す前後の描画が一致することを確認している。

## Paint coloring メニュー

coloring パネルの coloring の種類のドロップダウンと、シーンツリーで renderer を右クリックしたときの
Coloring サブメニューの構成。Paint coloring の中身は共通の `paintChoiceMenu`
(`tritium/react-gui/src/shared/coloring/paintChoiceMenu.ts`) が作るので、2 か所は同じ並びになる。

```
Molecule color                        renderer だけ。分子の色に従う
Paint coloring ▸ CueMol2 default
                 CueMol1 (woody)
                 ─────
                 Okabe-Ito ▸ ■ Orange / ■ Sky blue / …   (テーマごと。色見本と色名)
                 Tol bright ▸ …
                 ─────
                 Red / Orange / Yellow / Green / Cyan / Blue / Purple   (renderer だけ。style プリセット)
Solid coloring / CPK … / Reset to default style
```

- **Molecule color**: `DefaultHSCPaint` style (SolidColoring + `$molcol`) を当てる。ribbon / cartoon / tube の
  既定の状態で、分子 (オブジェクト) の coloring から色を引く。style 名が `...Paint` で終わるが PaintColoring
  ではないので、Paint のサブメニューには置かず、独立した項目にしている。オブジェクトには出さない
  (オブジェクト自身が分子の色の持ち主で、style も当てられない)。
- **Paint coloring** の項目は、どれも対象 (オブジェクト、または renderer) に新しい PaintColoring を持たせる。
  renderer で選ぶと、renderer が自分の表を持ち、分子側の paint からは切り離される。
  - CueMol2 default: `LEGACY_PAINT_ENTRIES` の固定 4 色 (`paint-type-paint-cuemol2`)。
  - CueMol1 (woody): `WoodyHSCPaint` style と同じ 3 色 (sheet `#7FFF7F`、helix `#FF7F7F`、`*` `#FFFFBF`) の
    PaintColoring (`paint-type-paint-cuemol1`)。style ではなく表として作るので、オブジェクトにも当てられる。
  - テーマの色: その色を主色にした 4 行 (上の「色の決め方」の修飾子)。coloring id は `paint-theme-<色名>`
    (例 `paint-theme-okabeito_3`)。使う色は `ensureSceneColor` で scene に複製する。
  - style プリセット: 色相順 (Red, Orange, Yellow, Green, Cyan, Blue, Purple) に並べ、リストに無いもの
    (ユーザーの `*Paint` style) はその後ろに置く (`panelList.ts` の `PRESET_ORDER`)。style manager は名前を
    アルファベット順に返すので、並べ直している。`DefaultHSCPaint` と `WoodyHSCPaint` はここに出さない
    (上の 2 項目が代わる)。どちらの style も古い qsc のために `default_style.xml` に残している。
- 分子を読み込んだときの自動の色分け (n 番目の分子に n 番目の色) はメニューに無い。テーマの色を選べば
  同じ色になる。

### テーマと色の一覧

`getPaintColoringStyles` の結果の `themes` (`listPaintThemes`) が、パネルと右クリックメニューの両方に渡る。

- テーマの表示名は `<palette_label id="okabeito" value="Okabe-Ito"/>`、色の表示名は各色の定義の隣の
  `<palette_color_label id="okabeito_1" value="Orange"/>` (どちらも `data/cuemol3_style.xml`)。
  - 色名は、パレット自身の名前がある Okabe-Ito と Paul Tol はそれを使い、公式名の無い ColorBrewer と
    Tableau は見た目の名前にしている。
  - 色名の無い色は番号で出す。
- メニューに出るのは、`palette_label` があり、色 (`<テーマ名>_<番号>`) が 1 つ以上あるテーマ。ユーザーの
  style ファイルで両方を足せば、メニューにも出る。
- 並びは、scene の既定テーマ (`default_paint`) を先頭に、残りを表示名の順。style manager は定義順を
  保たないため。
- 色見本の値は scene で解決する (scene の style set で色を書き換えていれば、その色)。

### op

`set_renderer_coloring` の省略可能な引数 `paintColor` が、mode `paint-type-paint` の主色を選ぶ:
テーマの色名 (`okabeito_3`)、`cuemol2`、`cuemol1`。省略 (null) なら自動の色分け。テーマに無い色名はエラーで
返す。`list_coloring_styles` の結果の `paintThemes` に、テーマと色名の一覧が入る。GUI でメニューを選ぶと、
同じ引数で op が記録される (`recordColoringChoice`)。

### ドロップダウンを platform のメニューで出す

coloring パネルのドロップダウンは、Blueprint の Popover ではなく、右クリックメニューと同じ platform のメニューで
出す: macOS はネイティブメニュー、Windows / Linux は React の `MenuPanel`。

- 汎用のフック `usePopupMenu()` (`tritium/react-gui/src/renderer/shell/menu/usePopupMenu.ts`) が、共通の
  `MenuNode` ツリーをボタンの直下に出し、選ばれた項目の action を返す。macOS では invoke チャンネル
  `POPUP_MENU_SHOW` で main (`main/popupMenu.ts`) にツリーを渡すので、action は structured clone できる
  値にする。
- 中身を自由に描く必要が無いドロップダウン (項目・チェック・色見本・区切り線・サブメニューだけのもの) は、
  これで platform のメニューにできる。今これを使うのは coloring パネルだけ。
- 置き場所は `shell/menu/`。h3-kit は ESLint の層の規則で `shell/` を import できず、Windows / Linux 用の
  `ContextMenuProvider` が `shell/menu/` にあるため。
- ネイティブメニューの色見本は `main/menuSwatches.ts` が描く。名前 (`white` / `black`) のほか `#rrggbb` を受ける。

## 既知の制約

- MolCoord (Object) には style を当てる仕組みが無い (`applyStyles` は Renderer のみ)。
  そのため paint の組み立て自体は TS に残り、色の値とテーマ名だけを style から読む。
- 修飾子の値 (色相・彩度・明度のずらし量) は TS の `DEFAULT_PAINT_ENTRIES` にあり、
  テーマによらず共通。淡いテーマ (`tollight`、`brewerset2`) では coil や核酸との差が
  小さくなる。
- テーマに灰色を含むもの (`tolbright` / `tolvibrant` の 7 番目など) は、その番目の分子が
  灰色になる。
- 既定のテーマ (`default_paint`) を GUI から切り替える機能は無い (分子ごとの主色はメニューで選べる)。構想は
  [`../plans/261027-palette-set-switch-plan.md`](../plans/261027-palette-set-switch-plan.md)。
