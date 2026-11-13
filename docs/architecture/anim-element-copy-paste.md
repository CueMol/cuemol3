# Animation element の copy / paste

tritium/react-gui の Animation panel で、element を Edit > Cut / Copy / Paste
(Cmd+X / C / V) で複製できる。貼った element は、時間軸の上で自動的に後ろに並ぶ。

UXP には element の copy / paste は無い (`anim-panel.js` にあるのは上下の移動だけ)。
そのため、これは tritium で追加した機能として扱う。

## 操作

- Animation panel にフォーカスがあるとき、Edit メニューと Cmd+X / C / V が panel に届く
  (`useClipboardScope('anim-strip', ...)` と、panel の root にある `data-clipboard-scope`)。
- **Copy**: 選んでいる element を OS の clipboard に書く。選択が無ければ何もしない。
- **Cut**: Copy が成功してから、その element を削除する (Camera pane と同じ)。
- **Paste**: clipboard の中身が animation element のときだけ貼る。貼る位置は、選んでいる
  element の直後。選択が無ければ末尾に貼る (Add と同じ規則)。貼った element を選択するので、
  続けて Cmd+V を押すと、その直後に次々と並ぶ。
- toolbar にボタンは無い。Edit メニューとキーボードだけで操作する。
- Scene tree の Paste は、animation element の clipboard を無視する。

## 貼るときに worker がすること

`worker/server/services/anim/edit.ts` の `pasteElement`。

- **名前**: 同じ名前の element が既にあれば、末尾の数字を外した名前に `uniqueElementName`
  で番号を付け直す (例: `Spin0` を貼ると `Spin1`)。
- **時間**: element の長さ (end - start) はそのまま残す。そのうえで、貼る位置の直前にある
  element に chain し直す (`timeRefName` = 直前の element、start の delay は 0)。
  これで、貼った element は直前の element が終わった直後から始まる。
  - chain できないとき (直前の element の chain が壊れている、など) は絶対時刻にし、
    直前の element の終わりから始める。直前が無ければ 0 から始める。終わりの時刻は、
    panel の表示と同じ取り方 (`read.ts` の `readElement`) で読む。
  - 元の element の chain 先は引き継がない。別の scene に貼ったときや、chain 先が
    無いときに壊れないようにするため。
- **開始カメラ**: Add と同じく、txn の外で `ensureStartCam` を呼ぶ。開始カメラがまだ
  無ければ、今の view を `__current` に保存して開始カメラにする。既に指定されている
  開始カメラは変えない。これが無いと、animation の無い scene に spin などを貼ったとき、
  scrub のたびにその時点の view が基準になり、同じ時刻でも姿勢が変わってしまう。
- **undo**: 1 回の paste が 1 つの undo txn になる。label は `Paste animation element`。
- **対象**: 対象の object や renderer は名前で持っている。別の scene に貼って、その名前の
  対象が無ければ、貼った element は対象の無い状態になる。これは Inspector で直す
  (Add と同じ扱い)。

## action log / console / MCP

op `paste_node` が animation element も扱う (`kind: 'anim'`)。引数 `before` (element の
指定。`list_anims` の番号、`#uid`、または名前) を渡すと、その element の前に
貼る。省略すると末尾に貼る。panel から貼ったときも、この形で txn の中で記録される。

## clipboard の形式

- `ClipKind` (`shared/cuemolClipboard.ts`) の `anim`。
- CueMol2 にはこれに当たる clipboard の形式が無いので、どの platform でも text の
  envelope (Format B、[os-clipboard-interop.md](os-clipboard-interop.md)) だけで書く。
  `legacyFormatFor('anim', ...)` は `null` を返し、main (`main/cuemolClipboard.ts`) は
  それを見て envelope を書く。
- 中身は AnimObj を `StreamManager.toXML` で書いた XML。

## C++: AnimObj の XML 化

- `SceneXMLWriter::toByteArray` は AnimObj を受け付ける。top の tag は `motion` で、
  `setTypeNameByObj` と `writeTo2` で書く。qsc の中の `<motion>` 要素 (`AnimMgr::writeTo2`)
  と同じ形になる。
- `SceneXMLReader::fromByteArray` は、tag が `motion` のとき
  `createObjByTypeNameT<AnimObj>()` と `readFrom2` で AnimObj を作る。
- `StreamManager.toXML` / `fromXML` の API は変えていない。
- 時間は XML の中ではミリ秒で書かれる (AnimObj 自体はナノ秒の `time_value`)。

## テスト

- gtest `AnimObjXML.RoundTripKeepsClassAndProperties`
  (`src/tests/modules/anim/test_animobj_xml.cpp`): toXML -> fromXML で class、名前、
  時間、型ごとの property (SimpleSpin の `angle`) が戻る。
- vitest `animationService.test.ts` の `anim pasteElement`: 名前の付け直し、長さを保った
  chain、chain できないときの絶対時刻、txn と記録。
- vitest `shared/cuemolClipboard.test.ts`: `anim` は envelope だけで書かれ、読み戻せる。
