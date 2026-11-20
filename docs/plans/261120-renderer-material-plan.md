# renderer の material の残り (陶器)

renderer の `material` は WebGL の描画で効き、金属度・環境の映り込み・toon も入った (仕様は [../architecture/renderer-material.md](../architecture/renderer-material.md))。`<def>` の `fresnel` は値の受け渡し (`gfx::Material` -> `Scene::MaterialLight` -> FogBlock の `u_matExtra.z`) までできていて、シェーダがまだ使っていない。

## 1. 陶器 (輪郭の照り)

- 輪郭の照り (Schlick の Fresnel、`u_matExtra.z`) を足した陶器の material を作る。
- 値は比較画像で決める: 2BBV の CPK と分子表面 (白っぽい色を 1 つ含む)、1AON の cartoon を数パターン書き出してユーザーに見比べてもらう。

## 2. その他

- material の検索は renderer ごとに毎フレーム `StyleMgr` を引いている。重さが問題になったら、名前が前回と同じなら引き直さない (旧実装の `m_curMater` と同じ)。
- 色ごとの material (`Color.material`、`ColorTable`) を WebGL の描画で効かせるのは後回し。
