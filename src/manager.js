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

  async startAnalyze(isolationId = "default", input) {
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
