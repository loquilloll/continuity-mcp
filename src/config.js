// vendored from opencode-continuity-tool@d3c55ec - local edits marked mcp:
// Persist effective settings rather than reinterpreting another runtime's config root.
import fs from "node:fs/promises"
import path from "node:path"
import os from "node:os"
import { createHash } from "node:crypto"
import { parse, printParseErrorCode } from "jsonc-parser"
const hash = value => createHash("sha256").update(value).digest("hex")
async function load(root) {
  for (const name of ["continuity.jsonc", "continuity.json"]) {
    const file = path.join(root, name)
    let text
    try { text = await fs.readFile(file, "utf8") } catch (e) { if (e.code === "ENOENT") continue; throw e }
    const errors = [], value = parse(text, errors, { allowTrailingComma: true, disallowComments: name.endsWith(".json") })
    const fail = message => { throw new Error(`${file}: ${message}`) }
    if (errors.length) fail(printParseErrorCode(errors[0].error))
    if (!value || typeof value !== "object" || Array.isArray(value)) fail("expected object")
    for (const key of Object.keys(value)) if (!(name.endsWith(".json") ? ["directory"] : ["directory", "distillation"]).includes(key)) fail(`unknown field ${key}`)
    if (name.endsWith(".json") && value.directory === undefined) fail("legacy JSON requires directory")
    if (value.directory !== undefined && (typeof value.directory !== "string" || !value.directory.trim())) fail("invalid directory")
    const d = value.distillation
    // Mirrors the installed forks' cross-provider reasoning-effort convention (options.ts ReasoningEfforts).
    const efforts = ["none", "minimal", "low", "medium", "high", "xhigh", "max"]
    if (d !== undefined) {
      if (!d || typeof d !== "object" || Array.isArray(d)) fail("invalid distillation")
      for (const key of Object.keys(d)) if (!["model", "intervalHours", "reasoning"].includes(key)) fail(`unknown field distillation.${key}`)
      if (d.model !== undefined && (typeof d.model !== "string" || !/^[^\s/]+\/[^\s]+$/.test(d.model))) fail("invalid model")
      if (d.intervalHours !== undefined && (typeof d.intervalHours !== "number" || !Number.isFinite(d.intervalHours) || d.intervalHours <= 0)) fail("invalid intervalHours")
      if (d.reasoning !== undefined && (typeof d.reasoning !== "string" || !efforts.includes(d.reasoning))) fail("invalid distillation.reasoning")
    }
    return { path: file, hash: hash(text), value }
  }
  return { path: path.join(root, "continuity.jsonc"), hash: null, value: {} }
}
export async function loadConfig({ workspace, globalConfigRoot }) {
  workspace = await fs.realpath(workspace)
  if (!globalConfigRoot) throw new Error("verified globalConfigRoot required")
  const global = await load(path.resolve(globalConfigRoot)), local = await load(path.join(workspace, ".opencode"))
  let directory = (local.value.directory ?? global.value.directory ?? "docs").trim()
  if (directory.startsWith("~")) {
    if (directory !== "~" && !directory.startsWith("~/")) throw new Error(`${local.path}: unsupported home directory`)
    directory = path.join(os.homedir(), directory.slice(2))
  }
  const snapshot = { workspace, settings: { model: "zai-coding-plan/glm-5.3-flash", intervalHours: 2.5, ...global.value.distillation, ...local.value.distillation }, paths: { global: global.path, workspace: local.path }, hashes: { global: global.hash, workspace: local.hash }, directory: path.resolve(workspace, directory) }
  return { ...snapshot, hash: hash(JSON.stringify(snapshot)) }
}
