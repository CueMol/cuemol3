# renderer の半透明を後処理の合成にする計画

renderer の `alpha` (renderer 単位の半透明) を、WebGL の描画でも umbreon と同じ「renderer を不透明として別に描き、画素ごとに重みを付けて合成する」方式にする。描く順番と z-buffer に左右されない見た目にし、umbreon の画像と揃える。頂点ごとの alpha (色の alpha) は今の経路のまま残す。

## 1. 現状と問題

- renderer の alpha は `Scene::displayRendImpl` で `pdc->setAlpha` に入り、各 GPU prim が `DrawParamsBlock.frag_alpha` に詰め、`fog_inc.glsl` の `fragFogColor` で `color.a * frag_alpha` にする。合成は常時有効の `glBlendFunc(SRC_ALPHA, ONE_MINUS_SRC_ALPHA)` (`OcView.cpp`、WebGL は `gfx_manager.ts`)。
- `Scene::display` は不透明 → `isTransp()` の renderer → `isDispLater()` の順に描くが、半透明どうしは UID 順のままでソートせず、深度の書き込みも止めていない (`enableDepthTest(false)` はコメントアウト、WebGL では空実装)。
- このため:
  - 同じ renderer の中で、先に描いた面が後の面を深度で消すかどうかが三角形の順番で決まり、場所によって半透明の度合いが変わる (自分の裏面が見えたり見えなかったりする)。
  - 半透明どうしが重なると、描く順番で結果が変わる。
  - 半透明の画素は、手前の面の深度・法線・material を 1 つだけ持つので、AO の合成 (`ao_composite_frag.glsl`) は「背景とブレンド済みの色」を手前の面の法線で分解する。
  - WebGL では MRT の法線・material にもブレンドが掛かる (`docs/architecture/gtao-screen-space-ao.md` の既知の問題)。
- 頂点ごとの alpha も同じシェーダ・同じブレンドを通る。`isTransp()` は renderer の alpha しか見ない。

## 2. 参考にした実装

### umbreon (目標とする見た目)

`docs/architecture/umbreon-group-alpha-blend.md`、`umbreon/src/umbreon/blend/group_blend.cpp`。

- alpha < 1 の renderer は veil (層) になり、alpha が 1e-4 以内のものは 1 つの veil にまとめる。
- 背景のパス (veil を全部隠す) と、veil ごとのパス (その veil だけを不透明として描く) を別々に描く。veil の中は普通の深度テストなので、見えるのは最前面の面だけ (自分の裏面は見えず、色も二重に乗らない)。同じ veil の renderer どうしも互いに遮蔽する。
- CueMol の既定の合成 (PerPixel): 画素ごとに、覆っている veil の集合 K について
  - 背景の重み `T = Π_{i∈K} (1 - a_i)`
  - veil i の重み `w_i = a_i (1 - T) / Σ_{j∈K} a_j`
  - `out = T * B + Σ w_i * S_i` (表示の値の空間で合成)
  - 重みは負にならず合計は 1。veil が 1 枚なら `(1 - a) B + a S`。描く順番にも veil どうしの奥行きにも依存しない (貫入した 2 つの veil は奥行きで減衰し合わない)。
- 頂点ごとの alpha は別の仕組み (1 本の光線上の front-to-back の over 合成) で、veil の中でも併用できる。

### ChimeraX

`/Users/user1/ext/ChimeraX/src/bundles/graphics/src/opengl.py` の `draw_transparent` ("Single layer transparency")。

- 不透明を描いたあと、半透明物の深度だけを書き (1 パス目)、深度が一致する最前面の半透明の面だけを 1 回ブレンドする (2 パス目、`GL_LEQUAL`)。半透明は全体で 1 層だけで、奥の半透明物は手前の半透明物を通して見えない。
- 描く順番には依存しない。renderer 単位の透明度と頂点ごとの alpha の区別はなく、どちらも色の alpha (フラグメントで 0.99 を閾値に不透明・半透明のパスへ振り分ける)。
- 本計画との違い: ChimeraX は半透明全体で 1 層だが、本計画は umbreon と同じく alpha ごとに層を分け、重なった層も見える (veil の中は ChimeraX と同じく最前面だけ)。

## 3. 方針

umbreon の PerPixel と同じ合成を、WebGL のフレームパイプラインの後処理で行う。

### 3.1 renderer の振り分け (Scene)

- veil にする条件は `getDefaultAlpha() < 1 - 1e-4` (renderer の alpha だけ)。`isTransp()` を上書きして常に true を返す renderer (選択の表示、ラベル、地図の mesh など) でも、alpha が 1 なら今の経路に残す。
- veil は alpha が 1e-4 以内のものをまとめる (umbreon の `bucketVeils` と同じ)。
- 背景のパスは veil 以外を今の順番 (不透明 → `isTransp()` → `isDispLater()` → ラベル) で描く。頂点ごとの alpha は今どおりここでブレンドされる。
- veil のパスは、その veil の renderer だけを `frag_alpha = 1` (不透明) で描く。renderer の alpha は合成の重みにだけ使う。veil の中の頂点ごとの alpha は今どおりブレンドする。
- `Scene::display` に「どの集合を描くか」を渡せる入口を足す (背景、veil i)。renderer の振り分けは純粋な関数にして単体テストする。

### 3.2 パイプライン (FrameRenderPipeline)

1. 背景のパス: 今のシーン描画 (scene RT) → AO → AO の合成。veil があるフレームでは、AO の合成の出力先を合成の RT (`m_pCompRT`) にする (空間の AA があるときは今もそこに書いている)。
2. veil ごとに:
   - veil の RT (color + depth、1 枚を使い回す) をクリア (alpha 0) し、深度に背景の深度を写す。
   - veil の renderer を不透明として描く (深度テストあり、書き込みあり)。背景の不透明物より奥の面は捨てられ、veil の中は最前面だけが残る。
   - 書かれた画素 (alpha > 0) が「この veil が覆う画素」。
   - 累積の RT に、覆う画素だけ全画面 1 回の加算で足す: 1 枚目 (RGBA16F) に `rgb += a_i * S_i`、`a += a_i`、2 枚目 (R16F) に `-log(1 - a_i)`。ブレンドの式は描画先すべてに共通なので (`glState.ts` の `blendFunc`)、同じパスで加算と乗算を両立できない。透過率 T は乗算で溜めず、`-log(1 - a)` の和から最後に `T = exp(-Σ)` で戻す。これで 2 枚とも加算の 1 回で済む (ブレンドの切り替えが無い)。RGBA16F への加算は jitter の累積で既に使っている。veil は a < 1 - 1e-4 なので log は発散しない。加算と乗算の 2 回のパスに分ける案もあるが、全画面のパスが veil ごとに 1 回増えるだけでコストの差は小さく、ブレンドの状態を 1 つに保てる log の方を採る。
3. 合成のパス: 背景 B の入った `m_pCompRT` に、veil の色をブレンドで重ねる。シェーダは累積の 2 枚だけを読み、`rgb = acc.rgb / acc.a`、`alpha = 1 - T` (`T = exp(-Σ)`) を出す。`acc.a` が 0 (覆う veil が無い) の画素は除算の前に捨てる (B がそのまま残る)。ブレンドは RGB を `(SRC_ALPHA, ONE_MINUS_SRC_ALPHA)`、alpha を `(ONE, ONE_MINUS_SRC_ALPHA)` にする。RGB は `(1 - T) * acc.rgb / acc.a + T * B` (上の式)、alpha は `(1 - T) + T * B.a` (§3.4 の背景の透明) になる。
   - B を `m_pCompRT` から読みながら同じ `m_pCompRT` に書くと、テクスチャの読み書きが衝突する (WebGL ではエラー、GL では未定義)。ブレンドで重ねれば B を読まずに済み、背景を別の RT に写すパスと RT も要らない。
   - ブレンドの式を RGB と alpha で分ける設定が要る。今の `DisplayContext` には `setBlendModeAdd(bool)` しかないので、RGB と alpha を分けた合成のモードを 1 つ足す (C++ の `DisplayContext`、デスクトップの `OcDisplayContext`、tritium の `ElecDisplayContext` の peer 呼び出し、`glState.ts`。`glState.ts` は XOR の代わりで `blendFuncSeparate` を既に使っている)。
4. 常時前面のラベル (`label_on_top`) を同じ `m_pCompRT` の上に描く (§3.5)。これで表示・AA・再表示 (hover) が同じ合成結果を参照する。
5. そのあとに FXAA / SMAA、jitter の累積 (今と同じ)。

再表示 (`presentLast`): カメラが動かずに描き直しだけが要るフレーム (hover の切り替えなど) では、ジオメトリを描かず、記録した最後の段階をもう一度実行する。空間の AA も jitter も無いときの最後の段階 (`COMPOSITE`) は、背景の scene RT から AO の合成をやり直すだけなので (`FrameRenderPipeline::presentStage`)、そのままでは veil と常時前面のラベルが再表示の瞬間に消える。veil があるフレームでは、AA の有無によらず、ラベルまで描いた合成結果が `m_pCompRT` に残る (上の 1・3・4)。AA が無いときは最後の段階を「`m_pCompRT` をコピーする」段階にする。FXAA / SMAA は既に `m_pCompRT` から再表示し、jitter はサンプルごとにシーンを描き直すので、そのままでよい。

veil の数によらずメモリは一定 (veil の RT 1 枚と累積 2 枚、`m_pCompRT` は空間の AA と共用)。veil 1 つにつき、その renderer だけの描画、深度のコピー、全画面の累積パス 1 回が増え、フレームに 1 回、全画面の合成パスが増える。

### 3.3 veil の光と AO

半透明の veil は不透明物と混ざって描かれ、はっきりとは見えないので、AO は無くても大きな問題にはならない。

- 最初は veil に AO を掛けない。光は、Fast GI では Fast GI の光、GTAO では AO なしのときの光 (`getMaterialLight` の AO なしの換算。Fast GI の光は AO で環境光が暗くなる前提で環境光を強めているので、GTAO の veil に使うと明るすぎる) を使う。
- 焼き込みプローブの遮蔽物から veil を除く (Fast GI)。今の焼き込みは `pScene->display` で全 renderer を描くので (`AmbientProbeVolume.cpp`、occluder の球の収集も同じ)、半透明の外殻が不透明な遮蔽物として中の構造を暗くする (今もそうなっている)。背景のパスと同じく、veil 以外の集合だけを描いて焼く。umbreon も背景のパスでは veil を物理的に取り除くので、veil は影も AO も落とさない。renderer の alpha が変わると veil と背景の間を移るので、alpha の変更でも焼き直す (形の変更の数 `Scene::notifyOccluderChanged` を進める)。
- veil の表面にプローブの陰影を足すかは、目視で決める (§4 の段階 3)。Fast GI で背景には通常の AO を掛け、veil には陰影を足さずに同じ分子を見て、表面の形と中の構造が十分読めればそこで止める。表面自身の凹凸が読み取りにくいときだけ、veil を描くシェーダでプローブの可視性を引いて環境光に掛ける (追加のパスは要らない。ChimeraX が multishadow の AO を描画の時点で半透明の面にも掛けているのと同じ考え方)。そのときは `gtao_frag.glsl` の `sampleProbeAtlasCubic` と `probeMomentVisibility` を include に出し、プローブの atlas と座標変換の uniform を veil のパスで lit のシェーダに渡す。不透明物の AO は `min(画面上の AO, プローブ)` なので、veil は画面上の AO の分 (接触部の細かい暗さ) だけ陰影が甘くなる。GTAO にはプローブが無いので、veil には AO を掛けない。
- veil が背景に落とす AO (半透明の表面が奥の不透明物を暗くすること) は扱わない (umbreon の PerPixel も、覆われていない画素は背景のパスの値)。
- 採らなかった案: veil ごとに法線・material を描き、画面上の AO と合成を回す。不透明物と同じ質の AO になるが、AO の計算・ノイズ除去・合成が veil の数だけ増える (全画面のパスなので、veil の覆う面積に絞らない限り画面の画素数に比例する)。

### 3.4 パイプラインを通す条件と書き出し

- veil があるときは、AO・AA の設定によらずフレームパイプラインを通す (`Scene::requiresFramePipeline` に veil の有無を足す)。
- 画像の書き出し (`OffScreenView` → `GUIView::renderAOColorFrame`) も同じパイプラインを通す。AO なしで直接描く経路も、veil があるときはパイプラインにする。
- 背景の透明 (`bgTransparent`): 出力の alpha は `T * B.a + (1 - T)` (veil は不透明として合成する)。

### 3.5 そのほかの描画との関係

- edge 線とシルエットは、veil の renderer のものを veil のパスで不透明として描き、veil と同じ重みで合成する (今は alpha の 2 乗になっている)。
- 常に手前に合成する描画は、置き場所で 2 種類に分かれる。veil の合成はパイプラインの中 (AA の前) に置くので、1 は今のまま影響を受けず、2 だけを別に扱う。
  1. シーンのパスの外 (UI のオーバーレイ): center mark (`CenterMarkDrawObj`)、距離を測るときの線 (`DistPickDrawObj`)、矩形・投げ縄の選択 (`RectSelDrawObj`)、hover highlight。`GUIView::drawUiOverlays` と `drawHoverOverlay` が、パイプラインの仕上げた画像 (AO の合成と AA の後) の上に既定のフレームバッファへ描く。深度を無視する線 (`setNoDepth`) を使うのもすべてこちら。AO も veil の合成も掛からない。深度で隠すもの (center mark など) が使う深度 (既定のフレームバッファへの深度のコピー) は背景の深度だけになり、veil は入らない (半透明の表面はオーバーレイを隠さない)。
  2. シーンのパスの中で深度テストを切って描く renderer: `label_on_top` のラベルだけ (下の項目)。
- pick (alpha 0.6 以下を除外) は今のまま。
- ラベル (`displayLabels`) と `isTransp()` の上書きで半透明扱いの renderer は今の経路のまま。
- 常時前面のラベル (`NameLabelRenderer` と `AtomIntrRenderer` の `label_on_top`): 今は深度テストを切って最後に描くので、半透明の表面に色を付けられない。背景のパスに入れたままだと、veil の合成で表面の色が上に乗り、表面の alpha を 1 に近づけるほど文字が薄れて、常時前面を選んだ意味が無くなる。veil があるときは、常時前面のラベルを背景のパスから外し、veil の合成のあと・AA の前に描く (Scene に「常時前面のラベルだけ」「それを除く」の集合を足す)。合成のあとに描くので AO も掛からない (今もラベルは法線を書かず AO の対象外)。距離線などの 3D 本体は背景のパスのまま。umbreon は文字ラベルを出力しないので、基準は WebGL の今の「常に手前に表示」の挙動。
- fog: veil のパスでも fog を掛けて描き、合成は fog 込みの色で行う (umbreon も各パスに fog が入る)。

## 4. 段階

1. Scene の振り分けと、集合を指定して描く入口 (背景、veil i、常時前面のラベル)。純粋関数の単体テスト (alpha のまとめ方、`isTransp()` の上書きが veil にならないこと)。
2. パイプライン: veil の RT、累積、合成のシェーダ (デスクトップ GL と WebGL の両方の RT)。veil があるときにパイプラインを通す。veil には AO を掛けない。
   - ここで一度、方式を目視で確かめる (照明や書き出しを作り込む前に、合成の結果と回転時の重さに問題があれば見直す): 半透明の分子表面と中の ball-and-stick を回して、表面の裏側の色が二重に乗らず、中の結合が透けて見えること。表面をもう一つ重ね、alpha を同じ値から違う値に変えて、1 つの veil の中の遮蔽と 2 つの veil の合成を見分ける。
   - 同じシーンで合成の式を検算する: alpha 0.6 と 0.5 の veil が重なる画素で背景の重みが 0.2 (`(1 - 0.6)(1 - 0.5)`) になること。2 つの veil の描く順番を入れ替えても画素が変わらないこと (順番を入れ替えて同じ誤りになるケースもこの数値で見つかる)。
3. 光とプローブ: veil の光 (Fast GI / GTAO)、焼き込みから veil を除く、alpha の変更で焼き直す。Fast GI で veil に陰影が要るかを目視で決め、要るときだけプローブを引く。
4. 常時前面のラベルを合成のあとに描く。段階 2 のシーンに常時前面のラベルを 1 つ置き、表面の alpha を上げても文字に表面の色が掛からないこと。再表示の段階 (`m_pCompRT` のコピー): AA と jitter を切り、カメラを止めたままポインターを別の原子へ移して、hover のハイライトだけが切り替わり、veil とラベルが消えないこと。edge・シルエット。
5. 書き出しの経路。
6. umbreon と並べて確認する。重なった 2 つの半透明 renderer (alpha が違うもの、同じもの)、不透明物との前後関係。renderer の描く順番を入れ替えても画素が変わらないこと。
7. 文書 (architecture に仕様、`gtao-screen-space-ao.md` の既知の問題の更新)。

## 5. テスト (最小)

- C++: 振り分けの純粋関数 1 件 (alpha 0.5 と 0.5 + 1e-5 が 1 つの veil、alpha 1 の `isTransp()` の renderer は背景、alpha 0.3 の renderer は veil)。
- C++: renderer の alpha の変更で形の変更の数 (`Scene::getOccluderGen`) が進むこと。既存の `src/tests/qsys/test_scene_occluder_gen.cpp` に 1 件足す (veil と背景を移るので、焼き直しが要る)。
- 合成の式は書き出し画像で確かめる (描く順番を入れ替えた 2 枚が一致すること、veil 1 枚の画素が `(1 - a) B + a S` になること)。シェーダの単体テストは持たない。
