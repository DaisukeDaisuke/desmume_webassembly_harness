import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { preprocessAssemblySource } from "../src/armv5t-assembly-preprocessor.js";
import { ChromeSession } from "../src/chrome-session.js";
import { DesmumeHarness } from "../src/desmume-harness.js";
import { HarnessManager } from "../src/manager.js";

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
    exportPath: "C:\\exports",
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
      paused: false,
      running: true,
      stateLoadSerial: this.stateLoadSerial,
      fileTransaction: { active: false, serial: this.fileTransactionSerial }
    };
    if (command === "saveAnalysisBaseline") return { ok: true, name: params.name, replace: params.replace };
    throw new Error(`unexpected command ${command}`);
  }
  async close() {}
}

test("startAnalyze loads ROM and State, saves the baseline, and returns only compact run state", async () => {
  const fake = new FakeAnalyzeSession();
  const harness = new DesmumeHarness({
    isolationId: "lane-a",
    config: config(),
    sessionFactory: () => fake
  });
  const statePath = "C:\\states\\external.dst";
  const result = await harness.startAnalyze(statePath);
  assert.deepEqual(result, { status: "ok", paused: false, running: true });
  assert.deepEqual(fake.events.filter((event) => event.startsWith("upload:")), [
    "upload:ROM:C:\\roms\\game.nds",
    `upload:State In:${statePath}`
  ]);
  const stateUpload = fake.events.indexOf(`upload:State In:${statePath}`);
  const baselineSave = fake.events.indexOf("mcp:saveAnalysisBaseline");
  assert.ok(stateUpload >= 0 && baselineSave > stateUpload);
  assert.equal(fake.events.some((event) => event.startsWith("snapshot:")), false);
  assert.equal(fake.events.includes("mcp:snapshotContext"), false);
  assert.equal(fake.events.includes("mcp:stepFrames"), false);
});

test("restartAnalyze reuses the already loaded Chrome lane without loading the ROM again", async () => {
  const fake = new FakeAnalyzeSession();
  fake.romLoaded = true;
  fake.fileTransactionSerial = 4;
  const harness = new DesmumeHarness({
    isolationId: "lane-reuse",
    config: config(),
    sessionFactory: () => fake
  });
  const statePath = "C:\\states\\next.dst";
  const result = await harness.restartAnalyze({ statePath });
  assert.deepEqual(result, { status: "ok", reusedWindow: true, paused: false, running: true });
  assert.equal(fake.events.some((event) => event.startsWith("upload:ROM:")), false);
  assert.ok(fake.events.includes(`upload:State In:${statePath}`));
  assert.ok(fake.events.indexOf("mcp:saveAnalysisBaseline") > fake.events.indexOf(`upload:State In:${statePath}`));
});

test("native fault runFrame permanently disables a harness lane after the fault is observed", async () => {
  let directCalls = 0;
  const session = {
    async start() {},
    async callDirect(command) {
      directCalls += 1;
      if (command === "callPScriptMcp") {
        return {
          ok: false,
          error: {
            code: "NATIVE_FAULT",
            message: "native fault during runFrame (-123)",
            details: { operation: "runFrame", nativeCode: -123 }
          }
        };
      }
      return { ok: true, paused: true, running: false };
    },
    async close() {}
  };
  const harness = new DesmumeHarness({
    isolationId: "faulted-lane",
    config: config(),
    sessionFactory: () => session
  });
  await assert.rejects(
    () => harness.callPScriptMcp("boom", {}, { blocking: true }),
    /unusable after native fault runFrame/u
  );
  assert.equal(harness.hasFatalRunFrameFault(), true);
  assert.equal(directCalls, 1);
  await assert.rejects(() => harness.directStatus(), /unusable after native fault runFrame/u);
  assert.equal(directCalls, 1, "faulted lane must reject before another page command is sent");
});

test("UI interaction lock cleanup remains available after native fault runFrame", async () => {
  const directCalls = [];
  const session = {
    async start() {},
    async callDirect(command, params) {
      directCalls.push({ command, params });
      if (command === "callPScriptMcp") {
        return {
          ok: false,
          error: {
            code: "NATIVE_FAULT",
            message: "native fault during runFrame",
            details: { operation: "runFrame" }
          }
        };
      }
      if (command === "setUiInteractionLock") return { ok: true, locked: !!params.locked };
      throw new Error(`unexpected command ${command}`);
    },
    async close() {}
  };
  const harness = new DesmumeHarness({
    isolationId: "faulted-lock-lane",
    config: config(),
    sessionFactory: () => session
  });
  await assert.rejects(
    () => harness.callPScriptMcp("boom", {}, { blocking: true }),
    /unusable after native fault runFrame/u
  );
  await harness.setUiInteractionLock("macro:cleanup", false);
  assert.deepEqual(directCalls.at(-1), {
    command: "setUiInteractionLock",
    params: { owner: "macro:cleanup", locked: false }
  });
});

test("ROM startup does not complete until the emulator is actually running", async () => {
  let statusReads = 0;
  const session = {
    async start() {},
    async uploadFileByLabel(label) {
      assert.equal(label, "ROM");
    },
    async callDirect(command) {
      assert.equal(command, "status");
      statusReads += 1;
      if (statusReads === 1) {
        return { ok: true, romLoaded: false, paused: true, running: false, fileTransaction: { serial: 0, active: false } };
      }
      if (statusReads === 2) {
        return { ok: true, romLoaded: true, paused: true, running: false, fileTransaction: { serial: 1, active: false } };
      }
      return { ok: true, romLoaded: true, paused: false, running: true, fileTransaction: { serial: 1, active: false } };
    },
    async close() {}
  };
  const harness = new DesmumeHarness({
    isolationId: "lane-running",
    config: config(),
    sessionFactory: () => session
  });
  const result = await harness.loadRom();
  assert.equal(result.running, true);
  assert.ok(statusReads >= 3);
});

test("HarnessManager discards a failed lane and retries start_analyze with a fresh harness", async () => {
  let created = 0;
  let closed = 0;
  const manager = new HarnessManager("unused.toml", {
    configLoader: async () => ({}),
    harnessFactory: () => {
      created += 1;
      const instance = created;
      return {
        async startAnalyze(input) {
          assert.deepEqual(input, { statePath: "C:\\states\\retry.dst", savePath: undefined });
          if (instance === 1) throw new Error("runtime never reached running state");
          return { status: "ok", paused: false, running: true };
        },
        async close() { closed += 1; }
      };
    },
    startAnalyzeMaxAttempts: 3,
    startAnalyzeRetryDelayMs: 1
  });
  const result = await manager.startAnalyze("retry-lane", { statePath: "C:\\states\\retry.dst", savePath: undefined });
  assert.deepEqual(result, { status: "ok", paused: false, running: true });
  assert.equal(created, 2);
  assert.equal(closed, 1);
});

test("HarnessManager requires restart_analyze for an existing lane and never creates another harness for restart", async () => {
  let created = 0;
  const restarts = [];
  const manager = new HarnessManager("unused.toml", {
    configLoader: async () => ({}),
    harnessFactory: ({ isolationId }) => {
      created += 1;
      return {
        describe: () => ({ isolationId, started: true, alive: true, dead: false, headless: true }),
        async startAnalyze() { return { status: "ok" }; },
        async restartAnalyze(input) {
          restarts.push(input);
          return { status: "ok", reusedWindow: true, paused: true, running: false };
        },
        async close() {}
      };
    }
  });
  await manager.startAnalyze("lane-a", { statePath: "C:\\states\\first.dst", savePath: undefined });
  await assert.rejects(
    () => manager.startAnalyze("lane-a", { statePath: "C:\\states\\second.dst", savePath: undefined }),
    /use restart_analyze/u
  );
  const restarted = await manager.restartAnalyze(undefined, { statePath: "C:\\states\\second.dst", savePath: undefined });
  assert.equal(restarted.reusedWindow, true);
  assert.equal(created, 1);
  assert.deepEqual(restarts, [{ statePath: "C:\\states\\second.dst", savePath: undefined }]);
});

test("HarnessManager allows only start_analyze to replace a runFrame-faulted lane", async () => {
  let created = 0;
  let closed = 0;
  const manager = new HarnessManager("unused.toml", {
    configLoader: async () => ({}),
    harnessFactory: ({ isolationId }) => {
      created += 1;
      const faulted = created === 1;
      return {
        isolationId,
        hasFatalRunFrameFault: () => faulted,
        assertUsable() {
          if (faulted) throw new Error("faulted lane");
        },
        async startAnalyze() { return { status: "ok", generation: created }; },
        async close() { closed += 1; }
      };
    },
    startAnalyzeMaxAttempts: 1
  });
  const first = await manager.create("lane-a");
  assert.equal(first.hasFatalRunFrameFault(), true);
  assert.throws(() => manager.requireExisting("lane-a"), /faulted lane/u);
  const restarted = await manager.startAnalyze("lane-a", { statePath: "C:\\states\\fresh.dst" });
  assert.deepEqual(restarted, { status: "ok", generation: 2 });
  assert.equal(created, 2);
  assert.equal(closed, 1);
  assert.equal(manager.requireExisting("lane-a").hasFatalRunFrameFault(), false);
});

test("concurrent start_analyze calls for one isolation id cannot create two Chrome lanes", async () => {
  let releaseFirst;
  let created = 0;
  const firstStarted = new Promise((resolve) => { releaseFirst = resolve; });
  let entered;
  const enteredStart = new Promise((resolve) => { entered = resolve; });
  const manager = new HarnessManager("unused.toml", {
    configLoader: async () => ({}),
    harnessFactory: () => {
      created += 1;
      return {
        async startAnalyze() {
          entered();
          await firstStarted;
          return { status: "ok", paused: true, running: false };
        },
        async close() {}
      };
    }
  });
  const first = manager.startAnalyze("lane-race", { statePath: "C:\\states\\first.dst" });
  await enteredStart;
  await assert.rejects(
    () => manager.startAnalyze("lane-race", { statePath: "C:\\states\\second.dst" }),
    /already starting|already exists/u
  );
  releaseFirst();
  await first;
  assert.equal(created, 1);
});

test("listInstances reports live/dead lane state without starting or probing Chrome", () => {
  const manager = new HarnessManager("unused.toml");
  manager.instances.set("lane-b", {
    describe: () => ({ isolationId: "lane-b", started: true, alive: false, dead: true, headless: false })
  });
  manager.instances.set("lane-a", {
    describe: () => ({ isolationId: "lane-a", started: true, alive: true, dead: false, headless: true })
  });
  assert.deepEqual(manager.listInstances(), {
    total: 2,
    returned: 2,
    truncated: false,
    instances: [
      { isolationId: "lane-a", started: true, alive: true, dead: false, headless: true },
      { isolationId: "lane-b", started: true, alive: false, dead: true, headless: false }
    ]
  });
});

test("a closed or crashed Chrome session is rejected instead of being silently recreated", async () => {
  const session = new ChromeSession({ isolationId: "dead-lane", config: config() });
  session.chrome = { exitCode: 1 };
  session.cdp = { isOpen: () => false };
  await assert.rejects(() => session.start(), /no longer alive/u);
});

test("persistent script editor readiness compares against textarea-normalized newlines", async () => {
  const session = new ChromeSession({ isolationId: "newline-lane", config: config() });
  session.chrome = { exitCode: null };
  let comparedSource = null;
  session.cdp = {
    isOpen: () => true,
    async send(method, params) {
      if (method === "Runtime.evaluate") return { result: { objectId: "global" } };
      if (method === "Runtime.callFunctionOn") {
        comparedSource = params.arguments[0].value;
        return { result: { value: true } };
      }
      throw new Error(`unexpected CDP method ${method}`);
    }
  };
  await session.waitForScriptEditorSource("one\r\ntwo\rthree\n", 1000);
  assert.equal(comparedSource, "one\ntwo\nthree\n");
});

test("Save start imports Save In after ROM startup and preserves the resulting run state", async () => {
  const fake = new FakeAnalyzeSession();
  fake.uploadFileByLabel = async function (label, filePath) {
    this.events.push(`upload:${label}:${filePath}`);
    if (label === "ROM") {
      this.romLoaded = true;
      this.fileTransactionSerial += 1;
    }
    if (label === "Save In") this.fileTransactionSerial += 1;
  };
  const harness = new DesmumeHarness({
    isolationId: "lane-save",
    config: config(),
    sessionFactory: () => fake
  });
  const savePath = "C:\\saves\\game.sav";
  const result = await harness.startAnalyze({ savePath });
  assert.deepEqual(result, { status: "ok", paused: false, running: true });
  assert.ok(fake.events.includes(`upload:Save In:${savePath}`));
});

test("ARMv5T preprocessor preserves legacy origin, label, address, and BL resolution semantics", () => {
  const source = [
    "entry:",
    "BL FUN_02000120",
    ".word 0x12345678",
    ".addr entry",
    ".addr4 entry",
    "#! 0x02001000",
    "next:",
    "bl FUN_02000FF0",
    ".ltorg",
    "MOV r0, r0"
  ].join("\n");
  const result = preprocessAssemblySource(source, 0x02000100);
  assert.deepEqual(result.generatedSource.split("\n"), [
    "entry:",
    "BL m+0x20",
    ".word 0x12345678",
    "\t.word 0x2000100",
    "\t.word 0x20000fc",
    "next:",
    "bl m-0x10",
    ".ltorg",
    "MOV r0, r0"
  ]);
  assert.equal(result.debuggerText.split("\n").at(-1), "MOV r0, r0 => 0x2001004");
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

test("listCommands pages the live runtime inventory and omits descriptions unless requested", async () => {
  const inventory = Object.fromEntries(Array.from({ length: 90 }, (_, index) => [
    `command${String(index).padStart(3, "0")}`,
    `description-${index}`
  ]));
  const session = {
    async start() {},
    async listCommandsDirect() { return inventory; },
    async close() {}
  };
  const harness = new DesmumeHarness({
    isolationId: "lane-list",
    config: config(),
    sessionFactory: () => session
  });
  const first = await harness.listCommands();
  assert.equal(first.total, 90);
  assert.equal(first.returned, 64);
  assert.equal(first.nextOffset, 64);
  assert.equal(first.commands[0], "command000");
  assert.equal(typeof first.commands[0], "string");
  const second = await harness.listCommands({ offset: first.nextOffset, limit: 64, includeDescriptions: true });
  assert.equal(second.returned, 26);
  assert.equal(second.nextOffset, null);
  assert.deepEqual(second.commands[0], { name: "command064", description: "description-64" });
});

test("managed State and Save exports return only path and byte count", async () => {
  const calls = [];
  const exportPath = path.join(os.tmpdir(), "desmume-harness-export-target");
  const session = {
    async start() {},
    async downloadCommandToFile(command, params, destinationPath, timeoutMs) {
      calls.push({ command, params, destinationPath, timeoutMs });
      return { result: { ok: true, privateBytes: [1, 2, 3] }, path: destinationPath, bytes: command === "exportStateFile" ? 4096 : 512 };
    },
    async close() {}
  };
  const harness = new DesmumeHarness({
    isolationId: "lane-export",
    config: config({ exportPath, fileTimeoutMs: 4321 }),
    sessionFactory: () => session
  });
  const state = await harness.exportStateFile();
  const save = await harness.exportSaveFile("manual");
  assert.deepEqual(state, {
    ok: true,
    kind: "state",
    path: path.join(exportPath, "state-000001.dst"),
    bytes: 4096
  });
  assert.deepEqual(save, {
    ok: true,
    kind: "save",
    path: path.join(exportPath, "manual.sav"),
    bytes: 512
  });
  assert.deepEqual(calls.map(({ command, destinationPath, timeoutMs }) => ({ command, destinationPath, timeoutMs })), [
    { command: "exportStateFile", destinationPath: path.join(exportPath, "state-000001.dst"), timeoutMs: 4321 },
    { command: "exportSaveFile", destinationPath: path.join(exportPath, "manual.sav"), timeoutMs: 4321 }
  ]);
  assert.equal(Object.hasOwn(state, "result"), false);
  assert.equal(Object.hasOwn(save, "result"), false);
});

test("ChromeSession managed export captures only the requested DeSmuME download and moves it to the destination", async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "desmume-harness-cdp-export-"));
  const destination = path.join(directory, "exports", "capture.dst");
  const listeners = new Map();
  let downloadPath = null;
  const session = new ChromeSession({
    isolationId: "lane-cdp-export",
    config: config({ profileRoot: path.join(directory, "profiles") })
  });
  session.chrome = { exitCode: null };
  session.cdp = {
    isOpen: () => true,
    onEvent(method, listener) {
      listeners.set(method, listener);
      return () => listeners.delete(method);
    },
    async send(method, params) {
      if (method === "Browser.setDownloadBehavior" && params.behavior === "allow") downloadPath = params.downloadPath;
      return {};
    }
  };
  session.callDirect = async (command) => {
    assert.equal(command, "exportStateFile");
    assert.ok(downloadPath);
    listeners.get("Browser.downloadWillBegin")({ guid: "other", suggestedFilename: "unrelated.bin" });
    listeners.get("Browser.downloadProgress")({ guid: "other", state: "completed" });
    await writeFile(path.join(downloadPath, "desmume-state.dst"), Buffer.from([1, 2, 3, 4]));
    listeners.get("Browser.downloadWillBegin")({ guid: "state-guid", suggestedFilename: "desmume-state.dst" });
    listeners.get("Browser.downloadProgress")({ guid: "state-guid", state: "completed" });
    return { ok: true, size: 4 };
  };
  t.after(async () => {
    await rm(directory, { recursive: true, force: true });
  });
  const result = await session.downloadCommandToFile("exportStateFile", {}, destination, 1000);
  assert.equal(result.path, destination);
  assert.equal(result.bytes, 4);
  assert.deepEqual(await readFile(destination), Buffer.from([1, 2, 3, 4]));
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

test("rerunPScript delegates same-name replacement to runLoadedPersistentScript", async () => {
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
  assert.equal(result.stopped, null);
  assert.deepEqual(fake.events, [
    "upload:Load source",
    "editor-ready",
    "mcp:runLoadedPersistentScript"
  ]);
  assert.equal(Object.hasOwn(result, "snapshot"), false);
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

test("analysisContext is rebuilt from live browser state and keeps bounded collections", async () => {
  const session = {
    async start() {},
    async callDirect(command) {
      if (command === "status") return {
        ok: true,
        romLoaded: true,
        romSize: 123456,
        paused: true,
        running: false,
        frame: 123,
        stateLoadSerial: 9,
        fileTransaction: { active: false, serial: 12, reason: "" },
        cpu: "arm9",
        recentFiles: [{ id: "recent-1", kind: "state", name: "fallback.dst", slot: "a", size: 999 }],
        native: {
          traceEnabled: true,
          arm9: { pc: 0x02012344, cpsr: 0x6000001f },
          lastBreak: { hit: true, kind: 0, cpu: "arm9", address: 0x02012344, pc: 0x02012344 }
        }
      };
      if (command === "snapshotContext") return {
        ok: true,
        cpu: "arm9",
        registers: { pc: "0x02012344", sp: "0x023ff000", lr: "0x02010000", cpsr: "0x6000001f" },
        skipIrq: true,
        traceEnabled: true,
        nearPc: ["must-not-escape"]
      };
      if (command === "listAnalysisBaselines") return {
        baselines: Array.from({ length: 20 }, (_, index) => ({ name: index === 0 ? "analysis-start" : `baseline-${index}` }))
      };
      if (command === "listScripts") return {
        scripts: [
          ...Array.from({ length: 20 }, (_, index) => ({
            id: index + 3,
            name: index === 0 ? "overlay" : `script-${index}`,
            running: true,
            started: true,
            registrationComplete: true,
            mcpCount: 0
          })),
          { id: 100, name: "stopped", running: false }
        ]
      };
      if (command === "listBreakpoints") return Array.from({ length: 140 }, (_, index) => ({
        id: index + 1,
        cpu: "arm9",
        type: "exec",
        address: 0x02012344 + index * 4,
        enabled: true
      }));
      throw new Error(`unexpected command ${command}`);
    },
    async close() {}
  };
  const harness = new DesmumeHarness({
    isolationId: "lane-context",
    config: config(),
    sessionFactory: () => session
  });
  const result = await harness.analysisContext();
  assert.equal(result.romLoaded, true);
  assert.equal(result.romSize, 123456);
  assert.equal(result.paused, true);
  assert.equal(result.running, false);
  assert.equal(result.stateLoadSerial, 9);
  assert.equal(result.fileTransaction.serial, 12);
  assert.equal(result.registers.pc, "0x02012344");
  assert.equal(result.break.kind, "exec");
  assert.equal(result.skipIrq, true);
  assert.equal(result.baselines[0].name, "analysis-start");
  assert.equal(result.recentFiles[0].name, "fallback.dst");
  assert.equal(result.baselines.length, 16);
  assert.equal(result.baselinesTruncated, true);
  assert.equal(result.scripts.length, 16);
  assert.equal(result.scriptsTruncated, true);
  assert.equal(result.scripts[0].id, 3);
  assert.equal(Object.hasOwn(result.scripts[0], "sourcePath"), false);
  assert.equal(Object.hasOwn(result, "statePath"), false);
  assert.equal(Object.hasOwn(result, "stateName"), false);
  assert.equal(Object.hasOwn(result, "breakpoints"), false);
  assert.equal(Object.hasOwn(result, "callStack"), false);
  assert.equal(Object.hasOwn(result, "disassembly"), false);
  assert.equal(Object.hasOwn(result, "nearPc"), false);
  const withBreakpoints = await harness.analysisContext({ includeBreakpoints: true });
  assert.equal(withBreakpoints.breakpoints.length, 128);
  assert.equal(withBreakpoints.breakpointsTruncated, true);
  assert.deepEqual(withBreakpoints.breakpoints[0], { id: 1, cpu: "arm9", type: "exec", address: 0x02012344, enabled: true });
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
