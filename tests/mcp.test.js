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

test("start_analyze forwards a caller-supplied state_path for repeated starts on the same lane", async () => {
  const starts = [];
  const manager = {
    async startAnalyze(isolationId, statePath) {
      starts.push({ isolationId, statePath });
      return { ok: true, isolationId, statePath };
    },
    async closeAll() {}
  };
  const server = new McpHarnessServer({
    configPath: "harness.toml",
    managerFactory: () => manager
  });
  for (const [id, statePath] of [[11, "C:\\states\\a.dst"], [12, "C:\\states\\b.dst"]]) {
    const reply = await server.handle({
      jsonrpc: "2.0",
      id,
      method: "tools/call",
      params: {
        name: "start_analyze",
        arguments: { isolation_id: "lane-a", state_path: statePath }
      }
    });
    assert.equal(reply.result.structuredContent.statePath, statePath);
  }
  assert.deepEqual(starts, [
    { isolationId: "lane-a", statePath: "C:\\states\\a.dst" },
    { isolationId: "lane-a", statePath: "C:\\states\\b.dst" }
  ]);
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
