# 核酸の側鎖・主鎖の原子名リストを直す (bysidech / bymainch)

## 1. 報告と原因

報告: 選択文法の `bysidech` で、核酸の T 残基のメチル基が選ばれない。

`bysidech` / `bymainch` は、残基のトポロジーが持つ `sidech` / `mainch` の原子名リストに、ファイル上の
原子名がそのまま含まれるかで判定する (`src/modules/molstr/SelAroundImpl.cpp` の
`SelOpNode::chkMainSideChainNode` -> `ResiToppar::isSideCh` / `isMainCh`)。トポロジーの別名
(`nucl_top.xml` の `<synonyms><atom cname=... value=.../>`) は引かない。リストは
`data/nucl_props.xml` にある。

- チミン (`Td`、T / DT / THY) の `sidech` は、メチル基の炭素の名前として **`C5A`** だけを持つ。
  `C5A` は CNS の名前 (旧トポロジー `data/queptl.top` の `THY` も `C5 C5A` の結合と側鎖リストに
  `C5A` を持つ) で、CNS 形式の入力ではこれで選ばれる。一方、PDB v3 / mmCIF の **`C7`**
  (水素は `H71 H72 H73`) と、PDB v2 と `nucl_top.xml` のトポロジーの **`C5M`**
  (旧 PDB の水素は `1H5M 2H5M 3H5M`) が欠けていて、今の PDB / mmCIF のファイルではメチル基が側鎖に
  入らない。
- 同じ原因の別の不具合: 全ヌクレオチドの `mainch` が、リン酸の酸素を古い名前 **`O1P O2P`** だけで
  書いている。PDB v3 / mmCIF の **`OP1 OP2`** (と 5' 末端の **`OP3`**) は入らず、`bymainch` で
  リン酸の酸素が選ばれないと思われる。

`isSideCh` / `isMainCh` を使うのは選択文法のこの 2 つだけなので、影響もこの 2 つに限られる。

## 2. 方針: データを直す (A 案)

`data/nucl_props.xml` のリストに、新旧どちらの名前も並べる。判定のコード (別名を引くようにする
B 案) は変えない。B 案は名前の揺れに強いが、今のリストが別名 (`O1P`) と正式名を混ぜて書いているので
データも書き直しになり、変更が大きい。リストに両方の名前を並べるのは、既存の書き方の範囲で済み、
ほかの残基や判定に影響しない。

## 3. 変更

`data/nucl_props.xml` のみ。

1. `Td` の `sidech`: `C5A` は残し (CNS 形式の入力のため)、`C7 C5M` と、メチル基の水素
   `H71 H72 H73` (PDB v3 / mmCIF)、`1H5M 2H5M 3H5M` (旧 PDB。PDB reader は先頭の数字を動かさず
   そのまま原子名にする)、`H5M1 H5M2 H5M3` (`nucl_top.xml` のトポロジー名) を足す。
   ```
   <sidech value="C1' N1 C6 C2 O2 N3 H3 C4 O4 C5 C5A C7 H71 H72 H73 C5M 1H5M 2H5M 3H5M H5M1 H5M2 H5M3"/>
   ```
   水素も入れるのは、報告が「メチル基」で、水素付きの構造 (NMR など) では水素が残ると見た目で
   選ばれていないままになるため。リストはすでに `H3` を含んでいる。
2. 全 16 残基 (`Ar Cr Gr Td Ur H2U 1MA 2MG 5MC 5MU 7MG M2G OMC OMG PSU YYG`) の `mainch`:
   `O1P O2P` の後に `OP1 OP2 OP3` を足す (旧名は残す)。

## 4. テスト

gtest 1 件 (`src/tests/modules/molstr/`、既存の `test_selcommand.cpp` か新しいファイル)。
PDB v3 の原子名で書いた DT 残基 1 つ (リン酸、糖、塩基、メチル基 `C7`) を PDB テキストから読み込み、
次を確かめる。

- `bysidech (*)` に `C7` が入り、`OP1` は入らない。
- `bymainch (*)` に `OP1` と `OP2` が入り、`C7` は入らない。

テストの環境だけでは `nucl_props.xml` は読まれない。`test_molstr` はソースツリーの
`data/sysconfig.xml` を使い、`%%CONFDIR%%` がそのファイルのある `data/` になるので、設定の
`%%CONFDIR%%/data/nucl_props.xml` は存在しない `data/data/nucl_props.xml` を指す (CI のログにも
`no mol topology/parameter files is loaded` が出ている)。そこでテストの中で、`CUEMOL2_SYSCONFIG_PATH`
と同じディレクトリの `nucl_top.xml`、`nucl_props.xml` をこの順に `TopparManager::readPrmTop(path, "xml")`
で読み、両方の成功を確かめてから DT 残基を読み込む。こうすれば、変更したリストそのものを検証できる。
旧名 (`C5A`、`C5M`、`O1P`) は今もリストにあるので、別のケースは足さない (同じ経路の値違いになる)。

## 5. 確認

- `task run_gtest` が通る。
- GUI で DNA の構造 (例: PDB `1BNA`、mmCIF で開く) を読み、`bysidech (resn DT)` でメチル基が選ばれ、
  `bymainch (*)` でリン酸の酸素が選ばれることを目で確かめる。

## 6. 対象外

- 核酸の塩基のほかの水素 (`H8`、`H2`、`H6`、`H5`、`H1'` など) や、糖・主鎖の水素の多くは、
  今もリストにない。これは残基ごとにまちまちな既存の状態で、報告とは別の問題として扱う
  (必要なら、水素を含めた核酸のリスト全体の見直しを別の plan にする)。
- 修飾ヌクレオチド (`1MA`、`2MG`、`5MC`、`7MG`、`M2G` など) の側鎖の原子名が、Chemical Component
  Dictionary の今の名前と合っているかは確かめていない。`mainch` に `OP1 OP2 OP3` を足すだけにする。
- 判定で別名を引く B 案。
