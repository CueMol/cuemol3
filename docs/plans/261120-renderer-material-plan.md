# renderer の material の残り

renderer の `material` は WebGL の描画で効き、金属度・環境の映り込み・toon・陶器の輪郭の照りも入った (仕様は [../architecture/renderer-material.md](../architecture/renderer-material.md))。残りは、必要になったら着手する項目だけ。

- material の検索は renderer ごとに毎フレーム `StyleMgr` を引いている。重さが問題になったら、名前が前回と同じなら引き直さない (旧実装の `m_curMater` と同じ)。
- 色ごとの material (`Color.material`、`ColorTable`) を WebGL の描画で効かせる。今は renderer 単位だけ。
