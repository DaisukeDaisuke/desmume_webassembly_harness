import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { createInterface } from "node:readline";
import { normalizeWebMcpExecution } from "../src/chrome-session.js";
import { McpHarnessServer } from "../src/mcpMain.js";

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
    async create(id) {
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

test("start_analyze forwards caller-supplied State and Save starts on the same lane", async () => {
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
    params: { name: "start_analyze", arguments: { isolation_id: "lane-a", save_path: "C:\\saves\\a.sav" } }
  });
  assert.equal(saveReply.result.structuredContent.savePath, "C:\\saves\\a.sav");
  assert.deepEqual(starts, [
    { isolationId: "lane-a", input: { statePath: "C:\\states\\a.dst", savePath: undefined } },
    { isolationId: "lane-a", input: { statePath: undefined, savePath: "C:\\saves\\a.sav" } }
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
    async create() { return harness; },
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
    async create(id) {
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
    async create() { return harness; },
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
    async create() { return harness; },
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
  child.stdin.end();
  await once(child, "exit");
  assert.equal(child.exitCode, 0);
});
