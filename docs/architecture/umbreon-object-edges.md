# umbreon の線の方式 (screen / object)

CueMol の umbreon レンダリングで renderer の edge line (`egtype`) を描く方式は 2 つある。
レンダリング設定 `umbreon.edgeMethod` で切り替える (既定は `screen`。GUI は無く、console /
スクリプトから `set_render_settings settings="umbreon.edgeMethod=object"` で選ぶ)。

| 方式 | umbreon 側 | 線の決め方 |
|---|---|---|
| `screen` | screen-space の edge (`RenderOptions::strokeEdges`) | レイトレースの結果 (深度・法線・物体の番号) の不連続から画面上で線を引く。太さは画素単位の帯 |
| `object` | object-space の edge (`RenderOptions::objectSpaceEdges`) | 球・円柱・mesh の形から輪郭を求め、線 (管) として場面に足してレイトレースする。太さはワールド空間の長さ |

`object` は POV-Ray への書き出し (`PovSilBuilder`) と同じ考え方で、POV-Ray の画像を基準に
合わせてある。umbreon 側の仕様は umbreon の `docs/api/libumbreon.md` の「方式B」と
`docs/plans/edge-object-space-completion.md` にある。

## screen 方式の段差の判定 (`screenEdgeDepth` / `screenEdgeJump`)

`screen` 方式で、同じ物体の中の奥行きの段差 (自己遮蔽の輪郭) をどう線にするかは、レンダリング
設定 `umbreon.screenEdgeDepth` で選ぶ (GUI は無い)。`UmbreonSceneExporter` が読み、
`UmbreonRenderParams::screenEdgeLegacy` / `screenEdgeJump` 経由で umbreon の
`StrokeEdgeOptions::screenDepthStep` / `screenDepthJump` に渡す。

| 値 | umbreon 側 | 判定 |
|---|---|---|
| `jump` (既定) | `ScreenDepthStep::Jump` | 画素の組ごとに独立に判定する。段差が `umbreon.screenEdgeJump` (Å、既定 0.5。12 画素分の長さが下限) を超え、両側の面をそれぞれ延長した奥行きが反対側と同じだけ外れ、平行に並ぶ 3 組の中で最大のときに線にする |
| `legacy` | `ScreenDepthStep::Legacy` | 従来の判定。段差の勾配に応じたしきい値で強い段差と弱い段差に分け、弱い段差は同じ線 (chain) に強い段差が十分あるときだけ残す |

- `legacy` は線全体を多数決で残すか消すかを決めるので、回転アニメーションで長い線がまるごと
  点滅することがあった (1IYE の ribbon など)。`jump` には線単位の判定が無く、線は段差が
  しきい値をまたぐ所で伸び縮みするだけになる。
- `jump` の延長の判定により、真横に近い向きで見た平らな面 (cartoon の helix 円柱の底面など)
  の内部は線にならない。
- `jump` の既知の性質:
  - 粗い mesh の面の稜を視線がすり抜けて奥に当たる段差 (ribbon の断面の稜に沿う短いヒゲ) は
    本物の段差として線になる。消すには renderer の分割数 (`axialdetail` や各断面の `detail`)
    を上げる。
  - 面の中で終わる輪郭は、先端で段差が 0 に向かうので、段差がしきい値を下回る所で止まる
    (円柱の底面から tube が生える根元など)。しきい値を下げると伸びるが、粗い mesh の
    細かい段差も拾う。
- 検証の経緯は umbreon の `docs/plans/edge-screen-depth-jump-report.md`。

## 受け渡し (`UmbreonSceneExporter` / `UmbreonDisplayContext`)

- `UmbreonRenderSettings.edgeMethod` を `UmbreonSceneExporter` が読み (`objectEdges` = 値が
  `"object"`)、`UmbreonRenderParams::objectEdges` で `UmbreonDisplayContext` に渡す。
- `object` のとき、renderer (= umbreon のセクション) ごとに `umbreon::ObjectEdgeStyle` を
  作って `Scene::groupObjectEdgeStyle` に入れる:
  - 描く種類: `egtype` が edges / silhouette なら輪郭、edges なら外周 (border) も、crease の
    角度が 0 より大きいときは折れ目も (screen 方式の対応付けと同じ)。
  - `egtype=silhouette` は `SilhouetteMode::Outline` (線の後ろに同じ renderer の面がある所の
    線を消す。別の renderer の面は後ろにあっても消さない)。
  - 色は `egcolor`。線の半径は `eglinew` (Å、POV-Ray の書き出しと同じく半径。太さは
    `2 * eglinew`)。`eglinew` が未指定なら既定の画素幅をワールド長に換算して半分にする。
  - 持ち上げ量 `raise` は `0.25 * eglinew` (POV-Ray の `_sl_rise` と同じ。線の内側は面に
    隠れる)。
  - edge line の無い renderer は、3 種類とも無効のスタイルを入れる。
- 線描画由来の円柱 (`convLines` で線を円柱にしたもの。wire / line 表示) には
  `Cylinder::noEdge` を付ける。それ自体には輪郭を作らず、ほかの線の切り落としにも使わない
  (POV-Ray の書き出しと同じ)。
- mesh の三角形ごとの線の扱い (`MeshFace::nmode`) を `umbreon::Mesh::triEdgeMode` で渡す:
  `MFMOD_MESHXX` (`DVA_NOEDGE` の頂点を含む三角形。リボンの矢じりの付け根の段差の内側など)
  は辺に線を出さず、`MFMOD_NORGLN` (`POLY_FILL_NORGLN` / `_XX`) は外周の線を出さない。
  POV-Ray の書き出し (`RendIntData::calcSilEdgeLines`) と同じ扱い。丸い断面のシート
  (RoundRibbon) では付け根の段差がごく小さな壁になり、これを渡さないとシートを横切る線が出た。
- silhouette モードの「後ろの面」の範囲 (`outlineFarVz`) は、fog の範囲から
  `outlineFarDepth` で求めた view-z を両方式で共有する。それより奥の面は fog でほぼ背景に
  溶けているので、後ろの面とみなさない。

## 比較で確かめたこと

- POV-Ray の画像 (同じシーン・カメラ、球と円柱は `detail` 30) と比べ、ball-and-stick /
  stick / tube / ribbon (DefaultRibbon / Fancy1Ribbon / RoundRibbon) / それらの混在で、
  edges・silhouette とその混在、透視・正射影のいずれも線の有無が一致する。分子表面
  (dsurface の distfield / meshms) も一致する。ただし distfield の marching cubes が作る
  線幅より小さい三角形の塊 (面積がほぼ 0) に POV-Ray は点を描くが、object 方式は描かない
  (面積 0 の三角形を輪郭の判定に使わないため。滑らかな表面の上の汚れなので、こちらを
  正とする)。os の線が POV-Ray より約 0.5 px 太いのは、POV-Ray が球・円柱を多角形の
  mesh にしてから輪郭を取るため。
- POV-Ray の書き出しは near clip のある場面を比較の基準にできない: 輪郭の計算と見え隠れの
  判定 (`RendIntData::calcSilEdgeLines` / `buildAABBTree`) が near clip で切る前の mesh を
  使うので、消えた手前の面の奥の線が途切れる。また far clip が無く、`export_scene` の経路では
  書き出しが常に透視投影で `useClipZ` も off (`PovrayBackend` はレンダリング設定から設定する)。
- clip と fog の効き方は `screen` 方式と揃う。near clip で開いた物体の内側 (切り口) に
  接する線は、両方式とも描かない (切った分子表面の奥の壁の線、切り口から見える空洞の
  輪郭、切ったリボンの内側の線)。違いは、`screen` 方式が clip 面から (far - near) の
  2% 以内の輪郭を切り口とみなして描かないこと (`object` は形どおり描く)。
