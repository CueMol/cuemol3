# 主鎖・側鎖の選択 (`bymainch` / `bysidech`)

selection 文法の `bymainch X` / `bysidech X` は、`X` に含まれる原子のうち、残基のトポロジーで
主鎖 / 側鎖と定義された原子名を持つものを選ぶ。

## 判定

- 実装: `SelOpNode::chkMainSideChainNode` (`src/modules/molstr/SelAroundImpl.cpp`) が、残基の
  `ResiToppar::isMainCh` / `isSideCh` (`src/modules/molstr/ResiToppar.cpp`) を呼ぶ。
- 原子名と、トポロジーの `mainch` / `sidech` リストの**完全一致**で判定する。トポロジーの
  alias (原子名の別名) は解決しない。そのため、同じ原子の表記ゆれ (PDB v2 / v3、mmCIF、CNS など) は
  リストに全て並べる。
- **リストが無い残基の原子は、どちらにも選ばれない。** 主鎖・側鎖のリストを持つのは
  `data/prot_props.xml` (アミノ酸) と `data/nucl_props.xml` (核酸) だけで、水・イオン・
  `data/mono_top.xml` の低分子などは `bymainch` でも `bysidech` でも選ばれない。トポロジーが無い残基も
  同じ。
  - 以前は `isMainCh` だけが「リストが無ければ全原子が主鎖」で、`bymainch (*)` が水を選んでいた。
    `isSideCh` と揃えて、何も選ばないようにした。

## 核酸のリストに含める原子名

`data/nucl_props.xml` の各残基では、次の表記ゆれを並べている。

| 原子 | 原子名 |
|---|---|
| チミンのメチル炭素 (`Td` の sidech) | `C7` (PDB v3 / mmCIF)、`C5M` (PDB v2)、`C5A` (CNS) |
| メチル水素 (同上) | `H71 H72 H73`、`H5M1 H5M2 H5M3`、`1H5M 2H5M 3H5M` (旧 PDB。reader は先頭の数字を末尾に移さない) |
| リン酸の酸素 (全 16 残基の mainch) | `O1P O2P` (旧)、`OP1 OP2 OP3` (PDB v3 / mmCIF) |

テスト: `src/tests/modules/molstr/test_nucl_sidech_mainch.cpp` (v3 名の DT 残基と水 1 つで、
メチル炭素・リン酸酸素の振り分けと、水がどちらにも入らないことを確認)。
