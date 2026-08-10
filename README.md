# desmume_webassembly_harness
`desmume_webassembly/webassembly/API_CURRENT.md` の現行仕様専用の stdio MCP ハーネスです。Codex から DeSmuME WebAssembly を操作するために使います。人間が Node.js ライブラリとして手動オーケストレーションすることは主目的ではありません。
## Requirements
- Node.js 22+
- Google Chrome
- Codex CLI / Codex IDE extension / ChatGPT desktop app のローカル MCP 対応環境
- `harness.toml` に指定する ROM と State
追加 npm パッケージは使用しません。
## 設定
`harness.example.toml` を `harness.toml` にコピーし、ROM と State のローカルパスを設定します。Windows パスは TOML literal string としてシングルクォートで囲めます。
```toml
rom_path = 'C:\dq9\rom.nds'
state_path = 'C:\dq9\baseline.dst'
baseline_name = 'battle-start'
```
`harness.toml` と Chrome の分離プロファイル `.harness/` は Git 対象外です。
## Codex へ追加する
このハーネスは `src/mcpMain.js` を stdio MCP サーバーとして起動します。Codex は STDIO MCP をローカルプロセスとして起動でき、`command`、`args`、`cwd` を `config.toml` に設定できます。
### Codex CLIから追加
このリポジトリのパスが `C:\Users\owner\Documents\desmume_webassembly_harness` の場合:
```text
codex mcp add desmume_harness -- node C:\Users\owner\Documents\desmume_webassembly_harness\src\mcpMain.js C:\Users\owner\Documents\desmume_webassembly_harness\harness.toml
```
登録後は次で確認できます。
```text
codex mcp list
```
Codex TUI 内では `/mcp` で接続状態を確認できます。
### config.tomlへ直接追加
ユーザー全体では `~/.codex/config.toml`、trusted project 単位では `.codex/config.toml` に追加できます。
```toml
[mcp_servers.desmume_harness]
command = "node"
args = ["C:\\Users\\owner\\Documents\\desmume_webassembly_harness\\src\\mcpMain.js", "C:\\Users\\owner\\Documents\\desmume_webassembly_harness\\harness.toml"]
cwd = "C:\\Users\\owner\\Documents\\desmume_webassembly_harness"
startup_timeout_sec = 30
tool_timeout_sec = 600
```
## Codexから見えるMCP tools
- `start_analyze`: Chrome起動、初回snapshot、ROM読込、再snapshot、State読込、analysis baseline作成まで行う。
- `status`: 現在のDeSmuME状態を取得する。
- `pause`: エミュレータを停止する。
- `resume`: エミュレータを再開する。
- `call`: 任意のDeSmuME commandを呼ぶ。
- `eval`: `desmume.eval` 相当のisolated JavaScriptを実行する。
- `rerun_script`: UTF-8 JavaScriptファイルを読み、`desmume.runScript` 相当で実行する。
- `rerun_pscript`: Persistent Scriptのsourceを読み込み、同名scriptがあれば停止してから直接 `runLoadedPersistentScript` を実行する。
- `stop_pscript`: Persistent Scriptを停止する。
- `restart_pscript`: Persistent Scriptを再起動する。
- `snapshot_elements`: 現在の操作要素と位置を取得する。
- `save_baseline`: analysis baselineを保存する。
- `restore_baseline`: analysis baselineを復元する。
- `list_pscript_mcp`: Persistent Scriptが公開したMCP一覧を取得する。
- `call_pscript_mcp`: Persistent Script MCPを呼ぶ。
- `close_instance`: isolation idに対応するChrome/DeSmuMEを閉じる。
## start_analyze
新しい `isolation_id` では原則として最初に `start_analyze` を呼びます。処理順は以下です。
1. isolation id 専用Chrome profileと自動割当DevTools portでChromeを起動する。
2. Chromeを `--enable-features=WebMCPTesting,DevToolsWebMCPSupport` 付きで起動し、DeSmuMEのWebMCP登録完了を待つ。
3. 現在の操作要素と位置をsnapshotする。
4. `harness.toml` のROMをfile inputへローカル投入し、file transaction完了まで待つ。
5. ROM読込後の操作要素を再snapshotする。
6. `harness.toml` のStateをfile inputへローカル投入し、`stateLoadSerial` 増加とfile transaction完了まで待つ。
7. State読込直後の状態を `saveAnalysisBaseline` で保存する。baseline作成のために余計なframeは進めない。
8. `snapshotContext` を取得して返す。
## 複数エミュレータ
すべての主要toolは `isolation_id` を受け取ります。異なる `isolation_id` は別Chrome profileと別DevTools portを使用するため、同じstdio MCPプロセスから複数DeSmuMEを同時に保持できます。
```text
start_analyze { isolation_id: "lane-a" }
start_analyze { isolation_id: "lane-b" }
```
`harness.toml` の `[instances.<id>]` でROM、State、baseline名をlane単位に上書きできます。
```toml
[instances.lane-a]
baseline_name = 'battle-a'
[instances.lane-b]
baseline_name = 'battle-b'
```
## WebMCP transport
Chrome内部ではDeSmuMEページが登録したWebMCPを使用しますが、生の `desmume.call`、`desmume.eval`、`desmume.runScript` tool objectをCodex側へ再公開しません。stdio MCP側では用途別のtoolとして隠蔽します。
- `call` / `pause` / `resume` / `status` は内部で `desmume.call` を使う。
- `eval` は内部で `desmume.eval` を使う。
- `rerun_script` は内部で `desmume.runScript` を使う。
- Persistent Script管理、file transaction serial監視、baseline管理など、structured resultを機械判定する内部処理はDeSmuMEのdocumented browser APIを直接使う。
WebMCP実行系が返す `status: "Completed"` のようなtransport wrapperはstdio MCPの外へ出しません。実際のDeSmuME出力だけを返します。
## MCP output
DeSmuMEのobject結果をJSON文字列へ変換してさらにJSON-RPCへ詰める二重JSONは避けます。stdio MCPの `structuredContent` には実際のobjectをそのまま置き、`content` はDeSmuME本体の `compactOutputText` と同じflatten方式の短いtextを返します。内側WebMCPがすでに `content` / `structuredContent` を返した場合も不要な再ラップをしません。
例として `{ ok: true, paused: true, frame: 42 }` はtext側では次の形になります。
```text
ok=true
paused=true
frame=42
```
## Persistent Scripts
`rerun_pscript` は固定UIDや `Run / Update` のclickを使用しません。
1. 明示 `name` と同名のrunning scriptがあれば `listScripts` からidを解決して `stopScript` する。
2. 最新ページ状態から `Load source` file inputを解決してローカルUTF-8 sourceを投入する。
3. editorへsourceが反映されたことを確認する。
4. `runLoadedPersistentScript` を直接呼ぶ。
`wait_for_registration=false` ならAPI_CURRENTの `started:true` 時点で返し、registration完了を待ちません。`startup_timeout_ms` はWorker/parser/compile/started handshakeだけに適用され、script bodyのtimeoutにはしません。
## UTF-8
`harness.toml` とローカルJavaScript sourceはUTF-8のみ受け付けます。UTF-16/UTF-32 BOMまたは不正UTF-8は実行前にエラーにします。
