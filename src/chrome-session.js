import { access, mkdir, mkdtemp, readFile, rename, rm, stat } from "node:fs/promises";
import { constants as fsConstants } from "node:fs";
import { spawn } from "node:child_process";
import path from "node:path";
import process from "node:process";
import { setTimeout as sleep } from "node:timers/promises";
import { CdpClient } from "./cdp.js";

function normalizeLabel(value) {
  return String(value ?? "").replaceAll(/\s+/gu, " ").trim().toLowerCase();
}

function assertIsolationId(value) {
  if (typeof value !== "string" || value.length < 1 || value.length > 64 || !/^[A-Za-z0-9][A-Za-z0-9._-]*$/u.test(value)) {
    throw new Error("isolationId must match ^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$");
  }
}

async function fileExists(filePath) {
  try {
    await access(filePath, fsConstants.F_OK);
    return true;
  } catch {
    return false;
  }
}

async function findChrome(configuredPath) {
  const candidates = [];
  if (configuredPath) candidates.push(configuredPath);
  if (process.platform === "win32") {
    const programFiles = process.env.ProgramFiles;
    const programFilesX86 = process.env["ProgramFiles(x86)"];
    const localAppData = process.env.LOCALAPPDATA;
    if (programFiles) candidates.push(path.join(programFiles, "Google", "Chrome", "Application", "chrome.exe"));
    if (programFilesX86) candidates.push(path.join(programFilesX86, "Google", "Chrome", "Application", "chrome.exe"));
    if (localAppData) candidates.push(path.join(localAppData, "Google", "Chrome", "Application", "chrome.exe"));
  } else if (process.platform === "darwin") {
    candidates.push("/Applications/Google Chrome.app/Contents/MacOS/Google Chrome");
  } else {
    candidates.push("/usr/bin/google-chrome", "/usr/bin/google-chrome-stable", "/usr/bin/chromium", "/usr/bin/chromium-browser");
  }
  for (const candidate of candidates) {
    if (candidate && await fileExists(candidate)) return candidate;
  }
  throw new Error("Google Chrome was not found. Set chrome_path in harness.toml.");
}

async function readDevToolsPort(profileDir) {
  const text = await readFile(path.join(profileDir, "DevToolsActivePort"), "utf8");
  const firstLine = text.split(/\r?\n/u)[0]?.trim();
  const port = Number(firstLine);
  if (!Number.isSafeInteger(port) || port < 1 || port > 65535) throw new Error("DevToolsActivePort contains an invalid port");
  return port;
}

async function fetchJson(url, timeoutMs = 1000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, { signal: controller.signal });
    if (!response.ok) throw new Error(`${response.status} ${response.statusText}`);
    return await response.json();
  } finally {
    clearTimeout(timer);
  }
}

async function discoverPage(port, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  let lastError = null;
  while (Date.now() < deadline) {
    try {
      const targets = await fetchJson(`http://127.0.0.1:${port}/json/list`, 1000);
      const page = targets.find((target) => target.type === "page" && target.webSocketDebuggerUrl);
      if (page) return page;
    } catch (error) {
      lastError = error;
    }
    await sleep(50);
  }
  throw new Error(`Chrome page target did not become available${lastError ? `: ${lastError.message}` : ""}`);
}

async function requireLocalFile(filePath) {
  if (!filePath) throw new Error("A local file path is required");
  const absolute = path.resolve(filePath);
  const info = await stat(absolute);
  if (!info.isFile()) throw new Error(`${absolute} is not a regular file`);
  return absolute;
}

export function normalizeWebMcpExecution(toolName, value) {
  if (value && typeof value === "object" && !Array.isArray(value)
      && typeof value.status === "string" && Object.hasOwn(value, "output")) {
    if (value.status === "Completed") return value.output;
    const detail = typeof value.output === "string"
      ? value.output
      : value.error?.message ?? value.message ?? "WebMCP execution did not complete";
    throw new Error(`${toolName} WebMCP execution ${value.status}: ${detail}`);
  }
  return value;
}

export class ChromeSession {
  constructor({ isolationId, config }) {
    assertIsolationId(isolationId);
    this.isolationId = isolationId;
    this.config = config;
    this.profileDir = path.join(config.profileRoot, isolationId);
    this.chrome = null;
    this.cdp = null;
    this.port = null;
    this.targetId = null;
    this.startupActive = false;
    this.downloadActive = false;
  }

  async start() {
    if (this.cdp) {
      if (this.isAlive()) return;
      throw new Error(`Chrome/DeSmuME session ${this.isolationId} is no longer alive`);
    }
    this.startupActive = true;
    await mkdir(this.profileDir, { recursive: true });
    const chromePath = await findChrome(this.config.chromePath);
    const args = [
      `--user-data-dir=${this.profileDir}`,
      "--remote-debugging-port=0",
      "--enable-features=WebMCPTesting,DevToolsWebMCPSupport",
      "--disable-background-timer-throttling",
      "--disable-backgrounding-occluded-windows",
      "--disable-renderer-backgrounding",
      "--no-first-run",
      "--no-default-browser-check",
      "about:blank"
    ];
    if (this.config.headless) args.unshift("--headless=new");
    this.chrome = spawn(chromePath, args, { stdio: "ignore", windowsHide: true });
    const deadline = Date.now() + this.config.startupTimeoutMs;
    let lastError = null;
    let page = null;
    while (Date.now() < deadline) {
      if (this.chrome.exitCode !== null) throw new Error(`Chrome exited during startup with code ${this.chrome.exitCode}`);
      try {
        const port = await readDevToolsPort(this.profileDir);
        const candidate = await discoverPage(port, 250);
        this.port = port;
        page = candidate;
        break;
      } catch (error) {
        lastError = error;
      }
      await sleep(50);
    }
    if (!this.port || !page) throw new Error(`Chrome DevTools page did not become available: ${lastError?.message ?? "timeout"}`);
    this.cdp = new CdpClient(page.webSocketDebuggerUrl);
    this.targetId = page.id ?? null;
    await this.cdp.connect(this.config.startupTimeoutMs);
    await Promise.all([
      this.cdp.send("Page.enable"),
      this.cdp.send("Runtime.enable"),
      this.cdp.send("DOM.enable")
    ]);
    const navigation = await this.cdp.send("Page.navigate", { url: this.config.url }, this.config.startupTimeoutMs);
    if (navigation.errorText) throw new Error(`Page.navigate failed: ${navigation.errorText}`);
    await this.waitForFunction(
      function () { return document.readyState === "complete" && typeof globalThis.DesmumeMCP?.call === "function"; },
      [],
      this.config.startupTimeoutMs,
      "DeSmuME page API"
    );
    await this.waitForFunction(
      async function () {
        const modelContext = document.modelContext;
        if (!modelContext || typeof modelContext.getTools !== "function" || typeof modelContext.executeTool !== "function") return false;
        const tools = await modelContext.getTools();
        const names = new Set(tools.map((tool) => tool.name));
        return names.has("desmume.list") && names.has("desmume.call") && names.has("desmume.eval") && names.has("desmume.runScript");
      },
      [],
      this.config.startupTimeoutMs,
      "DeSmuME WebMCP tools"
    );
    this.startupActive = false;
  }

  isAlive() {
    return this.chrome?.exitCode === null && this.cdp?.isOpen() === true;
  }

  describe() {
    return {
      isolationId: this.isolationId,
      started: this.chrome !== null || this.cdp !== null,
      alive: this.isAlive(),
      dead: (this.chrome !== null || this.cdp !== null) && !this.isAlive(),
      headless: this.config.headless
    };
  }

  async ensureWindowUsable() {
    if (this.startupActive || this.config.headless || !this.cdp || !this.targetId) return false;
    let current;
    try {
      current = await this.cdp.send("Browser.getWindowForTarget", { targetId: this.targetId }, 2000);
    } catch {
      return false;
    }
    let restored = false;
    if (current?.bounds?.windowState === "minimized") {
      await this.cdp.send("Browser.setWindowBounds", {
        windowId: current.windowId,
        bounds: { windowState: "normal" }
      }, 2000);
      await sleep(50);
      restored = true;
    }
    return restored;
  }

  async #callGlobal(functionDeclaration, args = [], { returnByValue = true, timeoutMs = this.config.commandTimeoutMs } = {}) {
    await this.ensureWindowUsable();
    const globalObject = await this.cdp.send("Runtime.evaluate", { expression: "globalThis", returnByValue: false }, timeoutMs);
    const objectId = globalObject.result?.objectId;
    if (!objectId) throw new Error("Unable to resolve page global object");
    const response = await this.cdp.send("Runtime.callFunctionOn", {
      objectId,
      functionDeclaration,
      arguments: args.map((value) => ({ value })),
      awaitPromise: true,
      returnByValue
    }, timeoutMs);
    if (response.exceptionDetails) {
      const description = response.exceptionDetails.exception?.description ?? response.exceptionDetails.text ?? "page evaluation failed";
      throw new Error(description);
    }
    return response.result;
  }

  async callDirect(command, params = {}, timeoutMs = this.config.commandTimeoutMs) {
    const remote = await this.#callGlobal(
      "async function(command, params) { return await this.DesmumeMCP.call(command, params); }",
      [command, params],
      { returnByValue: true, timeoutMs }
    );
    return remote.value;
  }

  async listCommandsDirect(timeoutMs = this.config.commandTimeoutMs) {
    const remote = await this.#callGlobal(
      "function() { return this.DesmumeMCP.list(); }",
      [],
      { returnByValue: true, timeoutMs }
    );
    return remote.value;
  }

  async callWebMcp(toolName, input = {}, timeoutMs = this.config.commandTimeoutMs) {
    const remote = await this.#callGlobal(
      `async function(toolName, input) {
        const modelContext = document.modelContext;
        if (!modelContext || typeof modelContext.getTools !== 'function' || typeof modelContext.executeTool !== 'function') {
          throw new Error('document.modelContext WebMCP API is unavailable');
        }
        const tools = await modelContext.getTools();
        const matches = tools.filter((tool) => tool.name === toolName);
        if (matches.length !== 1) {
          throw new Error('WebMCP tool ' + JSON.stringify(toolName) + ' resolved to ' + matches.length + ' registrations');
        }
        return await modelContext.executeTool(matches[0], JSON.stringify(input));
      }`,
      [toolName, input],
      { returnByValue: true, timeoutMs }
    );
    return normalizeWebMcpExecution(toolName, remote.value ?? null);
  }

  async downloadCommandToFile(command, params, destinationPath, timeoutMs = this.config.fileTimeoutMs) {
    await this.start();
    if (this.downloadActive) throw new Error("Another managed Chrome download is already active for this emulator instance");
    this.downloadActive = true;
    const absoluteDestination = path.resolve(destinationPath);
    const destinationDirectory = path.dirname(absoluteDestination);
    await mkdir(destinationDirectory, { recursive: true });
    if (await fileExists(absoluteDestination)) {
      this.downloadActive = false;
      throw new Error(`Export destination already exists: ${absoluteDestination}`);
    }
    const temporaryDirectory = await mkdtemp(path.join(destinationDirectory, ".desmume-export-"));
    const expectedFilename = command === "exportStateFile"
      ? "desmume-state.dst"
      : command === "exportSaveFile" ? "desmume-save.sav" : null;
    let downloadGuid = null;
    let suggestedFilename = null;
    let timeout = null;
    let removeBeginListener = () => {};
    let removeProgressListener = () => {};
    try {
      const completed = new Promise((resolve, reject) => {
        timeout = setTimeout(() => reject(new Error(`${command} download did not complete within ${timeoutMs} ms`)), timeoutMs);
        removeBeginListener = this.cdp.onEvent("Browser.downloadWillBegin", (event) => {
          if (expectedFilename && String(event.suggestedFilename ?? "") !== expectedFilename) return;
          if (downloadGuid !== null) return;
          downloadGuid = String(event.guid ?? "");
          suggestedFilename = String(event.suggestedFilename ?? "");
          if (!downloadGuid || !suggestedFilename) reject(new Error(`${command} download metadata was incomplete`));
        });
        removeProgressListener = this.cdp.onEvent("Browser.downloadProgress", (event) => {
          if (!downloadGuid || String(event.guid ?? "") !== downloadGuid) return;
          if (event.state === "completed") resolve();
          else if (event.state === "canceled") reject(new Error(`${command} download was canceled`));
        });
      });
      await this.cdp.send("Browser.setDownloadBehavior", {
        behavior: "allow",
        downloadPath: temporaryDirectory,
        eventsEnabled: true
      }, timeoutMs);
      const result = await this.callDirect(command, params, timeoutMs);
      if (result?.ok === false) {
        throw new Error(`${command}: ${result.error?.message ?? "application error"}`);
      }
      await completed;
      const downloadedPath = path.join(temporaryDirectory, suggestedFilename);
      const info = await stat(downloadedPath);
      if (!info.isFile()) throw new Error(`${command} download did not produce a regular file`);
      await rename(downloadedPath, absoluteDestination);
      return { result, path: absoluteDestination, bytes: info.size };
    } finally {
      if (timeout) clearTimeout(timeout);
      removeBeginListener();
      removeProgressListener();
      await this.cdp?.send("Browser.setDownloadBehavior", { behavior: "default", eventsEnabled: false }, 2000).catch(() => {});
      await rm(temporaryDirectory, { recursive: true, force: true }).catch(() => {});
      this.downloadActive = false;
    }
  }

  async snapshotElements() {
    const remote = await this.#callGlobal(`function() {
      const controls = [...document.querySelectorAll('input, button, select, textarea, a, [role="button"], [role="tab"]')];
      const normalize = (text) => String(text ?? '').replace(/\\s+/g, ' ').trim();
      return controls.map((element, index) => {
        const label = element.closest('label');
        const target = element.type === 'file' && label ? label : element;
        const rect = target.getBoundingClientRect();
        return {
          index,
          tag: element.tagName.toLowerCase(),
          type: element.getAttribute('type') || '',
          role: element.getAttribute('role') || '',
          id: element.id || '',
          label: normalize(label?.textContent || element.getAttribute('aria-label') || element.textContent),
          accept: element.getAttribute('accept') || '',
          disabled: !!element.disabled,
          x: Math.round(rect.x),
          y: Math.round(rect.y),
          width: Math.round(rect.width),
          height: Math.round(rect.height)
        };
      });
    }`);
    return remote.value;
  }

  async uploadFileByLabel(label, filePath) {
    const absolute = await requireLocalFile(filePath);
    const remote = await this.#callGlobal(`function(requestedLabel) {
      const normalize = (text) => String(text ?? '').replace(/\\s+/g, ' ').trim().toLowerCase();
      const wanted = normalize(requestedLabel);
      const inputs = [...document.querySelectorAll('input[type="file"]')];
      const matches = inputs.filter((input) => normalize(input.closest('label')?.textContent) === wanted);
      if (matches.length !== 1) return null;
      return matches[0];
    }`, [label], { returnByValue: false, timeoutMs: this.config.fileTimeoutMs });
    if (!remote.objectId) throw new Error(`File input with label ${JSON.stringify(label)} was not uniquely found in the current page snapshot`);
    try {
      const described = await this.cdp.send("DOM.describeNode", { objectId: remote.objectId }, this.config.fileTimeoutMs);
      const backendNodeId = described.node?.backendNodeId;
      if (!backendNodeId) throw new Error(`Unable to resolve file input for ${label}`);
      await this.cdp.send("DOM.setFileInputFiles", { files: [absolute], backendNodeId }, this.config.fileTimeoutMs);
      return absolute;
    } finally {
      await this.cdp.send("Runtime.releaseObject", { objectId: remote.objectId }).catch(() => {});
    }
  }

  async waitForFunction(functionDeclaration, args = [], timeoutMs = 30000, label = "page condition") {
    const deadline = Date.now() + timeoutMs;
    let lastError = null;
    while (Date.now() < deadline) {
      try {
        const remote = await this.#callGlobal(functionDeclaration.toString(), args, { returnByValue: true, timeoutMs: Math.min(5000, timeoutMs) });
        if (remote.value) return true;
      } catch (error) {
        lastError = error;
      }
      await sleep(25);
    }
    throw new Error(`${label} did not become ready within ${timeoutMs} ms${lastError ? `: ${lastError.message}` : ""}`);
  }

  async waitForScriptEditorSource(source, timeoutMs = this.config.fileTimeoutMs) {
    return await this.waitForFunction(function (expected) {
      const labels = [...document.querySelectorAll('label')];
      const label = labels.find((candidate) => String(candidate.textContent ?? '').includes('JavaScript script'));
      const textarea = label?.querySelector('textarea');
      return !!textarea && textarea.value === expected;
    }, [source], timeoutMs, "persistent script editor source");
  }

  async close() {
    const cdp = this.cdp;
    this.cdp = null;
    this.targetId = null;
    this.startupActive = false;
    this.downloadActive = false;
    if (cdp) {
      try {
        await cdp.send("Browser.close", {}, 2000);
      } catch {}
      cdp.close();
    }
    if (this.chrome && this.chrome.exitCode === null) {
      this.chrome.kill();
    }
    this.chrome = null;
  }
}

export { normalizeLabel };
