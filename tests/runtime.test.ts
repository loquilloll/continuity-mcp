// @ts-nocheck -- ported from upstream bun:test suites; runtime-verified under node:test, kept close to upstream for syncs
import { afterEach, describe, test } from "node:test"
import { expect } from "./expect.ts"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { execFileSync } from "node:child_process"
import { continuityScope, executeContinuity } from "../src/runtime.js"

const roots = []
const git = (cwd, ...args) => execFileSync("git", args, {
  cwd, encoding: "utf8", env: { ...process.env, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: path.join(path.dirname(cwd), "empty.gitconfig") },
}).trim()

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })))
})

async function fixture() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "continuity-runtime-"))
  roots.push(root)
  const repo = path.join(root, "repo")
  const globalConfigRoot = path.join(root, "global-config")
  await fs.mkdir(repo)
  await fs.mkdir(globalConfigRoot)
  await fs.writeFile(path.join(root, "empty.gitconfig"), "")
  git(repo, "init", "-b", "main")
  git(repo, "-c", "user.name=Runtime Test", "-c", "user.email=runtime@example.invalid", "commit", "--allow-empty", "-m", "initial")
  const context = (worktree = repo, sessionID = "runtime-test") => ({ worktree, sessionID })
  const run = (args, worktree = repo, sessionID = "runtime-test") => executeContinuity(args, context(worktree, sessionID), { globalConfigRoot })
  const update = (text, worktree = repo) => run({ command: "update", updates: [{ section: "PROGRESS", provenance: "CODE", text }] }, worktree)
  const read = (worktree = repo, extra = {}) => run({ command: "read", read: { mode: "delta" }, ...extra }, worktree)
  const scope = (worktree = repo, extra = {}) => continuityScope({ command: "read", ...extra }, context(worktree))
  const worktree = async (name, branch, force = false) => {
    const destination = path.join(root, name)
    git(repo, "worktree", "add", ...(force ? ["--force"] : []), destination, branch)
    return destination
  }
  return { root, repo, globalConfigRoot, context, run, update, read, scope, worktree }
}

async function queued(scope, directory) {
  const root = path.join(scope.storeRoot, scope.branchDir, directory)
  const names = (await fs.readdir(root)).filter((name) => name.endsWith(".json")).sort()
  return Promise.all(names.map(async (name) => ({ name, bytes: await fs.readFile(path.join(root, name), "utf8") })))
}

describe("runtime with physical Git workspaces", () => {
  test("branches are isolated, including the same session's delta ledger", async () => {
    const f = await fixture()
    git(f.repo, "branch", "feature")
    const feature = await f.worktree("feature-worktree", "feature")
    await f.update("main-only fact")
    await f.update("feature-only fact", feature)
    expect(await f.read()).toContain("main-only fact")
    expect(await f.read(feature)).toContain("feature-only fact")
    expect(await f.read()).not.toContain("feature-only fact")
    const selected = await f.read(f.repo, { branch: "feature" })
    // The feature ledger is shared across physical workspaces, so use a fresh session.
    expect(selected).not.toContain("main-only fact")
    const fresh = await f.run({ command: "read", branch: "feature", read: { mode: "delta" } }, f.repo, "fresh-reader")
    expect(fresh).toContain("feature-only fact")
    expect(fresh).not.toContain("main-only fact")
    expect((await f.scope()).branchKey).not.toBe((await f.scope(feature)).branchKey)
  })

  test("forced worktrees on the same branch share data and session delivery", async () => {
    const f = await fixture()
    const other = await f.worktree("same-branch", "main", true)
    await f.update("shared branch fact")
    expect((await f.scope(other)).branchKey).toBe((await f.scope()).branchKey)
    expect((await f.scope(other)).storeRoot).toBe((await f.scope()).storeRoot)
    expect(await f.read(other)).toContain("shared branch fact")
    expect(await f.read()).not.toContain("shared branch fact")
    await f.update("written from other workspace", other)
    expect(await f.read()).toContain("written from other workspace")
  })

  test("deleting and reusing a branch name retains its existing memories", async () => {
    const f = await fixture()
    git(f.repo, "switch", "-c", "reused")
    await f.update("retained after branch deletion")
    const before = await f.scope()
    const original = await fs.readFile(before.continuityPath, "utf8")
    git(f.repo, "switch", "main")
    git(f.repo, "branch", "-D", "reused")
    expect(await fs.readFile(before.continuityPath, "utf8")).toBe(original)
    git(f.repo, "switch", "-c", "reused")
    expect((await f.scope()).branchKey).toBe(before.branchKey)
    expect(await f.read()).toContain("retained after branch deletion")
  })

  test("delta pages deliver every source once without marking omitted sources seen", async () => {
    const f = await fixture()
    const texts = Array.from({ length: 48 }, (_, i) => `page-item-${i.toString().padStart(3, "0")} ${"alpha beta gamma delta ".repeat(15)}`)
    await f.run({ command: "update", updates: texts.map((text) => ({ section: "PROGRESS", provenance: "CODE", text })) })
    const pages = []
    for (let i = 0; i < 20; i++) {
      const page = await f.read()
      pages.push(page)
      if (!page.includes("More unseen memories remain")) break
    }
    expect(pages.length).toBeGreaterThan(1)
    expect(pages.at(-1)).not.toContain("More unseen memories remain")
    for (let i = 0; i < texts.length; i++) {
      const marker = `page-item-${i.toString().padStart(3, "0")}`
      expect(pages.filter((page) => page.includes(marker))).toHaveLength(1)
    }
    expect(await f.read()).toBe("No new or changed task memories.")
  })

  test("an oversized imported entry never starves later fitting delta entries", async () => {
    const f = await fixture()
    // Simulate an imported/legacy oversized line plus smaller fitting ones behind it.
    const scope = await f.scope()
    const { withStore, commit } = await import("../src/storage.js")
    const oversized = "oversized ".repeat(6000)
    await f.run({ command: "update", updates: [{ section: "DISCOVERIES", provenance: "CODE", text: "small before" }] })
    await withStore(scope, async () => {
      const content = (await import("node:fs/promises")).readFile(scope.continuityPath, "utf8")
      const lines = ((await content).split(/\r?\n/))
      const index = lines.findIndex((line) => line.startsWith("## [DISCOVERIES]"))
      lines.splice(index + 1, 0, `- 2026-01-01T00:00Z [CODE] ${oversized}`)
      await commit(scope, [{ path: `${scope.branchDir}/CONTINUITY.md`, content: lines.join("\n") }])
    })
    await f.run({ command: "update", updates: [{ section: "DISCOVERIES", provenance: "CODE", text: "small after one" }, { section: "DISCOVERIES", provenance: "CODE", text: "small after two" }] })
    const first = await f.read()
    expect(first).toContain("small after one")
    expect(first).toContain("small after two")
    expect(first).toContain("Blocked memory")
    expect(first).not.toContain("oversized oversized oversized")
    // The blocked entry stays unseen forever; later reads stay quiet about fitting work.
    const second = await f.read()
    expect(second).toContain("Blocked memory")
    expect(second).not.toContain("small after")
  })

  test("search reaches history beyond the read window, across branches and shared, and ids retrieve", async () => {
    const f = await fixture()
    await f.update("ancient-context needle-alpha was handled here")
    await f.run({ command: "update", updates: [{ section: "DISCOVERIES", provenance: "CODE", text: "shared will carry needle-beta after promotion" }] })
    const b = await (async () => { const { execFileSync } = await import("node:child_process"); execFileSync("git", ["branch", "search-b"], { cwd: f.repo }); return f.worktree("wt-search-b", "search-b", true) })()
    await f.run({ command: "update", updates: [{ section: "PROGRESS", provenance: "TOOL", text: "other branch recorded needle-gamma" }] }, b)

    const branchHit = await f.run({ command: "search", query: "needle-alpha" })
    expect(branchHit).toContain("needle-alpha was handled here")
    expect(branchHit).toContain("match for")

    const sharedMiss = await f.run({ command: "search", query: "needle-beta" })
    // Not yet distilled: found as a branch source on main, labeled accordingly.
    expect(sharedMiss).toContain("needle-beta")
    expect(sharedMiss).toContain("[main]")
    expect(await f.run({ command: "search", query: "nothing-matches-this" })).toContain("No matches")

    const all = await f.run({ command: "search", query: "needle", all: true })
    expect(all).toContain("needle-alpha")
    expect(all).toContain("search-b")
    expect(all).toContain("needle-gamma")

    const id = all.split("\n").find((line) => line.includes("needle-gamma"))?.match(/\] ([^:]+):/)?.[1]
    expect(id).toBeTruthy()
    // Cross-branch hits retrieve through the intentional-read branch selector.
    const retrieved = await f.run({ command: "read", branch: "search-b", read: { memoryId: id } })
    expect(retrieved).toContain("needle-gamma")

    await expect(f.run({ command: "search" })).rejects.toThrow("search.query")
    // search has no branch selector: current branch + shared, or all=true.
    await expect(f.run({ command: "search", query: "needle", branch: "other" })).rejects.toThrow("read-only selector")
  })

  test("branch selector is rejected for updates before any store mutation", async () => {
    const f = await fixture()
    await expect(f.run({ command: "update", branch: "other", updates: [{ section: "PROGRESS", provenance: "TOOL", text: "no cross-branch writes" }] })).rejects.toThrow("read-only selector")
  })

  test("search reports result caps and malformed foreign state and identifies deleted long branches", async () => {
    const f = await fixture()
    const branch = `long-${"a".repeat(55)}`
    git(f.repo, "switch", "-c", branch)
    await f.update("long branch searchable fact")
    git(f.repo, "switch", "main")
    git(f.repo, "branch", "-D", branch)
    await f.run({ command: "update", updates: Array.from({ length: 21 }, (_, i) => ({ section: "PROGRESS", provenance: "CODE", text: `cap-match-${i}` })) })
    const scope = await f.scope()
    const later = path.join(scope.storeRoot, scope.branchDir, "sources", "zzzz.json")
    await fs.writeFile(later, "{")
    const capped = await f.run({ command: "search", query: "cap-match" })
    expect(capped).toContain("results truncated")
    expect(capped).not.toContain("malformed data skipped")
    await fs.rm(later)
    const bad = path.join(scope.storeRoot, "branches", "bad-state")
    await fs.mkdir(bad, { recursive: true })
    await fs.writeFile(path.join(bad, "state.json"), "{")
    const found = await f.run({ command: "search", query: "long branch searchable", all: true })
    expect(found).toContain("malformed data skipped")
    expect(found).toContain(`[${branch}]`)
    const id = found.split("\n").find((line) => line.includes("long branch searchable fact"))?.match(/\] ([^:]+):/)?.[1]
    expect(await f.run({ command: "read", branch, read: { memoryId: id } })).toContain("long branch searchable fact")
  })

  test("search sanitizes control characters in displayed records and queries", async () => {
    const f = await fixture()
    const scope = await f.scope()
    const dir = path.join(scope.storeRoot, scope.branchDir, "sources")
    await fs.mkdir(dir, { recursive: true })
    await fs.writeFile(path.join(dir, "malicious.json"), JSON.stringify({ id: "id\n[shared] forged", text: "needle\n[shared] forged\u001b[31m" }))
    const result = await f.run({ command: "search", query: "needle" })
    expect(result).toContain("needle [shared] forged [31m")
    expect(result).not.toMatch(/[\x00-\x09\x0b-\x1f\x7f-\x9f]/)
    expect(result.split("\n")).toHaveLength(2)
    const noMatch = await f.run({ command: "search", query: "absent\n[shared] forged" })
    expect(noMatch.split("\n")).toHaveLength(2)
  })

  test("search reports scan truncation even without matches", async () => {
    const f = await fixture()
    const scope = await f.scope()
    const dir = path.join(scope.storeRoot, scope.branchDir, "sources")
    await fs.mkdir(dir, { recursive: true })
    await Promise.all(Array.from({ length: 5001 }, (_, i) => fs.writeFile(path.join(dir, `${String(i).padStart(5, "0")}.json`), '{"id":"x","text":"other"}')))
    const result = await f.run({ command: "search", query: "absent" })
    expect(result).toContain("No matches")
    expect(result).toContain("scan truncated")
  }, 30000)

  test("legacy archives preserve original bytes and do not change Git status", async () => {
    const f = await fixture()
    await fs.mkdir(path.join(f.repo, "docs"))
    const originals = new Map([
      ["CONTINUITY.md", Buffer.from("# original continuity\r\n\xff", "latin1")],
      ["MEMORY.md", Buffer.from("# original memory\r\n")],
    ])
    for (const [name, bytes] of originals) await fs.writeFile(path.join(f.repo, "docs", name), bytes)
    const before = git(f.repo, "status", "--porcelain", "--untracked-files=all")
    await f.run({ command: "status" })
    await f.update("new data lives outside tracked workspace")
    await f.run({ command: "status" })
    expect(git(f.repo, "status", "--porcelain", "--untracked-files=all")).toBe(before)
    const scope = await f.scope()
    const archive = path.join(scope.storeRoot, "legacy")
    const files = await fs.readdir(archive, { recursive: true })
    for (const [name, bytes] of originals) {
      expect(await fs.readFile(path.join(f.repo, "docs", name))).toEqual(bytes)
      const copies = files.filter((file) => path.basename(file) === name)
      expect(copies).toHaveLength(1)
      expect(await fs.readFile(path.join(archive, copies[0]))).toEqual(bytes)
    }
  })

  test("status and targeted reads do not consume the delta ledger", async () => {
    const f = await fixture()
    await f.update("targetable fact")
    const status = JSON.parse(await f.run({ command: "status" }))
    expect(status.state.pendingCount).toBe(1)
    expect(status.scope.branchKey).toBe((await f.scope()).branchKey)
    const sources = await queued(await f.scope(), "sources")
    const source = JSON.parse(sources[0].bytes)
    const target = await f.run({ command: "read", read: { memoryId: source.id } })
    expect(target).toContain("targetable fact")
    expect(await f.read()).toContain("targetable fact")
    expect(await f.read()).not.toContain("targetable fact")
    expect(await f.run({ command: "read", read: { memoryId: source.id } })).toContain("targetable fact")
    await expect(f.run({ command: "read", read: { memoryId: "missing-memory" } })).rejects.toThrow("Unknown memory ID")
  })

  test("updates retain immutable source metadata and do not enqueue duplicates", async () => {
    const f = await fixture()
    const args = { command: "update", updates: [{ section: "DECISIONS", provenance: "USER", plan: "runtime-plan", text: "immutable decision" }] }
    await f.run(args)
    const scope = await f.scope()
    const original = await queued(scope, "sources")
    expect(original).toHaveLength(1)
    const source = JSON.parse(original[0].bytes)
    expect(source).toMatchObject({ version: 1, section: "DECISIONS", provenance: "USER", plan: "runtime-plan", text: "immutable decision", storeId: scope.storeId, branchKey: scope.branchKey, workspace: scope.workspace })
    expect(source.timestamp).toBeGreaterThan(0)
    expect(source.id).toBeTruthy()
    expect(source.contentHash).toBeTruthy()
    expect(source.config.hash).toBeTruthy()
    await f.run(args)
    expect(await queued(scope, "sources")).toEqual(original)
    expect(await queued(scope, "pending")).toHaveLength(1)
    await f.update("second distinct fact")
    const later = await queued(scope, "sources")
    expect(later).toHaveLength(2)
    expect(later[0]).toEqual(original[0])
    expect(JSON.parse(later[1].bytes).sequence).toBeGreaterThan(source.sequence)
    expect(JSON.parse(await f.run({ command: "status" })).state.pendingCount).toBe(2)
  })
})
