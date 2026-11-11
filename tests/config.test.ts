// @ts-nocheck -- ported from upstream bun:test suites; runtime-verified under node:test, kept close to upstream for syncs
import { test } from "node:test"
import { expect } from "./expect.ts"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { loadConfig } from "../src/config.js"
async function fixture(run) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "continuity-config-")), workspace = path.join(root, "workspace"), globalConfigRoot = path.join(root, "global")
  await fs.mkdir(path.join(workspace, ".opencode"), { recursive: true }); await fs.mkdir(globalConfigRoot)
  try { await run({ workspace, globalConfigRoot }) } finally { await fs.rm(root, { recursive: true, force: true }) }
}
test("defaults explicit; nested settings inherit; snapshots reflect bytes", () => fixture(async input => {
  const defaults = await loadConfig(input)
  expect(defaults.settings.intervalHours).toBe(2.5)
  await fs.writeFile(path.join(input.globalConfigRoot, "continuity.jsonc"), '{ // global\n"distillation":{"model":"provider/model","intervalHours":4,},"directory":"legacy",}')
  await fs.writeFile(path.join(input.workspace, ".opencode/continuity.jsonc"), '{"distillation":{"intervalHours":0.25,"reasoning":"low"}}')
  const snapshot = await loadConfig(input)
  expect(snapshot.settings).toEqual({ model: "provider/model", intervalHours: 0.25, reasoning: "low" })
  expect(snapshot.directory).toBe(path.join(input.workspace, "legacy"))
  expect(snapshot.hash).not.toBe(defaults.hash)
  expect(snapshot.hashes.global).toHaveLength(64)
}))
test("JSON fallback only when JSONC absent; malformed JSONC blocks", () => fixture(async input => {
  await fs.writeFile(path.join(input.globalConfigRoot, "continuity.json"), '{"directory":"old"}')
  expect((await loadConfig(input)).directory).toBe(path.join(input.workspace, "old"))
  await fs.writeFile(path.join(input.globalConfigRoot, "continuity.jsonc"), "{")
  await expect(loadConfig(input)).rejects.toThrow("continuity.jsonc")
}))
test("invalid fields and values report filenames", () => fixture(async input => {
  for (const value of [{ other: true }, { distillation: { model: "missing-provider" } }, { distillation: { intervalHours: 0 } }, { distillation: { intervalHours: "2" } }, { distillation: { reasoning: "sometimes" } }, { distillation: { extra: 1 } }, { directory: "" }]) {
    await fs.writeFile(path.join(input.globalConfigRoot, "continuity.jsonc"), JSON.stringify(value))
    await expect(loadConfig(input)).rejects.toThrow("continuity.jsonc")
  }
}))
