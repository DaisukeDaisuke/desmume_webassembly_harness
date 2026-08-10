# desmume_webassembly_harness
`desmume_webassembly/webassembly/API_CURRENT.md` の現行仕様専用の Node.js ハーネスです。追加 npm パッケージは使わず、Node.js 22+ の標準 API と Chrome DevTools Protocol だけで動作します。
## 設定
`harness.example.toml` を `harness.toml` にコピーし、`rom_path` と `state_path` をローカルファイルへ設定します。Windows パスは TOML の literal string としてシングルクォートで囲めます。
```toml
rom_path = 'C:\dq9\rom.nds'
state_path = 'C:\dq9\baseline.dst'
baseline_name = 'battle-start'
```
`harness.toml` と Chrome の分離プロファイル `.harness/` は Git 対象外です。
## startAnalyze
`startAnalyze()` は次の順番を固定しています。
1. isolation id 専用 Chrome profile と自動割当 DevTools port で Chrome を起動する。
2. DeSmuME ページの `DesmumeMCP` が利用可能になるまで待つ。
3. 現在 DOM の操作要素と座標を snapshot し、固定 UID を使わず `ROM` file input を意味名で解決する。
4. TOML の ROM を `DOM.setFileInputFiles` でローカル投入し、`status.romLoaded` と `fileTransaction.active` を監視する。
5. ROM 読込後にもう一度要素 snapshot を取り直す。
6. `status.stateLoadSerial` を記録してから `State In` へ State を投入し、serial 増加と file transaction 完了を待つ。
7. State の直後に `saveAnalysisBaseline` を直接呼び、State から余計なフレームを進めず analysis baseline を保存する。
8. `snapshotContext` を返す。
```js
import { HarnessManager } from "./src/index.js";
const manager = new HarnessManager("./harness.toml");
const lane = await manager.create("lane-a");
const started = await lane.startAnalyze();
console.log(started.context);
```
## 複数エミュレータ
`HarnessManager` は isolation id ごとに別 Chrome profile と別 DevTools port を持ちます。同じ Node.js process から複数 lane を同時起動できます。
```js
const laneA = await manager.create("lane-a");
const laneB = await manager.create("lane-b");
await Promise.all([laneA.startAnalyze(), laneB.startAnalyze()]);
```
TOML の `[instances.<id>]` で ROM、State、baseline 名などを lane 単位に上書きできます。
## 主な API
`call(command, params)` は `window.DesmumeMCP.call()` の薄いラッパーです。`eval(script)` は現行 `eval` command、`rerunscript(path)` は UTF-8 のローカル JavaScript を読み `runScript` へ渡します。
`rerunPScript(path, asyncMode, name?)` は Persistent Scripts 用です。明示 name が既存なら `listScripts` から該当 id を見つけ `stopScript` で停止し、最新 snapshot を取り、`Load source` file input へローカルファイルを投入し、エディタへ UTF-8 source が反映されたことを確認してから `runLoadedPersistentScript` を直接呼びます。`Run / Update` ボタンの click、DOM click、座標操作は使いません。
```js
await lane.rerunPScript("C:\\scripts\\battle_observer.js", false, "battle_observer_mcp");
await lane.stopPscript("battle_observer_mcp");
await lane.restartPscript("battle_observer_mcp");
const directory = await lane.listPScriptMcp();
const result = await lane.callPScriptMcp("listActions", {}, {
  scriptName: "battle_observer_mcp",
  blocking: true,
  timeoutMs: 60000
});
```
`rerunPScript` の第4引数では `waitForRegistration`、`startupTimeoutMs`、CDP 側の `timeoutMs` を変更できます。`startupTimeoutMs` は API_CURRENT の定義どおり Worker/parser/compile/started handshake のみに使われ、top-level script body の timeout としては扱いません。
## UTF-8
TOML とローカル JavaScript source は UTF-8 のみ受け付けます。UTF-16/UTF-32 BOM または不正 UTF-8 は実行前にエラーにします。