# desmume_webassembly_harness
`desmume_webassembly/webassembly/API_CURRENT.md` の現行仕様専用の stdio MCP ハーネスです。Codex から DeSmuME WebAssembly を操作するために使います。人間が Node.js ライブラリとして手動オーケストレーションすることは主目的ではありません。
## Requirements
- Node.js 22+
- Google Chrome
- Codex CLI / Codex IDE extension / ChatGPT desktop app のローカル MCP 対応環境
- `harness.toml` に指定する ROM とスクリーンショット保存先、`start_analyze` 呼び出し時に指定する State
追加 npm パッケージは使用しません。
## 設定
`harness.example.toml` を `harness.toml` にコピーし、ROM とスクリーンショット保存先を設定します。State は設定ファイルには置かず、`start_analyze` の呼び出しごとに外部指定します。Windows パスは TOML literal string としてシングルクォートで囲めます。
```toml
rom_path = 'C:\dq9\rom.nds'
screenshot_path = 'harness/screenshots'
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
tool_output_token_limit = 1000000
```
## Codexから見えるMCP tools
- `start_analyze`: `state_path` を引数で受け、Chrome起動または既存lane再利用、初回snapshot、ROM読込、再snapshot、State読込、analysis baseline作成まで行う。
- `status`: 現在のDeSmuME状態を取得する。
- `direct_status`: WebMCP transportを挟まずdocumented browser APIから現在のDeSmuME statusを直接取得する。
- `analysis_context`: チャットを跨いで作業を再開するための小さい状況要約を返す。State/baseline、pause/run、frame、ARM9 PC/CPSR、最新break、起動中Persistent Scriptだけを含み、call stackやdisassemblyは含めない。
- `pause`: エミュレータを停止する。
- `resume`: エミュレータを再開する。
- `call`: 任意のDeSmuME commandを呼ぶ。
- `eval`: `desmume.eval` 相当のisolated JavaScriptを実行する。
- `rerun_script`: UTF-8 JavaScriptファイルを読み、`desmume.runScript` 相当で実行する。
- `rerun_pscript`: Persistent Scriptのsourceを読み込み、同名scriptがあれば停止してから直接 `runLoadedPersistentScript` を実行する。
- `rerun_pscript_console`: Persistent Scriptを読み込み・起動し、そのscriptの最新 `print(...)` 出力まで1回のMCP callで返す。
- `script_console`: 起動中Persistent Scriptの `script_id` を指定して最新 `print(...)` / `printf(...)` 出力だけをdirect `listScriptPrint` で取得する。
- `stop_pscript`: Persistent Scriptを停止する。
- `restart_pscript`: Persistent Scriptを再起動する。
- `snapshot_elements`: 現在の操作要素と位置を取得する。
- `screenshot`: DeSmuMEの256x384フレームバッファだけをPNG化し、`screenshot_path` ディレクトリへ新しいPNGとして保存する。ブラウザウインドウ全体は撮らない。`name` は任意。
- `save_baseline`: analysis baselineを保存する。
- `restore_baseline`: analysis baselineを復元する。
- `list_pscript_mcp`: Persistent Scriptが公開したMCP一覧を取得する。
- `call_pscript_mcp`: Persistent Script MCPを呼ぶ。
- `close_instance`: isolation idに対応するChrome/DeSmuMEを閉じる。
## start_analyze
新しい `isolation_id` では原則として最初に `start_analyze` を呼びます。`state_path` は必須引数です。同じ `isolation_id` で別の `state_path` を指定して再度呼んでも、stdio MCPやChromeプロセス自体は再起動せず既存laneを再利用します。処理順は以下です。
```text
start_analyze { isolation_id: "lane-a", state_path: "C:\\dq9\\states\\battle-a.dst" }
```
1. isolation id 専用Chrome profileと自動割当DevTools portでChromeを起動する。
2. Chromeを `--enable-features=WebMCPTesting,DevToolsWebMCPSupport` 付きで起動し、DeSmuMEのWebMCP登録完了を待つ。
3. 現在の操作要素と位置をsnapshotする。
4. `harness.toml` のROMをfile inputへローカル投入し、file transaction完了まで待つ。
5. ROM読込後の操作要素を再snapshotする。
6. 呼び出し引数 `state_path` のStateをfile inputへローカル投入し、`stateLoadSerial` 増加とfile transaction完了まで待つ。
7. State読込直後の状態を `saveAnalysisBaseline` で保存する。baseline作成のために余計なframeは進めない。
8. `snapshotContext` を取得して返す。

## チャットを跨いで作業を再開する
`analysis_context` は再開に必要な情報だけを小さく返します。通常はbreakpoint一覧も省略し、必要な場合だけ `include_breakpoints: true` を指定します。call stack、disassembly、script source、console全文は自動では含めません。

返す主な情報は `stateName` / `statePath` / `baselineName` / `baselinePresent` / `paused` / `running` / `frame` / ARM9 `pc` / `cpsr` / 最新 `break` / 起動中 `scripts` です。Harness経由で起動したPersistent Scriptには把握できる場合 `sourcePath` も付きます。

`direct_status` はDeSmuMEのdocumented `status` commandをbrowser API bridgeから直接呼びます。WebMCP transport wrapperを経由した `status` が不要な内部・機械処理向けです。

## Persistent Scriptの最短console取得
`overlay_jp.js` のように `print(...)` を使うPersistent Scriptでは、`rerun_pscript_console` を使うとローカルsource読込、direct `runPersistentScript`、direct `listScriptPrint` を1回のstdio MCP callにまとめられます。Persistent Scripts editorや巨大なUI snapshotは経由しません。

以後のconsole取得は `analysis_context` に出る `script_id` を `script_console` に渡せば、scriptを再実行せずdirect `listScriptPrint` 1回だけで取得できます。
## 複数エミュレータ
すべての主要toolは `isolation_id` を受け取ります。異なる `isolation_id` は別Chrome profileと別DevTools portを使用するため、同じstdio MCPプロセスから複数DeSmuMEを同時に保持できます。
```text
start_analyze { isolation_id: "lane-a", state_path: "C:\\dq9\\states\\a.dst" }
start_analyze { isolation_id: "lane-b", state_path: "C:\\dq9\\states\\b.dst" }
```
`harness.toml` の `[instances.<id>]` でROM、スクリーンショット保存先、baseline名をlane単位に上書きできます。Stateは常に `start_analyze` 引数です。
```toml
[instances.lane-a]
baseline_name = 'battle-a'
screenshot_path = 'harness/screenshots/lane-a'
[instances.lane-b]
baseline_name = 'battle-b'
screenshot_path = 'harness/screenshots/lane-b'
```
## フレームスクリーンショット
`screenshot` はブラウザやChromeウインドウのキャプチャではなく、DeSmuME本体の `takeScreenshot` が `ui.screen.toDataURL()` で生成する256x384のDSキャンバスPNGだけを保存します。`screenshot_path` は保存ディレクトリで、デフォルトはCodex sandboxから参照しやすい `harness/screenshots` です。呼び出し時に `name` を省略すると `frame-000001.png`, `frame-000002.png`, ... とlaneごとに自動採番し、`name: "battle-start"` のように指定すると `battle-start.png` として保存します。PNG本体のdata URLはMCP出力へ返しません。MCPの返り値 `path` は保存したPNGの絶対パスです。

State読込直後はAPI_CURRENTの仕様上、1つのcomplete emulator frameが進むまで画面capture APIが `SCREEN_INVALID` になります。`start_analyze` は読み込んだStateを厳密に保つため勝手に1フレーム進めません。そのため必要なタイミングでフレームを進めた後に `screenshot` を呼びます。
## WebMCP transport
Chrome内部ではDeSmuMEページが登録したWebMCPを使用しますが、生の `desmume.call`、`desmume.eval`、`desmume.runScript` tool objectをCodex側へ再公開しません。stdio MCP側では用途別のtoolとして隠蔽します。
- `call` / `pause` / `resume` / `status` は内部で `desmume.call` を使う。
- `eval` は内部で `desmume.eval` を使う。
- `rerun_script` は内部で `desmume.runScript` を使う。
- `screenshot` はPNG bytesを保存する必要があるため、内部のdocumented `takeScreenshot({download:false,includeDataUrl:true})` を直接使い、data URLはstdio MCPへ漏らさない。
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
