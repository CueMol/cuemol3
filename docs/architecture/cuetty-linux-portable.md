# cuetty の Linux 持ち運び版 (ヘッドレス計算ノードでの umbreon 静止画・動画描画)

GPU もディスプレイも root 権限もない Linux の計算ノード (Slurm などのクラスタ。RHEL 8 系を含む) で、
GUI で作った `.qsc` を umbreon で描くための cuetty。リリースに `cuetty-<version>-linux-x64.tar.gz`
を添付し、利用者は展開して実行するだけにする。使い方は [`cli/README.md`](../../cli/README.md)。

## 配布物

```
cuetty-<version>-linux-x64/
  bin/cuetty
  lib/libcuemol2.so*, libboost_*.so*
  share/sysconfig_cuemol3.xml, sysconfig.xml, data/, icc_profiles/
  README.md   (cli/README.md)
```

- cuetty の Linux の RPATH は `$ORIGIN/../lib` で、`LD_LIBRARY_PATH` は要らない。libpng / zlib /
  expat / TBB / Embree / OIDN / MeshMS は libcuemol2 に静的に入り、実行時に外から要るのは
  glibc、libstdc++、liblzma.so.5 だけ (いずれも対象の OS に標準で入っている)。
- `--config` がなければ、実行ファイルの位置 (Linux は `/proc/self/exe`、macOS は
  `_NSGetExecutablePath`) から `../share/sysconfig_cuemol3.xml` を探し、なければビルド時の
  `DEFAULT_CONFIG`。`sysconfig.xml` ではなく tritium と同じ `sysconfig_cuemol3.xml` を使うのは、
  `cuemol3_style.xml` の style (`AlphaFoldPlddtColoring` など) を GUI のシーンが名前で参照するため。
  `sysconfig.xml` では、エラーにならないまま違う色で描かれる。
- 作るのは `build_scripts/package_cuetty_linux.sh`。

## ビルド: manylinux_2_28

- `quay.io/pypa/manylinux_2_28_x86_64` (AlmaLinux 8, glibc 2.28, gcc-toolset) のコンテナでビルドする。
  gcc-toolset は新しい libstdc++ の差分を実行ファイルに静的に入れるので、RHEL 8 系の古い
  libstdc++ でも動く。glibc 2.28 以上 (RHEL 8 / 9、Ubuntu 20.04 以降、Debian 10 以降) を覆う。
  ubuntu-22.04 のビルド (glibc 2.35) をそのまま配ると RHEL 8 系で起動できない。
- deplibs も同じコンテナで作った `deplibs_Linux-manylinux_X64.tar.bz2` (CueMol/build_scripts の
  v0.3.0 以降、GLEW なし) を使う。`download_deplibs/run.sh` は `DEPLIBS_FLAVOR=manylinux` でこれを選ぶ。
- libcuemol2 は `CUEMOL2_CLI_ONLY=ON` (`build_libcuemol2_posix/run.sh`) でビルドする: Python /
  node.js / XPCOM の binding とテストを作らず、LibLZMA を必須にする (`REQUIRE_LIBLZMA`。GUI の既定の
  保存形式 QDF1 + xz の埋め込みデータを読めないビルドを作らないため)。`ENABLE_UMBREON` と
  `ENABLE_MESHMS` も ON で渡す (スクリプトの既定は OFF。MeshMS が OFF だと分子表面が BALL で作られ、
  GUI と形が変わる)。
- AlmaLinux 系では CMake の `GNUInstallDirs` が `lib64` を選ぶので、umbreon / MeshMS / libcuemol2
  (と build_scripts 側の TBB / Embree / OIDN / CGAL) は `-DCMAKE_INSTALL_LIBDIR=lib` で入れる。
- EL8 の Bison 3.0.4 / Flex 2.6.1 は libcuemol2 の要件 (3.7.4 / 2.6.4) に足りないので、CI のコンテナで
  ソースからビルドする (パーサー生成だけに使い、配布物には入らない)。
- CPU の下限は x86-64-v3。MeshMS を GUI の配布物と同じ `MESHMS_ARCH=avx2` でビルドするため。
  古い CPU では表面の生成中に `SIGILL` で落ちるので、cuetty は起動時に
  `__builtin_cpu_supports("x86-64-v3")` (GCC 12 以降の Linux x64 ビルドだけ) で調べ、終了コード 1 で止める。

## CI

`.github/workflows/build_linux.yml`:

- `cuetty_portable`: manylinux のコンテナで deplibs → umbreon → MeshMS → libcuemol2 → cuetty を
  ビルドし、tarball を artifact にする。
- `cuetty_portable_check`: 素の `rockylinux:8` と `ubuntu:22.04` で tarball を展開し、
  `LD_LIBRARY_PATH` も `--config` もなしで `build_scripts/check_cuetty_portable.sh` を回す。
  - 静止画: xz で 1CRN を埋め込んだ `tests/test_data/1crn_movie_test.qsc` を 64x64 で描き、PNG が
    背景だけの大きさ (約 200 バイト) より十分大きいこと (埋め込みデータが実際に読めたこと)。
    素のイメージには PNG を読む道具がないので、画素ではなく大きさで見る。
  - 動画: `--shard 0/2` と `--shard 1/2` を別のディレクトリに描き、それぞれのファイル名が担当範囲と
    ちょうど一致すること。合わせた連番だけを見ると、両方が全フレームを描いても通ってしまう。
  - 画素値の一致は見ない (umbreon の変更で毎回壊れる)。
- `cuetty_portable_release`: tag のときだけ、確認の済んだ tarball をリリースに添付する。

## 動画とフレームの分担

`cli/render_scene.cpp` の `renderMovieFrames()`。exporter の作り方と設定 (`applyRenderSettings`、
サイズの上書き) は静止画と共通の `makeExporter()`。

- フレーム数は GUI と同じく `AnimMgr::setupRender(0, length, fps)` の戻り値で、`--no-last-frame`
  なら 1 減らす。ファイル名は GUI と同じ `<base>_frm_NNNN.png` (`shared/movieFrames.ts`)。
- 開始カメラは GUI (`overrideStartCamForRender`) と同じ規則: アニメーションの `startcam` が空か、
  そのカメラがシーンにないときだけ `--camera` (既定 `__current`) に替える。view のない cuetty で
  替えないと、`AnimMgr` は既定値で作ったカメラから始めてしまう。
- 途中のフレームから描く run も、フレーム 0 から `beginFrame()` / `endFrame()` で状態を進め、担当
  範囲のフレームだけ `write()` する。フレームの状態はほぼ時刻で決まるが、`RendXformAnim::onStart`
  は開始した時点の作業カメラの向きで移動方向を決めるので、フレーム番号だけを飛ばすと、カメラの
  回転中に始まる移動で向きがずれる。状態の更新は軽く、重いのはレイトレースだけ。2 分割の出力は
  逐次描画とバイト単位で一致する。
- `--shard I/N` は全フレームを N 個の連続した区間に分け、先頭の (フレーム数 mod N) 個の区間が 1 枚
  多い。区間が空 (shard がフレームより多い) なら何もせず終了コード 0。
- 各フレームは `<file>.tmp` に書き、書き込みと close が成功してから完成名に rename する。途中で
  殺されたジョブや容量不足のフレームを、`--skip-existing` が完成品と見なさないため。並列のジョブが
  同じディレクトリに書くので、GUI と違って既存のフレームは消さない。静止画 (`--render`) も同じ書き方。
- 出力ディレクトリは cuetty では作らない。なければ終了コード 1 で止まり、作ってから投げるよう
  ログに出す (GUI も既存のフォルダを要求する)。array job のタスクは同時に始まるので、各タスクが
  作ると、NFS では別のノードのタスクが、他のノードが作った直後のディレクトリを見られないことがある。
  Linux 6.15 以降の NFS クライアントは、mkdir が EEXIST で失敗しても「その名前はない」という
  キャッシュを捨てない (commit 8376583b84a1 からの退行。v6.15+ 向けの修正パッチが 2026-08 に
  投稿されているが、取り込まれたかは確かめていない)。
  そのため、続く stat や open が ENOENT になる。既定の `lookupcache=all` では、このキャッシュは
  親ディレクトリの属性キャッシュ (`acdirmin` 30 秒〜`acdirmax` 60 秒) の間は信用される。実機の
  クラスター (/home が NFS、計算ノードは Ubuntu 26.04) では、各タスクが作る版で同じノードの 2 タスクが、
  EEXIST を成功とみなす版でも別のノードの 1 タスクが止まった。待って確かめ直す回避はカーネルの版と mount の設定に
  左右されるので採らず、投入前に 1 回作る (HPC サイトの案内と同じ) ことにした。CI の確認では、
  ないディレクトリで失敗すること、4 つの shard を同時に 1 つのディレクトリへ描かせて全フレームが
  揃うことを見る。

## 失敗を成功扱いにしない

- 読み込み: `SceneXMLReader` は読めないデータがあってもログを出して読み込みを続ける (GUI では
  そのほうが都合がよい)。代わりに `getLoadErrors()` に次を記録し、`LoadSceneCommand::m_loadErrors`
  で渡す。cuetty は 1 件でもあれば内容をログに出して終了コード 1 で止める。
  - 埋め込みデータ (chunk) の読み込みで出た例外。
  - XML が要求した chunk のうち、ファイルになかったもの。途中で切れたファイルは、次の chunk を
    探す段階で EOF に達して普通にループを抜けるので、例外を見るだけでは分からない。
    `procDataSrcLoad` で登録した chunk ID を `m_pendingChunks` に入れ、読めたものを消し、残りを記録する。
  - 外部ファイルが見つからないときは、もともと `read()` から例外が出る (cuetty はこれも 1 で止める)。
- 書き込み: umbreon の PNG コールバック (`UmbreonSceneExporter.cpp`) は短い書き込みや flush の失敗を
  `png_error()` に回す (C++ の例外を libpng の C のフレームに通さないため、longjmp で
  `writePngToStream` に戻ってから例外にする)。`PosixFileStream` の flush / close は失敗を
  `IOException` にする。小さな画像では stdio のバッファが close で初めて書き出されるので、容量不足は
  close で分かることが多い。

## スレッド数

umbreon (Embree、OIDN) と libcuemol2 は同じ 1 つの oneTBB (libcuemol2 に静的に入っている) を使う。
`qlib/parallel.hpp` の `CUEMOL_TBB_THREADS` が `tbb::global_control` で上限を決め、`qlib::init()` が
最初にこれを適用する (以前は最初の `parallel_for` で遅れて適用され、それより先に始まるレイトレースには
効かなかった)。cuetty は初期化の前に、`--threads`、なければ `SLURM_CPUS_PER_TASK`、`OMP_NUM_THREADS`
の順にこの変数を設定する。どれもなければ上限なし (共有ノードでは割り当てより多く使いうる)。

## 対象外

- label の描画 (file `DisplayContext` が `drawString` を描かない既存の制限)。
- POV-Ray バックエンド、`--interactive` の Python シェル、Python モジュールの wheel。
  動画の入口を Python スクリプトにしなかったのは、クラスタではノードや利用者ごとに Python の版と
  環境が違い、wheel を版ごとに配るより tarball 1 つのほうが配りやすいため。
- 動画のエンコード (ffmpeg は同梱しない。README に GUI と同じ引数の例を載せる)。
- arm64 Linux、GPU。
