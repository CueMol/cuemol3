# renderer の material の残り (金属度・陶器・toon)

renderer の `material` は WebGL の描画で効くようになった (仕様は [../architecture/renderer-material.md](../architecture/renderer-material.md))。残りは、値の配分だけでは出せない質感を足すこと。

## 1. 金属度 (ハイライトを下地の色で染める)

- 今のハイライトはどの material でも白く、`diff_metal` / `spec_metal` は「拡散を弱め、ハイライトを強く」という配分だけで金属に近づけている。金属はハイライトが下地の色に染まる (金なら黄色、銅なら赤み) ので、これが無いと磨いたプラスチックとの差が小さい。
- `gfx::Material` に値を足し (金属度 0〜1、鏡面の色を白から下地の色へ混ぜる)、`StyleFile` の読み込みと `<def>` の属性を広げる。`diff_metal` / `spec_metal` に値を入れ、拡散と鏡面の配分を比較画像で決め直す。
- Fast GI の合成 (`ao_composite_frag.glsl`) は鏡面を「環境光以外 − 拡散」として取り出すので、色の付いた鏡面で分け方が崩れないかを確かめる。
- レイトレーサー (umbreon) の表は既に metallic を持つ。POV-Ray 用の節は触らない。

## 2. 陶器 (輪郭の照り)

- 輪郭の照り (Schlick の Fresnel) を足した陶器の material を作る。`gfx::Material` に Fresnel の強さを足す (1 と同じ拡張)。
- 値は比較画像で決める: 2BBV の CPK と分子表面 (白っぽい色を 1 つ含む)、1AON の cartoon を数パターン書き出してユーザーに見比べてもらう。

## 3. toon material の量子化 (別作業)

- toon1 / toon2 はトゥーン調 (2 値・3 値のポスタリゼーション) を意図した material だが、OpenGL 用の値 (ambient 0、diffuse 0.85、specular 0) は普通の Lambert 拡散になり、滑らかなグラデーションのまま。CueMol2 の OpenGL 表示にも量子化はなく、トゥーン調は POV-Ray 用の節 (`brilliance 0`、toon2 は `phong 10000 phong_size 50`) でだけ出ていた。
- `flight2` (`lighting_inc.glsl`) で拡散の `N·L` を段に量子化する (2 段: 閾値で 1 / 0、3 段: 間に中間の段)。toon2 は鏡面も閾値で 0 / 1 にして白い点を乗せる。
- 段数は `gfx::Material` に値を足し、`<def>` の属性で指定する (1 と同じ拡張)。shininess などの既存の値に意味を持たせる案は分かりにくいので採らない。
- Fast GI の合成は画素の色を環境光・拡散・鏡面に分け直すので、段にした拡散で分け方が崩れないかを確かめる。

## 4. その他

- material の検索は renderer ごとに毎フレーム `StyleMgr` を引いている。重さが問題になったら、名前が前回と同じなら引き直さない (旧実装の `m_curMater` と同じ)。
- 色ごとの material (`Color.material`、`ColorTable`) を WebGL の描画で効かせるのは後回し。
