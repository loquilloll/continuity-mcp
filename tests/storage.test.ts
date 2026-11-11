// @ts-nocheck -- ported from upstream bun:test suites; runtime-verified under node:test, kept close to upstream for syncs
import { test } from "node:test"
import { expect } from "./expect.ts"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { promisify } from "node:util"
import { execFile } from "node:child_process"
import { resolveScope, withStore, commit, readText, readState, createBranchState, queueFile, sourcePath, iteratePending } from "../src/storage.js"
const exec = promisify(execFile)
async function fixture(run) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "continuity-storage-"))
  try { await run(await resolveScope({ workspace: root }), root) } finally { await fs.rm(root, { recursive: true, force: true }) }
}
test("abandoned lock candidates never wedge the store; orphan transactions block visibly", () => fixture(async (scope, root) => {
  const lock = path.join(scope.storeRoot, ".lock")
  await fs.mkdir(`${lock}.candidate-deadbeef`, { recursive: true })
  await fs.writeFile(path.join(`${lock}.candidate-deadbeef`, "owner.json"), "partial")
  await withStore(scope, async () => { await commit(scope, [{ path: "shared.md", content: "ok" }]) })
  await withStore(scope, async () => expect(await readText(path.join(scope.storeRoot, "shared.md"))).toBe("ok"))
  const orphan = path.join(scope.storeRoot, "transactions", "orphan-txn")
  await fs.mkdir(orphan, { recursive: true })
  await fs.writeFile(path.join(orphan, "payloads.json"), "{}")
  await expect(withStore(scope, () => {})).rejects.toThrow("Orphaned continuity transaction")
  await fs.rm(orphan, { recursive: true, force: true })
  await withStore(scope, () => {})
  // Committed transaction scratch directories are pruned instead of accumulating forever.
  expect(await fs.readdir(path.join(scope.storeRoot, "transactions"))).toHaveLength(0)
  void root
}))

test("queue is ordered, immutable and state remains bounded", () => fixture(async scope => {
  await withStore(scope, async () => {
    const state = await readState(scope)
    const changes = []
    for (const seq of [2, 1]) {
      const record = { id: `id${seq}`, contentHash: `hash${seq}`, workspace: scope.workspace, text: "source" }
      changes.push({ path: queueFile(scope, "sources", seq), content: JSON.stringify(record) }, { path: queueFile(scope, "pending", seq), content: JSON.stringify({ id: record.id, contentHash: record.contentHash }) })
    }
    state.nextSequence = 3
    state.pendingCount = 2
    state.oldestPendingSequence = 1
    state.firstPendingAt = Date.now()
    changes.push({ path: `${scope.branchDir}/state.json`, content: JSON.stringify(state) })
    await commit(scope, changes)
    const ids = []
    for await (const source of iteratePending(scope)) ids.push(source.id)
    expect(ids).toEqual(["id1", "id2"])
    expect(sourcePath(scope, 1)).toEndWith("000000000001.json")
    await expect(commit(scope, [{ path: queueFile(scope, "sources", 1), content: "changed" }])).rejects.toThrow("Immutable")
  })
}))
test("persisted null and malformed state block all mutations without changing bytes", () => fixture(async scope => {
  const file = path.join(scope.storeRoot, scope.branchDir, "state.json")
  await fs.mkdir(path.dirname(file), { recursive: true })
  const valid = createBranchState(scope)
  for (const state of [null, [], {}, { ...valid, pendingCount: -1 }, { ...valid, pendingCount: 1 }, { ...valid, reviewedCount: "0" }, { ...valid, nextSequence: 1.5 }, { ...valid, identity: { kind: "branch", name: "other" } }, { ...valid, checkpoint: { revision: -1, hash: null } }, { ...valid, conflicts: { revision: 0, hash: null } }, { ...valid, nextEligibleAt: "yesterday" }, { ...valid, epoch: {} }, { ...valid, claim: { token: "sparse", deadline: Date.now() + 300000 } }, { ...valid, error: { message: "oops", at: false } }]) {
    const bytes = JSON.stringify(state)
    await fs.writeFile(file, bytes)
    await expect(readState(scope)).rejects.toThrow("Invalid branch state")
    let entered = false
    await expect(withStore(scope, async () => { entered = true; await commit(scope, [{ path: "shared.md", content: "overwrite" }]) })).rejects.toThrow("Invalid branch state")
    expect(entered).toBe(false)
    expect(await fs.readFile(file, "utf8")).toBe(bytes)
    expect(await readText(path.join(scope.storeRoot, "shared.md"))).toBeNull()
  }
}))
test("full epoch and claim schema accepts numeric or ISO timestamps and rejects corruption", () => fixture(async scope => {
  const make = date => ({ ...createBranchState(scope), nextSequence: 2, pendingCount: 1, oldestPendingSequence: 1, firstPendingAt: date, nextEligibleAt: date,
    epoch: { revision: 1, workspace: scope.workspace, snapshot: { workspace: scope.workspace, settings: { model: "test/model", intervalHours: 2.5 }, paths: {}, hashes: {}, hash: "config" }, configHash: "config", anchor: date },
    claim: { token: "claim", pid: process.pid, processStart: "identity", startedAt: date, deadline: typeof date === "number" ? date + 300000 : new Date(Date.parse(date) + 300000).toISOString(), epochRevision: 1, checkpointRevision: 0, sharedRevision: 0, configHash: "config", batch: [{ sequence: 1, id: "source", contentHash: `sha256:${"a".repeat(64)}` }] } })
  await withStore(scope, async () => {
    for (const date of [Date.now(), new Date().toISOString()]) {
      const state = make(date)
      await commit(scope, [{ path: `${scope.branchDir}/state.json`, content: JSON.stringify(state) }])
      expect((await readState(scope)).claim.startedAt).toBe(date)
      const mutations = [s => { s.claim.pid = 0 }, s => { s.claim.deadline = s.claim.startedAt }, s => { s.claim.batch[0].contentHash = "bad" }, s => { s.claim.batch.push(s.claim.batch[0]) }, s => { s.epoch.snapshot.settings.intervalHours = 0 }, s => { s.epoch.configHash = "different" }]
      for (const mutate of mutations) {
        const invalid = structuredClone(state); mutate(invalid)
        await expect(commit(scope, [{ path: `${scope.branchDir}/state.json`, content: JSON.stringify(invalid) }])).rejects.toThrow("Invalid branch state")
        expect(await readState(scope)).toEqual(state)
      }
    }
  })
}))
test("partial transaction rolls forward before readers; deletes recover", () => fixture(async scope => {
  await expect(withStore(scope, () => commit(scope, [{ path: "shared.md", content: "shared" }, { path: `${scope.branchDir}/checkpoint.md`, content: "checkpoint" }], { failAfter: 1 }))).rejects.toThrow("Injected")
  await withStore(scope, async () => {
    expect(await readText(path.join(scope.storeRoot, "shared.md"))).toBe("shared")
    expect(await readText(path.join(scope.storeRoot, scope.branchDir, "checkpoint.md"))).toBe("checkpoint")
    await commit(scope, [{ path: "shared.md", content: null }])
    expect(await readText(path.join(scope.storeRoot, "shared.md"))).toBeNull()
  })
}))
test("unexpected bytes block recovery without overwriting", () => fixture(async scope => {
  await expect(withStore(scope, () => commit(scope, [{ path: "shared.md", content: "one" }, { path: "other.md", content: "two" }], { failAfter: 1 }))).rejects.toThrow()
  await fs.writeFile(path.join(scope.storeRoot, "shared.md"), "external")
  await expect(withStore(scope, () => {})).rejects.toThrow("Recovery blocked")
  expect(await readText(path.join(scope.storeRoot, "shared.md"))).toBe("external")
}))
test("path traversal rejected and commit requires lock", () => fixture(async scope => {
  await expect(commit(scope, [])).rejects.toThrow("withStore")
  await withStore(scope, async () => {
    for (const name of ["../outside", "C:/outside", "a/../../outside", "transactions/fake", "a\\..\\..\\outside", "a/.. /outside", "NUL", "a/CON.txt"]) await expect(commit(scope, [{ path: name, content: "bad" }])).rejects.toThrow("Unsafe")
  })
}))
test("concurrent callbacks serialize", () => fixture(async scope => {
  let active = 0, maximum = 0
  await Promise.all([1, 2, 3].map(() => withStore(scope, async () => { maximum = Math.max(maximum, ++active); await new Promise(r => setTimeout(r, 30)); active-- })))
  expect(maximum).toBe(1)
}))
test("git worktrees share store, namespace uses full branch identity", () => fixture(async (_, root) => {
  await exec("git", ["init", root])
  const a = await resolveScope({ workspace: root, branch: "feature/a" }), b = await resolveScope({ workspace: root, branch: "feature-a" })
  expect(a.isGit).toBe(true)
  expect(a.storeRoot).toBe(b.storeRoot)
  expect(a.branchKey).not.toBe(b.branchKey)
  expect(a.identity.name).toBe("refs/heads/feature/a")
}))
test("unverifiable lock blocks with bounded wait", () => fixture(async scope => {
  await fs.mkdir(path.join(scope.storeRoot, ".lock"), { recursive: true })
  await expect(withStore(scope, () => { throw new Error("must not enter") }, { timeoutMs: 100 })).rejects.toThrow("Store lock unavailable")
}))
test("dead process lock is recovered conservatively", () => fixture(async scope => {
  await fs.mkdir(path.join(scope.storeRoot, ".lock"), { recursive: true })
  await fs.writeFile(path.join(scope.storeRoot, ".lock/owner.json"), JSON.stringify({ token: "dead", pid: 2147483647, processStart: "old" }))
  await withStore(scope, () => commit(scope, [{ path: "shared.md", content: "recovered" }]))
  expect(await readText(path.join(scope.storeRoot, "shared.md"))).toBe("recovered")
}))
test("legacy Buffer bytes and prior bytes survive transaction recovery exactly", () => fixture(async scope => {
  const bytes = Buffer.from([0, 255, 254, 128, 13, 10, 65]), relative = "legacy/hash/CONTINUITY.md"
  await expect(withStore(scope, () => commit(scope, [{ path: relative, content: bytes }, { path: "shared.md", content: "done" }], { failAfter: 1 }))).rejects.toThrow("Injected")
  await withStore(scope, async () => {
    expect(await fs.readFile(path.join(scope.storeRoot, relative))).toEqual(bytes)
    await commit(scope, [{ path: relative, content: Buffer.from([129, 255]) }])
    expect(await fs.readFile(path.join(scope.storeRoot, relative))).toEqual(Buffer.from([129, 255]))
  })
}))
