// vendored from opencode-continuity-tool@d3c55ec - local edits marked mcp:
// Both adapters use this transaction boundary; no SDK or model calls run under its lock.
import path from "node:path"
import fs from "node:fs/promises"
import { createHash } from "node:crypto"
import {
  executeLegacy, tokens, buildEntry, parseContinuityEntry, formatReadEntry,
  collectParsedEntries, getSectionBoundaries, resolveReadConfig, normalizeMemoryContent, SECTIONS, PROVENANCE,
} from "./core.js"
import {
  resolveScope, withStore, readState, commit, readText, readJson,
} from "./storage.js"
import { loadConfig } from "./config.js"
import { inspectMemory, runDistillation } from "./distill.js"

const hash = (value) => createHash("sha256").update(value).digest("hex")
const json = (value) => `${JSON.stringify(value, null, 2)}\n`
const queueName = (sequence) => `${String(sequence).padStart(12, "0")}.json`
const millis = (value) => typeof value === "number" ? value : Date.parse(value)
const relative = (scope, file) => path.relative(scope.storeRoot, file)

function checkedWorkspace(context) {
  if (typeof context?.worktree !== "string" || !path.isAbsolute(context.worktree)) {
    throw new Error("Continuity requires the calling session's absolute physical workspace")
  }
  return context.worktree
}

export async function continuityScope(args, context) {
  if (args.branch !== undefined && (args.command !== "read" || typeof args.branch !== "string" || !args.branch.trim())) {
    throw new Error("branch is a nonempty read-only selector")
  }
  return resolveScope({ workspace: checkedWorkspace(context), branch: args.branch })
}

async function refreshEpoch(scope, state, config) {
  if (!state.epoch || state.epoch.workspace !== scope.workspace || state.epoch.configHash === config.hash || state.epoch.snapshot.paths?.global !== config.paths?.global) return
  state.epoch.snapshot = config
  state.epoch.configHash = config.hash
  state.epoch.revision += 1
  const anchor = state.lastAttemptAt ?? state.firstPendingAt ?? 0
  // Never Math.max with millis(null) (NaN): a null nextEligibleAt must fall through, not brick the state.
  const candidate = millis(anchor) + config.settings.intervalHours * 3_600_000
  state.nextEligibleAt = state.nextEligibleAt != null ? Math.max(candidate, millis(state.nextEligibleAt)) : candidate
  state.revision += 1
  await commit(scope, [{ path: `${scope.branchDir}/state.json`, content: json(state) }])
}

async function archiveLegacy(scope, config) {
  if (!scope.isGit) return
  // config.js already resolved ~ against os.homedir(); never re-expand here.
  const root = config.directory
  if (typeof root !== "string" || !path.isAbsolute(root)) throw new Error("Continuity config produced a non-absolute legacy directory")
  for (const name of ["CONTINUITY.md", "MEMORY.md"]) {
    const source = path.join(root, name)
    let bytes
    try { bytes = await fs.readFile(source) } catch (error) { if (error.code === "ENOENT") continue; throw error }
    const contentHash = hash(bytes)
    const sourceKey = hash(source)
    const prefix = `legacy/${contentHash}/${sourceKey}`
    if (await readText(path.join(scope.storeRoot, `${prefix}/manifest.json`), "")) continue
    await commit(scope, [
      { path: `${prefix}/${name}`, content: bytes },
      { path: `${prefix}/manifest.json`, content: json({ source, contentHash, importedAt: new Date().toISOString(), name }) },
    ])
  }
}

function validateUpdates(updates) {
  if (!Array.isArray(updates) || updates.length === 0 || updates.length > 100) throw new Error("updates must contain between 1 and 100 entries")
  for (const update of updates) {
    if (!SECTIONS.includes(update.section) || !PROVENANCE.includes(update.provenance)) throw new Error("Invalid section or provenance")
    if (typeof update.text !== "string" || !update.text.trim() || /[\r\n]/.test(update.text) || update.text.trimStart().startsWith("[")) throw new Error("text must be a nonblank single line without leading metadata")
    if (update.text.length > 400) throw new Error("text exceeds the 400-character limit")
    if (update.plan !== undefined && !/^[a-z0-9][a-z0-9.-]*$/.test(update.plan)) throw new Error("Invalid plan identifier")
  }
}

async function updateLocked(scope, config, args, context) {
  validateUpdates(args.updates)
  const state = await readState(scope)
  const now = Date.now()
  const timestamp = `${new Date(now).toISOString().slice(0, 16)}Z`
  const overlay = new Map()
  const io = {
    ...fs,
    readFile: async (file, encoding) => overlay.has(file) ? overlay.get(file) : fs.readFile(file, encoding),
    writeFile: async (file, value) => { overlay.set(file, value) },
    mkdir: async () => {},
  }
  await executeLegacy(args, context, {
    paths: { directory: path.dirname(scope.continuityPath), continuityPath: scope.continuityPath, memoryPath: scope.memoryPath }, fs: io, timestamp,
  })
  const changes = [...overlay].map(([file, content]) => ({ path: relative(scope, file), content }))
  const added = new Set()
  for (const update of args.updates) {
    const line = buildEntry(timestamp, update)
    const entry = parseContinuityEntry(line, update.section)
    // Dedup on deliberate content, not the minute-derived memoryId, so a resubmitted fact stays one source.
    const index = `${scope.branchDir}/identities/${hash([update.section, update.provenance, update.plan ?? "", normalizeMemoryContent(update.text)].join("|"))}.json`
    if (added.has(index) || await readText(path.join(scope.storeRoot, index), "")) continue
    added.add(index)
    const sequence = state.nextSequence++
    const source = { version: 1, sequence, id: entry.memoryId, contentHash: entry.contentHash,
      timestamp: now, workspace: scope.workspace, storeId: scope.storeId, branchKey: scope.branchKey,
      sessionID: context.sessionID ?? null,
      section: update.section, provenance: update.provenance, plan: update.plan ?? null,
      text: update.text, line, config }
    changes.push(
      { path: `${scope.branchDir}/sources/${queueName(sequence)}`, content: json(source) },
      { path: `${scope.branchDir}/pending/${queueName(sequence)}`, content: json({ id: source.id, contentHash: source.contentHash }) },
      { path: index, content: json({ sequence, id: source.id, contentHash: source.contentHash }) },
    )
    state.pendingCount += 1
    if (state.oldestPendingSequence == null) state.oldestPendingSequence = sequence
    if (!state.epoch) {
      state.firstPendingAt = now
      state.epoch = { revision: 1, workspace: scope.workspace, snapshot: config, configHash: config.hash, anchor: state.lastAttemptAt ?? now }
      state.nextEligibleAt = millis(state.lastAttemptAt ?? now) + config.settings.intervalHours * 3_600_000
    }
  }
  state.revision += 1
  changes.push({ path: `${scope.branchDir}/state.json`, content: json(state) })
  await commit(scope, changes)
  return ""
}

async function sourceEntries(scope) {
  const active = await readText(scope.continuityPath, "")
  const archived = await readText(scope.memoryPath, "")
  const seen = new Set()
  const entries = []
  for (const content of [archived, active]) {
    if (!content) continue
    for (const entry of collectParsedEntries(content.split(/\r?\n/), getSectionBoundaries(content.split(/\r?\n/)))) {
      const key = `${entry.memoryId}:${entry.contentHash}`
      if (seen.has(key)) continue
      seen.add(key)
      entries.push(entry)
    }
  }
  return entries.sort((a, b) => a.timestamp.localeCompare(b.timestamp))
}

async function readLocked(scope, args, context, memory) {
  if (args.updates?.length) throw new Error("updates are not supported for read command")
  const read = resolveReadConfig({ ...args.read, ...(args.read?.memoryId ? { mode: "tail" } : {}), sessionId: args.read?.sessionId ?? context.sessionID })
  const session = read.sessionId
  const ledgerPath = `${scope.branchDir}/ledgers/${hash(session ?? "tail")}.json`
  const ledger = await readJson(path.join(scope.storeRoot, ledgerPath), { version: 2, seen: {} })
  if (ledger.version !== 2 || !ledger.seen || Array.isArray(ledger.seen)) throw new Error("Invalid branch read ledger")
  let output = ""
  for (const [title, text, cap, key] of [
    ["Shared knowledge", memory.sharedText, 2000, "shared:baseline"],
    ["Branch checkpoint", memory.checkpointText, 1000, "branch:checkpoint"],
  ]) {
    if (!text || (read.mode === "delta" && ledger.seen[key] === hash(text))) continue
    const block = `## ${title}\n${text}\n\n`
    if (tokens(block) > cap) { output += `[Omitted oversized ${title}; use status for maintenance.]\n`; continue }
    output += block
    ledger.seen[key] = hash(text)
  }
  const entries = await sourceEntries(scope)
  if (args.read?.memoryId) {
    // Shared records are retrievable by their stable id alongside branch sources.
    const sharedMatch = args.read.memoryId.startsWith("shared-")
      ? (memory.shared ?? []).filter((record) => record.id === args.read.memoryId)
      : []
    const matches = entries.filter((entry) => entry.memoryId === args.read.memoryId)
    if (!matches.length && !sharedMatch.length) throw new Error(`Unknown memory ID: ${args.read.memoryId}`)
    const block = [
      ...matches.map((entry) => entry.line),
      ...sharedMatch.map((record) => `- [id:${record.id}] [shared] ${record.text} (cited by ${record.citations.length} source${record.citations.length === 1 ? "" : "s"})`),
    ].join("\n")
    if (tokens(output + block) > 8000) throw new Error(`Memory ${args.read.memoryId} exceeds targeted read budget`)
    return output + block
  }
  const keyOf = (entry) => `source:${entry.memoryId}`
  const unseen = entries.filter((entry) => ledger.seen[keyOf(entry)] !== entry.contentHash)
  const replay = entries.filter((entry) => !unseen.includes(entry) && ((read.includePinned && entry.pinned) || (read.includeUnresolved && entry.status === "unresolved")))
  const selected = []
  let branch = ""
  let branchTokens = 0
  const outputTokens = tokens(output)
  const append = (entry, budget) => {
    const block = `## [${entry.section}]\n[id:${entry.memoryId}] ${formatReadEntry(entry)}\n`
    const blockTokens = tokens(block)
    if (branchTokens + blockTokens > budget || outputTokens + branchTokens + blockTokens > 7900) return false
    branch += block
    branchTokens += blockTokens
    selected.push(entry)
    return true
  }
  if (read.mode === "tail") {
    for (const section of SECTIONS) {
      for (const entry of entries.filter((entry) => entry.section === section).slice(-read.linesPerSection)) append(entry, 4900)
    }
  } else {
    // Scan past blocked entries so fitting later entries are never starved; blocked ones stay unseen.
    const blocked = []
    for (const entry of unseen) if (!append(entry, 4900)) blocked.push(entry)
    output += blocked.map((entry) => `[Blocked memory ${entry.memoryId}: exceeds read budget; use read.memoryId.]\n`).join("")
    const replayStart = branchTokens
    for (const entry of replay) append(entry, unseen.length ? Math.min(4900, replayStart + 2450) : 4900)
  }
  for (const entry of selected) ledger.seen[keyOf(entry)] = entry.contentHash
  if (read.mode === "delta") await commit(scope, [{ path: ledgerPath, content: json(ledger) }])
  const returnedUnseen = selected.filter((entry) => unseen.includes(entry)).length
  const tailOmitted = read.mode === "tail" && SECTIONS.some((section) => {
    const candidates = entries.filter((entry) => entry.section === section).slice(-read.linesPerSection)
    return candidates.some((entry) => !selected.includes(entry))
  })
  return output + branch + (read.mode === "delta" && returnedUnseen < unseen.length ? "\n[More unseen memories remain; read again.]" : tailOmitted ? "\n[Some tail entries omitted by token budget; use targeted ID reads.]" : "") || "No new or changed task memories."
}

// The store lives under .git, invisible to ripgrep/grep; this is the look-back beyond bounded reads.
const SEARCH_RESULT_LIMIT = 20
const SEARCH_SCAN_LIMIT = 5000

async function searchLocked(scope, args, memory, branchLabel) {
  const query = typeof args.query === "string" ? args.query.trim().toLowerCase() : ""
  if (!query || query.length > 200) throw new Error("search.query must be 1-200 characters")
  const results = []
  let scanned = 0
  let scanTruncated = false, resultTruncated = false, skipped = false
  const clean = (value) => value.replace(/[\x00-\x1f\x7f-\x9f]+/g, " ")
  const consider = (text, id, where) => {
    if (!text.toLowerCase().includes(query)) return
    text = clean(text)
    results.push(`[${clean(where)}] ${clean(id)}: ${text.length > 160 ? `${text.slice(0, 157)}...` : text}`)
    if (results.length >= SEARCH_RESULT_LIMIT) resultTruncated = true
  }
  for (const record of memory.shared ?? []) {
    consider(record.text, record.id, "shared")
    if (resultTruncated) break
  }
  const scanBranch = async (key, label) => {
    const sourcesDir = path.join(scope.storeRoot, "branches", key, "sources")
    const names = await fs.readdir(sourcesDir).catch((error) => { if (error.code === "ENOENT") return []; throw error })
    for (const name of names.sort()) {
      if (!name.endsWith(".json")) continue
      if (scanned >= SEARCH_SCAN_LIMIT) { scanTruncated = true; return }
      scanned++
      let source
      try { source = await readJson(path.join(sourcesDir, name), null) } catch (error) {
        if (!error.message.startsWith("Malformed JSON:")) throw error
        skipped = true; continue
      }
      if (typeof source?.id !== "string" || !source.id || typeof source.text !== "string") { skipped = true; continue }
      consider(source.text, source.id, label)
      if (resultTruncated) return
    }
  }
  if (!resultTruncated) await scanBranch(scope.branchKey, branchLabel)
  if (args.all && !resultTruncated && !scanTruncated) {
    const branches = await fs.readdir(path.join(scope.storeRoot, "branches"), { withFileTypes: true }).catch((error) => { if (error.code === "ENOENT") return []; throw error })
    for (const entry of branches) {
      if (!entry.isDirectory() || entry.name === scope.branchKey) continue
      let state
      try { state = await readJson(path.join(scope.storeRoot, "branches", entry.name, "state.json"), null) } catch (error) {
        if (!error.message.startsWith("Malformed JSON:")) throw error
        skipped = true; continue
      }
      const identity = state?.identity
      if (!identity || typeof identity !== "object" || typeof identity.kind !== "string") { skipped = true; continue }
      if (identity?.kind !== "branch") continue
      if (typeof identity.name !== "string" || !identity.name.startsWith("refs/heads/") || identity.name.length === 11) { skipped = true; continue }
      const key = `${identity.name.replace(/[^a-zA-Z0-9-]/g, "-").slice(-40)}-${hash(JSON.stringify({ kind: "branch", name: identity.name }))}`
      if (entry.name !== key) { skipped = true; continue }
      try { await readState({ ...scope, identity: { kind: "branch", name: identity.name }, branchDir: `branches/${key}` }) } catch (error) {
        if (!error.message.startsWith("Invalid branch state")) throw error
        skipped = true; continue
      }
      await scanBranch(entry.name, identity.name.slice(11))
      if (scanTruncated || resultTruncated) break
    }
  }
  const warnings = [resultTruncated && "results truncated", scanTruncated && "scan truncated", skipped && "malformed data skipped"].filter(Boolean)
  const header = (results.length ? `${results.length} match${results.length === 1 ? "" : "es"} for "${clean(args.query.trim())}"` : `No matches for "${clean(args.query.trim())}"`) + `${warnings.length ? ` (${warnings.join("; ")}; results may be incomplete)` : ""}. Retrieve full entries with read.memoryId:\n`
  return header + results.join("\n")
}

export async function executeContinuity(args, context, options = {}) {
  if (!["read", "update", "status", "distill", "search"].includes(args.command)) throw new Error("Unknown continuity command")
  const scope = await continuityScope(args, context)
  if (args.command === "distill" && !options.generate) throw new Error("Distillation requires the continuity plugin")
  if (args.command !== "read" && args.branch !== undefined) throw new Error("branch selects intentional reads only; writes follow the calling checkout")
  const config = await loadConfig({ workspace: scope.workspace, globalConfigRoot: options.globalConfigRoot })
  const result = await withStore(scope, async () => {
    await archiveLegacy(scope, config)
    const memory = await inspectMemory(scope)
    // search is read-only: no state mutation, no epoch refresh, no ledger writes.
    if (args.command === "search") return searchLocked(scope, args, memory, scope.identity.kind === "branch" ? scope.identity.name.replace("refs/heads/", "") : "branch")
    const state = await readState(scope)
    await refreshEpoch(scope, state, config)
    if (args.command === "distill") return null
    if (args.command === "status") return json({ scope, config, state: await readState(scope), memory })
    if (args.command === "read") return readLocked(scope, args, context, memory)
    return updateLocked(scope, config, args, context)
  })
  if (args.command === "distill") return json(await runDistillation(scope, { ...options.generationOptions, generate: options.generate, manual: true, workspace: scope.workspace }))
  if (args.command === "update") options.onPending?.(scope, context.sessionID)
  return result
}
