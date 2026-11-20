# Fast GI (visibility bitmask AO と焼き込みプローブ)

Scene の AO 方式の一つ。Blender EEVEE Next の Fast GI (visibility bitmask の AO、AO を環境光だけに掛ける光の扱い、焼き込みのボリュームプローブ) にならい、分子の窪みとサブユニット間の暗がりを ChimeraX の `lighting soft` / `full` に近い見え方で出す。もう一つの方式 GTAO は [gtao-screen-space-ao.md](gtao-screen-space-ao.md) を参照 (パイプライン、MRT 法線、半解像度、AA は両方式で共通)。

## 1. 構成

```
[scene pass]  ライティング (環境光 + key light の拡散 + 鏡面) を clamp せず RGBA16F に書く
              MRT の法線の長さに「色のうち環境光の割合」を埋める
[probe bake]  遮蔽物が変わったときだけ: 32 方向の深度 -> 3 A 格子のプローブ (AmbientProbeVolume)
[AO pass]     gtao_frag.glsl (u_method = 1)
              R = 可視性 = min(画面の bitmask AO, プローブ), G = edges, B = key light の届く割合
              2 枚目の attachment = 照り返し (近くの面からの間接光)
[denoise]     R を edge-aware に平滑化、B は素通し
[composite]   環境光の分だけ AO で暗く、拡散は B で暗く、鏡面は AO で暗く、照り返しを足してトーンカーブで 0〜1 に収める
```

主なファイル:

| 役割 | ファイル |
|---|---|
| 方式の切り替え・光の強さ・保存の互換 | `src/qsys/Scene.{qif,hpp,cpp}` |
| パスの実行・プローブの準備 (`prepareProbes`) | `src/qsys/FrameRenderPipeline.{hpp,cpp}` |
| プローブの焼き込みと作り直しの判定 | `src/qsys/AmbientProbeVolume.{hpp,cpp}`、`probe_bake_frag.glsl`、`probe_fill_frag.glsl`、形の変更の数 (`Scene::notifyOccluderChanged`) |
| AO パス (GTAO と共通の入口 `PostProcGpuPrim::drawGtao`) | `src/sysdep/ogl_core/gtao_frag.glsl`、`fastgi_bitmask_inc.glsl` |
| 合成 | `src/sysdep/ogl_core/ao_composite_frag.glsl` |
| 光の向き・強さ・鏡面の指数 (FogBlock UBO) | `src/sysdep/ogl_core/fog_inc.glsl`、`lighting_inc.glsl`、`src/gfx/ShaderObject.{hpp,cpp}`、`tritium/react-gui/src/renderer/worker/server/gfx/ShaderStore.ts` |
| inspector | `tritium/react-gui/src/renderer/features/inspector/schema/scene.ts`、`rows/AoMethodRow.tsx`、`data/sceneQualityPresets.ts` |

## 2. Scene のプロパティと保存の互換

| プロパティ | 既定 | 意味 |
|---|---|---|
| `aoMethod` | `fastgi` | `fastgi` / `gtao`。保存時は既定値でも必ず書き出す |
| `aoRadius` / `aoSlices` / `aoSteps` / `aoHalfRes` | 10 / 8 / 8 / true | 画面の AO の探索距離 (Å) とサンプル数、半解像度 |
| `aoBounce` | 0.5 | 照り返しの強さ (0 = AO だけ) |
| `aoProbeStrength` | 0.8 | 焼き込みの強さ (0 = 焼かない、1 = 全部) |
| `lightBrightness` | 1.0 | 全体の明るさ。環境光・拡散・鏡面に同じ倍率を掛ける (AO なし・GTAO でも効く) |

- **古いファイル**: `aoMethod` を持たないファイルは Fast GI 以前に保存されたもの。既定値のプロパティは書き出されないので、そのままだと新しい既定値で読まれて見た目が変わる。`Scene::readFrom2` はこのファイルを GTAO で読み、ファイルに無い AO のプロパティに当時の既定値 (半径 4、slices 9、steps 3、半解像度 off) を入れ、既定値の印を外す。保存し直すと `aoMethod` とこれらの値が書かれ、次も同じ見た目で読まれる。
- **新しいファイル**: `aoMethod` を既定値でも書き出す (`Scene::writeTo2`)。書かないと古いファイルと区別できない。
- テスト: `src/tests/qsys/test_scene_ao_compat.cpp`。
- inspector: Ambient occlusion に Enabled、Method (Fast GI / GTAO)、Preset、Fast GI のときだけ Indirect light (`aoBounce`) と Baked occlusion (`aoProbeStrength`)。Lighting に Brightness。Method を切り替えると、その方式の Preset の Medium も同じ undo 単位で書く (GTAO は半径を広げるほど強さを下げる必要があり、半径・steps の意味が方式で違うため)。ほかの調整値 (厚み、方向数など) は定数にして出さない。

## 3. 光

Fast GI のときの光の強さ (material `default` のとき。`Scene::kFastGILight*`、`lightBrightness` 倍):

| 項目 | Fast GI | AO なし・GTAO |
|---|---|---|
| 環境光 | 0.56 | 0.4 |
| 拡散 (key light) | 0.52 | 0.8 |
| 鏡面 / 指数 | material の値 (`default` は 0.28 / 76.8) | 同じ |
| key light の向き (eye 空間) | (1, 1, 1.5) 右上手前 | 同じ |

光の強さは renderer の material から決まり、Fast GI では環境光と拡散だけを上の比率で換算する ([renderer-material.md](renderer-material.md))。

- **AO は環境光にだけ掛ける**: EEVEE と同じく直接光は AO で暗くしない。scene pass は環境光の割合 f を法線の長さ (`2 - f`) に埋め (ブレンドで `.w` が背景と混ざるため `.w` は使えない)、合成は `色 - 環境光の分 × (1 - AO)`。その前に色を clamp すると割合が狂うので、Fast GI のときは scene の色を RGBA16F にしてライティングの clamp を外し、合成の最後にトーンカーブ (`tonemap_inc.glsl`、[renderer-material.md](renderer-material.md) §5) で 0〜1 に収める。拡散と環境光の比や鏡面の粗さは、画素ごとの material (scene の描画先の 3 枚目の添付) から読む。フォグは合成で外してから AO を掛けて戻す (照明の後にフォグ)。
- **key light の影**: 拡散を入れると円柱の側面と蓋が見分けられる一方、拡散は AO で暗くならないので窪みの底が明るく残り、CPK と分子表面の奥行きが ChimeraX より浅くなった。そこで key light に、焼き込みプローブから作る柔らかい影を付けた (§5)。拡散だけに掛け、鏡面には掛けない (格子が粗く、外に出た原子のハイライトまで弱めるため。窪みのハイライトは鏡面の遮蔽で消える)。
- **鏡面の遮蔽**: 鏡面 = 環境光以外 − 拡散 (`albedo × 拡散 × N.L`) として取り出し、Lagarde & de Rousiers の近似 `saturate(pow(N.V + AO, exp2(-16 r - 1)) - 1 + AO)` で暗くする。r はその画素の material の指数 n を GGX の alpha に直した `sqrt(2 / (n + 2))`。
- **明るさのつまみ**: 3 つの光に同じ倍率を掛けるので、明暗の比 (AO の奥行き感) を保ったまま明るさだけが変わる (明るい側がトーンカーブで圧縮される分だけ比がわずかに動く)。既定値の 0.8 倍の明るさは、つまみではなく `kFastGILight*` に入れてある。つまみの既定を 0.8 にすると、AO なし・GTAO まで暗くなり、既定値を書かない古いファイルも暗く読まれるため。
- **調整の経緯** (2BBV、白背景、明暗比 = 暗い 10% 点 / 明るい 10% 点): 環境光だけ (1.15 / 0) で CPK は ChimeraX soft と同等 (0.23 / 0.20) だったが円柱の面が見分けられない。拡散 0.5 を足すと円柱は直るが CPK が 0.35 に浅くなる。拡散を弱めても向きを変えても戻らず、影を付けて 0.27、影の指数 2 と環境光 0.7・拡散 0.65 で 0.23。そこからユーザーの目視で全体を 0.8 倍し、焼き込みを 0.8 にした。ChimeraX に合わせて光を左上にする案は、CueMol の他の方式と向きが揃わないので採らなかった。

## 4. 画面の AO (visibility bitmask)

`gtao_frag.glsl` の `fastGIVisibility` が Blender の `fast_gi::eval` (`eevee_fast_gi.bsl.hh`、Therrien ら) の AO 部分の移植。ビット演算 (`popcount32`、`anglesToBitmask`、`bitmaskToVisibilityCosine`) は uniform を読まない関数として `fastgi_bitmask_inc.glsl` に分けてある。

- 遮蔽物の厚みは 3 Å の一定値 (`kFastGIThicknessNear`)。表現 (CPK / リボン) で厚みを変える案は、形の判断を表現に頼らないため採らなかった。
- 値は線形 (`saturate`) のまま使う。`aoIntensity` (指数) は GTAO だけ。
- 静止中に時間方向の AA (jitter) が動いている間は、1 サンプル 2 方向にし、ノイズの回転を変えて AA の蓄積で平均する (EEVEE の既定 2 方向 × 蓄積と同じ)。
- 探索は画面上でフル解像度換算 256 px まで。拡大して 1 画素が 0.04 Å 未満になったら、静止中も半解像度のままにする (`GUIView` の `kAOHalfResPixelSize`)。拡大すると原子が画面を埋め、フル解像度の 8 方向は 45 ms 程度かかるため。
- **照り返し**: 探索で見つけた遮蔽面の色 (scene の色からフォグを外し、遮蔽面自身の環境光の分をプローブの可視性で暗くしたもの) を集め、2 枚目の attachment (RGBA16F) に書く。合成で `環境光の分 × aoBounce / 環境光の強さ × 集めた光` を足す。強くすると陰影がぼやけるので 0.5。

## 5. 焼き込みプローブ

`AmbientProbeVolume` が、画面外や裏側の形も含む大きな遮蔽を世界座標の格子に焼く (EEVEE の volume light probe に当たる)。画面の AO は画面に写った形しか見ないので、サブユニット間の大きな暗がりはこちらが受け持つ。

- **焼き込み** (GPU): 分子を囲む球の外から 32 方向 (Fibonacci 球) の正射影で深度を描き、128 px のタイルを並べたアトラスに入れる。3 Å 格子の各プローブについて、各方向で手前に面が無ければ見える、として平均の可視性 m0 と可視性で重み付けた方向の平均 m1 を RGBA16F に書く。原子の中のプローブ (m0 = 0) は周りの有効な値で埋める (6 回の往復)。格子は z の層を横に並べた 2D アトラス (テクセル `(x + z * nx, y)`)。この配置は C++ のアトラスの大きさ、bake、fill、`sampleProbeGrid` の 4 か所が前提にしている (各所のコメントが互いを指す)。
- **作り直しの判定**: Scene が形の変わった回数 (`getOccluderGen`) を数え、焼いたときから動いていたら焼き直す。数えるのは、object と renderer のイベント (`Scene::objectChanged` / `rendererChanged`: 原子の移動・追加・削除、表示の切り替え、renderer の設定)、object と renderer の追加・削除 (`fireSceneEvent`)、表示キャッシュの無効化 (`DispCacheRenderer::invalidateDisplayCache`: renderer イベントを通らない style の変更)。カメラの操作はどれも通らないので、回転中は毎フレームの判定が整数の比較だけになる。ライブ表示では、形が変わっている間は焼かずにプローブなしで描き、0.2 s 変更が来なかったら 1 回焼く (`kProbeSettleSec`)。保留中は描画を続ける。画像の書き出しは待たずにその場で焼く。
- **格子の範囲**: renderer が渡す遮蔽物の球 (`collectOcclusionSpheres`) の範囲に 2 格子足す。球は焼くときにだけ集める。以前は球のハッシュで形の変化を調べていて、焼き込みが済んでいても 0.1 s ごとに収集が走り、Windows で 1AON を回すと 41 fps に落ちた (今は 60 fps)。範囲を分子全体の箱にすれば収集は安くなるが、大きな分子の一部だけを描くと格子が分子全体に広がるので採らなかった。
- **球の収集のキャッシュ**: 収集の重い部分は各 renderer の selection を全原子に掛けることなので (5.9 万原子で renderer 1 つあたり 11 ms 程度)、`MolRenderer::occlusionAtomIDs` が一致した原子の ID を覚えておき、座標だけ読み直す。ID を捨てるのは selection が変わったとき (`setSelection`)、`atomsMoved` 以外の `OBE_CHANGED` が来たとき (原子の追加・削除など)、原子数が変わったとき。原子の移動では捨てない (renderer の coordinate texture の経路も、原子が動く間は selection を評価し直さない)。4V6X の焼き直しで収集は 292 ms から 8 ms になった。読み込み直後や構造を編集した直後の 1 回は作り直しの分だけ重い。テスト: `src/tests/modules/molstr/test_occlusion_spheres.cpp`。
- **時間 AA との関係**: 焼き直すと画が変わるので、`FrameRenderPipeline::isProbeBaked()` が true のフレームの後、`GUIView` は AA の蓄積をサンプル 0 からやり直す。以前ここが無く、蓄積済みのサンプルと混ざって画面が明るくなりすぎた。
- **読み出し**: 受光点は法線方向に 1 格子 (3 Å) ずらした位置を 3 次 B-spline (3 線形の読み出し 8 回、Sigg & Hadwiger) で読む。3 線形で半格子ずらしただけでは、細い円柱 (cartoon のヘリックス) の中のプローブを拾って煤けた斑点が出た。照り返しの遮蔽面は 1 サンプルごとに読むので、安い 3 線形のまま。
- **画面の AO との合わせ方**: `min(画面の AO, mix(1, clamp(m0 + 2 m1.N), aoProbeStrength))`。積にすると、近くの遮蔽物を画面の AO とプローブの両方で数えて暗くなりすぎる。EEVEE の 8 プローブの向き・有効性の重み付けは、格子が原子より粗く CPK に暗い斑点を作るので入れていない。
- **key light の影**: 同じモーメントから光の方向 L の可視性を `V(L) = m0 + 3 m1.L` (1 次の再構成) で求め、平らな開いた面での値 `0.5 + 0.75 max(N.L, 0)` で割って受光面自身の半空間の分を除き、2 乗して濃くする。`mix(1, ., aoProbeStrength)` で弱める。結果は AO パスの B に書く。
- コスト (2BBV、ライブの焼き直し、GPU の完了まで): 分子表面 14 ms、CPK 9 ms。描画時は格子の読み出しが増えるだけ。

## 6. 計測について

`renderTiming` が出すのは、各パスを GPU に送るまでの CPU 時間と、フレームの間隔 (200 ms 以上は除外) の中央値・最大。Chromium の WebGL では `gl.finish()` がすぐ戻るので、パスごとの GPU 時間は測れない。ドラッグ中のフレーム間隔は表示周期 (16.67 ms) に張り付くので、AO の負荷差を見るには、拡大した CPK で AA の蓄積中の静止フレームなど、表示周期より重い条件を作る必要がある。

## 7. 既知の制限

- 形の変わらない変更 (色など) でも、イベントが来れば 1 回焼き直す。
- 画像の書き出しは別のパイプラインで、毎回焼き直す。
- 格子は 3 Å で、それより細かい遮蔽は画面の AO に頼る。

## 8. 採らなかった案

| 案 | 理由 |
|---|---|
| ChimeraX と同じ多方向のシャドウマップを描画時に引く | 同じ方法を移すのではなく別の方法を確かめる方針 |
| world 空間のボリューム AO (VXAO 式 cone tracing) | 接点付近に暗すぎる斑点が出て消えない |
| Unreal 式 distance field AO | CPK の凸凹で遮蔽を大きく見積もりすぎる |
| GTAO の半径を広げる、bitmask × GTAO | 接点で急に暗くなる / bitmask だけで足りる |
| CPU の焼き込み | GPU 版と相関 0.986 で、GPU の方が速く描いたものすべてを遮蔽物にできる |
| 表現ごとの厚み・プローブの重み付け | 形の判断を表現に頼らない / CPK に斑点 |
| 光の向きを ChimeraX (左上) に合わせる | AO なし・GTAO と向きが揃わない |
