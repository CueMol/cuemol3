# RockSpin: 振動する spin と、console からの camera の動き

animation element `RockSpin` は、開始時の向きを中心に view を振動させる。PyMOL と ChimeraX にある
rock / nutate / wobble をまとめて 1 クラスで扱う。ChimeraX と PyMOL の console は、`turn` / `roll` /
`rock` / `wobble`、`movie.*` / `rock` を、この element と既存の `SimpleSpin` に置き換えて timeline に
足す。

UXP には無い機能で、tritium で追加した。

## RockSpin (C++ `src/modules/anim/RockSpin.{hpp,cpp,qif}`)

### property

| property | 型 | 既定 | 意味 |
|---|---|---|---|
| `pattern` | enum | `rock` | `rock` (1 軸の往復) / `nutate` (視線が円を描く) / `wobble` (8 の字) |
| `angle` | real | 30 | 振れ幅の全体 (度)。実際の振れは ±angle/2。範囲は無く、負なら逆向き |
| `axis` | Vector | (0, 1, 0) | 主軸。画面の座標系 (x = 右、y = 上、z = 手前)。正規化して持つ |
| `cycles` | real | 1 | element の中の周期の数。小数も可 |
| `phase` | real | 0 | 開始の位相 (度) |
| `aspect` | real | 1 | 副軸の振幅比 (nutate / wobble) |
| `envelope` | enum | `none` | 振幅の時間変化: `none` / `grow` (0 から広がる) / `shrink` (0 へ縮む) |

### 回転の式

```
rho      = getRho(elapsed)               (0..1。quadric の緩急はここに効く)
t(rho)   = 2*pi * cycles * rho + phase
amp(rho) = env(rho) * angle / 2           (env: none = 1、grow = rho、shrink = 1 - rho)
g1(rho)  = amp * sin(t)                    (主軸)
g2(rho)  = amp * aspect * sin(ratio * t + shift)   (副軸。rock は 0)

主軸 axis  の回転 = g1(rho) - g1(0)
副軸 axis2 の回転 = g2(rho) - g2(0)
axis2 = normalize(cross((0, 0, -1), axis))   (視線方向 x 主軸。ChimeraX wobble と同じ)
```

| pattern | ratio | shift |
|---|---|---|
| nutate | 1 | 90 度 |
| wobble | 2 | 0 度 |

- **始まりで跳ばない**: 角度から rho = 0 の値を引くので、どの pattern・phase・envelope でも、element は
  適用前の向きから連続して始まる。式そのままだと、nutate は rho = 0 で副軸が +angle/2 になり、途中に
  置いた element の始まりで向きが跳ぶ。
  - その代わり、nutate の円は「適用前の向きを通る」円になる (中心は適用前の向きからずれる)。中心に
    置きたいときは envelope を grow にする。rock と wobble は phase = 0 なら g(0) = 0 なので、中心は
    適用前の向きのまま。
- **終わったとき**: `onTimerPost` で rho = 1 の回転 (g(1) - g(0)) を掛ける。envelope が none で
  `cycles` が整数なら、適用前の向きに戻る。
- **回転の合成**: 主軸、次に副軸の順に、`SimpleSpin` と同じく work camera の `m_rotQuat` に右から掛ける。
- **視線に平行な軸**: `axis` が視線方向と平行なとき (外積がほぼ 0) は、副軸の回転を行わない (rock と
  同じ動きになる)。
- AnimMgr は、時間が重なった element の回転を一覧の順に合成する。一定の回転 (`SimpleSpin`) と同じ時刻に
  置けば、回りながら揺れる。

### 1 クラスにした理由

rock / nutate / wobble は副軸の振幅比・周波数比・位相差だけが違う。クラスを分けると、軸・周期・位相・
振幅の変化と、Inspector / console の対応表が 3 つに増えるだけになる。nutate を「x 軸と y 軸の rock を
重ねた 2 つの element」で作ることもできるが、2 つの時間・削除・copy / paste を揃えて扱う仕組みが GUI に
無いので、C++ の `pattern` で持つ。

## worker と GUI

- **Add メニュー**: 「Rock」(`RockSpin`、pattern rock、angle 30、cycles 1、quadric 0)。nutate / wobble は
  Inspector の Pattern で選ぶ。
- **Inspector** (`AnimElementInspector`): Pattern、Axis (SimpleSpin と同じ preset + `(x, y, z)` の行)、
  Swing angle (範囲なし)、Cycles、Phase、Aspect (Nutate / Wobble のときだけ)、Envelope。
- **pattern と aspect**: `pattern` を書き換えると、worker (`setAnimElementProp`) が同じ undo txn の中で
  `aspect` をその pattern の既定 (nutate 1.0、wobble 0.3。rock は触らない) に入れ直す。Inspector の
  Properties タブ、Generic タブ (`pattern` だけ同じ経路に回す)、op `set_anim_prop`、記録の再実行の
  どこから変えても同じ結果になり、Undo 1 回で両方が戻る。別の `aspect` にしたいときは `pattern` の
  あとに書く。
- **op**: `add_anim` の `type` に `rock`、`set_anim_prop` に `pattern` / `cycles` / `phase` / `aspect` /
  `envelope`。

## 開始カメラ `__current`

element を足すとき (`ensureStartCam`)、開始カメラがまだ無ければ今の view を `__current` に保存して
開始カメラにする (UXP と同じ)。これに加えて、**timeline が空で、開始カメラが空か `__current` のとき**は、
`__current` を今の view で保存し直す。`__current` は「animation を作り始めた時点の view」を表す。

- これが無いと、空の scene で一度 animation を作ったあとに分子を読み込み、element を消して作り直しても、
  分子から離れた古い view から動いた。
- element が既にあるときは変えない (前の element はその開始カメラに合わせて作られている)。名前付きの
  カメラを開始カメラに選んでいるときも変えない。
- GUI の Add / paste と、console の motion (`add_anim`) のどれにも効く。

## console

両 dialect は、motion を op (`add_anim` -> `set_anim_time` -> `set_anim_prop`) で timeline の末尾に足す。
1 つの console コマンドは 1 つの undo にまとまる。共通の処理は console plugin の
`worker/runtime/motion.ts` (`dialect-api` から公開) にある。console は emulator ではなく利用者の補助
なので、速さ・位相・フレームの端数は大まかに合わせるだけにしている。

### ChimeraX (`chimerax-console/worker/commands/viewCommands.ts`)

フレーム数は 60 fps で秒に直す。回る向きは、すぐに回すほうの `turn` (`turnedRotation`) と揃える
(element の角度は符号を反転する)。

| コマンド | 動き |
|---|---|
| `turn axis angle` (frames なし) | すぐに回す (element は作らない) |
| `turn axis angle frames N` | SimpleSpin (angle x N 度、N フレーム) を足して、1 回再生する |
| `roll axis angle frames N` | 同上 (angle は 1 フレームあたり、既定 1 度) |
| `rock axis angle frames cycle N` | RockSpin rock (`cycles = frames / cycle`)。既定は 30 度、136 フレーム |
| `wobble axis angle frames cycle aspect` | RockSpin wobble。既定の aspect は 0.3 |
| `turn ... rock N` / `turn ... wobble N` | rock / wobble と同じ |
| frames が forever (roll / rock / wobble の既定) | 1 周期分 (roll は角度の符号の向きに 360 度) を足し、loop で再生する |
| `stop` | console が始めた loop を止めて loop を元に戻す。それが無ければ、再生中の timeline を pause する |

- **1 回再生**: 有限の motion は、足した element の開始時刻 (足す前の timeline の長さ) に seek してから
  再生する。新しい element は末尾にあるので、その motion だけが動いて止まる。
- `center` / `coordinateSystem` / `models` / `atoms` は断る (camera だけを動かす)。

### PyMOL (`pymol-console/worker/commands/motionCommands.ts`)

フレーム数は 30 fps (`movie_fps` の既定) で秒に直す。PyMOL と同じく、`movie.*` は足すだけで再生しない
(`mplay` で再生する)。

| コマンド | 動き |
|---|---|
| `movie.add_roll(duration, loop, axis, start)` | SimpleSpin 360 度、duration 秒 |
| `movie.add_rock(duration, angle, loop, axis, start)` | RockSpin rock、cycles 1 |
| `movie.add_nutate(duration, angle, spiral, loop, offset, phase, shift, start)` | RockSpin nutate (主軸 x)。`spiral` 1 -> grow、-1 -> shrink |
| `movie.roll(first, last, loop, axis)` | SimpleSpin 360 度、(last - first + 1) フレーム |
| `movie.rock(first, last, angle, phase, loop, axis)` | RockSpin rock |
| `movie.nutate(first, last, angle, phase, loop, shift)` | RockSpin nutate |
| `movie.tdroll(first, rangex, rangey, rangez, skip)` | x、y、z 軸の順に SimpleSpin を chain して並べる (範囲 0 の軸は飛ばす)。各軸 ceil(range / skip) フレーム |
| `movie.screw` | 断る (z 方向の移動を重ねる motion が無い) |
| `rock [mode]` | 省略か -1 で切り替え、1 で開始、0 で停止。y 軸、振れ幅 20 度、1 周期約 8.4 秒 (PyMOL の `sweep_angle` / `sweep_speed` の既定) の rock を loop で再生する |

- `first` / `start` の位置には置かず、いつも末尾に足す (`start` が既定と違えば warning)。`first` /
  `last` は長さにだけ使う。`last` が負なら今の timeline の長さに置き換え、timeline が空なら `last` の
  指定を求める。`loop` 引数は使わない。
- `shift` は PyMOL と同じくラジアンで受け取る。pi/2 と違えば warning (固定値のため)。
- `sweep_*` の setting には対応しない (PyMOL console の setting に保存先が無い)。
- `mstop` も、console が始めた rock の loop を元に戻す。
- 名前は `movie.roll 1, 120` のように空白区切りで書く。`movie.roll(1, 120)` の Python 風の書き方は無い。

### 一時的な loop

forever の motion と PyMOL の `rock` は、scene の loop を借りて 1 周期を繰り返す。loop は scene の設定
なので、console は scene ごとに「最初に見つけた loop の値」を 1 つ記録する (両 dialect で共有、
`motion.ts`)。

- 記録が無いときに始めたら、今の値を記録して loop を on にする。記録があるとき (続けて `rock` ->
  `wobble`) は上書きしない。
- console の停止 (ChimeraX `stop`、PyMOL `rock` / `rock 0` / `mstop`) は、再生中なら止め、止まっていても
  記録した値に戻して記録を消す。そのあいだに利用者が loop を切っていたら (今の値が off)、戻さずに
  記録だけ消す。
- 「console の rock が動いている」は、記録があり、かつ timeline が実際に再生中であること。GUI の
  Pause、別の scene への切り替え、element の編集で止まったあとの `rock 1` は、element を足さずに再開する。
- GUI の再生ボタンで止めたときは loop に触らない。
- loop は timeline 全体を繰り返すので、ほかの element が既にあれば warning を出す。

## テスト

- gtest `RockSpin.AnglesFollowThePatternAndStartWithoutAJump` (`src/tests/modules/anim/test_rockspin.cpp`):
  rock / wobble の角度、nutate の rho = 0 で 0 と整数周期で戻ること、視線に平行な軸。
- gtest `AnimObjXML.RockSpinKeepsPatternAndEnvelope`: enum property の round-trip。
- vitest `animDetailService.test.ts`: pattern が aspect を同じ txn で入れ直す。
- vitest `animationService.test.ts`: Add の既定 (quadric 0)、空の timeline で `__current` を保存し直す。
- vitest `chimerax-console/.../motionCommands.test.ts`: rock の長さと cycles、1 回再生、`rock` -> `wobble`
  -> `stop` で loop が戻る。
- vitest `pymol-console/.../motionCommands.test.ts`: `movie.tdroll` の長さと chain、`rock 0` / `rock 1`
  (GUI で Pause したあとの再開、Pause 中の停止で loop が戻る)。
