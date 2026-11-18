# Density map pane の Level ヒストグラム

Density map pane の Level は、数値の入力欄と、マップの密度ヒストグラムの上に置いた level の
縦線 (マーカー) の組で変える。ChimeraX の Volume Viewer に倣ったもので、UXP の map panel には
無かった (UXP の移植ではないので ADR ではなくここに書く)。

## 画面

pane の数値欄は上から Transp、Extent、Level。Level は `FieldGrid` の中の 3 行:

```
 Level  [ 1.50 ] σ          [-][+][Fit]
 [ヒストグラム ▁▂▅█▇▅▃▂▁▁       |       ]   <- 縦線 = 今の level
 -0.179     = 0.0595 (absolute)     0.259
```

- 1 行目は入力欄と表示範囲のボタン。入力欄は今のモードの単位 (native なら sigma か cryo-EM の
  上位格子点 %、absolute なら絶対値) で、Enter / blur で確定する (`NumericField`、表示は step より
  1 桁細かい `decimals`)。
- 2 行目のヒストグラムは**横軸が絶対密度**。縦軸は `log(1 + n)` (`histogramBarFraction`)。
  グリッドの行間は詰まっているので、帯は上に `--space-2` の余白を持つ。
- 3 行目は表示範囲の min / max と、その間に別単位での level の caption
  (`levelControlFor` の `hint`。native モードなら絶対値、absolute モードなら native 単位)。
  帯の横軸の単位で読める位置に置き、幅が足りなければ caption が先に省略される。

## 操作

| 操作 | 動き |
|---|---|
| 縦線を左右にドラッグ | level を変える。ドラッグ中は 1 フレームに 1 回 preview を書き (contour もその場で描き直る)、離したときに undo 1 回分として確定 |
| Shift + ドラッグ | 0.1 倍の細かさで動く (ChimeraX と同じ) |
| Esc (ドラッグ中) / 元の位置で離す | preview を取り消す (undo には何も残らない) |
| 帯の空いている所をクリック | そこへ level を移す (確定 1 回)。押したまま `DRAG_THRESHOLD_PX` を超えて動かすとパンになる |
| 帯の空いている所をドラッグ / ピンチ / 横スクロール | 表示範囲のパン / ズーム |
| − / + | 表示範囲を 1.5 倍に広げる / 狭める。中心は level (表示範囲の外なら中央) なので、縦線は同じ位置に残る |
| Fit | 表示範囲を最初の範囲に戻す |

表示範囲の最初の値 (Fit の戻り先) は renderer の `uiAbsLevelRange` (背景から上位 0.01% の
格子点)。cryo-EM マップのマスクされた背景や外れ値の最大値に横幅を取られないため。取れないときは
マップの全範囲。renderer を選び直すと最初からになる。ドラッグ中は表示範囲と再取得を止める
(軸が一緒に動くと縦線が止まって見える)。

## 書き込みと同期

- 縦線からは**常に `level` (絶対値) を書く**。C++ の `MapRenderer::setLevel()` が map の種類を
  通して `siglevel` に換算し、`siglevel` を modified にする (`use_abslevel` は変えない) ので、
  どのモードでもそのまま使える。入力欄は `levelControlFor` の prop (`siglevel` か `level`) を書く。
- 書き込みは `setMapRendererProp` の preview / commit (+ `originalValue` / `originalWasDefault`)
  / abort。default flag は `siglevel` のものを、ドラッグ開始時の値で固定して使う。
- **入力欄と縦線は、renderer の state を経路にして互いに追従する**。preview の書き込みでも
  property の変更イベントが飛び、`useDensityMapPanel` が `getMapRendererState` を取り直す。返る
  state には C++ が換算した `level` と `siglevel` の両方が入っているので、縦線をドラッグすると
  入力欄と caption がついてくる。sigma と絶対値の換算はともかく、cryo-EM の % と絶対値の換算は
  マップの累積ヒストグラムに依存し C++ にしか無いので、TS 側で換算するコードは持たない。追従は
  state の取り直しを待つので、1 フレーム + 30 ms ほど遅れる。

## 部品と配線

| 部品 | 場所 | 役割 |
|---|---|---|
| `HistogramStrip` | `h3-kit/gradient/HistogramStrip.tsx` | 帯の描画 (HiDPI canvas、log 縦軸)、ピンチ / パン、`onClickValue` (動かさずに離したら値を返す)、上に重ねる children。multigrad の `GradientStopBar` と共有 |
| `LevelHistogramField` | `h3-kit/gradient/LevelHistogramField.tsx` | `FieldGrid` の 3 行 (入力欄の差し込み口 + ズームボタン / 帯 + 縦線 / min・caption・max)。CueMol を知らない。Component Catalog 2 に見本 |
| `FieldGridSpan` | `h3-kit/form/FieldGrid.tsx` | `FieldGrid` の 2 列にまたがる行 |
| `useRebinnedHistogram` | `h3-kit/gradient/useRebinnedHistogram.ts` | nice なビン格子 (1-2-5、原点 0 に揃える)、100 ms debounce、ドラッグ中の停止、古い応答の破棄。取得関数は呼び出し側が渡す。multigrad の `useMultiGradHistogram` もこれを使う |
| `useLevelHistogram` | `features/density/useLevelHistogram.ts` | 表示範囲 (最初の値・Fit・選び直し)、ビン幅の下限 (`minHistogramBinWidth`)、取得 |
| `getMapHistogram` / `getMapHistogramInfo` | `worker/server/services/map/histogram.ts` | map renderer の親マップ (client object) のヒストグラム (窓 + `globalNmax`) と、ビン幅の下限に使う統計 (`den_*`、格子点数、最大ビン) |
| `helpers/mapHistogram.ts` | `worker/server/services/helpers/` | `readMapStats` / `readHistogramRange` (C++ `getHistogramJSON` の再ビン) / `readHistogramWithGlobalMax` / `readHistogramFloorStats`。multigrad の service と共有 |

`globalNmax` は同じビン幅・同じ原点でマップの全範囲を再ビンしたときの最大ビンで、パンしても
縦軸の倍率が変わらないようにするためのもの。全範囲が細かすぎる (65536 ビン超) ときは null で、
窓の中の最大値に戻る。

## 既知の制限

- 大きな cryo-EM マップでは、ドラッグ中のフレームごとの contour の計算が重くなりうる。重いと
  分かったら、一定サイズを超えるマップでは「離したときだけ描き直す」に切り替える案がある。その
  場合はドラッグ中に renderer へ書かないので、入力欄と caption は離すまで追従しない (換算だけを
  返す service を足して埋めることはしない。C++ の換算 API が要り範囲が広がるため)。
- 同じマップの他の renderer の level は帯に出さない。
