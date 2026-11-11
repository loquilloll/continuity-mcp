// vendored from opencode-continuity-tool@d3c55ec - local edits marked mcp:
// Repository-wide locking and recoverable transactions shared by core and distillation.
import fs from "node:fs/promises"
import path from "node:path"
import { createHash, randomUUID } from "node:crypto"
import { execFile, spawnSync } from "node:child_process"
import { promisify } from "node:util"
import { AsyncLocalStorage } from "node:async_hooks"
const exec = promisify(execFile), locks = new AsyncLocalStorage()
const hash = value => createHash("sha256").update(value).digest("hex")
export async function readText(file, fallback = null) { try { return await fs.readFile(file, "utf8") } catch (e) { if (e.code === "ENOENT") return fallback; throw e } }
async function readBytes(file) { try { return await fs.readFile(file) } catch (e) { if (e.code === "ENOENT") return null; throw e } }
export async function readJson(file, fallback = null) { const text = await readText(file); if (text === null) return fallback; try { return JSON.parse(text) } catch { throw new Error(`Malformed JSON: ${file}`) } }
async function git(workspace, args) { return (await exec("git", ["-C", workspace, ...args])).stdout.trim() }
export async function resolveScope({ workspace, branch }) {
  workspace = await fs.realpath(workspace)
  if (branch !== undefined && (typeof branch !== "string" || !branch.trim())) throw new Error("Invalid branch")
  let common, identity, isGit = true
  try { common = await git(workspace, ["rev-parse", "--path-format=absolute", "--git-common-dir"]) } catch (e) { if (!String(e.stderr).includes("not a git repository")) throw e; isGit = false }
  if (isGit) {
    common = await fs.realpath(common)
    workspace = await fs.realpath(await git(workspace, ["rev-parse", "--show-toplevel"]))
    let symbolic
    try { symbolic = await git(workspace, ["symbolic-ref", "--quiet", "HEAD"]) } catch (e) { if (e.code !== 1) throw e }
    identity = branch !== undefined ? { kind: "branch", name: branch.startsWith("refs/heads/") ? branch : `refs/heads/${branch}` } : symbolic ? { kind: "branch", name: symbolic } : { kind: "detached", name: await git(workspace, ["rev-parse", "HEAD"]) }
  } else identity = { kind: "directory", name: workspace }
  if (!isGit && branch !== undefined) throw new Error("branch selection requires a Git repository")
  const storeRoot = path.join(isGit ? common : workspace, isGit ? "opencode-continuity" : ".opencode-continuity")
  const branchKey = `${identity.name.replace(/[^a-zA-Z0-9-]/g, "-").slice(-40)}-${hash(JSON.stringify(identity))}`, branchDir = `branches/${branchKey}`
  return { workspace, storeRoot, storeId: hash(storeRoot), identity, branchKey, branchDir, isGit, continuityPath: path.join(storeRoot, branchDir, "CONTINUITY.md"), memoryPath: path.join(storeRoot, branchDir, "MEMORY.md") }
}
export function createBranchState(scope) { return { version: 1, revision: 0, identity: scope.identity, nextSequence: 1, pendingCount: 0, reviewedCount: 0, oldestPendingSequence: null, checkpoint: { revision: 0, hash: null }, conflicts: { revision: 0, hash: null, unresolvedCount: 0 }, firstPendingAt: null, lastAttemptAt: null, lastSuccessAt: null, nextEligibleAt: null, epoch: null, claim: null, error: null } }
export const initialState = createBranchState
const object = value => value !== null && typeof value === "object" && !Array.isArray(value)
const integer = value => Number.isSafeInteger(value) && value >= 0
const nonempty = value => typeof value === "string" && value.trim().length > 0
const timestamp = value => typeof value === "number" ? value >= 0 && Number.isFinite(new Date(value).getTime()) : typeof value === "string" && /^\d{4}-\d\d-\d\dT\d\d:\d\d(?::\d\d(?:\.\d{1,3})?)?Z$/.test(value) && Number.isFinite(Date.parse(value)) && new Date(value).toISOString().slice(0, 10) === value.slice(0, 10)
function validateState(scope, state) {
  const fail = field => { throw new Error(`Invalid branch state: ${field}`) }
  if (!object(state)) fail("expected object")
  for (const key of Object.keys(state)) if (!(key in createBranchState(scope))) fail(`unknown field ${key}`)
  if (state.version !== 1 || !object(state.identity) || state.identity.kind !== scope.identity.kind || state.identity.name !== scope.identity.name || Object.keys(state.identity).length !== 2) fail("identity/version")
  for (const key of ["revision", "pendingCount", "reviewedCount"]) if (!integer(state[key])) fail(key)
  if (!integer(state.nextSequence) || state.nextSequence < 1 || state.pendingCount + state.reviewedCount !== state.nextSequence - 1) fail("source counters")
  if (state.pendingCount ? !integer(state.oldestPendingSequence) || state.oldestPendingSequence < 1 || state.oldestPendingSequence >= state.nextSequence : state.oldestPendingSequence !== null) fail("oldestPendingSequence")
  for (const key of ["firstPendingAt", "lastAttemptAt", "lastSuccessAt", "nextEligibleAt"]) if (state[key] !== null && !timestamp(state[key])) fail(key)
  if (state.pendingCount && state.firstPendingAt === null) fail("firstPendingAt")
  for (const key of ["checkpoint", "conflicts"]) {
    const revision = state[key]
    if (!object(revision) || !integer(revision.revision) || !(revision.hash === null || typeof revision.hash === "string" && /^[a-f0-9]{64}$/.test(revision.hash))) fail(key)
  }
  if (!integer(state.conflicts.unresolvedCount)) fail("conflicts.unresolvedCount")
  if (state.epoch !== null) {
    const epoch = state.epoch, snapshot = epoch?.snapshot
    if (!object(epoch) || !integer(epoch.revision) || epoch.revision < 1 || !nonempty(epoch.workspace) || !path.isAbsolute(epoch.workspace) || !nonempty(epoch.configHash) || !timestamp(epoch.anchor)) fail("epoch")
    if (!object(snapshot) || snapshot.workspace !== epoch.workspace || snapshot.hash !== epoch.configHash || !object(snapshot.paths) || !object(snapshot.hashes) || !object(snapshot.settings) || typeof snapshot.settings.model !== "string" || !/^[^\s/]+\/[^\s]+$/.test(snapshot.settings.model) || typeof snapshot.settings.intervalHours !== "number" || !Number.isFinite(snapshot.settings.intervalHours) || snapshot.settings.intervalHours <= 0) fail("epoch.snapshot")
    if (Object.values(snapshot.paths).some(value => !nonempty(value) || !path.isAbsolute(value)) || Object.values(snapshot.hashes).some(value => value !== null && (typeof value !== "string" || !/^[a-f0-9]{64}$/.test(value))) || snapshot.directory !== undefined && (!nonempty(snapshot.directory) || !path.isAbsolute(snapshot.directory))) fail("epoch.snapshot paths/hashes")
    if (!state.pendingCount || state.nextEligibleAt === null) fail("epoch eligibility")
  }
  if (state.claim !== null) {
    const claim = state.claim
    if (!object(claim) || !nonempty(claim.token) || !Number.isSafeInteger(claim.pid) || claim.pid < 1 || !nonempty(claim.processStart) || !timestamp(claim.startedAt) || !timestamp(claim.deadline) || Number(new Date(claim.deadline)) <= Number(new Date(claim.startedAt)) || Number(new Date(claim.deadline)) - Number(new Date(claim.startedAt)) > 300000 || !nonempty(claim.configHash) || !state.epoch) fail("claim")
    for (const key of ["epochRevision", "checkpointRevision", "sharedRevision"]) if (!integer(claim[key])) fail(`claim.${key}`)
    if (claim.epochRevision < 1 || claim.epochRevision > state.epoch.revision || claim.checkpointRevision > state.checkpoint.revision || !Array.isArray(claim.batch) || !claim.batch.length || claim.batch.length > 512 || claim.batch.length > state.pendingCount) fail("claim.batch")
    const seen = new Set()
    for (const source of claim.batch) {
      if (!object(source) || !integer(source.sequence) || source.sequence < 1 || source.sequence >= state.nextSequence || !nonempty(source.id) || typeof source.contentHash !== "string" || !/^sha256:[a-f0-9]{64}$/.test(source.contentHash) || seen.has(source.sequence)) fail("claim source")
      seen.add(source.sequence)
    }
  }
  if (state.error !== null && (!object(state.error) || !nonempty(state.error.message) || !timestamp(state.error.at) || state.error.code !== undefined && !nonempty(state.error.code) || state.error.retryAt !== undefined && !timestamp(state.error.retryAt) || state.error.count !== undefined && (!integer(state.error.count) || state.error.count < 1))) fail("error")
  return state
}
export async function readState(scope) {
  const file = path.join(scope.storeRoot, scope.branchDir, "state.json"), text = await readText(file)
  if (text === null) return initialState(scope)
  let state
  try { state = JSON.parse(text) } catch { throw new Error(`Invalid branch state JSON: ${file}`) }
  return validateState(scope, state)
}
export function queueFile(scope, kind, seq) {
  if (!["sources", "pending", "reviewed"].includes(kind) || !Number.isSafeInteger(seq) || seq < 1) throw new Error("Invalid queue address")
  return `${scope.branchDir}/${kind}/${String(seq).padStart(12, "0")}.json`
}
export const sourcePath = (scope, seq) => path.join(scope.storeRoot, queueFile(scope, "sources", seq))
export const pendingPath = (scope, seq) => path.join(scope.storeRoot, queueFile(scope, "pending", seq))
export const reviewedPath = (scope, seq) => path.join(scope.storeRoot, queueFile(scope, "reviewed", seq))
export async function* iteratePending(scope, { afterSequence = 0, throughSequence, workspace } = {}) {
  const end = throughSequence ?? (await readState(scope)).nextSequence - 1
  if (!Number.isSafeInteger(afterSequence) || afterSequence < 0 || !Number.isSafeInteger(end) || end < 0) throw new Error("Invalid queue range")
  for (let seq = afterSequence + 1; seq <= end; seq++) {
    const pointer = await readJson(pendingPath(scope, seq))
    if (!pointer) continue
    const source = await readJson(sourcePath(scope, seq))
    if (!source || source.id !== pointer.id || source.contentHash !== pointer.contentHash) throw new Error(`Corrupt source ${seq}`)
    if (!workspace || source.workspace === workspace) yield source
  }
}
let ownProcessStart
function powershellIdentity(pid) {
  // promisified execFile("pwsh") can hang under this Bun on Windows; spawnSync cannot.
  const command = `$p=Get-Process -Id ${Number(pid)} -ErrorAction SilentlyContinue; if ($p) {$p.StartTime.ToUniversalTime().Ticks.ToString()} else {'absent'}`
  // PowerShell 7 is not preinstalled on stock Windows; fall back to Windows PowerShell.
  for (const shell of ["pwsh", "powershell"]) {
    // mcp: node port — Bun.spawnSync → node spawnSync; result field is .status (not .exitCode)
    const proc = spawnSync(shell, ["-NoProfile", "-NonInteractive", "-Command", command], { stdio: ["ignore", "pipe", "pipe"], encoding: "utf8" })
    const stdout = proc.stdout?.toString().trim()
    if (proc.status === 0 && /^(absent|\d+)$/.test(stdout)) return stdout
  }
  throw new Error("Cannot identify process: no PowerShell available")
}

async function processStart(pid) {
  if (process.platform === "win32") {
    // Our own identity is needed on every acquisition; compute it once per process.
    if (pid === process.pid) return (ownProcessStart ??= powershellIdentity(pid))
    return powershellIdentity(pid)
  }
  try { process.kill(pid, 0) } catch (e) { if (e.code === "ESRCH") return "absent"; throw e }
  if (process.platform === "linux") { const stat = await fs.readFile(`/proc/${pid}/stat`, "utf8"); return stat.slice(stat.lastIndexOf(")") + 2).split(" ")[19] }
  const { stdout } = await exec("ps", ["-p", String(pid), "-o", "lstart="])
  if (!stdout.trim()) throw new Error("Cannot identify process")
  return stdout.trim()
}
async function durable(file, content) {
  await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 })
  const handle = await fs.open(file, "wx", 0o600)
  try { await handle.writeFile(content); await handle.sync() } finally { await handle.close() }
  await syncDirectory(path.dirname(file))
}
async function syncDirectory(directory) {
  // Windows cannot open directory handles through fs; file flushes remain mandatory.
  if (process.platform === "win32") return
  const handle = await fs.open(directory, "r")
  try { await handle.sync() } finally { await handle.close() }
}
async function target(scope, relative) {
  if (typeof relative !== "string" || !relative || relative.includes("\\") || path.isAbsolute(relative) || relative.split("/").some(p => !p || /[. ]$/.test(p) || /[<>:"|?*\x00-\x1f]/.test(p) || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\.|$)/i.test(p)) || /^(transactions|\.lock)(\/|$)/i.test(relative)) throw new Error(`Unsafe path: ${relative}`)
  let current = scope.storeRoot
  for (const part of relative.split("/")) { current = path.join(current, part); try { if ((await fs.lstat(current)).isSymbolicLink()) throw new Error("Symlink storage target") } catch (e) { if (e.code !== "ENOENT") throw e } }
  return current
}
async function apply(scope, dir, intent, failAfter) {
  if (intent.version !== 1 || !Array.isArray(intent.changes) || intent.changes.length > 512) throw new Error("Invalid transaction intent")
  // All staged payloads live in one durably-written file so a commit costs O(1) fsyncs, not O(changes).
  const payloads = await readJson(path.join(dir, "payloads.json"))
  if (!payloads || typeof payloads !== "object" || Array.isArray(payloads)) throw new Error("Corrupt transaction payload")
  let count = 0
  for (let i = 0; i < intent.changes.length; i++) {
    const change = intent.changes[i]
    if (!change || change.encoding !== "base64" || ![change.oldHash, change.newHash].every(value => value === null || typeof value === "string" && /^[a-f0-9]{64}$/.test(value))) throw new Error("Invalid transaction hashes/encoding")
    const file = await target(scope, change.path), old = await readBytes(file), actual = old === null ? null : hash(old)
    if (actual !== change.oldHash && actual !== change.newHash) throw new Error(`Recovery blocked: ${change.path} (transaction ${path.basename(dir)}; expected old ${change.oldHash ?? "absent"} new ${change.newHash ?? "absent"}, found ${actual ?? "absent"})`)
    if (actual !== change.newHash) {
      if (change.newHash === null) { await fs.unlink(file); await syncDirectory(path.dirname(file)) }
      else {
        const encoded = payloads[String(i)]
        const bytes = typeof encoded === "string" ? Buffer.from(encoded, "base64") : null
        if (bytes === null || bytes.toString("base64") !== encoded || hash(bytes) !== change.newHash) throw new Error("Corrupt transaction payload")
        // No fsync here: a crash mid-apply replays from the durable staged payloads; committed marks completion.
        const temp = `${file}.${randomUUID()}.tmp`
        await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 })
        await fs.writeFile(temp, bytes); await fs.rename(temp, file)
      }
    }
    if (++count === failAfter) throw new Error("Injected transaction failure")
  }
  await durable(path.join(dir, "committed"), "committed\n")
}
async function recover(scope) {
  const root = path.join(scope.storeRoot, "transactions")
  await fs.mkdir(root, { recursive: true, mode: 0o700 })
  for await (const entry of await fs.opendir(root)) {
    if (!entry.isDirectory()) continue
    const dir = path.join(root, entry.name)
    if (await readText(path.join(dir, "committed")) !== null) {
      // history/ retains revision evidence; committed scratch dirs would otherwise rescan forever.
      await fs.rm(dir, { recursive: true, force: true })
      continue
    }
    const intent = await readJson(path.join(dir, "intent.json"))
    if (intent) { await apply(scope, dir, intent); await fs.rm(dir, { recursive: true, force: true }); continue }
    // Payloads without an intent can follow a crash (or NTFS reordering) before the intent rename.
    // Silently skipping would lose queued entries; require operator inspection instead.
    const staged = (await fs.readdir(dir).catch(() => [])).filter((name) => name === "payloads.json")
    if (staged.length) throw new Error(`Orphaned continuity transaction ${dir}: staged payloads without intent; recover manually (expected hashes may be missing)`)
  }
}
async function readOwner(file) {
  try { return await readJson(file) }
  catch (error) {
    // The creator can still be flushing its owner record; an unverifiable lock stays locked.
    if (error.message.startsWith("Malformed JSON:")) return null
    throw error
  }
}
async function deadOwner(owner) {
  if (!object(owner) || !nonempty(owner.token) || !/^[a-zA-Z0-9-]+$/.test(owner.token) || !Number.isSafeInteger(owner.pid) || owner.pid < 1 || !nonempty(owner.processStart)) return false
  try { const actual = await processStart(owner.pid); return actual === "absent" || actual !== owner.processStart } catch { return false }
}
async function moveDead(directory, owner) {
  if (!(await deadOwner(owner)) || (await readOwner(path.join(directory, "owner.json")))?.token !== owner.token) return false
  try {
    // Never remove these nonempty tombstones: a delayed reclaimer cannot replace one.
    await fs.rename(directory, `${directory}.stale-${owner.token}`)
    return true
  } catch (error) {
    if (["ENOENT", "EEXIST", "ENOTEMPTY", "EPERM", "EACCES"].includes(error.code)) return false
    throw error
  }
}
async function acquireGuard(guard, owner) {
  // Legacy ownerless guards are unverifiable, never an empty rename destination.
  try {
    await fs.lstat(guard)
    await moveDead(guard, await readOwner(path.join(guard, "owner.json")))
    return false
  } catch (error) { if (error.code !== "ENOENT") throw error }
  const candidate = `${guard}.candidate-${owner.token}`
  await durable(path.join(candidate, "owner.json"), JSON.stringify(owner))
  try {
    try { await fs.rename(candidate, guard); return true } catch (error) {
      if (!["EEXIST", "ENOTEMPTY", "EPERM", "EACCES"].includes(error.code)) throw error
    }
    await moveDead(guard, await readOwner(path.join(guard, "owner.json")))
    return false
  } finally { await fs.rm(candidate, { recursive: true, force: true }) }
}
export async function withStore(scope, callback, { timeoutMs = 10000 } = {}) {
  if (locks.getStore() === scope.storeRoot) throw new Error("Nested store lock")
  await fs.mkdir(scope.storeRoot, { recursive: true, mode: 0o700 })
  const lock = path.join(scope.storeRoot, ".lock"), token = randomUUID(), started = Date.now()
  const owner = { token, pid: process.pid, processStart: await processStart(process.pid) }
  for (;;) {
    if (Date.now() - started >= timeoutMs) throw new Error("Store lock unavailable: live or unverifiable owner")
  try {
    // Acquire exactly like acquireGuard: a crash before the owner record can never wedge the store.
    const candidate = `${lock}.candidate-${token}`
    await durable(path.join(candidate, "owner.json"), JSON.stringify(owner))
    let ownedLock = false
    try { await fs.rename(candidate, lock); ownedLock = true }
    catch (error) {
      if (!["EEXIST", "ENOTEMPTY", "EPERM", "EACCES"].includes(error.code)) throw error
      await fs.rm(candidate, { recursive: true, force: true })
    }
    if (ownedLock) break
  } catch (e) { if (e.code !== "EEXIST" && e.code !== "ENOTEMPTY" && e.code !== "EPERM" && e.code !== "EACCES") throw e }
    const previous = await readOwner(path.join(lock, "owner.json"))
    if (await deadOwner(previous)) {
        // Keep the owner file intact until the stale directory is atomically moved away.
        const guard = `${lock}.recovery`
        let acquired = false
        try {
          acquired = await acquireGuard(guard, owner)
          if (acquired) await moveDead(lock, previous)
        } catch (e) { if (e.code !== "ENOENT") throw e }
        finally { if (acquired && (await readOwner(path.join(guard, "owner.json")))?.token === owner.token) await fs.rm(guard, { recursive: true }) }
        continue
    }
    if (Date.now() - started >= timeoutMs) throw new Error("Store lock unavailable: live or unverifiable owner")
    await new Promise(resolve => setTimeout(resolve, 25))
  }
  try { return await locks.run(scope.storeRoot, async () => { await recover(scope); await readState(scope); return callback() }) }
  finally {
    try { if ((await readJson(path.join(lock, "owner.json")))?.token === token) await fs.rm(lock, { recursive: true }) }
    catch (error) { // Cleanup must never mask the callback's result or error; a stale lock times out later.
      console.error(`[continuity] lock cleanup failed: ${error.message}`) }
  }
}
export async function commit(scope, changes, { failAfter } = {}) {
  if (locks.getStore() !== scope.storeRoot) throw new Error("commit requires withStore")
  await recover(scope)
  await readState(scope)
  if (Array.isArray(changes)) changes = changes.map(change => ({ ...change, path: typeof change.path === "string" ? change.path.replaceAll("\\", "/") : change.path }))
  if (!Array.isArray(changes) || changes.length > 512 || new Set(changes.map(c => c.path)).size !== changes.length) throw new Error("Invalid changes")
  for (const change of changes) if (change.path === `${scope.branchDir}/state.json`) {
    if (change.content === null) throw new Error("Invalid branch state: deletion")
    let state
    try { state = JSON.parse(change.content.toString()) } catch { throw new Error("Invalid branch state JSON") }
    validateState(scope, state)
  }
  const dir = path.join(scope.storeRoot, "transactions", randomUUID()), records = [], payloads = {}
  await fs.mkdir(dir, { recursive: true, mode: 0o700 })
  await syncDirectory(path.dirname(dir))
  changes = [...changes].sort((a, b) => Number(a.path.endsWith("state.json")) - Number(b.path.endsWith("state.json")))
  for (let i = 0; i < changes.length; i++) {
    const change = changes[i]
    if (change.content !== null && typeof change.content !== "string" && !Buffer.isBuffer(change.content)) throw new Error("Content must be string, Buffer or null")
    const content = change.content === null ? null : Buffer.from(change.content)
    const old = await readBytes(await target(scope, change.path))
    if (/\/(sources|reviewed)\//i.test(change.path) && old !== null && (content === null || !old.equals(content))) throw new Error("Immutable record")
    // New payloads stage into one durable file; oldHash in the intent verifies targets on recovery.
    if (content !== null) payloads[i] = content.toString("base64")
    records.push({ path: change.path, encoding: "base64", oldHash: old === null ? null : hash(old), newHash: content === null ? null : hash(content) })
  }
  const intent = { version: 1, changes: records }
  await durable(path.join(dir, "payloads.json"), JSON.stringify(payloads))
  await durable(path.join(dir, "intent.tmp"), JSON.stringify(intent)); await fs.rename(path.join(dir, "intent.tmp"), path.join(dir, "intent.json")); await syncDirectory(dir)
  await apply(scope, dir, intent, failAfter)
}
