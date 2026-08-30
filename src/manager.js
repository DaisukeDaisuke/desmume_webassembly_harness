import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { loadHarnessConfig } from "./config.js";
import { DesmumeHarness } from "./desmume-harness.js";

const START_ANALYZE_MAX_ATTEMPTS = 3;
const START_ANALYZE_RETRY_DELAY_MS = 500;

export class HarnessManager {
  constructor(configPath, {
    configLoader = loadHarnessConfig,
    harnessFactory = (options) => new DesmumeHarness(options),
    startAnalyzeMaxAttempts = START_ANALYZE_MAX_ATTEMPTS,
    startAnalyzeRetryDelayMs = START_ANALYZE_RETRY_DELAY_MS
  } = {}) {
    this.configPath = path.resolve(configPath);
    this.instances = new Map();
    this.starting = new Set();
    this.configLoader = configLoader;
    this.harnessFactory = harnessFactory;
    this.startAnalyzeMaxAttempts = startAnalyzeMaxAttempts;
    this.startAnalyzeRetryDelayMs = startAnalyzeRetryDelayMs;
  }

  async create(isolationId = "default") {
    const existing = this.instances.get(isolationId);
    if (existing) return existing;
    const config = await this.configLoader(this.configPath, isolationId);
    const harness = this.harnessFactory({ isolationId, config });
    this.instances.set(isolationId, harness);
    return harness;
  }

  requireExisting(isolationId) {
    if (isolationId !== undefined) {
      const harness = this.instances.get(isolationId);
      if (!harness) throw new Error(`No existing emulator instance for isolation_id ${isolationId}; call start_analyze first`);
      harness.assertUsable?.();
      return harness;
    }
    if (this.instances.size === 1) {
      const harness = this.instances.values().next().value;
      harness.assertUsable?.();
      return harness;
    }
    if (this.instances.size === 0) throw new Error("No existing emulator instances; call start_analyze first");
    const ids = [...this.instances.keys()].slice(0, 16).join(", ");
    throw new Error(`Multiple emulator instances exist; specify isolation_id. Existing ids: ${ids}`);
  }

  async startAnalyze(isolationId = "default", input) {
    const existing = this.instances.get(isolationId);
    if (existing) {
      if (existing.hasFatalRunFrameFault?.()) {
        await this.close(isolationId);
      } else {
        throw new Error(`Emulator instance ${isolationId} already exists; use restart_analyze to reuse its Chrome window`);
      }
    }
    if (this.starting.has(isolationId)) {
      throw new Error(`Emulator instance ${isolationId} is already starting; do not start a second Chrome window`);
    }
    this.starting.add(isolationId);
    try {
      let lastError = null;
      for (let attempt = 1; attempt <= this.startAnalyzeMaxAttempts; attempt += 1) {
        try {
          return await (await this.create(isolationId)).startAnalyze(input);
        } catch (error) {
          lastError = error;
          await this.close(isolationId).catch(() => {});
          if (attempt >= this.startAnalyzeMaxAttempts) break;
          await sleep(this.startAnalyzeRetryDelayMs);
        }
      }
      throw new Error(`start_analyze failed after ${this.startAnalyzeMaxAttempts} fresh Chrome attempts: ${lastError?.message ?? lastError}`);
    } finally {
      this.starting.delete(isolationId);
    }
  }

  async restartAnalyze(isolationId, input) {
    return await this.requireExisting(isolationId).restartAnalyze(input);
  }

  listInstances() {
    const instances = [...this.instances.values()]
      .map((harness) => harness.describe())
      .sort((a, b) => a.isolationId.localeCompare(b.isolationId));
    const selected = instances.slice(0, 64);
    return {
      total: instances.length,
      returned: selected.length,
      truncated: instances.length > selected.length,
      instances: selected
    };
  }

  async close(isolationId) {
    const harness = this.instances.get(isolationId);
    if (!harness) return false;
    this.instances.delete(isolationId);
    await harness.close();
    return true;
  }

  async closeAll() {
    const harnesses = [...this.instances.values()];
    this.instances.clear();
    await Promise.allSettled(harnesses.map((harness) => harness.close()));
    return harnesses.length;
  }
}
