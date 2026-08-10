import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { HarnessManager } from "./manager.js";
import { compactOutputText } from "./compact-output.js";

const SERVER_NAME = "desmume-webassembly-harness";
const SERVER_VERSION = "0.3.2";
const SUPPORTED_PROTOCOLS = new Set([
  "2025-11-25",
  "2025-06-18",
  "2025-03-26",
  "2024-11-05"
]);

const objectSchema = (properties = {}, required = []) => ({
  type: "object",
  properties,
  ...(required.length ? { required } : {}),
  additionalProperties: false
});

const isolationProperty = {
  type: "string",
  description: "Emulator isolation id. Different ids run in separate Chrome profiles and DevTools ports.",
  minLength: 1,
  maxLength: 64,
  pattern: "^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$",
  default: "default"
};

const timeoutProperty = {
  type: "integer",
  minimum: 1,
  maximum: 600000,
  description: "Operation timeout in milliseconds."
};

const TOOLS = Object.freeze([
  {
    name: "start_analyze",
    description: "Start or reuse an isolated Chrome/DeSmuME instance, snapshot controls, load the configured ROM and caller-supplied State, snapshot again after ROM load, and create the configured analysis baseline.",
    inputSchema: objectSchema({
      isolation_id: isolationProperty,
      state_path: { type: "string", minLength: 1, description: "Local State file to load for this analysis start." }
    }, ["state_path"])
  },
  {
    name: "status",
    description: "Return DeSmuME status through the page's registered desmume.call WebMCP tool.",
    inputSchema: objectSchema({ isolation_id: isolationProperty }),
    annotations: { readOnlyHint: true }
  },
  {
    name: "pause",
    description: "Pause one emulator instance through the page's registered desmume.call WebMCP tool.",
    inputSchema: objectSchema({ isolation_id: isolationProperty })
  },
  {
    name: "resume",
    description: "Resume one emulator instance through the page's registered desmume.call WebMCP tool.",
    inputSchema: objectSchema({ isolation_id: isolationProperty })
  },
  {
    name: "call",
    description: "Call one DeSmuME command. This is internally transported through the registered desmume.call WebMCP tool.",
    inputSchema: objectSchema({
      isolation_id: isolationProperty,
      command: { type: "string", minLength: 1 },
      params: { type: "object", additionalProperties: true },
      timeout_ms: timeoutProperty
    }, ["command"])
  },
  {
    name: "eval",
    description: "Run isolated JavaScript through the page's registered desmume.eval WebMCP tool.",
    inputSchema: objectSchema({
      isolation_id: isolationProperty,
      script: { type: "string" },
      timeout_ms: timeoutProperty
    }, ["script"])
  },
  {
    name: "rerun_script",
    description: "Read a UTF-8 JavaScript file and run it through the page's registered desmume.runScript WebMCP tool.",
    inputSchema: objectSchema({
      isolation_id: isolationProperty,
      path: { type: "string", minLength: 1 },
      timeout_ms: timeoutProperty
    }, ["path"])
  },
  {
    name: "rerun_pscript",
    description: "Stop an existing persistent script with the same explicit name, load the UTF-8 source into the Persistent Scripts editor, then call runLoadedPersistentScript directly without UI-click automation.",
    inputSchema: objectSchema({
      isolation_id: isolationProperty,
      path: { type: "string", minLength: 1 },
      async_mode: { type: "boolean", default: false },
      name: { type: "string", minLength: 1, maxLength: 64 },
      wait_for_registration: { type: "boolean", default: true },
      startup_timeout_ms: timeoutProperty,
      timeout_ms: timeoutProperty
    }, ["path"])
  },
  {
    name: "stop_pscript",
    description: "Stop a persistent script by numeric script_id or script name.",
    inputSchema: objectSchema({
      isolation_id: isolationProperty,
      script_id: { type: "integer", minimum: 1 },
      name: { type: "string", minLength: 1 }
    })
  },
  {
    name: "restart_pscript",
    description: "Restart a persistent script by numeric script_id or script name while preserving its script identity rules.",
    inputSchema: objectSchema({
      isolation_id: isolationProperty,
      script_id: { type: "integer", minimum: 1 },
      name: { type: "string", minLength: 1 },
      wait_for_registration: { type: "boolean", default: true },
      startup_timeout_ms: timeoutProperty
    })
  },
  {
    name: "snapshot_elements",
    description: "Snapshot the current interactive page controls and their positions for one emulator instance.",
    inputSchema: objectSchema({ isolation_id: isolationProperty }),
    annotations: { readOnlyHint: true }
  },
  {
    name: "screenshot",
    description: "Save the DeSmuME 256x384 framebuffer canvas as a new PNG under screenshot_path from harness.toml. This does not capture the browser window.",
    inputSchema: objectSchema({
      isolation_id: isolationProperty,
      name: { type: "string", minLength: 1, description: "Optional PNG file name. Omit it for an automatically numbered frame-NNNNNN.png name." }
    })
  },
  {
    name: "save_baseline",
    description: "Save an analysis baseline for the loaded ROM.",
    inputSchema: objectSchema({
      isolation_id: isolationProperty,
      name: { type: "string", minLength: 1 },
      replace: { type: "boolean" }
    })
  },
  {
    name: "restore_baseline",
    description: "Restore a named analysis baseline after verifying ROM identity.",
    inputSchema: objectSchema({
      isolation_id: isolationProperty,
      name: { type: "string", minLength: 1 }
    })
  },
  {
    name: "list_pscript_mcp",
    description: "List MCP handlers published by running persistent scripts.",
    inputSchema: objectSchema({
      isolation_id: isolationProperty,
      script_id: { type: "integer", minimum: 1 }
    }),
    annotations: { readOnlyHint: true }
  },
  {
    name: "call_pscript_mcp",
    description: "Call one MCP handler published by a persistent script.",
    inputSchema: objectSchema({
      isolation_id: isolationProperty,
      name: { type: "string", minLength: 1 },
      params: { type: "object", additionalProperties: true },
      blocking: { type: "boolean", default: true },
      script_id: { type: "integer", minimum: 1 },
      script_name: { type: "string", minLength: 1 },
      timeout_ms: timeoutProperty
    }, ["name"])
  },
  {
    name: "close_instance",
    description: "Close the Chrome/DeSmuME process associated with one isolation id.",
    inputSchema: objectSchema({ isolation_id: isolationProperty })
  }
]);

function requestId(message) {
  return Object.hasOwn(message, "id") ? message.id : null;
}

function response(id, result) {
  return { jsonrpc: "2.0", id, result };
}

function errorResponse(id, code, message, data) {
  return {
    jsonrpc: "2.0",
    id,
    error: {
      code,
      message,
      ...(data === undefined ? {} : { data })
    }
  };
}

function requireObject(value, label) {
  if (value === undefined) return {};
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  return value;
}

function optionalIsolation(args) {
  const value = args.isolation_id ?? "default";
  if (typeof value !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/u.test(value)) {
    throw new Error("isolation_id must match ^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$");
  }
  return value;
}

function optionalTimeout(args, key, fallback) {
  if (args[key] === undefined) return fallback;
  const value = Number(args[key]);
  if (!Number.isSafeInteger(value) || value < 1 || value > 600000) {
    throw new Error(`${key} must be an integer from 1 through 600000`);
  }
  return value;
}

function scriptSelector(args) {
  const hasId = args.script_id !== undefined;
  const hasName = args.name !== undefined;
  if (hasId === hasName) throw new Error("exactly one of script_id or name is required");
  if (hasId) {
    const id = Number(args.script_id);
    if (!Number.isSafeInteger(id) || id < 1) throw new Error("script_id must be a positive integer");
    return id;
  }
  if (typeof args.name !== "string" || !args.name.trim()) throw new Error("name must be a non-empty string");
  return args.name.trim();
}

function toolResult(value) {
  if (value && typeof value === "object" && !Array.isArray(value)
      && Array.isArray(value.content)) {
    const content = value.content
      .filter((entry) => entry && entry.type === "text" && typeof entry.text === "string")
      .map((entry) => ({ type: "text", text: entry.text }));
    const structuredContent = value.structuredContent;
    if (structuredContent && typeof structuredContent === "object" && !Array.isArray(structuredContent)) {
      return {
        content: content.length ? content : [{ type: "text", text: compactOutputText(structuredContent) }],
        structuredContent,
        isError: value.isError === true
      };
    }
    if (content.length) {
      return { content, isError: value.isError === true };
    }
  }
  if (typeof value === "string") {
    return { content: [{ type: "text", text: value }], isError: false };
  }
  const structured = value && typeof value === "object" && !Array.isArray(value)
    ? value
    : { value };
  return {
    content: [{ type: "text", text: compactOutputText(value) }],
    structuredContent: structured,
    isError: false
  };
}

function toolError(error) {
  return {
    content: [{ type: "text", text: String(error?.message ?? error) }],
    isError: true
  };
}

export class McpHarnessServer {
  constructor({ configPath, managerFactory = (file) => new HarnessManager(file) }) {
    this.configPath = path.resolve(configPath);
    this.manager = managerFactory(this.configPath);
    this.initialized = false;
  }

  async #harness(args) {
    return await this.manager.create(optionalIsolation(args));
  }

  async #callTool(name, rawArguments) {
    const args = requireObject(rawArguments, "tool arguments");
    switch (name) {
      case "start_analyze":
        if (typeof args.state_path !== "string" || !args.state_path.trim()) throw new Error("state_path is required");
        return await this.manager.startAnalyze(optionalIsolation(args), args.state_path);
      case "status":
        return await (await this.#harness(args)).status();
      case "pause":
        return await (await this.#harness(args)).pause();
      case "resume":
        return await (await this.#harness(args)).resume();
      case "call": {
        if (typeof args.command !== "string" || !args.command.trim()) throw new Error("command is required");
        const harness = await this.#harness(args);
        return await harness.call(
          args.command,
          requireObject(args.params, "params"),
          optionalTimeout(args, "timeout_ms", harness.config.commandTimeoutMs)
        );
      }
      case "eval": {
        if (typeof args.script !== "string") throw new Error("script is required");
        const harness = await this.#harness(args);
        return await harness.eval(args.script, optionalTimeout(args, "timeout_ms", harness.config.commandTimeoutMs));
      }
      case "rerun_script": {
        if (typeof args.path !== "string" || !args.path.trim()) throw new Error("path is required");
        const harness = await this.#harness(args);
        return await harness.rerunscript(args.path, optionalTimeout(args, "timeout_ms", harness.config.commandTimeoutMs));
      }
      case "rerun_pscript": {
        if (typeof args.path !== "string" || !args.path.trim()) throw new Error("path is required");
        const harness = await this.#harness(args);
        return await harness.rerunPScript(
          args.path,
          args.async_mode ?? false,
          args.name,
          {
            waitForRegistration: args.wait_for_registration ?? true,
            startupTimeoutMs: optionalTimeout(args, "startup_timeout_ms", 10000),
            timeoutMs: optionalTimeout(args, "timeout_ms", harness.config.commandTimeoutMs)
          }
        );
      }
      case "stop_pscript":
        return await (await this.#harness(args)).stopPscript(scriptSelector(args));
      case "restart_pscript":
        return await (await this.#harness(args)).restartPscript(scriptSelector(args), {
          waitForRegistration: args.wait_for_registration ?? true,
          startupTimeoutMs: optionalTimeout(args, "startup_timeout_ms", 10000)
        });
      case "snapshot_elements":
        return await (await this.#harness(args)).snapshotElements();
      case "screenshot":
        return await (await this.#harness(args)).screenshot(args.name);
      case "save_baseline": {
        const harness = await this.#harness(args);
        return await harness.saveBaseline(args.name ?? harness.config.baselineName, args.replace ?? harness.config.replaceBaseline);
      }
      case "restore_baseline": {
        const harness = await this.#harness(args);
        return await harness.restoreBaseline(args.name ?? harness.config.baselineName);
      }
      case "list_pscript_mcp":
        return await (await this.#harness(args)).listPScriptMcp(args.script_id);
      case "call_pscript_mcp": {
        if (typeof args.name !== "string" || !args.name.trim()) throw new Error("name is required");
        return await (await this.#harness(args)).callPScriptMcp(args.name, requireObject(args.params, "params"), {
          blocking: args.blocking ?? true,
          scriptId: args.script_id,
          scriptName: args.script_name,
          timeoutMs: optionalTimeout(args, "timeout_ms", 60000)
        });
      }
      case "close_instance":
        return { closed: await this.manager.close(optionalIsolation(args)) };
      default:
        throw Object.assign(new Error(`Unknown tool: ${name}`), { protocolCode: -32602 });
    }
  }

  async handle(message) {
    if (!message || typeof message !== "object" || Array.isArray(message) || message.jsonrpc !== "2.0") {
      return errorResponse(null, -32600, "Invalid JSON-RPC request");
    }
    const id = requestId(message);
    if (message.method === "notifications/initialized") {
      this.initialized = true;
      return null;
    }
    if (message.method === "notifications/cancelled") return null;
    if (message.method === "initialize") {
      const requested = message.params?.protocolVersion;
      if (typeof requested !== "string") return errorResponse(id, -32602, "initialize requires protocolVersion");
      const negotiated = SUPPORTED_PROTOCOLS.has(requested) ? requested : "2025-11-25";
      return response(id, {
        protocolVersion: negotiated,
        capabilities: { tools: { listChanged: false } },
        serverInfo: {
          name: SERVER_NAME,
          title: "DeSmuME WebAssembly Harness",
          version: SERVER_VERSION
        },
        instructions: "Pass state_path to every start_analyze call. Reusing an isolation_id reuses its Chrome instance. Use a distinct isolation_id for each simultaneous emulator. screenshot saves only the DeSmuME framebuffer to screenshot_path from harness.toml. eval and rerun_script are transported through the page WebMCP tools; persistent-script lifecycle operations call the documented DeSmuME API directly and never click Run/Update in the UI."
      });
    }
    if (message.method === "ping") return response(id, {});
    if (message.method === "tools/list") return response(id, { tools: TOOLS });
    if (message.method === "tools/call") {
      const name = message.params?.name;
      if (typeof name !== "string") return errorResponse(id, -32602, "tools/call requires a tool name");
      if (!TOOLS.some((tool) => tool.name === name)) return errorResponse(id, -32602, `Unknown tool: ${name}`);
      try {
        return response(id, toolResult(await this.#callTool(name, message.params?.arguments)));
      } catch (error) {
        if (Number.isInteger(error?.protocolCode)) return errorResponse(id, error.protocolCode, error.message);
        return response(id, toolError(error));
      }
    }
    if (id === null) return null;
    return errorResponse(id, -32601, `Method not found: ${message.method}`);
  }

  async close() {
    await this.manager.closeAll();
  }
}

export async function runStdioMcp({
  input = process.stdin,
  output = process.stdout,
  configPath = process.argv[2] || "harness.toml",
  managerFactory
} = {}) {
  const server = new McpHarnessServer({ configPath, managerFactory });
  let buffered = "";
  input.setEncoding?.("utf8");
  const write = (message) => output.write(`${JSON.stringify(message)}\n`);
  try {
    for await (const chunk of input) {
      buffered += chunk;
      for (;;) {
        const newline = buffered.indexOf("\n");
        if (newline < 0) break;
        const line = buffered.slice(0, newline).replace(/\r$/u, "");
        buffered = buffered.slice(newline + 1);
        if (!line.trim()) continue;
        let message;
        try {
          message = JSON.parse(line);
        } catch (error) {
          write(errorResponse(null, -32700, "Parse error", { message: String(error.message) }));
          continue;
        }
        const result = await server.handle(message);
        if (result) write(result);
      }
    }
    if (buffered.trim()) {
      try {
        const result = await server.handle(JSON.parse(buffered));
        if (result) write(result);
      } catch (error) {
        write(errorResponse(null, -32700, "Parse error", { message: String(error.message) }));
      }
    }
  } finally {
    await server.close();
  }
}

const executedDirectly = process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));
if (executedDirectly) {
  runStdioMcp().catch((error) => {
    process.stderr.write(`${String(error?.stack ?? error)}\n`);
    process.exitCode = 1;
  });
}

export { TOOLS, SUPPORTED_PROTOCOLS };
