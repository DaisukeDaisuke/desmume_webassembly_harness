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
export_path = 'harness/exports'
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
- `start_analyze`: 新しいlane専用。`state_path` または `save_path` のどちらか一方を受け、Chrome起動、ROM読込、State/Save読込、analysis baseline作成まで行う。既存laneには使用せず`restart_analyze`を使う。初回起動失敗だけはfresh Chromeから最大3回まで再試行する。
- `restart_analyze`: 既存laneのChromeウインドウを使い回し、State/Saveを差し替えてanalysis baselineを作り直す。`isolation_id`省略は既存laneが1個だけの場合に限る。閉じられた／クラッシュしたChromeは復活させない。
- `list_instances`: 現在MCPプロセスが保持しているlaneとalive/dead状態を最大64件返す。Chromeを新規作成しない。
- `list_commands`: 実行中ページの`DesmumeMCP.list()`を読む。既定は名前だけ64件、最大64件でページングし、description要求時も各160文字までに制限して巨大なAPI一覧を一度に返さない。
- `load_state_file`: 既存laneへローカルStateを投入する。新しいChromeは作らない。
- `load_save_file`: 既存laneへローカルSaveを投入する。新しいChromeは作らない。
- `export_state_file`: 現在Stateを`export_path`へ保存する。State本文はMCP出力へ返さない。
- `export_save_file`: 現在Saveを`export_path`へ保存する。Save本文はMCP出力へ返さない。
- `status`: 現在のDeSmuME状態を取得する。
- `direct_status`: WebMCP transportを挟まずdocumented browser APIから現在のDeSmuME statusを直接取得する。
- `analysis_context`: チャットを跨いで作業を再開するため、ブラウザ／エミュレータからその場で取得した小さい状況要約を返す。Harness内部のState pathやscript source pathには依存せず、配列も上限付きにする。
- `pause`: エミュレータを停止する。
- `resume`: エミュレータを再開する。
- `call`: 任意のDeSmuME commandを呼ぶ。
- `micro_macro_list`: このharnessプロセス内に登録済みのマイクロマクロID、step数、総wait時間を返す。
- `micro_macro_get`: 指定IDのマイクロマクロJSONを返す。
- `micro_macro_exec`: AIが決めたIDとsteps JSONを渡して登録/上書きし、その場で実行する。steps省略時は登録済みIDを再実行する。各stepは`wait_ms`待機後、`tool`で指定したharnessのトップレベルMCP toolを通常の単独呼び出しと同じhandler経路で呼ぶ。
- `eval`: `desmume.eval` 相当のisolated JavaScriptを実行する。
- `rerun_script`: UTF-8 JavaScriptファイルを読み、`desmume.runScript` 相当で実行する。
- `rerun_pscript`: Persistent Scriptのsourceをeditorへ読み込み、直接`runLoadedPersistentScript`を実行する。同名更新の停止・script-only trap解放はページ本体のupdate経路へ任せる。
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
- `inject_bytes_file`: 絶対パスのローカルファイルを最大1MiBまで読み、指定開始アドレスへそのままバイト注入する。
- `close_instance`: isolation idに対応するChrome/DeSmuMEを閉じる。
- `close_all_sessions`: このstdio MCPプロセスが管理している全Chrome/DeSmuME laneを閉じる。通常の`Browser.close`後も子Chromeが残っていればkill fallbackを行う。
`start_analyze`だけが新しいChrome laneを作成します。`status`、`call`、`analysis_context`、script操作、screenshotなど他のtoolへ存在しない`isolation_id`を渡してもChromeは作られずエラーになります。
同じ`isolation_id`の`start_analyze`がすでに進行中の場合も、二重起動せず直ちにエラーにします。
`start_analyze`以外は`isolation_id`を省略したとき既存laneが1個ならそれを使い、複数laneがある場合は明示指定を要求します。
## マイクロマクロ
`micro_macro_exec`はDeSmuMEページ内command専用のbatchではなく、`call`、`resume`、`rerun_pscript`、`call_pscript_mcp`、`load_state_file`などharnessが公開しているトップレベルMCP toolそのものを短い待機付き手順へまとめます。マクロはstdio MCPプロセス内メモリに保持され、AIが任意のIDを決めます。
```json
{
  "id": "battle-turn-flow",
  "isolation_id": "lane-a",
  "steps": [
    {
      "wait_ms": 0,
      "tool": "call_pscript_mcp",
      "arguments": { "name": "queue_defend", "params": {} }
    },
    {
      "wait_ms": 120,
      "tool": "resume",
      "arguments": {}
    }
  ]
}
```
`wait_ms`はそのstepを呼ぶ直前の待機です。`tool`は内部名の`resume`/`call_pscript_mcp`だけでなく、AIから実際に見える`desmume_harness__resume`/`desmume_harness__call_pscript_mcp`形式も受け付けます。解決時はharnessの`TOOLS`一覧を総当たりし、完全一致を優先したうえで`__<tool name>`の後方一致を一意に解決して内部名へ正規化します。`micro_macro_exec`側へ`isolation_id`を指定すると、各stepの対象toolが`isolation_id`を受け取り、step自身に指定がない場合だけ継承します。stepに明示した`isolation_id`は上書きしません。初回は`steps`付きで登録・実行し、以後は`{ "id": "battle-turn-flow", "isolation_id": "lane-a" }`だけで同じ手順を再実行できます。`micro_macro_list`と`micro_macro_get`は実行せず保存内容だけを確認します。マイクロマクロから別の`micro_macro_*`を呼ぶ再帰実行は行いません。
## start_analyze
新しい `isolation_id` では最初に `start_analyze` を呼びます。`state_path` と `save_path` は排他的で、必ずどちらか一方を指定します。既存laneの再利用は`restart_analyze`で行い、`start_analyze`へ既存`isolation_id`を渡すとエラーにします。
```text
start_analyze { isolation_id: "lane-a", state_path: "C:\\dq9\\states\\battle-a.dst" }
```
1. isolation id 専用Chrome profileと自動割当DevTools portでChromeを起動する。
2. Chromeを `--enable-features=WebMCPTesting,DevToolsWebMCPSupport` 付きで起動し、DeSmuMEのWebMCP登録完了を待つ。
3. `harness.toml` のROMをfile inputへローカル投入し、file transaction完了まで待つ。
4. ROM投入後に `romLoaded=true` だけでなく `running=true` / `paused=false` まで待つ。Service Workerやruntime初期化失敗などでrunningへ到達しない場合、そのlaneを閉じ、500ms後に新しいChromeから開始処理全体をやり直す。
5. `state_path` の場合はStateを `State In` へ、`save_path` の場合はSaveを `Save In` へ投入し、対応するfile transaction完了まで待つ。
6. 読込直後の状態を `saveAnalysisBaseline` で保存する。baseline作成のために余計なframeは進めない。
7. `{ status: "ok", paused, running }` だけを返す。UI snapshot、full status、`snapshotContext` は返さず、必要な場合は専用toolを別途呼ぶ。

既存laneを別State/Saveからやり直す場合は、まず`list_instances`でlaneを確認して`restart_analyze`を呼びます。既存laneが1個だけなら`isolation_id`は省略できます。ユーザーがChromeを閉じた、またはChromeがクラッシュしたlaneはdeadとして扱い、自動的に新しいChromeへ差し替えません。

## チャットを跨いで作業を再開する
`analysis_context` は再開に必要な情報だけをブラウザAPIから毎回取得して小さく返します。通常はbreakpoint一覧も省略し、必要な場合だけ `include_breakpoints: true` を指定します。call stack、disassembly、script source、ローカルState path、console全文は自動では含めません。baselineとrunning scriptは各16件、明示要求したbreakpointも128件までです。

返す主な情報はROM load状態、`paused` / `running` / `frame`、現在CPUと主要register、trace/IRQ方針、最新`break`、ブラウザ側recent file一覧、analysis baseline一覧、起動中Persistent Scriptです。Harnessが過去に覚えたpathを正本にはしません。

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

## State / Save export
`export_state_file`と`export_save_file`はブラウザAPIの通常のdownloadをCDPで専用一時ディレクトリへ受け、完了後に`harness.toml`の`export_path`へ移します。本文byte列やdata URLはstdio MCPへ返さず、`path`と`bytes`だけを返します。`name`を省略すると`state-000001.dst`または`save-000001.sav`のようにlaneごとに採番します。
## WebMCP transport
Chrome内部ではDeSmuMEページが登録したWebMCPを使用しますが、生の `desmume.call`、`desmume.eval`、`desmume.runScript` tool objectをCodex側へ再公開しません。stdio MCP側では用途別のtoolとして隠蔽します。
- `call` / `pause` / `resume` / `status` は内部で `desmume.call` を使う。
- `eval` は内部で `desmume.eval` を使う。
- `rerun_script` は内部で `desmume.runScript` を使う。
- `screenshot` はPNG bytesを保存する必要があるため、内部のdocumented `takeScreenshot({download:false,includeDataUrl:true})` を直接使い、data URLはstdio MCPへ漏らさない。
- Persistent Script管理、file transaction serial監視、baseline管理など、structured resultを機械判定する内部処理はDeSmuMEのdocumented browser APIを直接使う。
WebMCP実行系が返す `status: "Completed"` のようなtransport wrapperはstdio MCPの外へ出しません。実際のDeSmuME出力だけを返します。
## Chromeウインドウ
Chrome起動時は最小化起動を使いません。AI操作前にはCDPのwindow stateを確認し、最小化されていれば`normal`へ戻してから操作します。`Page.bringToFront`は呼ばないため、長時間の自動操作がOSのキーボードフォーカスを継続的に奪う動作にはしません。またChromeはbackground timer/renderer/occluded-window throttlingを無効化して起動し、背面化によるエミュレータ停止を避けます。
## ARMv5T assembly preprocessor
`src/armv5t-assembly-preprocessor.js` は従来の `armv5tAssemblyPlayground/assembly.php` の変換規則をNode.jsへ移植したものです。`#!` origin、label、`.addr`、`.addr4`、`BL/bl FUN_xxxxxxxx`、`.ltorg` のアドレス計数規則を維持し、`preprocessAssemblySource(source, initialBaseAddress)` を公開します。`local-mcp-chatgpt-tunnel` 側のsandboxed `buildv5tassembly` MCPから、このモジュールを絶対パスで固定指定して利用できます。
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
1. `Load source` file inputを現在DOMから直接解決してローカルUTF-8 sourceを投入する。UI snapshotは取得も返却もしない。
2. textareaの改行正規化（CRLF/CR→LF）を考慮して、editorへsourceが反映されたことを確認する。
3. `runLoadedPersistentScript` を直接呼ぶ。同名scriptの置換はページ本体のupdate経路へ任せ、script-only breakpoint処理中でも通常の`stopScript`でpaused状態を固定しない。
`wait_for_registration=false` ならAPI_CURRENTの `started:true` 時点で返し、registration完了を待ちません。`startup_timeout_ms` はWorker/parser/compile/started handshakeだけに適用され、script bodyのtimeoutにはしません。
## UTF-8
`harness.toml` とローカルJavaScript sourceはUTF-8のみ受け付けます。UTF-16/UTF-32 BOMまたは不正UTF-8は実行前にエラーにします。
