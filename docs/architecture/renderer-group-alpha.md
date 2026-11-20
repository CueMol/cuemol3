# renderer の半透明 (veil の後処理合成)

renderer の `alpha` (renderer 単位の半透明) は、WebGL / デスクトップ GL のフレームパイプラインで、レイトレーサー (umbreon) と同じ方式で合成する: alpha ごとの層 (veil) を不透明として別に描き、画素ごとに重みを付けて合成する。描く順番と z-buffer に左右されず、umbreon の画像と同じ重なり方になる。頂点ごとの alpha (色の alpha) はシーンのパスでのブレンドのまま。umbreon 側の仕組みは [umbreon-group-alpha-blend.md](umbreon-group-alpha-blend.md)。

## 1. 以前の問題

renderer の alpha は、シーンのパスで色の alpha に掛けて普通にブレンドしていた (`SRC_ALPHA, ONE_MINUS_SRC_ALPHA`)。半透明どうしはソートせず、深度の書き込みも止めていなかったので:

- 同じ renderer の中で、先に描いた面が後の面を深度で消すかどうかが三角形の順番で決まり、自分の裏面が場所によって見えたり見えなかったりした (まだらな明るさや継ぎ目)。
- 半透明どうしが重なると、描く順番で結果が変わった。

## 2. 方式

### 2.1 veil への振り分け (`Scene`)

- `getDefaultAlpha() < 1 - 1e-4` の renderer が veil。alpha が 1e-4 以内のものは 1 つの veil にまとめる (初出順、umbreon の `bucketVeils` と同じ。`Scene::assignVeils`、`Scene::getVeilAlphas`)。`isTransp()` を上書きして半透明扱いの renderer (選択の表示、ラベル、地図の mesh など) でも、alpha が 1 なら veil にしない。
- `Scene::display` が描く範囲は `Scene::DrawFilter` で選ぶ (パイプラインが `Scene::AutoDrawFilter` で描画の前後に設定する。既定は全部):
  - 背景: veil と常時前面のラベル以外。頂点ごとの alpha はここでブレンドされる。
  - veil i: その veil の renderer だけを `alpha = 1` (不透明) で。ラベルは描かない。
  - 常時前面のラベル: `Renderer::isLabelOnTop()` (`NameLabelRenderer` と `AtomIntrRenderer` の `label_on_top`) の renderer のラベルだけ。

### 2.2 パイプライン (`FrameRenderPipeline`)

veil があるフレームは、AO・AA の設定によらずフレームパイプラインを通す (`Scene::requiresFramePipeline`)。

1. 背景のパス → AO → AO の合成。合成の出力先は合成の RT (`m_pCompRT`)。
2. veil ごとに (`compositeVeils`):
   - veil の RT (RGBA8 + 深度) をクリアし、背景の深度を写す (`RenderTarget::blitDepthTo`)。
   - veil の renderer を不透明として描く (深度テストと書き込みあり)。背景の不透明物より奥の面は捨てられ、veil の中は最前面の面だけが残る (自分の裏面は見えず、色も二重に乗らない)。書かれた画素 (alpha > 0) がこの veil の覆う画素。
   - 覆う画素だけ、2 枚の RGBA16F に加算で足す (`veil_accum_frag.glsl`): 1 枚目に `(a_i S_i, a_i)`、2 枚目に `-log(1 - a_i)`。透過率は乗算で溜めず、最後に `T = exp(-Σ)` で戻す。どちらも加算のブレンドだけで済む。
3. 合成 (`veil_composite_frag.glsl`): 背景 B の入った `m_pCompRT` に重ねる。シェーダは累積の 2 枚だけを読み、`(Σ a_i S_i / Σ a_i, 1 - T)` を出す (覆う veil が無い画素は捨てる)。ブレンドは色が `(SRC_ALPHA, ONE_MINUS_SRC_ALPHA)`、alpha が `(ONE, ONE_MINUS_SRC_ALPHA)` (`DisplayContext::setBlendModeVeil`)。結果は umbreon の PerPixel と同じ:
   - 色 `T * B + (1 - T) * Σ a_i S_i / Σ a_i`、alpha `(1 - T) + T * B.a`
   - `T = Π (1 - a_i)` は背景の重み。重みは負にならず合計は 1。veil が 1 枚なら `(1 - a) B + a S`。描く順番にも veil どうしの奥行きにも依存しない。
   - B を `m_pCompRT` から読みながら同じものに書くと読み書きが衝突するので、B はブレンドで使い、シェーダでは読まない。
4. 常時前面のラベルを `m_pCompRT` の上に描く。
5. そのあとに FXAA / SMAA、jitter の累積 (veil の無いフレームと同じ)。

再表示 (`presentLast`、カメラが動かずに hover などで描き直すフレーム): veil があり空間の AA が無いときの最後の段階は「`m_pCompRT` のコピー」(`StageRecord::COPY`)。背景の scene RT から合成をやり直す段階 (`COMPOSITE`) のままだと、再表示の瞬間に veil とラベルが消えるため。FXAA / SMAA は元から `m_pCompRT` から再表示し、jitter はサンプルごとに描き直す。

メモリは veil の数によらず一定 (veil の RT 1 枚と累積 2 枚、`m_pCompRT` は空間の AA と共用、最初に veil が出たフレームで確保)。veil 1 つにつき、その renderer だけの描画、深度のコピー、全画面の累積パス 2 回が増え、フレームに 1 回、全画面の合成パスが増える。

### 2.3 光と AO

- veil には AO を掛けない。半透明の veil は不透明物と混ざって描かれ、はっきりとは見えないので、AO が無くても読み取りに大きな差は出ない。光は各方式の光のまま (Fast GI は Fast GI の光、GTAO は AO なしと同じ光)。
- veil は影も AO も落とさない (umbreon と同じ)。Fast GI のプローブの焼き込みは veil を除いて描き、遮蔽物の球の収集からも除く (`AmbientProbeVolume`)。以前は半透明の殻が不透明な遮蔽物として中の構造を暗くしていた。renderer の alpha の変更は veil と背景の間を移すので、形の変更の数 (`Scene::getOccluderGen`) を進めて焼き直す (renderer のプロパティの変更として既に進む)。
- 採らなかった案:
  - veil を描くシェーダで焼き込みプローブの可視性を引いて環境光に掛ける (Fast GI。追加のパスは要らない)。alpha 0.8 前後で表面の凹凸が少し読みやすくなるだけで、よく使う 0.3〜0.6 では差が小さい。
  - veil ごとに法線・material を描き、画面上の AO と合成を回す。AO の計算・ノイズ除去・合成が veil の数だけ増える。

### 2.4 そのほかの描画

- edge 線とシルエットは veil のパスで veil と一緒に不透明として描くので、veil と同じ重みで合成される (以前は alpha が 2 回掛かっていた)。
- 常に手前に出す描画のうち、シーンのパスの外 (center mark、距離を測る線、矩形・投げ縄の選択、hover highlight。`GUIView::drawUiOverlays` / `drawHoverOverlay`) はパイプラインの仕上げた画像の上に描くので、veil の合成も AO も掛からない。深度で隠すものが使う深度 (既定のフレームバッファへのコピー) は背景の深度だけで、veil はオーバーレイを隠さない。シーンのパスの中で深度テストを切る renderer は `label_on_top` のラベルだけで、これは veil の合成のあとに描く (§2.2 の 4)。
- fog は veil のパスでも掛かり、合成は fog 込みの色で行う。
- pick (alpha 0.6 以下の renderer を除外) は変えていない。

### 2.5 画像の書き出し

- veil があるときは AO がオフでもパイプラインを通す (`GUIView::renderAOColorFrame`。AO のパスは回さず、合成と veil の合成だけ)。
- 背景を透明にする書き出しは、色を alpha を掛けた形 (premultiplied) で描く: 0 でクリアし、シーンのパスのブレンドは alpha を `a + (1 - a) * dst` で溜める (`setBlendModeVeil`)。veil の合成と AO の合成はこの形のまま線形に効き、最後にサンプルをまとめるときに alpha で割り戻す (`OffScreenView`、`jitter_compose_frag.glsl` の `u_unpremul`。supersample が無くても 1 サンプルの累積を通す)。以前は背景の色 (黒など) が半透明の画素に混ざって暗くなり、alpha も 2 乗になっていた。

## 3. 確認

- 合成の式: 黒・照明なしの 2 つの veil を白い背景に重ね、fog を外して (slab を大きく) 書き出した。両方が重なる画素は 255 × (1 - 0.6)(1 - 0.5) = 51、表面だけ (alpha 0.5 / 0.6) は 128 / 102。2 つの alpha を入れ替えても重なる画素は 51 のまま。
- 1CRN の stick と ribbon を alpha 0.5 の分子表面で覆ったシーンで、表面の裏側が二重に乗らず、中が均一に透けること、umbreon と同じ重なり方になることを確かめた (陰影の違いは光と GI の違い)。
- テスト: `src/tests/qsys/test_scene_veils.cpp` (振り分け)、`test_scene_occluder_gen.cpp` (alpha の変更で焼き直す)、tritium の `gfxManagerContract.test.ts` (peer の API に `blitDepthTo`・`setBlendModeVeil`)。

## 4. 既知の制限

- 頂点ごとの alpha は今もシーンのパスでのブレンドで、描く順番に依存する。
- veil には AO が掛からず、Fast GI の光 (AO を前提に環境光を強めたもの) のまま描くので、不透明のときより少し明るく平らに見える。
- veil は奥行きで互いを減衰させない (umbreon の PerPixel と同じ。貫入した 2 つの veil は重みの比で混ざる)。
