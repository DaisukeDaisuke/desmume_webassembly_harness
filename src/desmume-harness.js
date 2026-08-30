import path from "node:path";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
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

function isRunFrameNativeFault(value) {
  const candidates = [value, value?.result];
  for (const candidate of candidates) {
    if (!candidate || typeof candidate !== "object") continue;
    const error = candidate.error && typeof candidate.error === "object" ? candidate.error : null;
    const code = error?.code ?? candidate.mcpCode;
    const details = error?.details ?? candidate.mcpDetails;
    const message = String(error?.message ?? candidate.message ?? "");
    if (code === "NATIVE_FAULT" && details?.operation === "runFrame") return true;
    if (/native fault(?: during)? runFrame/iu.test(message)) return true;
  }
  return false;
}

function selectorParams(selector) {
  if (Number.isSafeInteger(selector) && selector > 0) return { id: selector };
  if (typeof selector === "string" && selector.trim()) return { name: selector.trim() };
  throw new Error("Script selector must be a positive numeric id or a non-empty name");
}

function analysisInput(input, operation) {
  const statePath = typeof input === "string" ? input : input?.statePath;
  const savePath = typeof input === "object" && input !== null ? input.savePath : undefined;
  if ((statePath === undefined) === (savePath === undefined)) {
    throw new Error(`${operation} requires exactly one of statePath or savePath`);
  }
  return { statePath, savePath };
}

function compactRunState(status) {
  return {
    ok: status?.ok !== false,
    romLoaded: status?.romLoaded === true,
    paused: status?.paused === true,
    running: status?.running === true,
    frame: Number(status?.frame ?? 0),
    stateLoadSerial: Number(status?.stateLoadSerial ?? 0),
    fileTransactionSerial: Number(status?.fileTransaction?.serial ?? 0)
  };
}

function managedFileName(name, extension, fallback) {
  if (name !== undefined && typeof name !== "string") throw new Error("export name must be a string");
  let fileName = name === undefined ? fallback : name.trim();
  if (!fileName) throw new Error("export name must be a non-empty string");
  if (fileName.includes("/") || fileName.includes("\\") || fileName === "." || fileName === "..") {
    throw new Error("export name must be a file name, not a path");
  }
  if (!fileName.toLowerCase().endsWith(extension)) fileName += extension;
  if (fileName.length > 255) throw new Error("export name must be at most 255 characters including extension");
  return fileName;
}

export class DesmumeHarness {
  constructor({ isolationId = "default", config, sessionFactory = (options) => new ChromeSession(options) }) {
    this.isolationId = isolationId;
    this.config = config;
    this.session = sessionFactory({ isolationId, config });
    this.screenshotSerial = 0;
    this.exportSerial = { state: 0, save: 0 };
    this.fatalRunFrameFault = false;
  }

  hasFatalRunFrameFault() {
    return this.fatalRunFrameFault;
  }

  assertUsable() {
    if (!this.fatalRunFrameFault) return;
    const error = new Error(
      `Emulator instance ${this.isolationId} is unusable after native fault runFrame; call start_analyze to create a fresh analysis instance`
    );
    error.code = "NATIVE_FAULT";
    throw error;
  }

  #observeRunFrameNativeFault(value) {
    if (isRunFrameNativeFault(value)) this.fatalRunFrameFault = true;
  }

  describe() {
    return this.session.describe();
  }

  async start() {
    await this.session.start();
    return this;
  }

  async call(command, params = {}, timeoutMs = this.config.commandTimeoutMs) {
    this.assertUsable();
    await this.start();
    try {
      const result = await this.session.callWebMcp("desmume.call", { command, params }, timeoutMs);
      this.#observeRunFrameNativeFault(result);
      this.assertUsable();
      return result;
    } catch (error) {
      this.#observeRunFrameNativeFault(error);
      this.assertUsable();
      throw error;
    }
  }

  async status() {
    return await this.call("status");
  }

  async directStatus() {
    return requireOk(await this.#directCall("status"), "status");
  }

  async setUiInteractionLock(owner, locked) {
    return requireOk(
      await this.#directCallUnchecked("setUiInteractionLock", { owner, locked }),
      "setUiInteractionLock"
    );
  }

  async pause() {
    return await this.call("pause");
  }

  async resume() {
    return await this.call("resume");
  }

  async #directCall(command, params = {}, timeoutMs = this.config.commandTimeoutMs) {
    this.assertUsable();
    try {
      const result = await this.#directCallUnchecked(command, params, timeoutMs);
      this.#observeRunFrameNativeFault(result);
      this.assertUsable();
      return result;
    } catch (error) {
      this.#observeRunFrameNativeFault(error);
      this.assertUsable();
      throw error;
    }
  }

  async #directCallUnchecked(command, params = {}, timeoutMs = this.config.commandTimeoutMs) {
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
        && status.running === true
        && status.paused === false
        && Number(status.fileTransaction?.serial ?? 0) > previousTransactionSerial
        && status.fileTransaction?.active === false,
      "ROM load and running startup"
    );
  }

  async loadState(filePath) {
    await this.start();
    if (typeof filePath !== "string" || !filePath.trim()) throw new Error("state_path is required");
    const before = requireOk(await this.#directCall("status"), "status before State load");
    const previousSerial = Number(before.stateLoadSerial ?? 0);
    await this.session.uploadFileByLabel("State In", filePath);
    return await this.#waitForStatus(
      (status) => Number(status.stateLoadSerial ?? 0) > previousSerial && status.fileTransaction?.active === false,
      "State load"
    );
  }

  async loadSave(filePath) {
    await this.start();
    if (typeof filePath !== "string" || !filePath.trim()) throw new Error("save_path is required");
    const before = requireOk(await this.#directCall("status"), "status before Save load");
    const previousTransactionSerial = Number(before.fileTransaction?.serial ?? 0);
    await this.session.uploadFileByLabel("Save In", filePath);
    return await this.#waitForStatus(
      (status) => status.romLoaded === true
        && Number(status.fileTransaction?.serial ?? 0) > previousTransactionSerial
        && status.fileTransaction?.active === false,
      "Save load"
    );
  }

  async loadStateFile(filePath) {
    return compactRunState(await this.loadState(filePath));
  }

  async loadSaveFile(filePath) {
    return compactRunState(await this.loadSave(filePath));
  }

  async saveBaseline(name = this.config.baselineName, replace = this.config.replaceBaseline) {
    return requireOk(await this.#directCall("saveAnalysisBaseline", { name, replace }), "saveAnalysisBaseline");
  }

  async restoreBaseline(name = this.config.baselineName) {
    return requireOk(await this.#directCall("restoreAnalysisBaseline", { name }), "restoreAnalysisBaseline");
  }

  async startAnalyze(input) {
    const { statePath, savePath } = analysisInput(input, "startAnalyze");
    await this.start();
    await this.loadRom();
    const stateStatus = statePath !== undefined
      ? await this.loadState(statePath)
      : await this.loadSave(savePath);
    await this.saveBaseline();
    return {
      status: "ok",
      paused: stateStatus.paused,
      running: stateStatus.running
    };
  }

  async restartAnalyze(input) {
    const { statePath, savePath } = analysisInput(input, "restartAnalyze");
    await this.start();
    const before = await this.directStatus();
    if (!before.romLoaded) await this.loadRom();
    const stateStatus = statePath !== undefined
      ? await this.loadState(statePath)
      : await this.loadSave(savePath);
    await this.saveBaseline();
    return {
      status: "ok",
      reusedWindow: true,
      paused: stateStatus.paused,
      running: stateStatus.running
    };
  }

  async listCommands({ filter = "", offset = 0, limit = 64, includeDescriptions = false } = {}) {
    await this.start();
    const inventory = await this.session.listCommandsDirect();
    if (!inventory || typeof inventory !== "object" || Array.isArray(inventory)) {
      throw new Error("DesmumeMCP.list() did not return a command inventory object");
    }
    if (typeof filter !== "string") throw new Error("filter must be a string");
    if (filter.length > 128) throw new Error("filter must be at most 128 characters");
    if (typeof includeDescriptions !== "boolean") throw new Error("includeDescriptions must be boolean");
    const query = filter.trim().toLowerCase();
    const safeOffset = Number(offset);
    const safeLimit = Number(limit);
    if (!Number.isSafeInteger(safeOffset) || safeOffset < 0) throw new Error("offset must be a non-negative integer");
    if (!Number.isSafeInteger(safeLimit) || safeLimit < 1 || safeLimit > 64) throw new Error("limit must be an integer from 1 through 64");
    const warning = typeof inventory.warning === "string" ? inventory.warning.slice(0, 240) : null;
    const entries = Object.entries(inventory)
      .filter(([name]) => name !== "warning")
      .filter(([name, description]) => !query
        || name.toLowerCase().includes(query)
        || String(description ?? "").toLowerCase().includes(query))
      .sort(([a], [b]) => a.localeCompare(b));
    const selected = entries.slice(safeOffset, safeOffset + safeLimit);
    const nextOffset = safeOffset + selected.length < entries.length ? safeOffset + selected.length : null;
    return {
      complete: warning === null,
      total: entries.length,
      offset: safeOffset,
      returned: selected.length,
      nextOffset,
      ...(warning ? { warning } : {}),
      commands: includeDescriptions
        ? selected.map(([name, description]) => ({ name, description: String(description ?? "").slice(0, 160) }))
        : selected.map(([name]) => name)
    };
  }

  async injectBytesFile(filePath, address, cpu) {
    if (typeof filePath !== "string" || !path.isAbsolute(filePath)) {
      throw new Error("file_path must be an absolute path");
    }
    const info = await stat(filePath);
    if (!info.isFile()) throw new Error("file_path must point to a regular file");
    if (info.size > 1024 * 1024) throw new Error("file_path exceeds the 1 MiB injectBytes limit");
    const bytes = await readFile(filePath);
    const params = {
      address,
      bytes: [...bytes],
      name: path.basename(filePath)
    };
    if (cpu !== undefined) params.cpu = cpu;
    return requireOk(await this.#directCall("injectBytes", params), "injectBytes");
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

  async #exportFile(kind, name) {
    const outputDirectory = this.config.exportPath;
    if (!outputDirectory) throw new Error("export_path is not configured");
    const isState = kind === "state";
    const extension = isState ? ".dst" : ".sav";
    const command = isState ? "exportStateFile" : "exportSaveFile";
    this.exportSerial[kind] += 1;
    const fallback = `${kind}-${String(this.exportSerial[kind]).padStart(6, "0")}${extension}`;
    const fileName = managedFileName(name, extension, fallback);
    const outputPath = path.join(outputDirectory, fileName);
    const exported = await this.session.downloadCommandToFile(command, {}, outputPath, this.config.fileTimeoutMs);
    return {
      ok: true,
      kind,
      path: exported.path,
      bytes: exported.bytes
    };
  }

  async exportStateFile(name) {
    return await this.#exportFile("state", name);
  }

  async exportSaveFile(name) {
    return await this.#exportFile("save", name);
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
    if (name !== undefined) {
      if (typeof name !== "string" || !name.trim()) throw new Error("name must be a non-empty string when provided");
    }
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
    return { ok: true, stopped: null, script };
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
    const scriptsSource = (scriptList?.scripts ?? []).filter((script) => script.running === true);
    const scripts = scriptsSource.slice(0, 16).map((script) => ({
      id: script.id,
      name: script.name,
      running: script.running,
      started: script.started,
      registrationComplete: script.registrationComplete,
      identitySource: script.identitySource,
      asyncMode: script.asyncMode,
      mcpCount: script.mcpCount
    }));
    const baselinesSource = Array.isArray(baselineList?.baselines) ? baselineList.baselines : [];
    const baselines = baselinesSource.slice(0, 16).map((baseline) => ({
      name: baseline.name,
      savedAt: baseline.savedAt ?? null,
      romName: baseline.romName ?? "",
      stateSize: Number(baseline.stateSize ?? 0),
      pcVerified: baseline.pcVerified === true
    }));
    const result = {
      isolationId: this.isolationId,
      romLoaded: status.romLoaded === true,
      romSize: Number(status.romSize ?? 0),
      paused: status.paused,
      running: status.running,
      frame: status.frame,
      stateLoadSerial: Number(status.stateLoadSerial ?? 0),
      fileTransaction: {
        active: status.fileTransaction?.active === true,
        serial: Number(status.fileTransaction?.serial ?? 0),
        reason: String(status.fileTransaction?.reason ?? "").slice(0, 120)
      },
      cpu: snapshot?.cpu ?? status.cpu ?? "arm9",
      registers: snapshot?.registers ?? null,
      traceEnabled: snapshot?.traceEnabled ?? status.native?.traceEnabled,
      skipIrq: snapshot?.skipIrq,
      ...(lastBreak ? {
        break: {
          kind: breakKinds[Number(lastBreak.kind)] ?? "unknown",
          cpu: lastBreak.cpu,
          address: Number(lastBreak.address) >>> 0,
          pc: Number(lastBreak.pc) >>> 0
        }
      } : { break: null }),
      recentFiles: (status.recentFiles ?? []).slice(0, 6).map((entry) => ({
        id: entry.id,
        kind: entry.kind,
        name: entry.name,
        slot: entry.slot ?? "",
        size: Number(entry.size ?? entry.bytes ?? 0)
      })),
      baselines,
      baselinesTruncated: baselinesSource.length > baselines.length,
      scripts,
      scriptsTruncated: scriptsSource.length > scripts.length
    };
    if (includeBreakpoints) {
      const breakpointResult = await this.#directCall("listBreakpoints");
      const breakpointSource = Array.isArray(breakpointResult)
        ? breakpointResult
        : Array.isArray(breakpointResult?.breakpoints) ? breakpointResult.breakpoints : [];
      result.breakpoints = breakpointSource.slice(0, 128).map((breakpoint) => ({
        id: breakpoint.id,
        cpu: breakpoint.cpu,
        type: breakpoint.type,
        address: breakpoint.address,
        enabled: breakpoint.enabled
      }));
      result.breakpointsTruncated = breakpointSource.length > result.breakpoints.length;
    }
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
