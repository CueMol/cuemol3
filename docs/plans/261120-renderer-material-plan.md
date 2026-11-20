# renderer の material を WebGL の描画で効かせる計画

renderer の `material` プロパティ (`Renderer.qif`) を、tritium の描画 (AO なし・GTAO・Fast GI のすべて) で効くように戻し、既定の見た目をプラスチックに近づける。あわせて陶器風の material を足す。

## 1. 背景と現状

- 今の Fast GI の光 (`Scene::kFastGILight*`: 環境光 0.56、拡散 0.52、鏡面 0.25、指数 16) は、広くて弱いハイライトになり、プラスチックより艶消しの金属 (サテン) に見える。指数 16 の Blinn-Phong は Phong の指数 4 程度に当たる。
- material の仕組みは一式残っている:
  - 定義: `data/default_style.xml` の OpenGL 用 `<material>` (ambient / diffuse / specular / shininess、id は default・matte・toon1・toon2・diff_metal・spec_metal・shadow・nolighting)。POV-Ray 用は同じ id の別の節。
  - 値の検索: `StyleMgr::getMaterial(id, Material::MAT_*)` (scope ごと、`gfx::Material` は 5 値で MAT_EMISSION まで)。
  - 設定: renderer の `material` プロパティ。tritium の inspector にも Material の選択肢がある (`features/inspector/schema/common.ts`)。地図の contour の style は `material="nolighting"`。
  - 伝達: `Scene::displayRendImpl` が renderer ごとに `pdc->setMaterial(name)` を呼ぶ。
- 切れている所: 旧 OpenGL の `OglDisplayContext::setMaterImpl` (初回 import 4651fcc0 にある) は値を引いて `glMaterial` に渡していたが、今の `DisplayContext::setMaterial` は名前を覚えるだけ。光は Scene が 1 組の値を `setLightIntensities` / `setLightShininess` で入れ、各 GPU prim の描画時に `ShaderObject::setupFog` が FogBlock UBO に書く。
- 三角形 (ribbon、分子表面) は `trig_vert.glsl` で頂点ごとにライティングする。鋭いハイライトにすると頂点の間で斑点や多角形が出る。CPK・円柱の impostor は画素ごと。

## 2. 決めたこと

- material が未指定 (`""`) の renderer は、新しいプラスチックの material で描く (既定の見た目が変わる)。
- 古いファイルの material (CueMol2 で選んだ `spec_metal` など) は効くようにする。CueMol2 では効いていた設定なので、効く方が正しい。
- 色ごとの material (`Color.material`、`ColorTable`) は後回し。最初は renderer 単位だけ。
- PR は Fast GI の性能改善 (#779) とは別にする。

## 3. 実装の段階

### 3.1 material を光に掛ける

- DisplayContext の `setMaterial` で `StyleMgr` から値を引き、Scene の光の強さに掛けたものを `setupFog` が UBO に書く値にする。material は反射率、Scene は光の強さと明るさのつまみ (`lightBrightness`) を受け持つ。shininess は material の値をそのまま使う。
- 決めること: Scene の光の強さを AO なし・GTAO と Fast GI でどう分けるか (今は方式ごとに 4 値の組)。material を掛けた結果が、今の 2 組を material `default` で再現できる形にするか、新しいプラスチックに合わせて組み直すか。
- 名前が見つからないとき (未定義、`""`) は既定の material にする。値の検索は renderer ごとに毎フレーム走るので、名前が前回と同じなら引き直さない (旧実装の `m_curMater` と同じ)。

### 3.2 合成に画素ごとの material を渡す

- Fast GI の合成 (`ao_composite_frag.glsl`) は画面の色を環境光・拡散・鏡面に分け直す。環境光の割合は画素ごと (MRT 法線の長さ) だが、拡散の比 (`u_lightDiffuse / u_lightAmbient`) と鏡面遮蔽の粗さ (指数 16 を前提にした `rough = 0.3333`) は Scene 全体で 1 つの値。material が renderer ごとに違うと分け方が合わなくなる。
- scene パスの MRT に RGBA8 の添付を 1 枚足し、画素ごとの拡散の比と粗さを書く。法線の `.w` は scene パスのブレンドで背景と混ざるので使えない (`lighting_inc.glsl` の注記)。
- 書き出し側: `trig_frag`・`sphere_body_frag`・`cylinder_body_frag` ほか MRT 法線を書くシェーダ全部。添付を足すのは Fast GI のときだけにするか常にするかは、帯域の計測で決める。

### 3.3 三角形を画素ごとのライティングにする

- 法線と色を fragment shader に渡し、そこで `flight2` を評価する。Fast GI の文書 §8 で「凹凸の明暗への寄与が小さい」として採らなかった案だが、鋭いハイライトのために必要。
- 計測: 分子表面・cartoon の scene パスの GPU 時間 (Windows / RTX 4070、`EXT_disjoint_timer_query_webgl2` の一時的な計測)。

### 3.4 material の追加と値の決定

- プラスチック (既定): 拡散が主で、小さく明るい白いハイライト (指数 64〜128、鏡面 0.3〜0.5 の範囲から選ぶ)。
- 陶器: 輪郭の照り (Schlick の Fresnel) を足す。`gfx::Material` に 6 つ目の値 (Fresnel の強さ) を足し、`StyleFile` の読み込みと `<def>` の属性を広げる。
- 値は比較画像で決める: 指数・強さ・Fresnel を一時的に実行時に変えられるようにし、2BBV の CPK と分子表面 (白っぽい色を 1 つ含む)、1AON の cartoon を数パターン書き出してユーザーに見比べてもらう。
- 既存の material (matte、toon1/2、diff_metal、spec_metal、shadow、nolighting) は新しい光の下で破綻しないかを確かめ、必要なら値を直す。POV-Ray 用の節は触らない。

## 4. テスト (最小)

- material の名前から UBO に書く光の値が決まること (未定義名は既定に落ちる)。C++ 1 件。
- 古いファイルの material が読まれて効くこと (保存 -> 読込のラウンドトリップは既存の renderer プロパティの経路なので、追加は要否を見て判断)。
- 合成の分け方は目視で確かめる (シェーダの単体テストは持たない)。

## 5. 文書

- 実装した段階から `docs/architecture/fastgi-ambient-occlusion.md` (§3 光、§8 採らなかった案の「三角形のライティングを画素ごとにする」) と、material の仕様を architecture 側に書き起こし、この計画から消す。
