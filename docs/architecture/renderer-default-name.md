# Renderer の既定名

新しい renderer に名前が指定されなかったときの名前の付け方。GUI とコマンドで同じ手順を踏めば
同じ名前になるよう、規則を 1 つにしている。

## 規則

`services/rend/defaultRendererName.ts`:

- 接頭辞は、preset の group なら `presetNamePrefix(preset)` (`Default1RendPreset` -> `default1_`)、
  そうでなければ renderer の型名 (`cartoon`)。
- `<接頭辞>1`, `<接頭辞>2`, ... のうち、**scene のどの renderer にも使われていない**最初の名前
  (`Scene.getRendByName` で調べる)。object ごとの連番ではない。renderer は scene 全体から名前で
  引かれることがあり (`getRendByName`)、object ごとの連番では別の object に同名の renderer ができて
  曖昧になるため。UXP も scene 単位だった (`onNewRendGrp`)。

## 使う所

| 経路 | 呼び方 |
|---|---|
| File Open / New Renderer の dialog | `proposeUniqName` (kind `sceneRenderer`) で名前欄の既定値を出す |
| Get PDB の PubChem / CCD (dialog なし) | `proposeUniqName` で `ballstick<n>` を決めてから読む |
| `add_renderer` op | `unusedRendererName` |
| load / fetch 系の op (`load_file`、`fetch_pdb` ほか) | `applyRendererArgs` で、利用者の `preset` / `rendererType` を反映した**後**に採番する (`rendererName` が指定されていれば採番しない)。最終的な preset / 型から採番しないと、既定 preset の接頭辞が残って GUI と食い違う |

## 記録

読み込みの記録 (`recordLoadFile`、`streamLoadFromUrl` の `recordFetch`) は、`recordedRendererName`
で renderer を作る**前**に既定名を求め、実際の名前と同じなら `rendererName: null`、違えば名前を残す。
作った後に求めると、その renderer 自身が名前を使っているので次の番号が返る。preset の group も
対象 (group 名と子の接頭辞は `rendererName` から作られる。`setupRenderer.ts`) で、利用者が付けた名前は
再生でも保たれ、後続の操作がその名前で参照できる。

既定名を null で残すので、再生時の名前は再生時点の scene で決まる。記録した時と同じ順に再生すれば
同じ名前になる。読み込み系の op が object ごとに `<type>1` を付けていた頃の記録を、renderer の多い
scene で再生すると、名前が変わることがある。
