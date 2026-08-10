import path from "node:path";
import { loadHarnessConfig } from "./config.js";
import { DesmumeHarness } from "./desmume-harness.js";

export class HarnessManager {
  constructor(configPath) {
    this.configPath = path.resolve(configPath);
    this.instances = new Map();
  }

  async create(isolationId = "default") {
    const existing = this.instances.get(isolationId);
    if (existing) return existing;
    const config = await loadHarnessConfig(this.configPath, isolationId);
    const harness = new DesmumeHarness({ isolationId, config });
    this.instances.set(isolationId, harness);
    return harness;
  }

  async startAnalyze(isolationId = "default", statePath) {
    return await (await this.create(isolationId)).startAnalyze(statePath);
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
  }
}
