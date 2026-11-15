# Animation strip の drag 表示と snap

tritium/react-gui の Animation panel で、strip (1 つの AnimObj) を drag して移動・伸縮する
あいだ、変わっている値を浮動 badge に表示し、端を grid に snap させる。

UXP の animation panel には時間軸上の strip が無い (strip モデル自体が
[ADR-0029](../migration/adr/ADR-0029-anim-timeline-strip-model.md) で tritium に追加したもの)
ため、これは tritium で追加した機能として扱う。

## 表示 (`features/animation/anim/AnimDragBadge.tsx`)

| drag | 主の値 (太字) | 従の値 |
|------|---------------|--------|
| 右端の resize | `len 2.400s` | `end 0:05.400` |
| 左端の resize | `len 2.400s` | `start 0:03.000` |
| 本体の move | `start 0:03.000` | `end 0:05.400` |

- 時刻はすべて絶対時刻 (ruler と同じ座標)。長さは秒 3 桁、時刻は `formatClock` の `m:ss.mmm`。
- badge は strip の中ではなく `.anim-canvas` の直下に描く (strip は `overflow: hidden` で中身を切る)。
  縦位置は strip の lane の 1 つ上。先頭の lane だけは sticky な ruler (z-index 4) に隠れるので下に出す。
- 横位置は掴んでいる端 (右端の resize は end、それ以外は start) を中心にし、
  `.anim-timeline` の **見えている範囲** (scrollLeft から pane 右端まで) に clamp する。
  canvas 幅で clamp すると、range を越えて伸ばしたときに badge が取り残される。
- drop した時点 (`DragPreview.committed`) で消す。

## snap (`AnimationPanel.tsx` の `handleStripEditDown`)

- grid は ruler の目盛り間隔 (`niceTickStepMs`) の 1/10 (`snapStepMs`)。拡大するほど細かくなる
  (既定の倍率では 100 ms)。
- 何を丸めるかは drag の種類で変える:
  - 右端の resize: **長さ**を丸める (ユーザーが見て合わせたいのは長さなので)。
  - 左端の resize / move: **絶対時刻の start** を丸める (ruler の目盛りと揃う)。
  chained element でも丸めるのは絶対時刻で、相対時刻はその結果から決まる。
- 丸めた後に、従来の境界 (start >= 0、chained の相対 start >= 0、start <= end) を当てる。
- **Alt (Option) を押している間は snap しない**。そのときも commit 値は ms 単位に丸める。
  修飾キーは mousemove / mouseup ごとに読むので、drag の途中で切り替えられる。

## drag 中の canvas と cursor

- canvas 幅を決める `contentMs` は `max(AnimMgr.length, element の absEnd の最大, 1s)` に、
  drag 中の preview の end も含める。range を越えて伸ばすと ruler と canvas がその場で伸びる。
  commit 後は C++ 側の length が自動で `max(absEnd)` に伸びるので、表示は変わらない。
- drag のあいだ `<html data-anim-drag="resize|move">` を立て、CSS
  (`:root[data-anim-drag] *` と `!important`、`data-busy` と同じ方式) で cursor を
  `ew-resize` / `grabbing` に固定する。snap でポインタが幅 6px の grip から外れても、
  lane の cursor に戻ってちらつかない。mouseup で外す。

## テスト

`__test__/animationPanel.test.tsx` の「snaps to a tenth of the ruler tick; Alt drags freely
in whole milliseconds」が、既定で snap されること、Alt 付きでは ms 単位で自由に動くことを pin する。
