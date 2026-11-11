// @ts-nocheck -- ported from upstream bun:test suites; runtime-verified under node:test, kept close to upstream for syncs
import { afterEach, describe, test } from "node:test"
import { expect } from "./expect.ts"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { createScheduler } from "../src/scheduler.js"
import * as storage from "../src/storage.js"
import { hashMemoryContent } from "../src/distill.js"

const fixtures = []
const interval = 2.5 * 3_600_000
const empty = JSON.stringify({ checkpoint: [], proposals: [] })

afterEach(async () => {
  for (const fixture of fixtures.splice(0)) {
    fixture.scheduler?.close()
    await fs.rm(fixture.workspace, { recursive: true, force: true })
  }
})

function fakeTimers(now) {
  let next = 0
  const active = new Map()
  const cleared = []
  return {
    active, cleared,
    clock: () => now,
    setTimer(callback, delay) {
      const handle = { id: ++next, callback, delay, unref() {} }
      active.set(handle.id, handle)
      return handle
    },
    clearTimer(handle) {
      cleared.push(handle.id)
      active.delete(handle.id)
    },
  }
}

async function fixture({ pending = true, generate = async () => empty } = {}) {
  const tempRoot = process.platform === "win32" && process.env.LOCALAPPDATA
    ? path.join(process.env.LOCALAPPDATA, "Temp", "opencode") : os.tmpdir()
  await fs.mkdir(tempRoot, { recursive: true })
  const workspace = await fs.mkdtemp(path.join(tempRoot, "continuity-scheduler-"))
  const f = { workspace }
  fixtures.push(f)
  const scope = await storage.resolveScope({ workspace })
  const now = Date.now()
  const timers = fakeTimers(now)
  const config = { workspace, settings: { model: "test/fake", intervalHours: 2.5 }, paths: {}, hashes: {}, hash: "scheduler-config" }
  const source = { version: 1, sequence: 1, id: "scheduler-source", contentHash: hashMemoryContent("Durable scheduler evidence"),
    timestamp: new Date(now - interval - 60_000).toISOString(), workspace: scope.workspace,
    storeId: scope.storeId, branchKey: scope.branchKey, section: "PROGRESS", provenance: "CODE", plan: null,
    text: "Durable scheduler evidence", line: "- Durable scheduler evidence", config }
  const changeState = (edit) => storage.withStore(scope, async () => {
    const state = await storage.readState(scope)
    edit(state)
    await storage.commit(scope, [{ path: `${scope.branchDir}/state.json`, content: JSON.stringify(state) }])
  })
  await storage.withStore(scope, async () => {
    const state = storage.createBranchState(scope)
    if (pending) {
      Object.assign(state, { pendingCount: 1, nextSequence: 2, oldestPendingSequence: 1,
        firstPendingAt: source.timestamp, nextEligibleAt: new Date(now - 60_000).toISOString(),
        epoch: { revision: 1, workspace: scope.workspace, snapshot: config, configHash: config.hash, anchor: source.timestamp } })
    }
    const writes = [{ path: `${scope.branchDir}/state.json`, content: JSON.stringify(state) }]
    if (pending) writes.push(
      { path: storage.queueFile(scope, "sources", 1), content: JSON.stringify(source) },
      { path: storage.queueFile(scope, "pending", 1), content: JSON.stringify({ sequence: 1, id: source.id, contentHash: source.contentHash }) },
    )
    await storage.commit(scope, writes)
  })
  const reports = []
  let calls = 0
  f.scheduler = createScheduler({ ...timers, generate: async (request) => { calls++; return generate(request) }, report: (error) => reports.push(error) })
  return { ...f, scope, now, timers, reports, changeState, source, calls: () => calls,
    state: () => storage.withStore(scope, () => storage.readState(scope)) }
}

function onlyTimer(f) {
  expect(f.timers.active.size).toBe(1)
  return [...f.timers.active.values()][0]
}

describe("durable branch scheduler", () => {
  test("overlapping arms install one timer and close fences in-flight arms", async () => {
    const f = await fixture()
    await Promise.all([f.scheduler.remember(f.scope, "one"), f.scheduler.remember(f.scope, "two")])
    expect(f.timers.active.size).toBe(1)
    const inFlight = f.scheduler.remember(f.scope, "three")
    f.scheduler.close()
    await inFlight
    expect(f.timers.active.size).toBe(0)
    expect(f.calls()).toBe(0)
  }, 30_000)

  test("clean branches arm no timer and never generate on idle", async () => {
    const f = await fixture({ pending: false })
    await f.scheduler.remember(f.scope, "clean-session")
    expect(f.timers.active.size).toBe(0)
    await f.scheduler.status("clean-session", true)
    expect(f.calls()).toBe(0)
    expect(f.timers.active.size).toBe(0)
    expect((await f.state()).pendingCount).toBe(0)
  }, 30_000)

  test("any busy session defers generation until the entire branch is idle", async () => {
    const f = await fixture()
    await f.scheduler.remember(f.scope, "busy-session")
    await f.scheduler.remember(f.scope, "idle-session", true)
    await f.scheduler.status("idle-session", true)
    expect(f.calls()).toBe(0)
    expect((await f.state()).pendingCount).toBe(1)
    const timer = onlyTimer(f)
    expect(Number.isFinite(timer.delay)).toBe(true)
    expect(timer.delay).toBeGreaterThanOrEqual(60_000)
    await f.scheduler.status("busy-session", true)
    expect(f.calls()).toBe(1)
    expect((await f.state()).pendingCount).toBe(0)
  }, 30_000)

  test("an unexpired claim waits for its deadline even when eligibility is overdue", async () => {
    const f = await fixture()
    await f.changeState((state) => {
      // A foreign live owner writes a complete claim; the scheduler must only respect its deadline.
      state.claim = { token: "another-process", pid: 999999, processStart: "foreign-start",
        startedAt: new Date(f.now).toISOString(), deadline: new Date(f.now + 300000).toISOString(),
        configHash: f.scope.storeId, epochRevision: state.epoch.revision, checkpointRevision: state.checkpoint.revision,
        sharedRevision: 0, batch: [{ sequence: 1, id: f.source.id, contentHash: f.source.contentHash }] }
    })
    await f.scheduler.remember(f.scope, "claim-session", true)
    const timer = onlyTimer(f)
    expect(Number.isFinite(timer.delay)).toBe(true)
    expect(timer.delay).toBeGreaterThanOrEqual(300_000)
    expect(timer.delay).toBeLessThanOrEqual(301_000)
    await f.scheduler.status("claim-session", true)
    expect(f.calls()).toBe(0)
    expect(onlyTimer(f).delay).toBeGreaterThanOrEqual(300_000)
    expect((await f.state()).claim.token).toBe("another-process")
  }, 30_000)

  test("close clears injected timers and stale callbacks cannot generate or rearm", async () => {
    const f = await fixture()
    await f.scheduler.remember(f.scope, "closing-session")
    const timer = onlyTimer(f)
    f.scheduler.close()
    expect(f.timers.cleared).toContain(timer.id)
    expect(f.timers.active.size).toBe(0)
    timer.callback()
    await f.scheduler.status("closing-session", true)
    await f.scheduler.remember(f.scope, "new-session", true)
    expect(f.calls()).toBe(0)
    expect(f.timers.active.size).toBe(0)
  }, 30_000)

  test("remember then repeated idle events commit exactly one durable run", async () => {
    const f = await fixture()
    await f.scheduler.remember(f.scope, "once-session")
    expect(f.calls()).toBe(0)
    await Promise.all([f.scheduler.status("once-session", true), f.scheduler.status("once-session", true)])
    await f.scheduler.status("once-session", true)
    await f.scheduler.remember(f.scope, "once-session", true)
    expect(f.calls()).toBe(1)
    const state = await f.state()
    expect(state.pendingCount).toBe(0)
    expect(state.reviewedCount).toBe(1)
    expect(state.claim).toBeNull()
    expect(state.lastSuccessAt).toBeTruthy()
    expect(await storage.readJson(storage.pendingPath(f.scope, 1))).toBeNull()
    const reviewed = await storage.readJson(storage.reviewedPath(f.scope, 1))
    expect(reviewed).toMatchObject({ id: f.source.id, contentHash: f.source.contentHash })
    const batches = await fs.readdir(path.join(f.scope.storeRoot, "history", "batches"))
    expect(batches).toHaveLength(1)
    expect(f.timers.active.size).toBe(0)
  }, 30_000)

  test("generation errors keep evidence pending and schedule a slow durable retry", async () => {
    const f = await fixture({ generate: async () => { throw new Error("model unavailable") } })
    await f.scheduler.remember(f.scope, "error-session")
    await f.scheduler.status("error-session", true)
    expect(f.calls()).toBe(1)
    const state = await f.state()
    expect(state.pendingCount).toBe(1)
    expect(state.reviewedCount).toBe(0)
    expect(state.claim).toBeNull()
    expect(state.error.message).toContain("model unavailable")
    expect(Date.parse(state.nextEligibleAt)).toBeGreaterThanOrEqual(f.now + interval)
    expect(await storage.readJson(storage.pendingPath(f.scope, 1))).toMatchObject({ id: f.source.id })
    const timer = onlyTimer(f)
    expect(Number.isFinite(timer.delay)).toBe(true)
    expect(timer.delay).toBeGreaterThanOrEqual(interval)
    await f.scheduler.status("error-session", true)
    expect(f.calls()).toBe(1)
    expect(onlyTimer(f).delay).toBeGreaterThanOrEqual(interval)
  }, 30_000)
})
