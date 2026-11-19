# 分子表面の立体感 (AO・ライティング) を ChimeraX に近づける

CueMol3 (tritium) の分子表面は、同じ構造を ChimeraX で描いた画に比べて奥行き感が弱い。原因をコードで確かめ、
**安い段階から順に実装し、段階ごとに画面を見て、十分ならそこで止める** プランにする。

- 依頼書: Claude Docs「Claude Code 指示書: CueMol3 立体感改善プランの作成」
  (https://claude.ai/artifact/6WRgkYxN6BNYwuY8CuSPRW)
- 置き換える計画: `docs/plans/261108-large-scale-ambient-shadow-plan.md` (粗い multishadow を AO のパスで引く案)。
  依頼書の制約「ChimeraX と同じ多方向シャドウマップを描画時に参照する方式は採用しない」に合わないので、このプランで
  置き換えて削除する。その調査 (§1 の方法の比較) のうち使えるものは §5 に引き継いだ。
- 関連: `docs/architecture/gtao-screen-space-ao.md` (今の GTAO)、`docs/architecture/console-chimerax-dialect.md`
  の `lighting` (今は soft / gentle / full を GTAO の on で近似して warn している)

## 前提

| 項目 | 値 |
|---|---|
| 比較する構造 | PDB 2BBV (Black beetle virus のカプシド、非対称単位、7 鎖 7817 原子) |
| ChimeraX のライティング | `lighting full` 相当 (key 0.7 + 影、fill 0.3、ambient 0.8 に 64 方向の multishadow)。`quickstart.cxc` の 2BBV 部分に `lighting` は無いが、ChimeraX は open 時に鎖 5 本以上・100 万原子未満を "medium polymer" とし `preset: 'full'` を選ぶ (`/Users/user1/ext/ChimeraX/src/bundles/atomic/src/structure.py:1529-1625`)。30 万原子未満なので multishadow は既定の 64 |
| 比較画像 | `/Users/user1/proj64/chx-compare/out/phase3/pair_2.png` (コマンド 12-23)。分子表面だけの場面は `qs_cx/cx_010.png` と `qs_cm/cm_010.png` (`surface #1` の直後) |
| CueMol 側の撮影条件 | `/Users/user1/proj64/chx-compare/scripts/cm_runner.py:63-66` が AO Medium (`aoRadius 8`、`aoSteps 4`、`aoIntensity 1.9`、`aoHalfRes true`) を入れてから撮る。保存は ChX の `save` (OffScreenView、AO はフル解像度) |
| 性能目標 | 定めない。段階ごとの追加時間を計測して記録するだけ |
| 進め方 | 段階ごとに実装 → 2BBV で撮り直し → ユーザーの目視。十分なら以降の段階は保留にする |

---

## 1. 現状のまとめ

### 1.1 描画の経路

tritium は C++ の描画コードがそのまま使われ、GL の呼び出しは worker の **WebGL2** context に送られる
(`tritium/react-gui/src/renderer/worker/server/gfx_manager.ts:100`)。シェーダは `#version 300 es` を前置して
コンパイルされる (`tritium/react-gui/src/renderer/worker/server/gfx/ShaderStore.ts:116`)。同じシェーダを uxp_gui の
デスクトップ GL (`src/sysdep/ogl_core`) も使う。依頼書の「WebGL2 (GLSL ES 3.00)」の前提は正しい。

フォワード描画 + 後処理で、AO / AA / jitter のどれかが on のとき off-screen のパイプラインに乗る
(`docs/architecture/gtao-screen-space-ao.md` §1、`src/qsys/FrameRenderPipeline.cpp`)。

```
[scene pass]  頂点ごと (三角形) / 画素ごと (impostor) のライティング + フォグを済ませた色
   -> m_pAOSceneRT  COLOR0 色 RGBA8 / COLOR1 eye 空間の法線 RGBA16F (MRT, .w = 1 固定) / DEPTH24 (フル解像度)
[GTAO]        gtao_frag.glsl       -> m_pAoRT  RGBA8  R = 遮蔽, G = edges, B/A 未使用   (aoHalfRes 時は 1/2)
[denoise]     ao_denoise_frag.glsl -> m_pAoDenRT  edge-aware 3x3                         (AO と同解像度)
[composite]   ao_composite_frag.glsl  color.rgb * AO (フォグの奥ほど AO を弱める, 半解像度なら depth 判定 upsample)
[post-AA]     none / FXAA / SMAA -> default framebuffer
```

- 深度は深度テクスチャから線形化し、法線は MRT の幾何法線 (無ければ深度から再構成)。MSAA は使わない。
- トーンマッピング・ガンマ補正のパスは無い (RGBA8 に直接書く)。
- 投影は正射影と透視の両方に対応 (`u_isOrtho`)。near / far は slab から決まる (`src/qsys/GUIView.cpp:126-144`)。
- 3 つの表現の描き方:
  - 分子表面: ChX の `surface` は `dsurface` renderer
    (`tritium/react-gui/src/plugins/chimerax-console/worker/surface.ts:84`)。メッシュは C++ で作り、
    `gfx::TrigGpuPrim` で描く。ライティングは**頂点ごと** (`src/sysdep/ogl_core/trig_vert.glsl:47-48`)。
  - リボン: 三角形メッシュ (同じ trig シェーダ)。
  - 球 / スティック: impostor。`gl_FragDepth` と法線を書き、ライティングは**画素ごと**
    (`src/modules/molvis/sphere_body_frag.glsl:113`、`cylinder_body_frag.glsl`)。
- MRT の法線を書くシェーダ: `trig_frag`、`trigedge_frag`、`pixdraw_frag`、`linew_frag` (`src/sysdep/ogl_core/`)、
  `mapmesh_frag` (`src/modules/xtal/`)、`sphere_body_frag`、`cylinder_body_frag` (`src/modules/molvis/`)。
- WebGL2 で使える物: `EXT_color_buffer_float` を起動時に取得済み (`gfx_manager.ts:105`)。3D テクスチャ、
  timer query、GPU のミップ生成を使うコードは無い。AO のデバッグ表示 (`u_debugMode`) はシェーダにあるが、
  呼び出し側が 0 固定 (`src/qsys/FrameRenderPipeline.cpp:319`)。

### 1.2 現行パラメータ

| 項目 | 値 | 場所 |
|---|---|---|
| `aoRadius` (world 単位 = Å) | 既定 4。プリセット Low 4 / Medium 8 / High 12 | `src/qsys/Scene.qif:49`、`tritium/react-gui/src/renderer/data/sceneQualityPresets.ts:36-38` |
| `aoIntensity` (`pow(visibility, x)`) | 既定 2.2。Low 2.2 / Medium 1.9 / High 1.7 | 同上 |
| `aoSlices` / `aoSteps` | 9 / 3。プリセットは steps だけ 3 / 4 / 5 | 同上 |
| 距離フォールオフ | 半径の 38.5% まで重み 1、そこから半径で 0 へ直線 (`falloffRangeRatio = 0.615`、固定) | `src/sysdep/ogl_core/gtao_frag.glsl:194,224-227` |
| ステップ分布 | `s^2` (中心寄り) | `gtao_frag.glsl:193,270` |
| 画面半径の上限 | フル解像度換算 256 px | `src/qsys/FrameRenderPipeline.cpp:313-314` |
| 薄い物への対策 | 無し (深度を無限に厚い高さ場として扱う) | `gtao_frag.glsl` |
| bent normal / multi-bounce | 無し | 同上 |
| 環境光 | `lightModel_ambient 0.2` + 光源の ambient 0.2 = 0.4 (定数) | `src/sysdep/ogl_core/lighting_inc.glsl:77,109` |
| 主光源 | 1 灯、拡散 0.8、向き (1, 1, 1.5) eye 空間 (右上手前、カメラに固定) | `lighting_inc.glsl:75,78` |
| 鏡面 | 0.4、shininess 32 | `lighting_inc.glsl:76,79,110` |
| fill light / 影 | 無し (ChX の `shadows true` は warn して無視) | `tritium/react-gui/src/plugins/chimerax-console/worker/commands/lookCommands.ts:94` |
| AO の掛け先 | 最終色全体 (環境光・拡散・鏡面・フォグ込みの色) | `src/sysdep/ogl_core/ao_composite_frag.glsl:108` |
| depth cue (フォグ) | 視点中心で開始、中心 + slab/2 で背景色に到達。切れない | `src/qsys/GUIView.cpp:136-138`、`lookCommands.ts:97` |

ライティングの定数はすべてシェーダ内の直書き (`// TODO: make these uniforms`)。

## 2. 仮説の検証結果

| 仮説 (依頼書) | 判定 | 根拠 |
|---|---|---|
| GTAO の半径が原子間スケール (2-3 Å) に留まっている | **ほぼ確認** (数値は違う) | 比較時の `aoRadius` は 8 Å (`cm_runner.py:65`) だが、重み 1 なのは 3.1 Å まで (`gtao_frag.glsl:224-227`)、サンプルも `s^2` で中心に寄る (`:270`)。4 ステップで 8 Å の外周に届くサンプルは 1 本程度。強く効くのは実質 3 Å 前後。256 px の上限は、この画角 (約 0.3 Å/px で 8 Å ≒ 27 px) では効いていない |
| 遠距離の遮蔽項がない | **確認** | AO は画面空間の GTAO だけで、届くのは最大でも `aoRadius` (High で 12 Å)。シャドウマップ・世界座標の遮蔽は無い (`lighting_inc.glsl` に影の項無し、`lookCommands.ts:94`) |
| AO の掛け先と強度、depth cue の条件が違う | **AO の掛け先とライティングは確認、depth cue は未確定** | CueMol は AO を最終色全体に掛け (`ao_composite_frag.glsl:108`)、光の配分は環境光 0.4 : 拡散 0.8 で、光源がカメラ寄り (`lighting_inc.glsl:75-79`) なので正面向きの面が一様に明るい。ChimeraX full は ambient 0.8 に遮蔽を掛け、key 0.7 に影を付ける。凹凸の明暗の大半が「遮蔽された環境光」から来る。depth cue は、CueMol は中心から奥半分を背景色へ、ChimeraX は前後範囲の 50% から 100% を黒へで、形は近い。slab 次第でずれるが、2BBV の比較画像では奥の暗さに目立つ差は無かった |

加えて、コードから分かった差:

- 三角形 (分子表面・リボン) のライティングは頂点ごと (Gouraud) で、鏡面のハイライトがメッシュの粗さで崩れる。
  ChimeraX は画素ごと。凹凸の見え方への寄与は小さいと見て、このプランでは扱わない (§5)。
- CueMol の画は分子が ChimeraX より小さく写る (自動の画角の差)。比較の前に揃える (段階 0)。

### 2.1 ChimeraX `lighting full` の項ごとの寄与 (2026-11-19 に分解して撮影)

ChimeraX の明るさは `色 × (0.8 × 64 方向の遮蔽を掛けた環境光 + 0.7 × key の拡散 × key の影 + 0.3 × fill の拡散)
+ 鏡面 × key の影` (`/Users/user1/ext/ChimeraX/src/bundles/graphics/src/fragmentShader.txt:430-490`)。key は左上手前
から当たり (向き (0.577, -0.577, -0.577))、key の影は 2048 のシャドウマップで縁がほぼ硬い。

2BBV を設定を変えて撮った (`/Users/user1/proj64/chx-compare/out/depth/stage0_cx_decomp/decomp_sheet.png`、
リモートの ChimeraX 1.12 で撮影)。分子の画素の明るさ (平均 / 90% 点 − 10% 点):

| 設定 | 分子表面 | 棒 + リボン |
|---|---|---|
| full | 0.47 / 0.43 | 0.36 / 0.47 |
| soft (64 方向の環境光だけ) | 0.50 / 0.40 | 0.37 / 0.44 |
| full − key の影 | 0.52 / 0.39 | 0.41 / 0.45 |
| full − 64 方向の環境光 | 0.57 / 0.35 | 0.48 / 0.41 |
| full − 両方 | 0.61 / 0.36 | 0.52 / 0.43 |

- 立体感の大部分は **64 方向の環境光の遮蔽** (分子全体を範囲に入れた world 空間の AO) から来る。外すと画が平板に
  なり、サブユニット間とくぼみの暗がりが消える。
- key の影は、張り出したサブユニットの下に暗い影を足す 2 層目。単独で戻しても明暗の幅はほとんど増えない。
- 画面空間の AO (今の GTAO、段階 3 の bitmask、Mol* の SSGI) は画面外・裏側の形を見ないので、この項には原理的に
  届かない。

### 2.2 方式の比較 (2026-11-19、2BBV の CPK)

ChimeraX の大きな暗部の正体を、項ごとの分解・レイトレースの真値・Blender 本体との突き合わせで調べた。画像と数値は
`/Users/user1/proj64/chx-compare/out/depth/stageA/` (`control/`, `gt/`, `blender/`, `eevee_tune/`, `eevee_combo/`)。

- **光の配分が決め手**: どの AO も、今の光源 (ヘッドライトの拡散 0.8 + 鏡面、環境光 0.4) では球ごとの陰影に隠れて
  効かない。光源を一時的に環境光だけにすると (ChimeraX soft と同じ条件)、AO の違いがそのまま見え方に出る。
- **world 空間のボリューム AO (VXAO 式の cone tracing)**: 遮蔽の量は真値 (球へのレイトレース) と相関 0.9-0.95 で
  正しく求まるが、半分覆われた円錐を重ねる性質で接点付近が暗くなりすぎ、「変な斑点」に見える。ボクセルを
  0.5 Å にしても、円錐を 32 本にしても消えない。Unreal 式の distance field AO は凸凹の CPK 表面で遮蔽を大きく
  見積もりすぎて使えない (平均 0.08、真値 0.55)。不採用。
- **GTAO**: 半径を 16 Å に広げると大きな明暗は出るが、遮蔽物を無限に厚い壁として扱うので接点で急に暗くなる。
- **visibility bitmask (Blender EEVEE Next の AO、Therrien ら)**: 遮蔽物に厚みを仮定するので裏を光が抜け、影が
  柔らかく、急な暗がりが出ない。指数 2 (`pow(visibility, 2)`) で窪みが ChimeraX と同程度に暗くなる
  (環境光だけ × 1.15 倍で 明るさの平均 0.39 / 10% 点 0.15 / 90% 点 0.64、ChimeraX soft は 0.40 / 0.14 / 0.66)。
  GTAO との積も試したが、指数 2 だけで十分 (ユーザー判断)。**この方式を採る。**
- 移植の検証: `eevee_fast_gi.bsl.hh` (Blender main) の `eval` を GLSL を経由せず Python に書き写した版と GPU の移植が
  一致 (1500 画素で平均 0.799 / 0.801、相関 0.96)。インストール済み Blender 5.1.2 の AO レンダーパス (同じ構図・
  同じ設定) とは 10 Å で平均 0.74 / 0.72・相関 0.97。近距離の差は 5.1.2 が厚みを一定値で扱う版の違い。5.1.2 の
  マテリアルの AO ノードは旧来の地平線探索なので比較に使えない。HiZ (最大深度のミップ) の有無は平均で 0.01 程度。

## 3. 方針

- **なるべく Blender (EEVEE Next) と同じ仕組みにする。** 今の GTAO との折衷 (指数での強調、GTAO との積など) は
  しない (ユーザー判断、2026-11-19)。
- AO は visibility bitmask (EEVEE Next の移植、`Scene.aoMethod = 1`、`src/sysdep/ogl_core/gtao_frag.glsl` の
  `eeveeVisibility`)。値は線形のまま使う (EEVEE の AO パス・AO ノードは `saturate(result)` だけで `pow` は無い)。
- EEVEE は AO を最終色に掛けない (`eevee_fast_gi.bsl.hh` の `resolve`): 直接光 (ライト) は AO で暗くならず、
  環境光 (ワールド・ライトプローブ) だけが `見え具合 × 環境光` になる。CueMol も同じく、AO は環境光の分だけに掛ける。
- 環境光を主な光にする (光の配分を変える)。配分は Scene の設定にして、既定値は今の定数のまま (見え方を変えない)。

## 4. 段階ごとの設計

### 段階 1: 環境光だけに AO を掛ける (Blender と同じ光の扱い)

- **光の強さ**: `lighting_inc.glsl` の直書きの定数 (環境光 0.2 + 0.2、拡散 0.8、鏡面 0.4) を、FogBlock の UBO
  (binding 1、全プリミティブが描画のたびに `ShaderObject::setupFog` で更新する) に足した欄から読む。
  `lighting_inc.glsl` が `fog_inc.glsl` を include する (`#pragma once`)。値は `DisplayContext` 経由で Scene の
  設定 `lightAmbient` / `lightDiffuse` / `lightSpecular` から渡す。既定値は今の定数と同じ。
- **環境光の割合**: 光を計算するシェーダー (`trig_vert` → `trig_frag`、`sphere_body_frag`、`cylinder_body_frag`) が、
  色のうち環境光が占める割合を法線の MRT の `.w` に書く (今は 1 固定)。ほかの MRT を書くシェーダー (線、ラベル、
  edge、map mesh) は 1 のまま = 今と同じく色全体に AO。
- **合成**: `aoMethod = 1` のとき `色 × (1 − 割合 × (1 − AO))`。`aoMethod = 0` (GTAO) は今のまま色全体に掛ける。
- **HDR**: 光の合計が 1 を超えると、AO を掛ける前に 0〜1 に切られて環境光の割合が狂う。`aoMethod = 1` のときは
  シーンの色バッファを RGBA16F にし、ライティングでの clamp をやめて合成の後で 0〜1 に収める (Blender も AO は
  clamp 前の値に掛かる)。
- **AO の値**: 線形 (`aoIntensity` の指数と `aoCurve` は bitmask では使わない。`aoCurve` は削除)。
- 確かめ方: 2BBV の CPK で ChimeraX soft / full と並べる。可能なら Blender で同じ場面 (ワールドの環境光 + 太陽光、
  AO) を描いて並べる。既定の設定の画が今と画素単位で同じこと。
- Blender にあって入れないもの: 近くの面からの照り返し (色の付いた間接光)。EEVEE の `fast_gi_method = AO_ONLY`
  に当たる。

### 段階 1.5: 焼き込みのボリュームプローブ (EEVEE の volume light probe)

POC の状態 (2026-11-19、未コミット):

- `qsys::AmbientProbeVolume` が、renderer が渡す遮蔽物の球 (今は CPK だけ) から 3 Å 間隔のプローブを CPU で焼く。
  各プローブは 64 方向の光線で見え具合の平均 m0 と方向の偏り m1 を持ち、原子の中のプローブは周りで埋める。
  画素では法線方向に半格子ずらして補間し、`clamp(m0 + 2 dot(m1, N))` を `mix(1, ., aoProbeStrength)` で画面上の
  AO に掛ける (EEVEE の `distant_radiance_visibility × プローブの放射照度` と同じ構成)。2BBV で 360 ms。
- 決めた値: 厚み (`aoThicknessNear`) 10 Å、環境光 (`lightAmbient`) 1.0、焼き込みの強さ 0.5 前後 (ユーザーの目視)。
- フォグ: 合成で「フォグを外す → 環境光の分に AO → フォグを戻す」にした (照明の後にフォグ、ChimeraX・Blender と
  同じ)。以前は AO をフォグの深さで弱めていて、環境光だけの照明では奥が平らになった。

- GPU の焼き込み (`aoProbeGpu`、既定 on): 64 方向の正射影の深度を 2048 px のアトラス (8×8 タイル) に `Scene::display`
  で描き、プローブの格子 (z の層を横に並べた RGBA16F の 2D アトラス) を全画面パス 1 回で評価し、原子の中の
  プローブを 6 回の往復パスで埋める (`probe_bake_frag.glsl` / `probe_fill_frag.glsl`)。描いたものがすべて遮蔽物に
  なる (棒・リボン・分子表面でも効く)。格子の範囲と作り直しの判定は、renderer が渡す原子の球
  (`MolRenderer` の既定は 1.8 Å、CPK は vdW 半径) から決める。
  - CPU 版との突き合わせ (2BBV の CPK、AO の項): 相関 0.986、平均 0.488 / 0.487、画素の差の平均 0.03。
  - コスト: 800×600 の書き出しで焼き込みなし 0.374 s、GPU 0.387 s (+約 13 ms)、CPU 0.72-0.91 s。
- 方向数とタイル: 32 方向・128 px に確定 (2026-11-19、ユーザー判断)。ライブでの焼き直し (GPU の完了まで、2BBV):
  分子表面 64・256 px 39.6 ms → 32・128 px 14.2 ms、CPK 18.2 → 8.8 ms。時間は方向数にほぼ比例 (形の処理が重い)。
  AO の項の 64・256 px との相関は分子表面 0.987、CPK 0.995 で、見た目の差はほとんど無い。
- 形が変わっている間は焼かない (2026-11-19): ライブ表示 (`FrameRenderParams::deferProbeBake`) では、遮蔽物の球の
  集合 (ハッシュ) が焼いたものと違うフレームは焼き込みなしで描き、同じ集合が 0.2 s 続いたら 1 回焼く。焼き込み済みの
  形に戻ったら保留を取り消す。保留中は `GUIView::needsContinuousRedraw` で描画を続ける (AA の蓄積と同じ)。書き出しは
  その場で焼く。表示/非表示を 0.1 s ごとに 13 回切り替えた確認で、焼き直しは止まった後の 1 回だけ。焼き込みは徐々に
  効かせず、切り替えのみ (ユーザー判断)。
- 残り: 原子の集合が変わらない表示の変更 (リボンの太さなど) では焼き直さない (判定が原子の座標だけ)。
  書き出しは別のパイプラインなので毎回焼く。CPU 版は比較用で、確定後に外す。

### 段階 2: bitmask AO の仕上げ

- 時間方向の蓄積: 1 フレームは 2 方向 × 8 サンプル (EEVEE の既定) にし、静止中はノイズの回転を変えてフレームを
  またいで平均する。今は jitter の AA が on のときだけ蓄積される。書き出しは方向数を増やす。
  - 4000×3000 px の書き出しで、AO なし 1.43 s、GTAO Medium 2.63 s、bitmask 2 方向 2.33 s、8 方向 3.32 s、32 方向
    7.54 s。32 方向を毎フレームは重すぎる。
- 既定値: 探索距離 30 Å、指数 2、厚み 0.1 Å (EEVEE の既定)。プリセット (Low / Medium / High) を作り直す。
- `aoMethod` を enum にして保存するか、GTAO を置き換えるか決める。
- 分子表面・棒 + リボンの場面でも撮って確かめる (今は CPK だけ)。
- 計測の修正: `renderTiming` の 1×1 読み戻しは GPU を待っておらず (全パスが同じ比率で増減する)、パスごとの時間は
  信用できない。`EXT_disjoint_timer_query_webgl2` を試すか、フレームレートで測る。

### 段階 3: 主光源の影 (任意)

- ChimeraX full は key light の影 (張り出しの下の影) を足している (§2.1)。段階 1・2 で足りなければ検討する。

## 5. 採用しなかった案

| 案 | 理由 |
|---|---|
| 多方向のシャドウマップ (ChimeraX multishadow と同じ方法) | 同じ方法なら同じ結果になるのは自明で、別の方法を確かめたかった (依頼書の制約でもある) |
| world 空間のボリューム AO (VXAO 式 cone tracing)、EEVEE + ボリューム AO の組み合わせ | 接点付近の暗すぎる斑点が消えない (§2.2) |
| Unreal 式 distance field AO | CPK の凸凹で遮蔽を大きく見積もりすぎる (§2.2) |
| 距離場の上で光線を進める AO | 真値と一致するが、bitmask で十分になったので保留 |
| bitmask AO × GTAO | 指数 2 の bitmask だけで十分 |
| AO の半径・強さを広げるだけ (旧段階 1) | 今の光源では画全体が一様に暗くなるだけ |
| 光源の向きだけを ChimeraX に合わせる (旧段階 2a) | 陰影の付く側が変わるだけで、大きな暗部は出ない |
| 深度のアンシャープマスク (旧段階 2、Luft ら 2006) | 暗くなるのが主に外周で、ChimeraX の暗部と場所が合わない |
| 三角形のライティングを画素ごとにする | 凹凸の明暗への寄与は小さい。必要なら別の計画にする |

## 6. 検証方法と合格基準

- 比較スクリプト: `/Users/user1/proj64/chx-compare/scripts/cpk_compare.py` (CPK の場面、ChimeraX 参照と並べる)、
  `depth_compare.py` (棒 + リボンと分子表面)、`blender_match.py` (Blender と同じ正射影の構図で画素ごとに比べる)。
- ChimeraX の参照はリモート (`ssh devmacbookair`、ChimeraX 1.12、`~/chx-run/`) で撮る。
- 合否は目視。目安は ChimeraX soft / full と並べて、窪み・サブユニットの境目の暗さが近く、急な暗がりや斑点が無く、
  回転してもちらつかないこと。新しい設定をすべて既定にした画が今と同じこと。

## 7. 未解決の質問

1. 光の配分をどうするか (§4 段階 1)。
2. bitmask AO で GTAO を置き換えるか、選択肢として残すか。
3. 段階 0 の `renderTiming` (信用できない計測) を直すか外すか。
