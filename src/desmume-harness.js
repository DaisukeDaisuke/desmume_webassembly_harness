import path from "node:path";
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
  }

  async start() {
    await this.session.start();
    return this;
  }

  async call(command, params = {}, timeoutMs = this.config.commandTimeoutMs) {
    await this.start();
    return await this.session.callMcp(command, params, timeoutMs);
  }

  async status() {
    return await this.call("status");
  }

  async snapshotElements() {
    await this.start();
    return await this.session.snapshotElements();
  }

  async #waitForStatus(predicate, label, timeoutMs = this.config.fileTimeoutMs) {
    const deadline = Date.now() + timeoutMs;
    let latest = null;
    while (Date.now() < deadline) {
      latest = await this.call("status", {}, Math.min(this.config.commandTimeoutMs, 5000));
      if (latest?.ok !== false && predicate(latest)) return latest;
      await sleep(25);
    }
    const suffix = latest?.error?.message ? `; latest error: ${latest.error.message}` : "";
    throw new Error(`${label} did not complete within ${timeoutMs} ms${suffix}`);
  }

  async loadRom(filePath = this.config.romPath) {
    await this.start();
    if (!filePath) throw new Error("rom_path is not configured");
    const before = requireOk(await this.call("status"), "status before ROM load");
    const previousTransactionSerial = Number(before.fileTransaction?.serial ?? 0);
    await this.session.uploadFileByLabel("ROM", filePath);
    return await this.#waitForStatus(
      (status) => status.romLoaded === true
        && Number(status.fileTransaction?.serial ?? 0) > previousTransactionSerial
        && status.fileTransaction?.active === false,
      "ROM load"
    );
  }

  async loadState(filePath = this.config.statePath) {
    await this.start();
    if (!filePath) throw new Error("state_path is not configured");
    const before = requireOk(await this.call("status"), "status before State load");
    const previousSerial = Number(before.stateLoadSerial ?? 0);
    await this.session.uploadFileByLabel("State In", filePath);
    return await this.#waitForStatus(
      (status) => Number(status.stateLoadSerial ?? 0) > previousSerial && status.fileTransaction?.active === false,
      "State load"
    );
  }

  async saveBaseline(name = this.config.baselineName, replace = this.config.replaceBaseline) {
    return requireOk(await this.call("saveAnalysisBaseline", { name, replace }), "saveAnalysisBaseline");
  }

  async restoreBaseline(name = this.config.baselineName) {
    return requireOk(await this.call("restoreAnalysisBaseline", { name }), "restoreAnalysisBaseline");
  }

  async startAnalyze() {
    await this.start();
    const beforeRom = await this.snapshotElements();
    const romStatus = await this.loadRom();
    const afterRom = await this.snapshotElements();
    const stateStatus = await this.loadState();
    const baseline = await this.saveBaseline();
    const context = requireOk(await this.call("snapshotContext"), "snapshotContext");
    return {
      isolationId: this.isolationId,
      baseline,
      context,
      status: {
        afterRom: romStatus,
        afterState: stateStatus
      },
      snapshots: {
        beforeRom,
        afterRom
      }
    };
  }

  async eval(script, timeoutMs = this.config.commandTimeoutMs) {
    if (typeof script !== "string") throw new Error("eval script must be a string");
    return requireOk(await this.call("eval", { code: script, timeoutMs }, timeoutMs + 1000), "eval");
  }

  async rerunscript(filePath, timeoutMs = this.config.commandTimeoutMs) {
    const absolute = path.resolve(filePath);
    const code = await readUtf8Text(absolute);
    return requireOk(await this.call("runScript", { code, timeoutMs }, timeoutMs + 1000), "runScript");
  }

  async listScripts() {
    return requireOk(await this.call("listScripts"), "listScripts");
  }

  async stopPscript(selector) {
    const params = selectorParams(selector);
    if (params.id !== undefined) return requireOk(await this.call("stopScript", params), "stopScript");
    const listed = await this.listScripts();
    const script = listed.scripts?.find((candidate) => candidate.name === params.name);
    if (!script) return { ok: true, stopped: false, name: params.name, reason: "not-found" };
    return requireOk(await this.call("stopScript", { id: script.id }), "stopScript");
  }

  async restartPscript(selector, { waitForRegistration = true, startupTimeoutMs = 10000 } = {}) {
    return requireOk(await this.call("restartScript", {
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
      if (existing) stopped = requireOk(await this.call("stopScript", { id: existing.id }), "stopScript before rerunPScript");
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
      await this.call("runLoadedPersistentScript", params, timeoutMs),
      "runLoadedPersistentScript"
    );
    return { ok: true, stopped, script, snapshot };
  }

  async listPScriptMcp(scriptId) {
    const params = scriptId === undefined ? {} : { scriptId };
    return requireOk(await this.call("listPScriptMcp", params), "listPScriptMcp");
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
    return requireOk(await this.call("callPScriptMcp", request, timeoutMs + 1000), "callPScriptMcp");
  }

  async close() {
    await this.session.close();
  }
}
