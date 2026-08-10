import path from "node:path";
import { mkdir, writeFile } from "node:fs/promises";
import { setTimeout as sleep } from "node:timers/promises";
import { ChromeSession } from "./chrome-session.js";
import { readUtf8Text } from "./config.js";

function resultError(result, operation) {
  const code = result?.error?.code ? ` [${result.error.code}]` : "";
  const message = result?.error?.message ?? "unknown application error";
  const error = new Error(`${operation}${code}: ${message}`);
  error.result = result;
  return error;
}

function requireOk(result, operation) {
  if (result?.ok === false) throw resultError(result, operation);
  return result;
}

function selectorParams(selector) {
  if (Number.isSafeInteger(selector) && selector > 0) return { id: selector };
  if (typeof selector === "string" && selector.trim()) return { name: selector.trim() };
  throw new Error("Script selector must be a positive numeric id or a non-empty name");
}

export class DesmumeHarness {
  constructor({ isolationId = "default", config, sessionFactory = (options) => new ChromeSession(options) }) {
    this.isolationId = isolationId;
    this.config = config;
    this.session = sessionFactory({ isolationId, config });
    this.screenshotSerial = 0;
    this.currentStatePath = null;
    this.currentBaselineName = config.baselineName;
    this.scriptSourcePaths = new Map();
  }

  async start() {
    await this.session.start();
    return this;
  }

  async call(command, params = {}, timeoutMs = this.config.commandTimeoutMs) {
    await this.start();
    return await this.session.callWebMcp("desmume.call", { command, params }, timeoutMs);
  }

  async status() {
    return await this.call("status");
  }

  async directStatus() {
    return requireOk(await this.#directCall("status"), "status");
  }

  async pause() {
    return await this.call("pause");
  }

  async resume() {
    return await this.call("resume");
  }

  async #directCall(command, params = {}, timeoutMs = this.config.commandTimeoutMs) {
    await this.start();
    return await this.session.callDirect(command, params, timeoutMs);
  }

  async snapshotElements() {
    await this.start();
    return await this.session.snapshotElements();
  }

  async #waitForStatus(predicate, label, timeoutMs = this.config.fileTimeoutMs) {
    const deadline = Date.now() + timeoutMs;
    let latest = null;
    while (Date.now() < deadline) {
      latest = await this.#directCall("status", {}, Math.min(this.config.commandTimeoutMs, 5000));
      if (latest?.ok !== false && predicate(latest)) return latest;
      await sleep(25);
    }
    const suffix = latest?.error?.message ? `; latest error: ${latest.error.message}` : "";
    throw new Error(`${label} did not complete within ${timeoutMs} ms${suffix}`);
  }

  async loadRom(filePath = this.config.romPath) {
    await this.start();
    if (!filePath) throw new Error("rom_path is not configured");
    const before = requireOk(await this.#directCall("status"), "status before ROM load");
    const previousTransactionSerial = Number(before.fileTransaction?.serial ?? 0);
    await this.session.uploadFileByLabel("ROM", filePath);
    return await this.#waitForStatus(
      (status) => status.romLoaded === true
        && Number(status.fileTransaction?.serial ?? 0) > previousTransactionSerial
        && status.fileTransaction?.active === false,
      "ROM load"
    );
  }

  async loadState(filePath) {
    await this.start();
    if (typeof filePath !== "string" || !filePath.trim()) throw new Error("state_path is required");
    const before = requireOk(await this.#directCall("status"), "status before State load");
    const previousSerial = Number(before.stateLoadSerial ?? 0);
    const absolute = path.resolve(filePath);
    await this.session.uploadFileByLabel("State In", filePath);
    const loaded = await this.#waitForStatus(
      (status) => Number(status.stateLoadSerial ?? 0) > previousSerial && status.fileTransaction?.active === false,
      "State load"
    );
    this.currentStatePath = absolute;
    return loaded;
  }

  async saveBaseline(name = this.config.baselineName, replace = this.config.replaceBaseline) {
    const saved = requireOk(await this.#directCall("saveAnalysisBaseline", { name, replace }), "saveAnalysisBaseline");
    this.currentBaselineName = name;
    return saved;
  }

  async restoreBaseline(name = this.config.baselineName) {
    const restored = requireOk(await this.#directCall("restoreAnalysisBaseline", { name }), "restoreAnalysisBaseline");
    this.currentBaselineName = name;
    return restored;
  }

  async startAnalyze(statePath) {
    await this.start();
    await this.loadRom();
    const stateStatus = await this.loadState(statePath);
    await this.saveBaseline();
    return {
      status: "ok",
      paused: stateStatus.paused,
      running: stateStatus.running
    };
  }

  async screenshot(name) {
    const outputDirectory = this.config.screenshotPath;
    if (!outputDirectory) throw new Error("screenshot_path is not configured");
    let fileName;
    if (name === undefined) {
      this.screenshotSerial += 1;
      fileName = `frame-${String(this.screenshotSerial).padStart(6, "0")}.png`;
    } else {
      if (typeof name !== "string" || !name.trim()) throw new Error("screenshot name must be a non-empty string");
      fileName = name.trim();
      if (fileName.includes("/") || fileName.includes("\\") || fileName === "." || fileName === "..") {
        throw new Error("screenshot name must be a file name, not a path");
      }
      if (!fileName.toLowerCase().endsWith(".png")) fileName += ".png";
    }
    const outputPath = path.join(outputDirectory, fileName);
    const capture = requireOk(await this.#directCall("takeScreenshot", {
      download: false,
      includeDataUrl: true,
      cooldownMs: 250,
      name: fileName
    }), "takeScreenshot");
    const prefix = "data:image/png;base64,";
    if (typeof capture.dataUrl !== "string" || !capture.dataUrl.startsWith(prefix)) {
      throw new Error("takeScreenshot did not return a PNG data URL");
    }
    const bytes = Buffer.from(capture.dataUrl.slice(prefix.length), "base64");
    await mkdir(outputDirectory, { recursive: true });
    await writeFile(outputPath, bytes);
    const { dataUrl: _dataUrl, ...metadata } = capture;
    return { ...metadata, path: outputPath, bytes: bytes.length };
  }

  async eval(script, timeoutMs = this.config.commandTimeoutMs) {
    if (typeof script !== "string") throw new Error("eval script must be a string");
    await this.start();
    return await this.session.callWebMcp("desmume.eval", { code: script, timeoutMs }, timeoutMs + 1000);
  }

  async rerunscript(filePath, timeoutMs = this.config.commandTimeoutMs) {
    const absolute = path.resolve(filePath);
    const code = await readUtf8Text(absolute);
    await this.start();
    return await this.session.callWebMcp("desmume.runScript", { code, timeoutMs }, timeoutMs + 1000);
  }

  async listScripts() {
    return requireOk(await this.#directCall("listScripts"), "listScripts");
  }

  async stopPscript(selector) {
    const params = selectorParams(selector);
    if (params.id !== undefined) return requireOk(await this.#directCall("stopScript", params), "stopScript");
    const listed = await this.listScripts();
    const script = listed.scripts?.find((candidate) => candidate.name === params.name);
    if (!script) return { ok: true, stopped: false, name: params.name, reason: "not-found" };
    return requireOk(await this.#directCall("stopScript", { id: script.id }), "stopScript");
  }

  async restartPscript(selector, { waitForRegistration = true, startupTimeoutMs = 10000 } = {}) {
    return requireOk(await this.#directCall("restartScript", {
      ...selectorParams(selector),
      waitForRegistration,
      startupTimeoutMs
    }), "restartScript");
  }

  async rerunPScript(filePath, asyncMode = false, name, {
    waitForRegistration = true,
    startupTimeoutMs = 10000,
    timeoutMs = this.config.commandTimeoutMs
  } = {}) {
    if (typeof asyncMode !== "boolean") throw new Error("asyncMode must be boolean");
    const absolute = path.resolve(filePath);
    const source = await readUtf8Text(absolute);
    let stopped = null;
    if (name !== undefined) {
      if (typeof name !== "string" || !name.trim()) throw new Error("name must be a non-empty string when provided");
      const listed = await this.listScripts();
      const existing = listed.scripts?.find((candidate) => candidate.name === name);
      if (existing) stopped = requireOk(await this.#directCall("stopScript", { id: existing.id }), "stopScript before rerunPScript");
    }
    const snapshot = await this.snapshotElements();
    await this.session.uploadFileByLabel("Load source", absolute);
    await this.session.waitForScriptEditorSource(source, this.config.fileTimeoutMs);
    const params = {
      asyncMode,
      waitForRegistration,
      startupTimeoutMs
    };
    if (name !== undefined) params.name = name;
    const script = requireOk(
      await this.#directCall("runLoadedPersistentScript", params, timeoutMs),
      "runLoadedPersistentScript"
    );
    if (Number.isSafeInteger(script.id)) this.scriptSourcePaths.set(script.id, absolute);
    return { ok: true, stopped, script, snapshot };
  }

  async rerunPScriptConsole(filePath, asyncMode = false, name, {
    waitForRegistration = true,
    startupTimeoutMs = 10000,
    timeoutMs = this.config.commandTimeoutMs,
    max = 20
  } = {}) {
    if (typeof asyncMode !== "boolean") throw new Error("asyncMode must be boolean");
    const absolute = path.resolve(filePath);
    const code = await readUtf8Text(absolute);
    const params = { code, asyncMode, waitForRegistration, startupTimeoutMs };
    if (name !== undefined) params.name = name;
    const script = requireOk(
      await this.#directCall("runPersistentScript", params, timeoutMs),
      "runPersistentScript"
    );
    const id = script?.id;
    if (Number.isSafeInteger(id)) this.scriptSourcePaths.set(id, absolute);
    const printed = requireOk(await this.#directCall("listScriptPrint", {
      ...(Number.isSafeInteger(id) ? { id } : {}),
      max
    }), "listScriptPrint");
    return {
      ok: true,
      script,
      logs: printed.logs ?? []
    };
  }

  async scriptConsole(scriptId, max = 20) {
    if (!Number.isSafeInteger(scriptId) || scriptId < 1) throw new Error("script_id must be a positive integer");
    if (!Number.isSafeInteger(max) || max < 1 || max > 1000) throw new Error("max must be an integer from 1 through 1000");
    return requireOk(await this.#directCall("listScriptPrint", { id: scriptId, max }), "listScriptPrint");
  }

  async analysisContext({ includeBreakpoints = false } = {}) {
    const status = await this.directStatus();
    const snapshot = status.romLoaded
      ? requireOk(await this.#directCall("snapshotContext"), "snapshotContext")
      : null;
    const baselineList = await this.#directCall("listAnalysisBaselines");
    const scriptList = await this.#directCall("listScripts");
    const breakKinds = ["exec", "read", "write", "dataAbort", "prefetchAbort", "undefinedInstruction"];
    const lastBreak = status.native?.lastBreak?.hit ? status.native.lastBreak : null;
    const latestState = status.recentFiles?.find((entry) => entry?.kind === "state") ?? null;
    const scripts = (scriptList?.scripts ?? []).filter((script) => script.running === true).map((script) => ({
      id: script.id,
      name: script.name,
      running: script.running,
      started: script.started,
      registrationComplete: script.registrationComplete,
      identitySource: script.identitySource,
      asyncMode: script.asyncMode,
      mcpCount: script.mcpCount,
      ...(this.scriptSourcePaths.has(script.id) ? { sourcePath: this.scriptSourcePaths.get(script.id) } : {})
    }));
    const result = {
      isolationId: this.isolationId,
      stateName: this.currentStatePath ? path.basename(this.currentStatePath) : latestState?.name ?? null,
      statePath: this.currentStatePath,
      baselineName: this.currentBaselineName,
      baselinePresent: (baselineList?.baselines ?? []).some((baseline) => baseline.name === this.currentBaselineName),
      paused: status.paused,
      running: status.running,
      frame: status.frame,
      pc: status.native?.arm9?.pc,
      cpsr: status.native?.arm9?.cpsr,
      traceEnabled: status.native?.traceEnabled,
      skipIrq: snapshot?.skipIrq,
      ...(lastBreak ? {
        break: {
          kind: breakKinds[Number(lastBreak.kind)] ?? "unknown",
          cpu: lastBreak.cpu,
          address: Number(lastBreak.address) >>> 0,
          pc: Number(lastBreak.pc) >>> 0
        }
      } : { break: null }),
      scripts
    };
    if (includeBreakpoints) result.breakpoints = await this.#directCall("listBreakpoints");
    return result;
  }

  async listPScriptMcp(scriptId) {
    const params = scriptId === undefined ? {} : { scriptId };
    return requireOk(await this.#directCall("listPScriptMcp", params), "listPScriptMcp");
  }

  async callPScriptMcp(name, params = {}, {
    blocking = true,
    scriptId,
    scriptName,
    timeoutMs = 60000
  } = {}) {
    const request = { name, params, blocking, timeoutMs };
    if (scriptId !== undefined) request.scriptId = scriptId;
    if (scriptName !== undefined) request.scriptName = scriptName;
    return requireOk(await this.#directCall("callPScriptMcp", request, timeoutMs + 1000), "callPScriptMcp");
  }

  async close() {
    await this.session.close();
  }
}
