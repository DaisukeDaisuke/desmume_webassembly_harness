import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
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
    screenshotPath: "C:\\shots",
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
  async uploadFileByLabel(label, filePath) {
    this.events.push(`upload:${label}:${filePath}`);
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
  const statePath = "C:\\states\\external.dst";
  const result = await harness.startAnalyze(statePath);
  assert.equal(result.baseline.name, "analysis-start");
  assert.deepEqual(result.snapshots.beforeRom, [{ phase: "before-rom" }]);
  assert.deepEqual(result.snapshots.afterRom, [{ phase: "after-rom" }]);
  assert.deepEqual(fake.events.filter((event) => event.startsWith("upload:")), [
    "upload:ROM:C:\\roms\\game.nds",
    `upload:State In:${statePath}`
  ]);
  const stateUpload = fake.events.indexOf(`upload:State In:${statePath}`);
  const baselineSave = fake.events.indexOf("mcp:saveAnalysisBaseline");
  assert.ok(stateUpload >= 0 && baselineSave > stateUpload);
  assert.equal(fake.events.includes("mcp:stepFrames"), false);
});

test("screenshot writes multiple DeSmuME PNG framebuffers under the configured directory without returning dataUrl", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "desmume-harness-shot-"));
  const screenshotPath = path.join(directory, "nested");
  const pngBytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const names = [];
  const session = {
    async start() {},
    async callDirect(command, params) {
      assert.equal(command, "takeScreenshot");
      names.push(params.name);
      assert.equal(params.download, false);
      assert.equal(params.includeDataUrl, true);
      assert.equal(params.cooldownMs, 250);
      return {
        ok: true,
        type: "image/png",
        name: params.name,
        width: 256,
        height: 384,
        cooldownMs: 250,
        dataUrl: `data:image/png;base64,${pngBytes.toString("base64")}`
      };
    },
    async close() {}
  };
  const harness = new DesmumeHarness({
    isolationId: "lane-shot",
    config: config({ screenshotPath }),
    sessionFactory: () => session
  });
  const first = await harness.screenshot();
  const second = await harness.screenshot("battle-start");
  assert.deepEqual(names, ["frame-000001.png", "battle-start.png"]);
  assert.deepEqual(await readFile(path.join(screenshotPath, "frame-000001.png")), pngBytes);
  assert.deepEqual(await readFile(path.join(screenshotPath, "battle-start.png")), pngBytes);
  assert.equal(first.path, path.join(screenshotPath, "frame-000001.png"));
  assert.equal(second.path, path.join(screenshotPath, "battle-start.png"));
  assert.equal(first.dataUrl, undefined);
  assert.equal(second.dataUrl, undefined);
});

test("screenshot rejects a name that escapes the configured screenshot directory", async () => {
  const harness = new DesmumeHarness({
    isolationId: "lane-shot",
    config: config(),
    sessionFactory: () => ({ async start() {}, async close() {} })
  });
  await assert.rejects(() => harness.screenshot("..\\outside.png"), /must be a file name/u);
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
    if (command === "listScriptPrint") {
      assert.equal(params.id, 8);
      assert.equal(params.max, 20);
      return { ok: true, logs: [{ id: 8, name: "observer", text: "ready" }] };
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

test("rerunPScriptConsole skips UI snapshot output and returns startup console in one harness call", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "desmume-harness-console-"));
  const scriptPath = path.join(directory, "observer.js");
  const source = "print('ready');\n";
  await writeFile(scriptPath, source, "utf8");
  const fake = {
    events: [],
    async start() {},
    async callDirect(command, params) {
      this.events.push(`mcp:${command}`);
      if (command === "runPersistentScript") {
        assert.equal(params.name, "observer");
        assert.equal(params.code, source);
        assert.equal(params.asyncMode, false);
        assert.equal(params.waitForRegistration, true);
        return { ok: true, id: 8, name: "observer", running: true, started: true, registrationComplete: true, mcpCount: 0 };
      }
      if (command === "listScriptPrint") {
        assert.equal(params.id, 8);
        assert.equal(params.max, 20);
        return { ok: true, logs: [{ id: 8, name: "observer", text: "ready" }] };
      }
      throw new Error(`unexpected command ${command}`);
    },
    async close() {}
  };
  const harness = new DesmumeHarness({
    isolationId: "lane-console",
    config: config(),
    sessionFactory: () => fake
  });
  const result = await harness.rerunPScriptConsole(scriptPath, false, "observer");
  assert.equal(result.script.id, 8);
  assert.deepEqual(result.logs, [{ id: 8, name: "observer", text: "ready" }]);
  assert.equal(Object.hasOwn(result, "snapshot"), false);
  assert.deepEqual(fake.events, [
    "mcp:runPersistentScript",
    "mcp:listScriptPrint"
  ]);
});

test("scriptConsole reads one persistent-script console directly by id", async () => {
  const session = {
    async start() {},
    async callDirect(command, params) {
      assert.equal(command, "listScriptPrint");
      assert.deepEqual(params, { id: 12, max: 7 });
      return { logs: [{ id: 12, name: "overlay", text: "slot 0: nil" }] };
    },
    async close() {}
  };
  const harness = new DesmumeHarness({
    isolationId: "lane-console-read",
    config: config(),
    sessionFactory: () => session
  });
  assert.deepEqual(await harness.scriptConsole(12, 7), {
    logs: [{ id: 12, name: "overlay", text: "slot 0: nil" }]
  });
});

test("analysisContext stays compact and omits call stack, disassembly, and breakpoint list by default", async () => {
  const session = {
    async start() {},
    async callDirect(command) {
      if (command === "status") return {
        ok: true,
        romLoaded: true,
        paused: true,
        running: false,
        frame: 123,
        recentFiles: [{ kind: "state", name: "fallback.dst" }],
        native: {
          traceEnabled: true,
          arm9: { pc: 0x02012344, cpsr: 0x6000001f },
          lastBreak: { hit: true, kind: 0, cpu: "arm9", address: 0x02012344, pc: 0x02012344 }
        }
      };
      if (command === "snapshotContext") return { ok: true, skipIrq: true, nearPc: ["must-not-escape"] };
      if (command === "listAnalysisBaselines") return { baselines: [{ name: "analysis-start" }] };
      if (command === "listScripts") return { scripts: [
        { id: 3, name: "overlay", running: true, started: true, registrationComplete: true, mcpCount: 0 },
        { id: 4, name: "stopped", running: false }
      ] };
      if (command === "listBreakpoints") return [{ id: 1, type: "exec", address: 0x02012344 }];
      throw new Error(`unexpected command ${command}`);
    },
    async close() {}
  };
  const harness = new DesmumeHarness({
    isolationId: "lane-context",
    config: config(),
    sessionFactory: () => session
  });
  harness.currentStatePath = path.resolve("C:\\states\\current.dst");
  harness.scriptSourcePaths.set(3, path.resolve("C:\\scripts\\overlay.js"));
  const result = await harness.analysisContext();
  assert.equal(result.stateName, path.basename(path.resolve("C:\\states\\current.dst")));
  assert.equal(result.baselineName, "analysis-start");
  assert.equal(result.baselinePresent, true);
  assert.equal(result.paused, true);
  assert.equal(result.running, false);
  assert.equal(result.break.kind, "exec");
  assert.equal(result.skipIrq, true);
  assert.equal(result.scripts.length, 1);
  assert.equal(result.scripts[0].id, 3);
  assert.equal(Object.hasOwn(result, "breakpoints"), false);
  assert.equal(Object.hasOwn(result, "callStack"), false);
  assert.equal(Object.hasOwn(result, "disassembly"), false);
  assert.equal(Object.hasOwn(result, "nearPc"), false);
  const withBreakpoints = await harness.analysisContext({ includeBreakpoints: true });
  assert.deepEqual(withBreakpoints.breakpoints, [{ id: 1, type: "exec", address: 0x02012344 }]);
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
