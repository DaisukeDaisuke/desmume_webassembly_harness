import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { HarnessManager } from "./manager.js";
import { compactOutputText } from "./compact-output.js";

const SERVER_NAME = "desmume-webassembly-harness";
const SERVER_VERSION = "0.5.0";
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
  description: "Existing emulator isolation id. Omit only when exactly one instance exists.",
  minLength: 1,
  maxLength: 64,
  pattern: "^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$"
};

const startIsolationProperty = {
  ...isolationProperty,
  description: "New emulator isolation id. Omit to create the default lane.",
  default: "default"
};

const existingIsolationProperty = isolationProperty;

const timeoutProperty = {
  type: "integer",
  minimum: 1,
  maximum: 600000,
  description: "Operation timeout in milliseconds."
};

const TOOLS = Object.freeze([
  {
    name: "start_analyze",
    description: "Create a new Chrome/DeSmuME lane, load ROM plus one State/Save, save the analysis baseline, and return compact run state. If the lane already exists, use restart_analyze.",
    inputSchema: objectSchema({
      isolation_id: startIsolationProperty,
      state_path: { type: "string", minLength: 1, description: "Local State file to load for this analysis start." },
      save_path: { type: "string", minLength: 1, description: "Local .sav/.dsv file to load instead of a State." }
    }, [])
  },
  {
    name: "restart_analyze",
    description: "Reuse an existing Chrome window, load one State/Save, refresh the analysis baseline, and return compact run state.",
    inputSchema: objectSchema({
      isolation_id: existingIsolationProperty,
      state_path: { type: "string", minLength: 1 },
      save_path: { type: "string", minLength: 1 }
    })
  },
  {
    name: "list_instances",
    description: "List managed emulator lanes without creating Chrome. Results are bounded.",
    inputSchema: objectSchema({}),
    annotations: { readOnlyHint: true }
  },
  {
    name: "list_commands",
    description: "Read the runtime DesmumeMCP.list() inventory with bounded paging; names only by default.",
    inputSchema: objectSchema({
      isolation_id: existingIsolationProperty,
      filter: { type: "string", maxLength: 128 },
      offset: { type: "integer", minimum: 0, default: 0 },
      limit: { type: "integer", minimum: 1, maximum: 64, default: 64 },
      include_descriptions: { type: "boolean", default: false }
    }),
    annotations: { readOnlyHint: true }
  },
  {
    name: "load_state_file",
    description: "Load one local State into an existing lane without creating another Chrome window.",
    inputSchema: objectSchema({
      isolation_id: existingIsolationProperty,
      path: { type: "string", minLength: 1 }
    }, ["path"])
  },
  {
    name: "load_save_file",
    description: "Load one local Save into an existing lane without creating another Chrome window.",
    inputSchema: objectSchema({
      isolation_id: existingIsolationProperty,
      path: { type: "string", minLength: 1 }
    }, ["path"])
  },
  {
    name: "export_state_file",
    description: "Export the current State into export_path without returning State bytes.",
    inputSchema: objectSchema({
      isolation_id: existingIsolationProperty,
      name: { type: "string", minLength: 1, maxLength: 255 }
    })
  },
  {
    name: "export_save_file",
    description: "Export the current Save into export_path without returning Save bytes.",
    inputSchema: objectSchema({
      isolation_id: existingIsolationProperty,
      name: { type: "string", minLength: 1, maxLength: 255 }
    })
  },
  {
    name: "status",
    description: "Return DeSmuME status through the page's registered desmume.call WebMCP tool.",
    inputSchema: objectSchema({ isolation_id: isolationProperty }),
    annotations: { readOnlyHint: true }
  },
  {
    name: "direct_status",
    description: "Return DeSmuME status through the documented direct page API without the inner WebMCP transport layer.",
    inputSchema: objectSchema({ isolation_id: isolationProperty }),
    annotations: { readOnlyHint: true }
  },
  {
    name: "analysis_context",
    description: "Return bounded live emulator context from browser APIs, not harness-tracked State/script paths.",
    inputSchema: objectSchema({
      isolation_id: isolationProperty,
      include_breakpoints: { type: "boolean", default: false, description: "Include the current breakpoint list only when explicitly needed." }
    }),
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
    description: "Load the UTF-8 source into the Persistent Scripts editor, then call runLoadedPersistentScript directly without UI-click automation. Same-name replacement is delegated to the page's update path so script-only breakpoint traps can be released correctly.",
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
    name: "rerun_pscript_console",
    description: "Read one local persistent-script source, start it through runPersistentScript, then return its startup summary and latest console print lines in the same MCP call.",
    inputSchema: objectSchema({
      isolation_id: isolationProperty,
      path: { type: "string", minLength: 1 },
      async_mode: { type: "boolean", default: false },
      name: { type: "string", minLength: 1, maxLength: 64 },
      wait_for_registration: { type: "boolean", default: true },
      startup_timeout_ms: timeoutProperty,
      timeout_ms: timeoutProperty,
      max: { type: "integer", minimum: 1, maximum: 1000, default: 20 }
    }, ["path"])
  },
  {
    name: "script_console",
    description: "Return the latest print/printf console lines for one running persistent script through direct listScriptPrint.",
    inputSchema: objectSchema({
      isolation_id: isolationProperty,
      script_id: { type: "integer", minimum: 1 },
      max: { type: "integer", minimum: 1, maximum: 1000, default: 20 }
    }, ["script_id"]),
    annotations: { readOnlyHint: true }
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
    name: "inject_bytes_file",
    description: "Inject the exact bytes from one absolute local file into emulated memory at the requested starting address.",
    inputSchema: objectSchema({
      isolation_id: isolationProperty,
      address: { oneOf: [{ type: "integer", minimum: 0, maximum: 4294967295 }, { type: "string", minLength: 1 }] },
      file_path: { type: "string", minLength: 1, description: "Absolute path to a file of at most 1 MiB." },
      cpu: { type: "string", enum: ["arm9", "arm7"] }
    }, ["address", "file_path"])
  },
  {
    name: "close_instance",
    description: "Close the Chrome/DeSmuME process associated with one isolation id.",
    inputSchema: objectSchema({ isolation_id: isolationProperty })
  },
  {
    name: "close_all_sessions",
    description: "Close every Chrome/DeSmuME session managed by this MCP process, including kill fallback for managed Chrome children.",
    inputSchema: objectSchema({})
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

function optionalExistingIsolation(args) {
  if (args.isolation_id === undefined) return undefined;
  const value = args.isolation_id;
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

  #harness(args) {
    return this.manager.requireExisting(optionalExistingIsolation(args));
  }

  #existingHarness(args) {
    return this.manager.requireExisting(optionalExistingIsolation(args));
  }

  async #callTool(name, rawArguments) {
    const args = requireObject(rawArguments, "tool arguments");
    switch (name) {
      case "start_analyze":
        if ((args.state_path === undefined) === (args.save_path === undefined)) {
          throw new Error("exactly one of state_path or save_path is required");
        }
        if (args.state_path !== undefined && (typeof args.state_path !== "string" || !args.state_path.trim())) throw new Error("state_path must be a non-empty string");
        if (args.save_path !== undefined && (typeof args.save_path !== "string" || !args.save_path.trim())) throw new Error("save_path must be a non-empty string");
        return await this.manager.startAnalyze(optionalIsolation(args), {
          statePath: args.state_path,
          savePath: args.save_path
        });
      case "restart_analyze":
        if ((args.state_path === undefined) === (args.save_path === undefined)) {
          throw new Error("exactly one of state_path or save_path is required");
        }
        if (args.state_path !== undefined && (typeof args.state_path !== "string" || !args.state_path.trim())) throw new Error("state_path must be a non-empty string");
        if (args.save_path !== undefined && (typeof args.save_path !== "string" || !args.save_path.trim())) throw new Error("save_path must be a non-empty string");
        return await this.manager.restartAnalyze(optionalExistingIsolation(args), {
          statePath: args.state_path,
          savePath: args.save_path
        });
      case "list_instances":
        return this.manager.listInstances();
      case "list_commands":
        return await this.#existingHarness(args).listCommands({
          filter: args.filter ?? "",
          offset: args.offset ?? 0,
          limit: args.limit ?? 64,
          includeDescriptions: args.include_descriptions ?? false
        });
      case "load_state_file":
        if (typeof args.path !== "string" || !args.path.trim()) throw new Error("path is required");
        return await this.#existingHarness(args).loadStateFile(args.path);
      case "load_save_file":
        if (typeof args.path !== "string" || !args.path.trim()) throw new Error("path is required");
        return await this.#existingHarness(args).loadSaveFile(args.path);
      case "export_state_file":
        return await this.#existingHarness(args).exportStateFile(args.name);
      case "export_save_file":
        return await this.#existingHarness(args).exportSaveFile(args.name);
      case "status":
        return await (await this.#harness(args)).status();
      case "direct_status":
        return await (await this.#harness(args)).directStatus();
      case "analysis_context":
        return await (await this.#harness(args)).analysisContext({
          includeBreakpoints: args.include_breakpoints ?? false
        });
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
      case "rerun_pscript_console": {
        if (typeof args.path !== "string" || !args.path.trim()) throw new Error("path is required");
        const harness = await this.#harness(args);
        const max = args.max === undefined ? 20 : Number(args.max);
        if (!Number.isSafeInteger(max) || max < 1 || max > 1000) throw new Error("max must be an integer from 1 through 1000");
        return await harness.rerunPScriptConsole(
          args.path,
          args.async_mode ?? false,
          args.name,
          {
            waitForRegistration: args.wait_for_registration ?? true,
            startupTimeoutMs: optionalTimeout(args, "startup_timeout_ms", 10000),
            timeoutMs: optionalTimeout(args, "timeout_ms", harness.config.commandTimeoutMs),
            max
          }
        );
      }
      case "script_console": {
        const scriptId = Number(args.script_id);
        if (!Number.isSafeInteger(scriptId) || scriptId < 1) throw new Error("script_id must be a positive integer");
        const max = args.max === undefined ? 20 : Number(args.max);
        if (!Number.isSafeInteger(max) || max < 1 || max > 1000) throw new Error("max must be an integer from 1 through 1000");
        return await (await this.#harness(args)).scriptConsole(scriptId, max);
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
      case "inject_bytes_file": {
        if (typeof args.file_path !== "string" || !args.file_path.trim()) throw new Error("file_path is required");
        return await (await this.#harness(args)).injectBytesFile(args.file_path, args.address, args.cpu);
      }
      case "close_instance": {
        const harness = this.manager.requireExisting(optionalExistingIsolation(args));
        return { closed: await this.manager.close(harness.isolationId) };
      }
      case "close_all_sessions":
        return { closed: await this.manager.closeAll() };
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
        instructions: "Use start_analyze only to create a new lane. Use list_instances then restart_analyze to reuse an existing Chrome window; restart_analyze may omit isolation_id only when exactly one lane exists. A Chrome window closed or crashed by the user is a dead session and is not automatically revived. load_state_file/load_save_file switch local files in an existing lane. export_state_file/export_save_file write under export_path without returning file bytes. list_commands is paged and names-only by default. analysis_context is bounded live browser/emulator state and does not depend on harness-tracked State/script paths. screenshot saves only the DeSmuME framebuffer to screenshot_path."
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
