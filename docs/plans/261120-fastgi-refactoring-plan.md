# FastGI のリファクタリング計画

対象は `feat/depth-perception-stage0` の FastGI。着手前の同ブランチを比較基準にし、描画画像と通常時・再ベイク時の処理時間を維持する。処理時間は計測ではなく、差分で処理の回数・条件が変わらないことと、展開済みシェーダーの照合で確かめる (下記「採否の判定」)。以下は優先順で、各項目を独立したコミットとして検証する。

## 1. フレーム描画からプローブ準備を切り出す

[FrameRenderPipeline.cpp](../../src/qsys/FrameRenderPipeline.cpp) のプローブ更新判定と描画パラメータ設定 (`AoProbeParams` を組み立てる部分) を private 関数にまとめる。引数は `pdc`、`pScene`、AO 方式、`modelView`、`params.deferProbeBake`、呼び出し側の `AoProbeParams` の参照とし、戻り値で `drawGtao` に渡すポインタ (プローブを使わないときは nullptr) を返す。

- 方式・強度を判定する前に `m_bProbePending` と `m_bProbeBaked` をリセットする順序を保つ。
- `update` の前後でハッシュを比較し、ベイクの有無を判定する。遅延ベイクの待ち時間と pending 通知も維持する。
- 更新成功時だけ逆行列を計算し、既存の座標系・精度でパラメータ (key light の向き・影の強さを含む) を設定する。
- `isProbeBaked()` の宣言にある契約のコメント (再ベイクで画像が変わるので、蓄積中の時間 AA をやり直す) は、切り出した後も残す。ベイクを管理する側から AA をやり直す側 (`GUIView`) へたどる手がかりになる。
- `GUIView` は `isProbeBaked()` で AA の時間方向の足し込みをやり直す。この経路はかつて画面が明るくなりすぎる不具合を起こしたので、確認は二段で行う。

1. **差分の照合**: `AmbientProbeVolume::update` の呼び出し条件・引数・回数と、逆行列を計算する条件が変更前と同じであることを差分で確かめる。
2. **ライブ描画**: 時間 AA を有効にし、FastGI のベイク完了後に遮蔽物を動かして静止させる。待機中はプローブが外れ、再ベイクしたフレームでプローブが有効になり、そのフレームの描画後に時間 AA が先頭のサンプルから再開することを確認する。FastGI から GTAO に切り替えた直後のフレームでプローブが外れることも見る。

ライブ描画の確認に必要な値 (pending・baked・プローブの使用有無、AA のサンプル番号と `m_jitterMoreSamples`) は今は外から見えないので、検証のあいだだけ `LOG_DPRINTLN` の一時的なログで毎フレーム出し、コミット前に消す (AA のサンプル番号の既存ログ `GUIView> jitter SS sample` は `MB_DPRINTLN` で、ビルドによっては出ない)。期待する並びは仕様から決まるので、変更前の版でログを取って比べる必要はない。ベイクの開始は実時間 (待ち時間 0.2 秒と、変更を見に行く 0.1 秒間隔) で決まり、待機フレームの数は試行ごとに変わるので、同じ状態が続く行を一つにまとめて次の順序を確かめる。

1. 変更検出後の待機中: pending が true、baked が false、プローブは未使用。
2. 再ベイクしたフレーム: pending が false、baked が true、プローブを使用。
3. 同じフレームの描画後: AA のサンプル番号が 0 に戻り、次のサンプルの描画が要求される (`m_jitterMoreSamples` が true)。

## 2. プローブ可視性の式をまとめる

[gtao_frag.glsl](../../src/sysdep/ogl_core/gtao_frag.glsl) では、プローブのモーメント `(m0, m1)` から法線方向の可視性 `mix(1, clamp(m0 + 2 dot(m1, N)), strength)` を出す式が、`main` (3 次補間で読む受光点) と `probeVisibility` (照り返しの遮蔽元、3 線形補間) の二か所にある。`probeVisibility` の `cubic = true` の分岐は使われていない。

- モーメントから可視性を出す関数を一つ置き、`main` と照り返し側の両方から呼ぶ。
- `probeVisibility` の `cubic` 引数と、使われていない分岐を消す。
- key light の影 (`m0 + 3 dot(m1, L)` を平面の値で割る式) は `main` に残す。読み出したモーメントを可視性と共有するため、読み出しの回数を増やさない。
- 受光点 (3 次補間) と照り返し側 (3 線形補間) のそれぞれで、補間方法、テクスチャの読み出し回数、演算の順序と型を変えない。

## 3. ビットマスクの関数を include に移す

[gtao_frag.glsl](../../src/sysdep/ogl_core/gtao_frag.glsl) のうち、uniform を参照しない `popcount32`、`anglesToBitmask`、`bitmaskToVisibilityCosine` だけを一つの include に移し、元の位置で展開する。`anglesToBitmask` はファイル定数 `PI` を参照し、`bitmaskToVisibilityCosine` は `popcount32` を呼ぶため、`PI` の定義より後に置き、3 関数の宣言順を保つ。目的は、ビットマスクの計算 (EEVEE の `fast_gi` 移植部分) を、パスの入出力 (深度・法線・プローブ・照り返しの読み出し) から分けて読めるようにすること。座標変換、プローブの読み出し、`occluderRadiance`、`eeveeVisibility` は uniform を前提にしているので、呼び出し元に残す。

- include は [シェーダーのビルド設定](../../src/sysdep/ogl_core_shaders.cmake) の `OGL_CORE_SHADER_DEPS` に登録する (DEPS は配布されず、ビルド時に展開される)。
- 展開済みの `share/data/shaders/gtao_frag.glsl` のトークン列を項目 3 の直前コミットと照合する。

## 4. プローブアトラスの配置の重複にコメントを付ける

プローブ格子 `(x, y, z)` をアトラスのテクセル `(x + z * nx, y)` に並べる配置は、次の四か所がそれぞれ前提にしている。

- C++ 側のアトラスの大きさ ([AmbientProbeVolume.cpp](../../src/qsys/AmbientProbeVolume.cpp) の `aw = m_dim[0] * m_dim[2]`)
- [ベイク](../../src/sysdep/ogl_core/probe_bake_frag.glsl) と [fill](../../src/sysdep/ogl_core/probe_fill_frag.glsl) の整数変換
- 描画時の [sampleProbeGrid](../../src/sysdep/ogl_core/gtao_frag.glsl) の浮動小数座標 (z を二つのスライスに分け、スライスの中はハードウェアの双線形補間で読む)

描画時の読み出しは整数変換と形が違い、C++ 側は GLSL の include で共有できないので、関数の共有はしない。各箇所に、配置を変えるときに合わせて直す他の三か所を示すコメントを付ける。

あわせて、[PostProcGpuPrim](../../src/gfx/PostProcGpuPrim.hpp) の `drawGtao` の宣言に、FastGI と GTAO の両方がこの入口と `gtao_frag.glsl` を通り、`u_method` で分岐することをコメントで書く。名前だけを見て FastGI の入口を探せないためで、名前の変更より安く同じ手がかりが得られる。

## 採否の判定

| 項目 | 確認 |
|---|---|
| 1. プローブ準備の切り出し | 上記の差分の照合とライブ描画の確認。画像の書き出しの一致 (下記)。 |
| 2. 可視性の式の共通化 | 着手前の版で照り返しのオン・オフに画素差が出るシーン (近接する CPK 球など) を選び、照り返しオンの書き出し画像が変更前後で一致する。 |
| 3・4. include 移動とコメント | 展開済みシェーダーのトークン列が、各項目の直前コミットと一致する。 |

- **画像**: 同じ GPU、シーン、カメラ、解像度で、画像の書き出し (ベイクを待つ経路。ライブ描画は AA の時間サンプル・ノイズの回転・ベイクの遅延で毎回同じにならない) を使い、FastGI のプローブ強度ゼロ、プローブのベイク完了後、GTAO の各出力を比較する。各項目の直前コミットとの比較に加え、最終画像はリファクタリング着手前の版とも比較し、各条件で変更画素数ゼロを採用条件とする。
- **処理時間**: 採否の条件にはしない。GPU の処理時間は今の仕組みでは測れず (`renderTiming` は各パスを送るまでの CPU 時間だけを測り、Chromium の WebGL では `gl.finish()` がすぐ戻る)、ドラッグ中のフレーム間隔は表示周期の上限 (16.67 ms) に張り付くため、計測で差を判定する手順は手間が大きいわりに判定できない可能性が高い。代わりに、項目 1 は CPU の重い処理 (遮蔽物の収集とハッシュ計算、再ベイク時の描画命令の発行) をすべて含む `update` の呼び出しを変えないこと、項目 3・4 はトークン列の一致、項目 2 は読み出し回数と演算を変えないことを差分で確かめる。通常描画や再ベイク時に遅さが疑われた場合は、その条件を再現し、`renderTiming` を手がかりに追加で計測する。
- **記録**: 実装後の記録 (コミットメッセージや作業報告) では、差分で確かめた処理の回数・条件と、実際に測った処理時間を分けて書く。
- **ビルド**: libqsys は静的ライブラリなので、確認のたびに libcuemol2 と tritium の両方をビルドする。
