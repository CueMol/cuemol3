# renderer の material の残り (toon・陶器)

renderer の `material` は WebGL の描画で効き、金属度と環境の映り込みも入った (仕様は [../architecture/renderer-material.md](../architecture/renderer-material.md))。`<def>` の `toon` と `fresnel` は値の受け渡し (`gfx::Material` -> `Scene::MaterialLight` -> FogBlock の `u_matExtra.y` / `.z`) までできていて、シェーダがまだ使っていない。

## 1. toon material の量子化

- toon1 / toon2 はトゥーン調 (2 値・3 値のポスタリゼーション) を意図した material だが、OpenGL 用の値 (ambient 0、diffuse 0.85、specular 0) は普通の Lambert 拡散になり、滑らかなグラデーションのまま。CueMol2 の OpenGL 表示にも量子化はなく、トゥーン調は POV-Ray 用の節 (`brilliance 0`、toon2 は `phong 10000 phong_size 50`) と umbreon の Toon でだけ出ていた。
- `flight2` (`lighting_inc.glsl`) で拡散の `N·L` を `u_matExtra.y` 段に量子化する (2 段: 閾値で 1 / 0、3 段: 間に中間の段)。toon2 は鏡面も閾値で 0 / 1 にして白い点を乗せる。
- Fast GI の合成は画素の色を環境光・拡散・鏡面に分け直す (拡散を滑らかな `N·L` で計算し直す)。段にした拡散で分け方が崩れないかを確かめ、崩れるなら画素ごとの material (MRT の添付) で toon を合成に伝える。
- umbreon の toon と並べて値を決める。

## 2. 陶器 (輪郭の照り)

- 輪郭の照り (Schlick の Fresnel、`u_matExtra.z`) を足した陶器の material を作る。
- 値は比較画像で決める: 2BBV の CPK と分子表面 (白っぽい色を 1 つ含む)、1AON の cartoon を数パターン書き出してユーザーに見比べてもらう。

## 3. その他

- material の検索は renderer ごとに毎フレーム `StyleMgr` を引いている。重さが問題になったら、名前が前回と同じなら引き直さない (旧実装の `m_curMater` と同じ)。
- 色ごとの material (`Color.material`、`ColorTable`) を WebGL の描画で効かせるのは後回し。
