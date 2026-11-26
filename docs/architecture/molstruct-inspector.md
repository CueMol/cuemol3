# Mol Struct の Properties (chain / residue / atom の inspector)

Mol Struct pane の Properties ボタンで、選んだ chain・residue・atom の値を inspector に読み取り専用で
出す。UXP の同じボタンは handler が空 (`molstruct-panel.js` `onBtnPropCmd`) だったので、tritium で
足した機能。

## 開き方

- Properties は tree の行が**ちょうど 1 つ**選ばれているときだけ押せ、その行を開く
  (`MolStructPane.tsx`)。0 行・複数行では押せない。anchor (`anchorId`) は使わない: Cmd/Ctrl+クリックで
  選択から外した行や Shift+クリックの範囲の始点に残り、選ばれていない行を開いてしまうため。
- inspector の target は `{ kind: 'molStruct', sceneId, molId, part }`
  (`state/inspector/InspectorProvider.tsx`)。`part` (`MolStructRef`、`worker/shared/molStructInfo.ts`) は
  tree の id を `decodeMolTreeId` で分けたもの。chain / residue / atom には uid が無いので、分子の uid と
  部分の名前で引く。

## 表示する値

worker の `getMolStructInfo` (`services/select/getMolStructure.ts`) が読み、`MolStructInspector.tsx` が
整形する。読むだけなので undo txn も op も無い。

| 対象 | 値 |
|---|---|
| Chain | 名前、残基数、残基番号の範囲 (先頭 - 末尾) |
| Residue | Chain、番号 (挿入コード込み)、残基名、原子数、二次構造 |
| Atom | 原子名、元素、残基、altloc (あれば)、座標、B-factor、occupancy、CueMol の原子 ID |

- Chain の原子数は出さない。数える C++ API が無く、MD の水の chain では全残基を回すことになる。
- 二次構造は残基の文字列 property `secondary` (`helix` / `sheet`) と `secondary2` (先頭の H / G / I / E が
  らせんの種類と strand) から出す。PDB / mmCIF の reader と二次構造の再計算 (`Prot2ndry`) が書く。
  script から読めるよう `MolResidue.qif` に `getPropStr(name)` (無ければ空文字列) を足した。
  `secondary` が無い残基は、CA 原子があれば Coil (renderer の描き方と同じ)、無ければ `-`。
- 原子 ID は CueMol 内部の ID で、ファイルの serial number ではない。

## 更新と消滅

ページは scene の object event (`SEM_OBJECT`) で取り直す (編集、undo / redo)。分子や部分が無くなると
service が `not-found` を返し、`onGone` -> `clearMolStruct` で inspector を空に戻す (camera inspector と
同じ形)。
