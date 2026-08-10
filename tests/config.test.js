import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { parseToml, resolveHarnessConfig } from "../src/config.js";

test("instance config overrides only the selected isolation lane", () => {
  const raw = parseToml(`
url = 'https://example.invalid/desmume/'
rom_path = 'roms\\base.nds'
screenshot_path = 'shots\\base.png'
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
  assert.equal(laneA.screenshotPath, laneB.screenshotPath);
  assert.equal(Object.hasOwn(laneA, "statePath"), false);
});

test("Windows literal paths keep backslashes instead of interpreting escapes", () => {
  const raw = parseToml("rom_path = 'C:\\dq9\\rom.nds'\nscreenshot_path = 'C:\\dq9\\frame.png'");
  assert.equal(raw.rom_path, "C:\\dq9\\rom.nds");
  assert.equal(raw.screenshot_path, "C:\\dq9\\frame.png");
});

test("state_path is rejected in harness.toml because it is supplied per start_analyze call", () => {
  const raw = parseToml("state_path = 'C:\\dq9\\state.dst'");
  assert.throws(
    () => resolveHarnessConfig(raw, path.join("C:\\workspace", "harness.toml")),
    /pass state_path to start_analyze/u
  );
});

test("default screenshot directory avoids dot-prefixed folders for Codex sandbox access", () => {
  const configPath = path.join("C:\\workspace", "harness.toml");
  const resolved = resolveHarnessConfig({}, configPath);
  assert.equal(resolved.screenshotPath, path.resolve(path.dirname(path.resolve(configPath)), "harness/screenshots"));
  assert.equal(resolved.screenshotPath.includes(`${path.sep}.harness${path.sep}`), false);
});
