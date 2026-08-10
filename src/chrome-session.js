import { access, mkdir, readFile, stat } from "node:fs/promises";
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

export class ChromeSession {
  constructor({ isolationId, config }) {
    assertIsolationId(isolationId);
    this.isolationId = isolationId;
    this.config = config;
    this.profileDir = path.join(config.profileRoot, isolationId);
    this.chrome = null;
    this.cdp = null;
    this.port = null;
  }

  async start() {
    if (this.cdp) return;
    await mkdir(this.profileDir, { recursive: true });
    const chromePath = await findChrome(this.config.chromePath);
    const args = [
      `--user-data-dir=${this.profileDir}`,
      "--remote-debugging-port=0",
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
  }

  async #callGlobal(functionDeclaration, args = [], { returnByValue = true, timeoutMs = this.config.commandTimeoutMs } = {}) {
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

  async callMcp(command, params = {}, timeoutMs = this.config.commandTimeoutMs) {
    const remote = await this.#callGlobal(
      "async function(command, params) { return await this.DesmumeMCP.call(command, params); }",
      [command, params],
      { returnByValue: true, timeoutMs }
    );
    return remote.value;
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
