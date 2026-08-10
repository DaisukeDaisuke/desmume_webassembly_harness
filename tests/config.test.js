import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { parseToml, resolveHarnessConfig } from "../src/config.js";

test("instance config overrides only the selected isolation lane", () => {
  const raw = parseToml(`
url = 'https://example.invalid/desmume/'
rom_path = 'roms\\base.nds'
state_path = 'states\\base.dst'
baseline_name = 'base'
[instances.lane-a]
rom_path = 'roms\\a.nds'
baseline_name = 'lane-a'
[instances.lane-b]
rom_path = 'roms\\b.nds'
baseline_name = 'lane-b'
`);
  const configPath = path.join("C:\\workspace", "harness.toml");
  const laneA = resolveHarnessConfig(raw, configPath, "lane-a");
  const laneB = resolveHarnessConfig(raw, configPath, "lane-b");
  assert.equal(laneA.baselineName, "lane-a");
  assert.equal(laneB.baselineName, "lane-b");
  assert.notEqual(laneA.romPath, laneB.romPath);
  assert.equal(laneA.statePath, laneB.statePath);
});

test("Windows literal paths keep backslashes instead of interpreting escapes", () => {
  const raw = parseToml("rom_path = 'C:\\dq9\\rom.nds'\nstate_path = 'C:\\dq9\\state.dst'");
  assert.equal(raw.rom_path, "C:\\dq9\\rom.nds");
  assert.equal(raw.state_path, "C:\\dq9\\state.dst");
});
