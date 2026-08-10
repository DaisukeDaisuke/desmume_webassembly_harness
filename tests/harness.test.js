import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DesmumeHarness } from "../src/desmume-harness.js";

function config(overrides = {}) {
  return {
    url: "https://example.invalid/",
    chromePath: "",
    headless: true,
    startupTimeoutMs: 1000,
    fileTimeoutMs: 1000,
    commandTimeoutMs: 1000,
    profileRoot: ".harness/profiles",
    romPath: "C:\\roms\\game.nds",
    statePath: "C:\\states\\baseline.dst",
    baselineName: "analysis-start",
    replaceBaseline: true,
    ...overrides
  };
}

class FakeAnalyzeSession {
  constructor() {
    this.events = [];
    this.romLoaded = false;
    this.stateLoadSerial = 0;
    this.fileTransactionSerial = 0;
  }
  async start() { this.events.push("start"); }
  async snapshotElements() {
    const phase = this.romLoaded ? "after-rom" : "before-rom";
    this.events.push(`snapshot:${phase}`);
    return [{ phase }];
  }
  async uploadFileByLabel(label) {
    this.events.push(`upload:${label}`);
    if (label === "ROM") {
      this.romLoaded = true;
      this.fileTransactionSerial += 1;
    }
    if (label === "State In") this.stateLoadSerial += 1;
  }
  async callDirect(command, params) {
    this.events.push(`mcp:${command}`);
    if (command === "status") return {
      ok: true,
      romLoaded: this.romLoaded,
      stateLoadSerial: this.stateLoadSerial,
      fileTransaction: { active: false, serial: this.fileTransactionSerial }
    };
    if (command === "saveAnalysisBaseline") return { ok: true, name: params.name, replace: params.replace };
    if (command === "snapshotContext") return { ok: true, pc: "02000000" };
    throw new Error(`unexpected command ${command}`);
  }
  async close() {}
}

test("startAnalyze snapshots around ROM load, waits for State serial, then saves the exact loaded State", async () => {
  const fake = new FakeAnalyzeSession();
  const harness = new DesmumeHarness({
    isolationId: "lane-a",
    config: config(),
    sessionFactory: () => fake
  });
  const result = await harness.startAnalyze();
  assert.equal(result.baseline.name, "analysis-start");
  assert.deepEqual(result.snapshots.beforeRom, [{ phase: "before-rom" }]);
  assert.deepEqual(result.snapshots.afterRom, [{ phase: "after-rom" }]);
  assert.deepEqual(fake.events.filter((event) => event.startsWith("upload:")), ["upload:ROM", "upload:State In"]);
  const stateUpload = fake.events.indexOf("upload:State In");
  const baselineSave = fake.events.indexOf("mcp:saveAnalysisBaseline");
  assert.ok(stateUpload >= 0 && baselineSave > stateUpload);
  assert.equal(fake.events.includes("mcp:stepFrames"), false);
});

class FakeScriptSession {
  constructor(source) {
    this.source = source;
    this.events = [];
  }
  async start() {}
  async snapshotElements() {
    this.events.push("snapshot");
    return [{ label: "Load source" }];
  }
  async uploadFileByLabel(label) { this.events.push(`upload:${label}`); }
  async waitForScriptEditorSource(source) {
    assert.equal(source, this.source);
    this.events.push("editor-ready");
  }
  async callDirect(command, params) {
    this.events.push(`mcp:${command}`);
    if (command === "listScripts") return { ok: true, scripts: [{ id: 7, name: "observer", running: true }] };
    if (command === "stopScript") {
      assert.equal(params.id, 7);
      return { ok: true, id: 7, stopped: true };
    }
    if (command === "runLoadedPersistentScript") {
      assert.equal(params.name, "observer");
      assert.equal(params.asyncMode, false);
      return { ok: true, id: 8, name: "observer", running: true, started: true, registrationComplete: true };
    }
    throw new Error(`unexpected command ${command}`);
  }
  async close() {}
}

test("rerunPScript stops the same explicit name and directly starts the source loaded through the file input", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "desmume-harness-"));
  const scriptPath = path.join(directory, "observer.js");
  const source = "return { fallbackId: 'observer', mcps: [] };\n";
  await writeFile(scriptPath, source, "utf8");
  const fake = new FakeScriptSession(source);
  const harness = new DesmumeHarness({
    isolationId: "lane-a",
    config: config(),
    sessionFactory: () => fake
  });
  const result = await harness.rerunPScript(scriptPath, false, "observer");
  assert.equal(result.script.name, "observer");
  assert.deepEqual(fake.events, [
    "mcp:listScripts",
    "mcp:stopScript",
    "snapshot",
    "upload:Load source",
    "editor-ready",
    "mcp:runLoadedPersistentScript"
  ]);
});

class FakeWebMcpSession {
  constructor() {
    this.calls = [];
  }
  async start() {}
  async callWebMcp(toolName, input, timeoutMs) {
    this.calls.push({ toolName, input, timeoutMs });
    return `webmcp:${toolName}`;
  }
  async close() {}
}

test("public command helpers use the registered WebMCP tools instead of the direct page command bridge", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "desmume-harness-webmcp-"));
  const scriptPath = path.join(directory, "oneshot.js");
  const source = "return await mcp.call('status', {});\n";
  await writeFile(scriptPath, source, "utf8");
  const fake = new FakeWebMcpSession();
  const harness = new DesmumeHarness({
    isolationId: "lane-webmcp",
    config: config(),
    sessionFactory: () => fake
  });
  assert.equal(await harness.pause(), "webmcp:desmume.call");
  assert.equal(await harness.resume(), "webmcp:desmume.call");
  assert.equal(await harness.eval("return 1;", 4321), "webmcp:desmume.eval");
  assert.equal(await harness.rerunscript(scriptPath, 8765), "webmcp:desmume.runScript");
  assert.deepEqual(fake.calls, [
    { toolName: "desmume.call", input: { command: "pause", params: {} }, timeoutMs: 1000 },
    { toolName: "desmume.call", input: { command: "resume", params: {} }, timeoutMs: 1000 },
    { toolName: "desmume.eval", input: { code: "return 1;", timeoutMs: 4321 }, timeoutMs: 5321 },
    { toolName: "desmume.runScript", input: { code: source, timeoutMs: 8765 }, timeoutMs: 9765 }
  ]);
});
