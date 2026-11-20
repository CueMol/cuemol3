# renderer の material と光

renderer の `material` プロパティ (`Renderer.qif`) で、その renderer の光の当たり方 (環境光・拡散・鏡面の強さとハイライトの鋭さ) を決める。AO なし・GTAO・Fast GI のすべての WebGL 描画で効き、POV-Ray の書き出しとレイトレーサー (umbreon) にも同じ名前の定義がある。Fast GI の光と合成は [fastgi-ambient-occlusion.md](fastgi-ambient-occlusion.md) を参照。

## 1. 構成

```
data/default_style.xml の <material>  (OpenGL 用: ambient / diffuse / specular / shininess)
   | StyleMgr::getMaterial (scene の style scope で検索)
Scene::getMaterialLight(name)  -> 光の強さ 3 つと指数 (MaterialLight)
   | Scene::displayRendImpl が renderer ごとに setLightIntensities / setLightShininess
FogBlock UBO (ShaderObject::setupFog が各 GPU prim の描画時に書く)
   | lighting_inc.glsl flight2 (CPK・円柱の impostor、三角形はどれも画素ごと)
scene の色  (Fast GI のときは MRT の 3 枚目に material も書く -> 合成)
   | tonemap_inc.glsl toneMap (1 を超えた明るさを滑らかに 1 に収める)
```

主なファイル:

| 役割 | ファイル |
|---|---|
| material の定義 (OpenGL 用・POV-Ray 用) | `data/default_style.xml` |
| 名前から光への換算 | `src/qsys/Scene.{hpp,cpp}` (`getMaterialLight`、`kDefaultMaterial*`) |
| ライティング | `src/sysdep/ogl_core/lighting_inc.glsl`、`trig_vert.glsl` / `trig_frag.glsl` |
| 画素ごとの material (Fast GI) | `fog_inc.glsl` (`encodeMaterial`)、`ao_composite_frag.glsl`、`src/gfx/RenderTarget.hpp` (`RT_MATERIAL_RGBA8`)、`src/sysdep/ogl_core/OcRenderTarget.cpp`、`tritium/core/cxx_src/EcRenderTarget.cpp`、`tritium/react-gui/src/renderer/worker/server/gfx/FboStore.ts` |
| トーンカーブ | `src/sysdep/ogl_core/tonemap_inc.glsl` |
| レイトレーサーの material の表 | `src/modules/rendering/UmbreonDisplayContext.cpp` (`lookupMaterial`) |
| テスト | `src/tests/qsys/test_scene_material_light.cpp` |

## 2. material の一覧

OpenGL 用の値と見た目 (鏡面の実効値 = specular × 0.4):

| id | 見た目 | ambient | diffuse | specular (実効値) | shininess | metallic |
|---|---|---|---|---|---|---|
| `default` | 艶消しプラスチック (`matte_plastic` と同じ) | 0.2 | 0.8 | 0.3 (0.12) | 16 | 0 |
| `plastic` | 磨いたプラスチック | 0.2 | 0.8 | 0.7 (0.28) | 76.8 | 0 |
| `ceramic` | 釉薬のかかった陶器 (鋭いハイライトと輪郭の照り、fresnel 3) | 0.2 | 0.8 | 1.0 (0.4) | 160 | 0 |
| `matte_plastic` | 艶消しプラスチック | 0.2 | 0.8 | 0.3 (0.12) | 16 | 0 |
| `matte` | ハイライトなし | 0.3 | 0.6 | 0 | 32 | 0 |
| `diff_metal` | 艶消し金属 | 0.2 | 0.5 | 1.25 (0.5) | 16 | 0.6 |
| `spec_metal` | 磨いた金属 | 0.2 | 0.3 | 2.5 (1.0) | 48 | 0.7 |
| `toon1` | トゥーン調 2 値 (§4、toon 1) | 0 | 0.8 | 0 | 0 | 0 |
| `toon2` | トゥーン調 + 白い点 (§4、toon 1) | 0.3 | 0.5 | 2.5 (1.0) | 16 | 0 |
| `shadow` | 拡散なし | 0.75 | 0 | 0 | 0 | 0 |
| `nolighting` | 照明なし (地図の contour の style) | 1.0 | 0 | 0 | 0 | 0 |

`<def>` の属性は ambient / diffuse / specular / shininess / emission に加えて、CueMol3 で足した `metallic` (金属度 0〜1)、`toon` (1 = POV-Ray の toon の finish、0 = 滑らか)、`fresnel` (輪郭の照りの強さ、0 以上) を読む (`gfx::Material::MAT_METALLIC` / `MAT_TOON` / `MAT_FRESNEL`、既定はどれも 0)。

- **material を指定しない renderer** (`""`) は `default` で描く。style に無い名前も `default` と同じ値 (`Scene::kDefaultMaterial*`) になる。CueMol2 は未指定に組み込みの値を使い、`default` (鏡面 0) と見た目が違っていたが、inspector の「なし」と `default` が同じに見えるように揃えた。既定は艶消しプラスチックにした。磨いたプラスチック (`plastic`) を既定にすると、テカりすぎた。
- **プラスチックと金属の分け方**: プラスチックは金属度 0 で、色 (拡散) が主、ハイライトは白い。金属は金属度で地の拡散を弱め、ハイライトを下地の色で染め、環境の映り込みを足す (§4)。艶消し (指数 16) と磨き (指数 48〜77) はハイライトの広さで分ける。金属の値は umbreon と並べて目視で合わせた (金属度は umbreon の表と同じ)。`spec_metal` の拡散を umbreon と同じ 0.6 にすると、地の色が明るくなってプラスチックに近く見えたので 0.3 にしてある。
- **POV-Ray**: `default` と `matte_plastic` は specular 0.15・roughness 0.08、`plastic` は specular 0.4・roughness 0.01 (以前の `default` の finish)、`ceramic` は specular 0.6・roughness 0.005 に縁ほど強い反射 (`reflection { 0.02, 0.3 falloff 5 }`)。未定義の名前は `default` で描かれる。
- **レイトレーサー (umbreon)**: `lookupMaterial` の表 (principled BSDF) を、WebGL の同じ名前の見た目に目視で合わせてある。POV-Ray の値を換算しただけの値では、磨いたプラスチックのハイライトが弱く、`matte_plastic` が `matte` と同じに見え、金属 (metallic 1) は拡散が無く黒い背景を映して黒いシミになったため。

| id | metallic | roughness | specular | diffuse | reflection |
|---|---|---|---|---|---|
| `plastic` | 0 | 0.36 | 0.6 | 0.8 | 0 |
| `ceramic` | 0 | 0.25 | 1.0 | 0.8 | 0 |
| `default` / `matte_plastic` | 0 | 0.45 | 0.6 | 0.8 | 0 |
| `diff_metal` | 0.6 | 0.55 | 0.8 | 0.3 | 0.1 |
| `spec_metal` | 0.7 | 0.37 | 0.8 | 0.6 | 0 |

  umbreon の principled では粗さ 0.45 を超えるとハイライトが広がって見えなくなり、`matte` と区別がつかない。そのため `matte_plastic` は 0.45 に留め、`plastic` を 0.36 にして差を付けている。金属は metallic を 1 未満にして拡散を一部残す。umbreon の反射は、GI ありでは鏡の向きに 1 本だけ光線を飛ばし、当たった面の直接光と空の分だけを持ち帰る (その面の間接光は持ち帰らない)。GI なしでは反射を追わず、背景の色をそのまま映す (`reflection × 背景` または `F0 × 背景`)。どちらも周りが暗いと金属の映り込みが黒くなる。

## 3. 名前から光への換算 (`Scene::getMaterialLight`)

CueMol2 の OpenGL 表示 (`OglDisplayContext::setMaterImpl`) と同じ読み方をする:

- 環境光 = 0.2 (光のモデル全体の環境光) + material の ambient
- 拡散 = material の diffuse
- 鏡面 = 0.4 (光の鏡面の強さ) × material の specular
- 指数 = material の shininess

Fast GI のときは、環境光と拡散だけを `default` が `Scene::kFastGILight*` (0.56 / 0.52) になる比率で換算する (環境光 ×1.4、拡散 ×0.65)。Fast GI では AO を環境光にだけ掛けるため、環境光を主にした光にしてある。鏡面と指数は換算しない。以前は鏡面も換算していたが (×1.56)、`diff_metal` が Fast GI でだけ鏡面 > 拡散になって金属らしく見えるなど、方式を変えると material の性格が変わったため、換算をやめた。環境光だけで照らす material (拡散も鏡面も 0、`nolighting`・`shadow`) は AO を掛けない (§6) ので、換算もしない。最後に 3 つの強さすべてに `lightBrightness` を掛ける。

`Scene::display` は、material を持たない描画 (renderer の外) のために `""` の光を入れ、`displayRendImpl` が renderer ごとに入れ直す。検索は renderer ごとに毎フレーム走る (`StyleMgr` の検索、キャッシュはしていない)。

## 4. ライティング

- **三角形も画素ごと**: ribbon・cartoon・分子表面の三角形は、法線と頂点色を fragment shader に渡し、`trig_frag.glsl` で `flight2` を評価する。頂点ごとのライティングでは、指数 76.8 のような鋭いハイライトが三角形の間で途切れて斑点や多角形になるため。1AON の既定の表示で、scene パスの GPU 時間は RTX 4070 で変わらなかった (1 フレーム 2.9〜3.6 ms)。CPK・円柱の impostor は元から画素ごと。
- **金属度** (`u_matExtra.x`、umbreon の principled BSDF にならう): 環境光と拡散の分を (1 − 金属度) 倍にし、ハイライトの色を白から下地の色へ金属度の半分だけ寄せる (光源のハイライトの芯は umbreon でも飽和して白く見えるため、全部は染めない)。
- **環境の映り込み** (`envReflection`、金属度 > 0 のときだけ): 金属の見た目の大半は、光源のハイライトより周りの映り込みから来る。鏡の向き (eye 空間) で、カメラの上向きに沿った空のグラデーション (上 1.2、下 0.15) を引き、金属度 × 下地の色 × 環境光の強さを掛けて足す。下を暗くしてあるのは、umbreon の金属が下や後ろに映す隣の陰や背景の代わり。粗いほど地平線をぼかし (GGX の alpha の幅)、鏡のような面でも幅 0.5 より鋭くしない (鋭い地平線は球を上下に二分して見える)。Fast GI の合成では鏡面の側に入るので、鏡面の遮蔽でくぼみの映り込みが暗くなる。
- **toon** (`u_matExtra.y` が 1、`toon1` / `toon2`): POV-Ray の toon の finish (`brilliance 0`、`toon2` は `phong 10000 phong_size 50`) を、CueMol の POV-Ray 書き出しの光で POV-Ray が描く見た目に、AO なしで合わせる。書き出しの光は key light (右上手前、0.5) とカメラからの影なしの flash light (0.8) の 2 つ (`_light_inten` 1.3)。`brilliance 0` では光に向いた面は角度によらず平らに照らされるので、key light の当たる側は 1.3、反対側も flash light の 0.8 の平らな色になる。白い点は flash light のハイライト (視線の向きを中心に、滑らかなハイライトが頂点の半分を超える所) だけ (POV-Ray の画像に key light の点は出ない)。全体の環境光 0.2 は足さず、拡散に `Scene::kToonLightDiffuse` (1.3) を掛ける。最後に POV-Ray の出力 (`assumed_gamma 1.0` で sRGB のファイル) と同じく、0〜1 に切ってガンマ 1/2.2 で符号化する (トーンカーブは通さない)。1CRN の CPK で、平らな色の画素値は POV-Ray と 3 以内で一致した (toon1 の灰色 199 / 160 に対して 201 / 162)。GTAO と Fast GI では POV-Ray には合わせず (POV-Ray の toon は AO なしの表現で、別のもの)、ほかの material と同じ光の下で 2 値化だけする: key light の当たる側と反対側の 2 色と、通常のハイライトの位置の白い点。AO もそのまま掛かる。POV-Ray の光とガンマ補正は `u_matExtra.w` (`Scene::MaterialLight::toonPov`、AO なしのときだけ 1) で切り替える。umbreon の toon は flash light を持たず、POV-Ray より暗い。
- **輪郭の照り** (`fresnelRim`、`u_matExtra.z` = 強さ、`ceramic`): 釉薬は、視線に対して寝た面ほど周りを強く映す。Schlick の `(1 - N.V)^5` で縁に向かって強くなる照りを足し、金属と同じ空のグラデーション (地平線の幅 0.5) を白いまま映して、環境光の強さを掛ける。強さ 1 では plastic とほとんど区別がつかず、3 で縁の白い照りがはっきり出た。umbreon では principled の鏡面が Fresnel を持つので、鏡面を強めて縁を明るくしている (WebGL ほど強い白い縁にはならない)。
- **shininess 0**: `pow(0, 0)` は GLSL では未定義で、GPU では NaN になり画素が黒くなる (ストランドの側面など `N.H` が 0 の所)。`nolighting`・`shadow`・`toon1` は shininess 0 なので、`flight2` は `pow(max(N.H, 1e-6), max(shininess, 0))` とする (固定機能の OpenGL と同じく、指数 0 は常に 1 倍)。

## 5. 明るさを 0〜1 に収める (トーンカーブ)

白い面では、光が正面から当たる所の明るさがハイライトを足す前から 1 前後かそれ以上になる (Fast GI で最大約 1.36、AO なし・GTAO で約 1.48)。1 で切り捨てると、光の当たる面とハイライトがどちらも 1 に潰れ、ハイライトが見えなくなる。そこで切り捨ての代わりに `toneMap` を通す:

- 0.7 (`TONE_KNEE`) までは値をそのまま出す。それより上は 3 次の肩の曲線で、1.5 (`TONE_WHITE`) でちょうど 1 に、傾き 0 で届く (両端で傾きが連続)。

| 入力 | 0.7 以下 | 0.9 | 1.0 | 1.2 | 1.36 | 1.48 以上 |
|---|---|---|---|---|---|---|
| 出力 (0〜255) | そのまま | 219 | 233 | 249 | 254 | 255 |

- 掛ける所は 1 画素につき 1 回: Fast GI は合成の最後 (scene の色は RGBA16F で 1 を超えたまま持つ)、AO なし・GTAO は `flight2` (それまで clamp していた所)。
- 白い分子表面 (Fast GI) では、255 に張り付いた画素が 14,633 から 0 になり、陰の側と中間の明るさはほぼ変わらなかった (下位 10% 点 131、中央値 203 → 200)。
- 1 で頭打ちしない比較案 (1 に近づくだけで届かない曲線) は、最大 244 で白い面が灰色寄りに見えたので採らなかった。

## 6. 画素ごとの material (Fast GI の合成)

Fast GI の合成は scene の色を環境光・拡散・鏡面に分け直す (環境光の分に AO、拡散にプローブの影、鏡面に鏡面の遮蔽)。分け方は「拡散 / 環境光」の比と鏡面の粗さに依存し、material が renderer ごとに違うと Scene の 1 組の値では合わない。

- AO があるとき (GTAO・Fast GI)、scene の描画先に RGBA8 の 3 枚目の添付 (`RT_MATERIAL_RGBA8`) を足す。ライティングするシェーダは描いている renderer の光を書く (`encodeMaterial`): r = 拡散 / 環境光、b = 環境光 (どちらも `x / (1 + x)` で 0〜1 に収める)、g = 指数 n を GGX の alpha に直した粗さ `sqrt(2 / (n + 2))`、a = 1 (環境光だけで照らす material は 0.75)。法線の `.w` は scene パスのブレンドで背景と混ざるので使えない。
- 合成は a が 1 の画素ではこの値を使い、照明なしの描画 (a = 0) では Scene の値 (`u_lightAmbient` / `u_lightDiffuse`、指数 16 の粗さ 0.3333) を使う。照り返し (間接光) の albedo も、その画素の環境光の強さで割って求める。
- **AO を掛けない material**: a が 0.75 の画素 (環境光だけで照らす material: `nolighting`・`shadow`) は、GTAO でも Fast GI でも AO を掛けない (Fast GI は照り返しも足さない)。これらは平らな色の表現 (地図の等高線は `nolighting`) で、AO を掛けると環境光だけの陰影が付いて立体に見えてしまうため。拡散と鏡面がどちらも 0 であることで決めるので、material に印を足す必要はない。
- WebGL (`FboStore` / `EcRenderTarget`) とデスクトップ GL (`OcRenderTarget`) の両方の描画先に対応している。

## 7. 既知の制限

- 環境の映り込みは固定の空のグラデーションで、周りの分子は映らない。`spec_metal` の赤い球は、umbreon (GI) より暗めに出る。
- toon には、POV-Ray (`_shadow` を付けたとき) や umbreon が出す隣の原子の硬い落ち影がない (WebGL に影の計算がないため)。Fast GI のプローブの key light の影を閾値で硬くする案は、プローブの値が `N.L` で変わるため、光に向いた所 (白い点の位置) に黒い円が出て採らなかった。
- material は renderer 単位。色ごとの material (`Color.material`、`ColorTable`) は WebGL の描画では効かない。
- トーンカーブの肩 (0.7 より上) にかかる明るい色は、わずかに暗く出る。
