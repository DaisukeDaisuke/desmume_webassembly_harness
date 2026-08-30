import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { createInterface } from "node:readline";
import { normalizeWebMcpExecution } from "../src/chrome-session.js";
import {
  inheritMicroMacroIsolation,
  McpHarnessServer,
  TOOLS,
  resolveMicroMacroToolName
} from "../src/mcpMain.js";

test("WebMCP execution transport wrapper is removed before harness results escape", () => {
  const output = { ok: true, paused: true, running: false };
  assert.equal(normalizeWebMcpExecution("desmume.call", { status: "Completed", output }), output);
  assert.throws(
    () => normalizeWebMcpExecution("desmume.call", { status: "Failed", output: "worker failed" }),
    /worker failed/u
  );
});

test("stdio MCP tool results expose compact text plus one structured object without JSON-string nesting", async () => {
  const harness = {
    config: { commandTimeoutMs: 600000, baselineName: "base", replaceBaseline: true },
    async status() {
      return { ok: true, paused: true, running: false, frame: 42 };
    }
  };
  const manager = {
    requireExisting(id) {
      assert.equal(id, "lane-a");
      return harness;
    },
    async closeAll() {}
  };
  const server = new McpHarnessServer({
    configPath: "harness.toml",
    managerFactory: () => manager
  });
  const reply = await server.handle({
    jsonrpc: "2.0",
    id: 7,
    method: "tools/call",
    params: {
      name: "status",
      arguments: { isolation_id: "lane-a" }
    }
  });
  assert.deepEqual(reply.result.structuredContent, { ok: true, paused: true, running: false, frame: 42 });
  assert.equal(reply.result.content[0].text, "ok=true\npaused=true\nrunning=false\nframe=42");
  assert.equal(reply.result.isError, false);
});

test("start_analyze forwards caller-supplied State and Save inputs to new lanes", async () => {
  const starts = [];
  const manager = {
    async startAnalyze(isolationId, input) {
      starts.push({ isolationId, input });
      return { ok: true, isolationId, ...input };
    },
    async closeAll() {}
  };
  const server = new McpHarnessServer({
    configPath: "harness.toml",
    managerFactory: () => manager
  });
  const stateReply = await server.handle({
    jsonrpc: "2.0",
    id: 11,
    method: "tools/call",
    params: { name: "start_analyze", arguments: { isolation_id: "lane-a", state_path: "C:\\states\\a.dst" } }
  });
  assert.equal(stateReply.result.structuredContent.statePath, "C:\\states\\a.dst");
  const saveReply = await server.handle({
    jsonrpc: "2.0",
    id: 12,
    method: "tools/call",
    params: { name: "start_analyze", arguments: { isolation_id: "lane-b", save_path: "C:\\saves\\a.sav" } }
  });
  assert.equal(saveReply.result.structuredContent.savePath, "C:\\saves\\a.sav");
  assert.deepEqual(starts, [
    { isolationId: "lane-a", input: { statePath: "C:\\states\\a.dst", savePath: undefined } },
    { isolationId: "lane-b", input: { statePath: undefined, savePath: "C:\\saves\\a.sav" } }
  ]);
});

test("existing-lane tools route through requireExisting and do not create a new lane", async () => {
  const calls = [];
  const harness = {
    async listCommands(options) {
      calls.push({ listCommands: options });
      return { complete: true, total: 1, returned: 1, nextOffset: null, commands: ["status"] };
    },
    async loadStateFile(filePath) {
      calls.push({ loadStateFile: filePath });
      return { ok: true, paused: true, running: false };
    },
    async loadSaveFile(filePath) {
      calls.push({ loadSaveFile: filePath });
      return { ok: true, paused: false, running: true };
    },
    async exportStateFile(name) {
      calls.push({ exportStateFile: name });
      return { ok: true, kind: "state", path: "C:\\exports\\state.dst", bytes: 4096 };
    },
    async exportSaveFile(name) {
      calls.push({ exportSaveFile: name });
      return { ok: true, kind: "save", path: "C:\\exports\\save.sav", bytes: 512 };
    }
  };
  const manager = {
    requireExisting(id) {
      calls.push({ requireExisting: id });
      return harness;
    },
    async restartAnalyze(id, input) {
      calls.push({ restartAnalyze: { id, input } });
      return { status: "ok", reusedWindow: true, paused: true, running: false };
    },
    listInstances() {
      calls.push("listInstances");
      return { total: 1, returned: 1, truncated: false, instances: [{ isolationId: "lane-a", alive: true }] };
    },
    async create() {
      throw new Error("create must not be called by existing-lane tools");
    },
    async closeAll() {}
  };
  const server = new McpHarnessServer({ configPath: "harness.toml", managerFactory: () => manager });
  const restarted = await server.handle({
    jsonrpc: "2.0",
    id: 31,
    method: "tools/call",
    params: { name: "restart_analyze", arguments: { state_path: "C:\\states\\next.dst" } }
  });
  assert.equal(restarted.result.structuredContent.reusedWindow, true);
  const listed = await server.handle({
    jsonrpc: "2.0",
    id: 32,
    method: "tools/call",
    params: { name: "list_instances", arguments: {} }
  });
  assert.equal(listed.result.structuredContent.instances[0].isolationId, "lane-a");
  const commands = await server.handle({
    jsonrpc: "2.0",
    id: 33,
    method: "tools/call",
    params: { name: "list_commands", arguments: { isolation_id: "lane-a", limit: 8 } }
  });
  assert.deepEqual(commands.result.structuredContent.commands, ["status"]);
  await server.handle({
    jsonrpc: "2.0",
    id: 34,
    method: "tools/call",
    params: { name: "load_state_file", arguments: { isolation_id: "lane-a", path: "C:\\states\\a.dst" } }
  });
  await server.handle({
    jsonrpc: "2.0",
    id: 35,
    method: "tools/call",
    params: { name: "load_save_file", arguments: { isolation_id: "lane-a", path: "C:\\saves\\a.sav" } }
  });
  await server.handle({
    jsonrpc: "2.0",
    id: 36,
    method: "tools/call",
    params: { name: "export_state_file", arguments: { isolation_id: "lane-a", name: "state" } }
  });
  await server.handle({
    jsonrpc: "2.0",
    id: 37,
    method: "tools/call",
    params: { name: "export_save_file", arguments: { isolation_id: "lane-a", name: "save" } }
  });
  assert.deepEqual(calls, [
    { restartAnalyze: { id: undefined, input: { statePath: "C:\\states\\next.dst", savePath: undefined } } },
    "listInstances",
    { requireExisting: "lane-a" },
    { listCommands: { filter: "", offset: 0, limit: 8, includeDescriptions: false } },
    { requireExisting: "lane-a" },
    { loadStateFile: "C:\\states\\a.dst" },
    { requireExisting: "lane-a" },
    { loadSaveFile: "C:\\saves\\a.sav" },
    { requireExisting: "lane-a" },
    { exportStateFile: "state" },
    { requireExisting: "lane-a" },
    { exportSaveFile: "save" }
  ]);
});

test("inject_bytes_file and close_all_sessions expose the dedicated top-level operations", async () => {
  const calls = [];
  const harness = {
    config: { commandTimeoutMs: 600000, baselineName: "base", replaceBaseline: true },
    async injectBytesFile(filePath, address, cpu) {
      calls.push({ filePath, address, cpu });
      return { ok: true, size: 4, address: 0x020f9104 };
    }
  };
  const manager = {
    requireExisting() { return harness; },
    async closeAll() { return 3; }
  };
  const server = new McpHarnessServer({ configPath: "harness.toml", managerFactory: () => manager });
  const injected = await server.handle({
    jsonrpc: "2.0",
    id: 13,
    method: "tools/call",
    params: {
      name: "inject_bytes_file",
      arguments: { file_path: "C:\\build\\arm9.bin", address: "0x020F9104", cpu: "arm9" }
    }
  });
  assert.equal(injected.result.structuredContent.size, 4);
  assert.deepEqual(calls, [{ filePath: "C:\\build\\arm9.bin", address: "0x020F9104", cpu: "arm9" }]);
  const closed = await server.handle({
    jsonrpc: "2.0",
    id: 14,
    method: "tools/call",
    params: { name: "close_all_sessions", arguments: {} }
  });
  assert.equal(closed.result.structuredContent.closed, 3);
});

test("close_instance bypasses a faulted-lane usability guard", async () => {
  const calls = [];
  const harness = { isolationId: "faulted-lane" };
  const manager = {
    requireExisting() {
      throw new Error("faulted lane must not be used normally");
    },
    requireExistingForClose(id) {
      calls.push({ requireExistingForClose: id });
      return harness;
    },
    async close(id) {
      calls.push({ close: id });
      return true;
    },
    async closeAll() { return 0; }
  };
  const server = new McpHarnessServer({ configPath: "harness.toml", managerFactory: () => manager });
  const reply = await server.handle({
    jsonrpc: "2.0",
    id: 15,
    method: "tools/call",
    params: { name: "close_instance", arguments: { isolation_id: "faulted-lane" } }
  });
  assert.equal(reply.result.structuredContent.closed, true);
  assert.deepEqual(calls, [
    { requireExistingForClose: "faulted-lane" },
    { close: "faulted-lane" }
  ]);
});

test("micro macro close_instance also bypasses a faulted-lane usability guard", async () => {
  const calls = [];
  const harness = {
    isolationId: "faulted-lane",
    async setUiInteractionLock() {
      throw new Error("close-only macro must not UI-lock a faulted lane");
    }
  };
  const manager = {
    requireExisting() {
      throw new Error("faulted lane must not be used normally");
    },
    requireExistingForClose(id) {
      calls.push({ requireExistingForClose: id });
      return harness;
    },
    async close(id) {
      calls.push({ close: id });
      return true;
    },
    async closeAll() { return 0; }
  };
  const server = new McpHarnessServer({ configPath: "harness.toml", managerFactory: () => manager });
  const reply = await server.handle({
    jsonrpc: "2.0",
    id: 16,
    method: "tools/call",
    params: {
      name: "micro_macro_exec",
      arguments: {
        id: "close-faulted-lane",
        isolation_id: "faulted-lane",
        steps: [{ tool: "close_instance", arguments: {} }]
      }
    }
  });
  assert.equal(reply.result.structuredContent.ok, true);
  assert.equal(reply.result.structuredContent.results[0].result.closed, true);
  assert.deepEqual(calls, [
    { requireExistingForClose: "faulted-lane" },
    { requireExistingForClose: "faulted-lane" },
    { close: "faulted-lane" }
  ]);
});

test("direct_status and analysis_context route to compact direct harness helpers", async () => {
  const calls = [];
  const harness = {
    config: { commandTimeoutMs: 600000, baselineName: "base", replaceBaseline: true },
    async directStatus() {
      calls.push("directStatus");
      return { ok: true, paused: true, running: false };
    },
    async analysisContext(options) {
      calls.push({ analysisContext: options });
      return { isolationId: "lane-a", stateName: "a.dst", paused: true, running: false, scripts: [] };
    }
  };
  const manager = {
    requireExisting(id) {
      assert.equal(id, "lane-a");
      return harness;
    },
    async closeAll() {}
  };
  const server = new McpHarnessServer({ configPath: "harness.toml", managerFactory: () => manager });
  const directReply = await server.handle({
    jsonrpc: "2.0",
    id: 21,
    method: "tools/call",
    params: { name: "direct_status", arguments: { isolation_id: "lane-a" } }
  });
  assert.equal(directReply.result.structuredContent.paused, true);
  const contextReply = await server.handle({
    jsonrpc: "2.0",
    id: 22,
    method: "tools/call",
    params: { name: "analysis_context", arguments: { isolation_id: "lane-a", include_breakpoints: true } }
  });
  assert.equal(contextReply.result.structuredContent.stateName, "a.dst");
  assert.deepEqual(calls, ["directStatus", { analysisContext: { includeBreakpoints: true } }]);
});

test("rerun_pscript_console returns startup logs through one stdio MCP tool", async () => {
  const harness = {
    config: { commandTimeoutMs: 600000, baselineName: "base", replaceBaseline: true },
    async rerunPScriptConsole(filePath, asyncMode, name, options) {
      assert.equal(filePath, "C:\\scripts\\overlay.js");
      assert.equal(asyncMode, false);
      assert.equal(name, "overlay");
      assert.equal(options.max, 7);
      return { ok: true, script: { id: 9, name: "overlay", running: true }, logs: [{ id: 9, name: "overlay", text: "ready" }] };
    }
  };
  const manager = {
    requireExisting() { return harness; },
    async closeAll() {}
  };
  const server = new McpHarnessServer({ configPath: "harness.toml", managerFactory: () => manager });
  const reply = await server.handle({
    jsonrpc: "2.0",
    id: 23,
    method: "tools/call",
    params: {
      name: "rerun_pscript_console",
      arguments: { path: "C:\\scripts\\overlay.js", name: "overlay", max: 7 }
    }
  });
  assert.equal(reply.result.structuredContent.script.id, 9);
  assert.equal(reply.result.structuredContent.logs[0].text, "ready");
});

test("script_console routes a bounded direct console read by script id", async () => {
  const harness = {
    config: { commandTimeoutMs: 600000, baselineName: "base", replaceBaseline: true },
    async scriptConsole(scriptId, max) {
      assert.equal(scriptId, 4);
      assert.equal(max, 9);
      return { logs: [{ id: 4, name: "overlay", text: "ready" }] };
    }
  };
  const manager = {
    requireExisting() { return harness; },
    async closeAll() {}
  };
  const server = new McpHarnessServer({ configPath: "harness.toml", managerFactory: () => manager });
  const reply = await server.handle({
    jsonrpc: "2.0",
    id: 24,
    method: "tools/call",
    params: {
      name: "script_console",
      arguments: { script_id: 4, max: 9 }
    }
  });
  assert.equal(reply.result.structuredContent.logs[0].text, "ready");
});

test("micro macro tool resolution exhaustively accepts namespaced top-level tools by suffix", () => {
  for (const tool of TOOLS) {
    if (tool.name.startsWith("micro_macro_")) {
      assert.throws(
        () => resolveMicroMacroToolName(`desmume_harness__${tool.name}`, 0),
        /cannot invoke another micro_macro tool/u
      );
      continue;
    }
    assert.equal(resolveMicroMacroToolName(tool.name, 0), tool.name);
    assert.equal(resolveMicroMacroToolName(`desmume_harness__${tool.name}`, 0), tool.name);
    assert.equal(resolveMicroMacroToolName(`any_gateway_prefix__${tool.name}`, 0), tool.name);
  }
});

test("micro macro root isolation exhaustively inherits only into isolation-aware tools and never overrides a step", () => {
  for (const tool of TOOLS) {
    const acceptsIsolation = Boolean(tool.inputSchema?.properties?.isolation_id);
    const inherited = inheritMicroMacroIsolation(tool.name, { marker: true }, "root-lane");
    assert.equal(
      inherited.isolation_id,
      acceptsIsolation ? "root-lane" : undefined,
      `${tool.name} root isolation inheritance`
    );
    const explicit = inheritMicroMacroIsolation(
      tool.name,
      { isolation_id: "step-lane", marker: true },
      "root-lane"
    );
    assert.equal(explicit.isolation_id, "step-lane", `${tool.name} explicit step isolation wins`);
  }
});

test("micro macros register namespaced top-level MCP calls, list/get them, and re-execute by id", async () => {
  const calls = [];
  const harness = {
    isolationId: "lane-a",
    config: { commandTimeoutMs: 600000, baselineName: "base", replaceBaseline: true },
    async setUiInteractionLock(owner, locked) {
      calls.push({ uiLock: { owner, locked } });
      return { ok: true, locked };
    },
    async resume() {
      calls.push("resume");
      return { ok: true, running: true, paused: false };
    },
    async call(command, params) {
      calls.push({ command, params });
      return { ok: true, command };
    }
  };
  const manager = {
    requireExisting(id) {
      assert.equal(id, "lane-a");
      return harness;
    },
    async closeAll() {}
  };
  const server = new McpHarnessServer({ configPath: "harness.toml", managerFactory: () => manager });
  const first = await server.handle({
    jsonrpc: "2.0",
    id: 40,
    method: "tools/call",
    params: {
      name: "micro_macro_exec",
      arguments: {
        id: "turn-flow",
        isolation_id: "lane-a",
        steps: [
          { wait_ms: 0, tool: "desmume_harness__call", arguments: { command: "pressButtons", params: { buttons: ["A"] } } },
          { wait_ms: 1, tool: "desmume_harness__resume", arguments: {} }
        ]
      }
    }
  });
  assert.equal(first.result.structuredContent.id, "turn-flow");
  assert.equal(first.result.structuredContent.stepCount, 2);
  assert.deepEqual(calls, [
    { uiLock: { owner: "micro-macro:turn-flow:1", locked: true } },
    { command: "pressButtons", params: { buttons: ["A"] } },
    "resume",
    { uiLock: { owner: "micro-macro:turn-flow:1", locked: false } }
  ]);

  const listed = await server.handle({
    jsonrpc: "2.0",
    id: 41,
    method: "tools/call",
    params: { name: "micro_macro_list", arguments: {} }
  });
  assert.deepEqual(listed.result.structuredContent.macros, [
    { id: "turn-flow", stepCount: 2, totalWaitMs: 1 }
  ]);

  const fetched = await server.handle({
    jsonrpc: "2.0",
    id: 42,
    method: "tools/call",
    params: { name: "micro_macro_get", arguments: { id: "turn-flow" } }
  });
  assert.equal(fetched.result.structuredContent.steps[1].tool, "resume");
  assert.equal(fetched.result.structuredContent.steps[1].wait_ms, 1);

  await server.handle({
    jsonrpc: "2.0",
    id: 43,
    method: "tools/call",
    params: { name: "micro_macro_exec", arguments: { id: "turn-flow", isolation_id: "lane-a" } }
  });
  assert.deepEqual(calls.slice(4), [
    { uiLock: { owner: "micro-macro:turn-flow:2", locked: true } },
    { command: "pressButtons", params: { buttons: ["A"] } },
    "resume",
    { uiLock: { owner: "micro-macro:turn-flow:2", locked: false } }
  ]);
});

test("micro macro UI lock is released on failure and intentional pause remains a normal step", async () => {
  const calls = [];
  const harness = {
    isolationId: "lane-a",
    config: { commandTimeoutMs: 600000 },
    async setUiInteractionLock(owner, locked) {
      calls.push(`lock:${owner}:${locked}`);
      return { ok: true, locked };
    },
    async pause() {
      calls.push("pause");
      return { ok: true, paused: true, running: false };
    },
    async call() {
      calls.push("failing-call");
      throw new Error("step failed");
    }
  };
  const server = new McpHarnessServer({
    configPath: "harness.toml",
    managerFactory: () => ({
      requireExisting(id) {
        assert.equal(id, "lane-a");
        return harness;
      },
      async closeAll() {}
    })
  });
  const paused = await server.handle({
    jsonrpc: "2.0",
    id: 46,
    method: "tools/call",
    params: {
      name: "micro_macro_exec",
      arguments: {
        id: "intentional-pause",
        isolation_id: "lane-a",
        steps: [{ tool: "desmume_harness__pause", arguments: {} }]
      }
    }
  });
  assert.equal(paused.result.isError, false);
  assert.deepEqual(calls, [
    "lock:micro-macro:intentional-pause:1:true",
    "pause",
    "lock:micro-macro:intentional-pause:1:false"
  ]);
  calls.length = 0;
  const failed = await server.handle({
    jsonrpc: "2.0",
    id: 47,
    method: "tools/call",
    params: {
      name: "micro_macro_exec",
      arguments: {
        id: "failing-step",
        isolation_id: "lane-a",
        steps: [{ tool: "desmume_harness__call", arguments: { command: "boom" } }]
      }
    }
  });
  assert.equal(failed.result.isError, true);
  assert.match(failed.result.content[0].text, /step failed/u);
  assert.deepEqual(calls, [
    "lock:micro-macro:failing-step:2:true",
    "failing-call",
    "lock:micro-macro:failing-step:2:false"
  ]);
});

test("micro macros reject recursive macro execution and unknown top-level tools", async () => {
  const server = new McpHarnessServer({
    configPath: "harness.toml",
    managerFactory: () => ({ async closeAll() {} })
  });
  const recursive = await server.handle({
    jsonrpc: "2.0",
    id: 44,
    method: "tools/call",
    params: {
      name: "micro_macro_exec",
      arguments: { id: "recursive", steps: [{ tool: "micro_macro_exec", arguments: { id: "recursive" } }] }
    }
  });
  assert.equal(recursive.result.isError, true);
  assert.match(recursive.result.content[0].text, /cannot invoke another micro_macro tool/u);

  const unknown = await server.handle({
    jsonrpc: "2.0",
    id: 45,
    method: "tools/call",
    params: {
      name: "micro_macro_exec",
      arguments: { id: "unknown", steps: [{ tool: "does_not_exist", arguments: {} }] }
    }
  });
  assert.equal(unknown.result.isError, true);
  assert.match(unknown.result.content[0].text, /unknown top-level tool/u);
});

test("stdio MCP initialize returns server instructions and negotiates the requested supported protocol", async () => {
  const server = new McpHarnessServer({
    configPath: "harness.toml",
    managerFactory: () => ({ async closeAll() {} })
  });
  const reply = await server.handle({
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: { protocolVersion: "2025-11-25", capabilities: {}, clientInfo: { name: "test", version: "1" } }
  });
  assert.equal(reply.result.protocolVersion, "2025-11-25");
  assert.equal(reply.result.serverInfo.name, "desmume-webassembly-harness");
  assert.match(reply.result.instructions, /start_analyze/u);
});

test("stdio MCP initialize falls back to the latest server protocol when the client requests another version", async () => {
  const server = new McpHarnessServer({
    configPath: "harness.toml",
    managerFactory: () => ({ async closeAll() {} })
  });
  const reply = await server.handle({
    jsonrpc: "2.0",
    id: 2,
    method: "initialize",
    params: { protocolVersion: "2099-01-01", capabilities: {}, clientInfo: { name: "test", version: "1" } }
  });
  assert.equal(reply.result.protocolVersion, "2025-11-25");
});

test("mcpMain runs as a newline-delimited stdio MCP process", async (t) => {
  const child = spawn(process.execPath, ["src/mcpMain.js", "missing-test-config.toml"], {
    cwd: process.cwd(),
    stdio: ["pipe", "pipe", "pipe"]
  });
  t.after(() => {
    if (child.exitCode === null) child.kill();
  });
  const lines = createInterface({ input: child.stdout, crlfDelay: Infinity });
  const iterator = lines[Symbol.asyncIterator]();
  child.stdin.write(`${JSON.stringify({
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: { protocolVersion: "2025-11-25", capabilities: {}, clientInfo: { name: "stdio-test", version: "1" } }
  })}\n`);
  const initialized = JSON.parse((await iterator.next()).value);
  assert.equal(initialized.id, 1);
  assert.equal(initialized.result.serverInfo.name, "desmume-webassembly-harness");
  child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" })}\n`);
  child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} })}\n`);
  const tools = JSON.parse((await iterator.next()).value);
  assert.equal(tools.id, 2);
  assert.ok(tools.result.tools.some((tool) => tool.name === "start_analyze"));
  assert.ok(tools.result.tools.some((tool) => tool.name === "micro_macro_exec"));
  child.stdin.end();
  await once(child, "exit");
  assert.equal(child.exitCode, 0);
});
