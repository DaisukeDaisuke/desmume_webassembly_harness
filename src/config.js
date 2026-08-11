import { readFile } from "node:fs/promises";
import path from "node:path";
import { TextDecoder } from "node:util";

const DEFAULTS = Object.freeze({
  url: "https://daisukedaisuke.github.io/desmume_webassembly/",
  chrome_path: "",
  headless: false,
  startup_timeout_ms: 30000,
  file_timeout_ms: 60000,
  command_timeout_ms: 600000,
  profile_root: ".harness/profiles",
  rom_path: "",
  screenshot_path: "harness/screenshots",
  export_path: "harness/exports",
  baseline_name: "analysis-start",
  replace_baseline: true
});

function stripComment(line) {
  let quote = null;
  let escaped = false;
  for (let i = 0; i < line.length; i += 1) {
    const ch = line[i];
    if (quote === '"' && escaped) {
      escaped = false;
      continue;
    }
    if (quote === '"' && ch === "\\") {
      escaped = true;
      continue;
    }
    if (ch === '"' || ch === "'") {
      if (quote === ch) quote = null;
      else if (quote === null) quote = ch;
      continue;
    }
    if (ch === "#" && quote === null) return line.slice(0, i);
  }
  return line;
}

function findAssignment(line) {
  let quote = null;
  let escaped = false;
  for (let i = 0; i < line.length; i += 1) {
    const ch = line[i];
    if (quote === '"' && escaped) {
      escaped = false;
      continue;
    }
    if (quote === '"' && ch === "\\") {
      escaped = true;
      continue;
    }
    if (ch === '"' || ch === "'") {
      if (quote === ch) quote = null;
      else if (quote === null) quote = ch;
      continue;
    }
    if (ch === "=" && quote === null) return i;
  }
  return -1;
}

function parseValue(raw, lineNumber) {
  const value = raw.trim();
  if (!value) throw new Error(`TOML line ${lineNumber}: value is empty`);
  if (value[0] === "'" && value[value.length - 1] === "'") {
    return value.slice(1, -1);
  }
  if (value[0] === '"' && value[value.length - 1] === '"') {
    try {
      return JSON.parse(value);
    } catch (error) {
      throw new Error(`TOML line ${lineNumber}: invalid quoted string: ${error.message}`);
    }
  }
  if (value === "true") return true;
  if (value === "false") return false;
  const number = Number(value.replaceAll("_", ""));
  if (Number.isFinite(number)) return number;
  throw new Error(`TOML line ${lineNumber}: unsupported value ${value}`);
}

function ensureTable(root, parts, lineNumber) {
  let cursor = root;
  for (const part of parts) {
    if (!part) throw new Error(`TOML line ${lineNumber}: empty table segment`);
    const existing = cursor[part];
    if (existing !== undefined && (existing === null || typeof existing !== "object" || Array.isArray(existing))) {
      throw new Error(`TOML line ${lineNumber}: ${part} is already a scalar value`);
    }
    if (existing === undefined) cursor[part] = {};
    cursor = cursor[part];
  }
  return cursor;
}

export function parseToml(text) {
  const root = {};
  let table = root;
  const lines = text.split(/\r?\n/u);
  for (let index = 0; index < lines.length; index += 1) {
    const lineNumber = index + 1;
    const line = stripComment(lines[index]).trim();
    if (!line) continue;
    if (line.startsWith("[") && line.endsWith("]")) {
      const name = line.slice(1, -1).trim();
      table = ensureTable(root, name.split(".").map((part) => part.trim()), lineNumber);
      continue;
    }
    const equals = findAssignment(line);
    if (equals < 1) throw new Error(`TOML line ${lineNumber}: expected key = value`);
    const key = line.slice(0, equals).trim();
    if (!key) throw new Error(`TOML line ${lineNumber}: key is empty`);
    if (Object.hasOwn(table, key)) throw new Error(`TOML line ${lineNumber}: duplicate key ${key}`);
    table[key] = parseValue(line.slice(equals + 1), lineNumber);
  }
  return root;
}

export function decodeUtf8(buffer, label = "file") {
  if (buffer.length >= 2) {
    const b0 = buffer[0];
    const b1 = buffer[1];
    if ((b0 === 0xff && b1 === 0xfe) || (b0 === 0xfe && b1 === 0xff)) {
      throw new Error(`${label} is UTF-16. This harness accepts UTF-8 only.`);
    }
  }
  if (buffer.length >= 4) {
    const utf32be = buffer[0] === 0x00 && buffer[1] === 0x00 && buffer[2] === 0xfe && buffer[3] === 0xff;
    const utf32le = buffer[0] === 0xff && buffer[1] === 0xfe && buffer[2] === 0x00 && buffer[3] === 0x00;
    if (utf32be || utf32le) throw new Error(`${label} is UTF-32. This harness accepts UTF-8 only.`);
  }
  try {
    const decoded = new TextDecoder("utf-8", { fatal: true }).decode(buffer);
    return decoded.charCodeAt(0) === 0xfeff ? decoded.slice(1) : decoded;
  } catch (error) {
    throw new Error(`${label} is not valid UTF-8: ${error.message}`);
  }
}

export async function readUtf8Text(filePath) {
  return decodeUtf8(await readFile(filePath), filePath);
}

function absoluteFrom(baseDir, value) {
  if (!value) return "";
  return path.isAbsolute(value) ? path.normalize(value) : path.resolve(baseDir, value);
}

function requirePositiveInteger(value, name) {
  if (!Number.isSafeInteger(value) || value < 1) throw new Error(`${name} must be a positive integer`);
  return value;
}

export function resolveHarnessConfig(raw, configPath, isolationId = "default") {
  const baseDir = path.dirname(path.resolve(configPath));
  const instance = raw.instances?.[isolationId] ?? {};
  if (instance === null || typeof instance !== "object" || Array.isArray(instance)) {
    throw new Error(`instances.${isolationId} must be a TOML table`);
  }
  if (Object.hasOwn(raw, "state_path") || Object.hasOwn(instance, "state_path")) {
    throw new Error("state_path is not a harness.toml setting; pass state_path to start_analyze");
  }
  const merged = { ...DEFAULTS, ...raw, ...instance };
  delete merged.instances;
  if (typeof merged.url !== "string" || !merged.url) throw new Error("url must be a non-empty string");
  if (typeof merged.headless !== "boolean") throw new Error("headless must be boolean");
  if (typeof merged.screenshot_path !== "string" || !merged.screenshot_path) throw new Error("screenshot_path must be a non-empty string");
  if (typeof merged.export_path !== "string" || !merged.export_path) throw new Error("export_path must be a non-empty string");
  if (typeof merged.baseline_name !== "string" || !merged.baseline_name) throw new Error("baseline_name must be a non-empty string");
  if (typeof merged.replace_baseline !== "boolean") throw new Error("replace_baseline must be boolean");
  return Object.freeze({
    url: merged.url,
    chromePath: absoluteFrom(baseDir, merged.chrome_path),
    headless: merged.headless,
    startupTimeoutMs: requirePositiveInteger(merged.startup_timeout_ms, "startup_timeout_ms"),
    fileTimeoutMs: requirePositiveInteger(merged.file_timeout_ms, "file_timeout_ms"),
    commandTimeoutMs: requirePositiveInteger(merged.command_timeout_ms, "command_timeout_ms"),
    profileRoot: absoluteFrom(baseDir, merged.profile_root),
    romPath: absoluteFrom(baseDir, merged.rom_path),
    screenshotPath: absoluteFrom(baseDir, merged.screenshot_path),
    exportPath: absoluteFrom(baseDir, merged.export_path),
    baselineName: merged.baseline_name,
    replaceBaseline: merged.replace_baseline
  });
}

export async function loadHarnessConfig(configPath, isolationId = "default") {
  const absolute = path.resolve(configPath);
  const text = await readUtf8Text(absolute);
  return resolveHarnessConfig(parseToml(text), absolute, isolationId);
}
