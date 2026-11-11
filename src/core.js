// vendored from opencode-continuity-tool@d3c55ec - local edits marked mcp:
import { createHash } from "crypto"
import fs from "fs/promises"
import os from "os"
import path from "path"
 
const tiktoken = await import("tiktoken")

const get_encoding =
  tiktoken.get_encoding ??
  tiktoken.default?.get_encoding ??
  tiktoken["module.exports"]?.get_encoding

const SECTIONS = [
  "PLANS",
  "DECISIONS",
  "PROGRESS",
  "DISCOVERIES",
  "OUTCOMES",
]

const PROVENANCE = [
  "USER",
  "CODE",
  "TOOL",
  "ASSUMPTION",
  "UNCONFIRMED",
]

const DEFAULT_UPPER_TOKEN_THRESHOLD = 10000
const DEFAULT_ENCODING = "cl100k_base"
let sharedEncoder

function getDefaultEncoder() {
  return sharedEncoder ??= get_encoding(DEFAULT_ENCODING)
}

export function tokens(text) {
  return countTokensForContent(text, getDefaultEncoder())
}
const DEFAULT_READ_LINES_PER_SECTION = 5
const DEFAULT_READ_MODE = "delta"
const SESSION_LEDGER_VERSION = 1
const SESSION_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/
const CONTINUITY_FILE_NAME = "CONTINUITY.md"
const MEMORY_FILE_NAME = "MEMORY.md"

const SECTION_RATIO_WEIGHTS = {
  PLANS: 4339,
  DECISIONS: 5175,
  PROGRESS: 22471,
  DISCOVERIES: 6622,
  OUTCOMES: 9126,
}
const SECTION_RATIO_TOTAL = Object.values(SECTION_RATIO_WEIGHTS).reduce(
  (sum, value) => sum + value,
  0
)

const TEMPLATE = `# CONTINUITY

## [PLANS]

## [DECISIONS]

## [PROGRESS]

## [DISCOVERIES]

## [OUTCOMES]
`

const MEMORY_TEMPLATE = `# MEMORY

## [PLANS]

## [DECISIONS]

## [PROGRESS]

## [DISCOVERIES]

## [OUTCOMES]

## [THEMES]

## [MILESTONES]
`

const HEADER_PATTERN =
  /^## \[(PLANS|DECISIONS|PROGRESS|DISCOVERIES|OUTCOMES)\]\s*$/

const ENTRY_PATTERN =
  /^- (?:\[id:(?<memoryId>[^\]]+)\] )?(?<timestamp>\d{4}-\d{2}-\d{2}T\d{2}:\d{2}Z) (?<rest>.+)$/

function validateText(text) {
  if (text.includes("\n") || text.includes("\r")) {
    throw new Error("text must be a single line")
  }
  if (text.trim().length === 0) {
    throw new Error("text must not be blank")
  }
  if (text.trimStart().startsWith("[")) {
    throw new Error("text must not start with a bracketed token")
  }
}

function normalizeMemoryContent(content) {
  return content.replace(/\r\n?/g, "\n").replace(/\s+/g, " ").trim()
}

function hashMemoryContent(content) {
  return `sha256:${createHash("sha256")
    .update(normalizeMemoryContent(content), "utf8")
    .digest("hex")}`
}

function slugifyMemorySegment(value) {
  const slug = value.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "")
  return slug || "entry"
}

function deriveMemoryId({ section, timestamp, provenance, plan, text }) {
  const normalizedText = normalizeMemoryContent(text)
  const compactTimestamp = (timestamp ?? "undated").replace(/[^0-9]/g, "") || "undated"
  const hash = hashMemoryContent(
    [section, timestamp ?? "", provenance ?? "", plan ?? "", normalizedText].join("|")
  ).slice("sha256:".length, "sha256:".length + 12)

  return [
    slugifyMemorySegment(section ?? "entry"),
    compactTimestamp,
    slugifyMemorySegment(provenance ?? "unknown"),
    hash,
  ].join("-")
}

function parseContinuityEntry(line, section = null) {
  const match = line.match(ENTRY_PATTERN)
  if (!match?.groups) {
    return null
  }

  const { memoryId, timestamp, rest } = match.groups
  const metadata = {
    provenance: null,
    plan: null,
    status: null,
    pinned: false,
  }

  let remaining = rest
  const textPrefixes = []
  while (remaining.startsWith("[")) {
    const tokenEnd = remaining.indexOf("]")
    if (tokenEnd === -1) break
    const token = remaining.slice(1, tokenEnd)
    remaining = remaining.slice(tokenEnd + 1)
    if (remaining.startsWith(" ")) {
      remaining = remaining.slice(1)
    }

    if (PROVENANCE.includes(token)) {
      metadata.provenance = token
      continue
    }
    if (token.startsWith("plan:")) {
      metadata.plan = token.slice("plan:".length)
      continue
    }
    if (token.startsWith("status:")) {
      metadata.status = token.slice("status:".length)
      continue
    }
    if (token === "pin" || token === "pinned") {
      metadata.pinned = true
      continue
    }

    textPrefixes.push(`[${token}]`)
  }

  const text = [...textPrefixes, remaining].join(" ").trim()
  if (!metadata.provenance || text.length === 0) {
    return null
  }

  const resolvedSection = section ?? "UNKNOWN"
  const resolvedMemoryId =
    memoryId ??
    deriveMemoryId({
      section: resolvedSection,
      timestamp,
      provenance: metadata.provenance,
      plan: metadata.plan,
      text,
    })

  return {
    line,
    section: resolvedSection,
    memoryId: resolvedMemoryId,
    timestamp,
    provenance: metadata.provenance,
    plan: metadata.plan,
    status: metadata.status,
    pinned: metadata.pinned,
    text,
    normalizedContent: normalizeMemoryContent(text),
    contentHash: hashMemoryContent(text),
    isLegacy: !memoryId,
  }
}

function buildEntry(timestamp, update) {
  const memoryId = deriveMemoryId({
    section: update.section,
    timestamp,
    provenance: update.provenance,
    plan: update.plan,
    text: update.text,
  })
  const planSegment = update.plan ? ` [plan:${update.plan}]` : ""
  return `- [id:${memoryId}] ${timestamp} [${update.provenance}]${planSegment} ${update.text}`
}

function formatReadEntry(entry) {
  const planSegment = entry.plan ? ` [plan:${entry.plan}]` : ""
  const statusSegment = entry.status ? ` [status:${entry.status}]` : ""
  const pinSegment = entry.pinned ? " [pin]" : ""
  return `- ${entry.timestamp} [${entry.provenance}]${planSegment}${statusSegment}${pinSegment} ${entry.text}`
}

function resolveCompactionConfig(input) {
  const enabled = input?.enabled ?? true
  const hasUpper = typeof input?.upperTokenThreshold === "number"
  const hasLower = typeof input?.lowerTokenThreshold === "number"
  const hasLegacy = typeof input?.totalTokenThreshold === "number"

  let upperTokenThreshold = DEFAULT_UPPER_TOKEN_THRESHOLD
  if (hasUpper) {
    upperTokenThreshold = input?.upperTokenThreshold ?? upperTokenThreshold
  } else if (hasLegacy) {
    upperTokenThreshold = input?.totalTokenThreshold ?? upperTokenThreshold
  } else if (hasLower) {
    upperTokenThreshold = (input?.lowerTokenThreshold ?? 0) * 2
  }

  const derivedLowerTokenThreshold = Math.max(
    1,
    Math.floor(upperTokenThreshold / 2)
  )
  const lowerTokenThreshold = derivedLowerTokenThreshold

  if (!Number.isInteger(upperTokenThreshold) || upperTokenThreshold <= 0) {
    throw new Error("upperTokenThreshold must be a positive integer")
  }
  if (!Number.isInteger(lowerTokenThreshold) || lowerTokenThreshold <= 0) {
    throw new Error("lowerTokenThreshold must be a positive integer")
  }
  if (lowerTokenThreshold > upperTokenThreshold) {
    throw new Error(
      "lowerTokenThreshold must be less than or equal to upperTokenThreshold"
    )
  }

  return {
    enabled,
    upperTokenThreshold,
    lowerTokenThreshold,
    encoding: input?.encoding ?? DEFAULT_ENCODING,
  }
}

function resolveReadConfig(read) {
  const linesPerSection =
    read?.linesPerSection ?? DEFAULT_READ_LINES_PER_SECTION
  const mode = read?.mode ?? DEFAULT_READ_MODE
  const sessionId = read?.sessionId
  const includePinned = read?.includePinned ?? false
  const includeUnresolved = read?.includeUnresolved ?? false

  if (!Number.isInteger(linesPerSection) || linesPerSection <= 0) {
    throw new Error("read.linesPerSection must be a positive integer")
  }
  if (mode !== "tail" && mode !== "delta") {
    throw new Error('read.mode must be either "tail" or "delta"')
  }
  if (sessionId != null && !SESSION_ID_PATTERN.test(sessionId)) {
    throw new Error("read.sessionId must match ^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$")
  }
  if (mode === "delta" && !sessionId) {
    throw new Error("read.sessionId must be provided for delta mode")
  }

  return {
    linesPerSection,
    mode,
    sessionId,
    includePinned,
    includeUnresolved,
  }
}

function hashWorktreePath(worktree) {
  return createHash("sha256").update(worktree, "utf8").digest("hex")
}

function resolveLedgerPath(worktree, sessionId) {
  return path.join(
    os.tmpdir(),
    "opencode-continuity-ledger",
    hashWorktreePath(worktree),
    `${sessionId}.json`
  )
}

function resolveWorktree(context, cwd = process.cwd()) {
  const fallbackCwd = path.resolve(cwd)
  const configuredWorktree =
    typeof context?.worktree === "string" ? context.worktree.trim() : ""

  if (!configuredWorktree) {
    return fallbackCwd
  }

  const resolvedWorktree = path.resolve(configuredWorktree)

  // Some runtimes report the filesystem root instead of the actual project.
  if (
    resolvedWorktree === path.parse(resolvedWorktree).root &&
    fallbackCwd !== resolvedWorktree
  ) {
    return fallbackCwd
  }

  return resolvedWorktree
}

function resolveGlobalConfigPath({
  xdgConfigHome = process.env.XDG_CONFIG_HOME,
  homeDirectory = os.homedir(),
} = {}) {
  const configHome =
    typeof xdgConfigHome === "string" && xdgConfigHome.trim()
      ? xdgConfigHome.trim()
      : path.join(homeDirectory, ".config")
  return path.join(configHome, "opencode", "continuity.json")
}

function resolveProjectConfigPath(worktree) {
  return path.join(worktree, ".opencode", "continuity.json")
}

async function loadContinuityDirectoryConfig(configPath, io = fs) {
  let content
  try {
    content = await io.readFile(configPath, "utf8")
  } catch (error) {
    if (error && typeof error === "object" && "code" in error) {
      if (error.code === "ENOENT") return null
    }
    throw error
  }

  let config
  try {
    config = JSON.parse(content)
  } catch {
    throw new Error(`Invalid continuity config JSON: ${configPath}`)
  }

  if (
    !config ||
    Array.isArray(config) ||
    Object.keys(config).length !== 1 ||
    typeof config.directory !== "string" ||
    !config.directory.trim()
  ) {
    throw new Error(
      `Invalid continuity config at ${configPath}: expected {"directory":"<path>"}`
    )
  }

  return config.directory
}

function resolveConfiguredDirectory(directory, worktree, homeDirectory = os.homedir()) {
  const configuredDirectory = directory.trim()

  if (configuredDirectory === "~") return homeDirectory
  if (configuredDirectory.startsWith("~/")) {
    return path.join(homeDirectory, configuredDirectory.slice(2))
  }
  if (configuredDirectory.startsWith("~")) {
    throw new Error(`Unsupported home-directory path: ${directory}`)
  }
  return path.resolve(worktree, configuredDirectory)
}

async function resolveContinuityDirectory(worktree, options = {}) {
  const io = options.fs ?? fs
  const projectConfigPath =
    options.projectConfigPath ?? resolveProjectConfigPath(worktree)
  const globalConfigPath =
    options.globalConfigPath ?? resolveGlobalConfigPath(options)
  const projectDirectory = await loadContinuityDirectoryConfig(projectConfigPath, io)
  const globalDirectory =
    projectDirectory ?? (await loadContinuityDirectoryConfig(globalConfigPath, io))
  const configuredDirectory = globalDirectory ?? "docs"
  const sourcePath = projectDirectory
    ? projectConfigPath
    : globalDirectory
      ? globalConfigPath
      : null

  let directory
  try {
    directory = resolveConfiguredDirectory(
      configuredDirectory,
      worktree,
      options.homeDirectory
    )
  } catch (error) {
    if (sourcePath && error instanceof Error) {
      throw new Error(`${error.message} in ${sourcePath}`)
    }
    throw error
  }

  try {
    const stats = await io.stat(directory)
    if (!stats.isDirectory()) {
      throw new Error(`Configured continuity directory is not a directory: ${directory}`)
    }
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") {
      return directory
    }
    if (sourcePath && error instanceof Error) {
      throw new Error(`${error.message} (configured by ${sourcePath})`)
    }
    throw error
  }

  return directory
}

async function resolveContinuityPaths(worktree, options = {}) {
  const directory = await resolveContinuityDirectory(worktree, options)
  return {
    directory,
    continuityPath: path.join(directory, CONTINUITY_FILE_NAME),
    memoryPath: path.join(directory, MEMORY_FILE_NAME),
  }
}

async function loadSessionLedger(filePath, worktree, sessionId, io = fs) {
  try {
    const content = await io.readFile(filePath, "utf8")
    const parsed = JSON.parse(content)
    if (
      parsed &&
      parsed.version === SESSION_LEDGER_VERSION &&
      typeof parsed.seen === "object" &&
      parsed.seen !== null
    ) {
      return parsed
    }
    throw new Error(`Invalid session ledger format: ${filePath}`)
  } catch (error) {
    if (error instanceof SyntaxError) {
      return {
        version: SESSION_LEDGER_VERSION,
        worktreeHash: hashWorktreePath(worktree),
        sessionId,
        seen: {},
      }
    }
    if (error && typeof error === "object" && "code" in error) {
      if (error.code === "ENOENT") {
        return {
          version: SESSION_LEDGER_VERSION,
          worktreeHash: hashWorktreePath(worktree),
          sessionId,
          seen: {},
        }
      }
    }
    if (
      error instanceof Error &&
      error.message === `Invalid session ledger format: ${filePath}`
    ) {
      return {
        version: SESSION_LEDGER_VERSION,
        worktreeHash: hashWorktreePath(worktree),
        sessionId,
        seen: {},
      }
    }
    throw error
  }
}

async function saveSessionLedger(filePath, ledger, io = fs) {
  await io.mkdir(path.dirname(filePath), { recursive: true })
  const tempPath = `${filePath}.tmp`
  await io.writeFile(tempPath, JSON.stringify(ledger, null, 2), "utf8")
  await io.rename(tempPath, filePath)
}

function findSectionIndexes(lines) {
  const indexBySection = new Map()

  lines.forEach((line, index) => {
    const match = line.match(HEADER_PATTERN)
    if (!match) return

    const section = match[1]
    if (indexBySection.has(section)) {
      throw new Error(`Duplicate section header: ${section}`)
    }
    indexBySection.set(section, index)
  })

  const missing = SECTIONS.filter((section) => !indexBySection.has(section))
  if (missing.length > 0) {
    throw new Error(`Missing section header(s): ${missing.join(", ")}`)
  }

  return indexBySection
}

function getSectionBoundaries(lines) {
  const sectionIndexes = findSectionIndexes(lines)
  const boundaries = SECTIONS.map((section) => {
    const startIndex = sectionIndexes.get(section) ?? 0
    let endIndex = lines.length
    for (let i = startIndex + 1; i < lines.length; i += 1) {
      if (lines[i].startsWith("## [")) {
        endIndex = i
        break
      }
    }
    return { section, startIndex, endIndex }
  })
  boundaries.sort((a, b) => a.startIndex - b.startIndex)
  return boundaries
}

function computeInsertIndex(lines, startIndex, endIndex) {
  let insertIndex = startIndex + 1
  for (let i = startIndex + 1; i < endIndex; i += 1) {
    if (lines[i].startsWith("- ")) {
      insertIndex = i + 1
    }
  }
  return insertIndex
}

function insertEntriesBySection(lines, orderedSections, entriesBySection) {
  const operations = []

  orderedSections.forEach((current) => {
    const entries = entriesBySection.get(current.section)
    if (!entries || entries.length === 0) return

    const insertIndex = computeInsertIndex(
      lines,
      current.startIndex,
      current.endIndex
    )
    operations.push({
      section: current.section,
      insertIndex,
      entries,
    })
  })

  operations.sort((a, b) => b.insertIndex - a.insertIndex)
  operations.forEach((operation) => {
    lines.splice(operation.insertIndex, 0, ...operation.entries)
  })
}

async function ensureContinuityFile(filePath, io = fs) {
  try {
    return await io.readFile(filePath, "utf8")
  } catch (error) {
    if (error && typeof error === "object" && "code" in error) {
      if (error.code === "ENOENT") {
        await io.mkdir(path.dirname(filePath), { recursive: true })
        await io.writeFile(filePath, TEMPLATE, "utf8")
        return TEMPLATE
      }
    }
    throw error
  }
}

async function readContinuityFile(filePath, io = fs) {
  try {
    return await io.readFile(filePath, "utf8")
  } catch (error) {
    if (error && typeof error === "object" && "code" in error) {
      if (error.code === "ENOENT") {
        throw new Error(`CONTINUITY.md not found: ${filePath}`)
      }
    }
    throw error
  }
}

async function ensureMemoryFile(filePath, io = fs) {
  try {
    return await io.readFile(filePath, "utf8")
  } catch (error) {
    if (error && typeof error === "object" && "code" in error) {
      if (error.code === "ENOENT") {
        await io.mkdir(path.dirname(filePath), { recursive: true })
        await io.writeFile(filePath, MEMORY_TEMPLATE, "utf8")
        return MEMORY_TEMPLATE
      }
    }
    throw error
  }
}

function getBulletEntries(lines, encoder, hasTrailingNewline) {
  const entries = []
  let current = null
  lines.forEach((line, index) => {
    const match = line.match(HEADER_PATTERN)
    if (match) {
      current = match[1]
      return
    }
    if (current && line.startsWith("- ")) {
      const needsNewline = hasTrailingNewline || index < lines.length - 1
      const suffix = needsNewline ? "\n" : ""
      const tokens = encoder.encode(`${line}${suffix}`).length
      entries.push({ section: current, line, index, tokens })
    }
  })
  return entries
}

function countTokensForContent(content, encoder) {
  if (content.length === 0) return 0
  return encoder.encode(content).length
}

function computeSectionBudgets(availableTokens) {
  const budgets = new Map()
  const remainders = []
  let allocated = 0

  SECTIONS.forEach((section) => {
    const weight = SECTION_RATIO_WEIGHTS[section]
    const raw = (availableTokens * weight) / SECTION_RATIO_TOTAL
    const floored = Math.floor(raw)
    budgets.set(section, floored)
    allocated += floored
    remainders.push({ section, remainder: raw - floored })
  })

  let remainderTokens = Math.max(0, availableTokens - allocated)
  remainders.sort((a, b) => b.remainder - a.remainder)
  let index = 0
  while (remainderTokens > 0 && remainders.length > 0) {
    const section = remainders[index % remainders.length].section
    budgets.set(section, (budgets.get(section) ?? 0) + 1)
    remainderTokens -= 1
    index += 1
  }

  return budgets
}

function truncateEntriesToTargetThreshold(
  lines,
  entries,
  targetThreshold,
  encoder,
  hasTrailingNewline
) {
  const removedBySection = new Map()
  if (entries.length === 0) {
    return removedBySection
  }

  let tokenCount = countTokensForContent(lines.join("\n"), encoder)
  if (tokenCount <= targetThreshold) {
    return removedBySection
  }

  const bulletTokensTotal = entries.reduce((sum, entry) => sum + entry.tokens, 0)
  const headerTokens = Math.max(0, tokenCount - bulletTokensTotal)
  const availableBulletTokens = Math.max(0, targetThreshold - headerTokens)
  const budgets = computeSectionBudgets(availableBulletTokens)

  const entriesBySection = new Map()
  entries.forEach((entry) => {
    const existing = entriesBySection.get(entry.section) ?? []
    existing.push(entry)
    entriesBySection.set(entry.section, existing)
  })

  const indexesToRemove = []
  entriesBySection.forEach((sectionEntries, section) => {
    const budget = budgets.get(section) ?? 0
    let sectionTokens = sectionEntries.reduce(
      (sum, entry) => sum + entry.tokens,
      0
    )
    let removeCount = 0
    while (sectionTokens > budget && removeCount < sectionEntries.length) {
      const entry = sectionEntries[removeCount]
      indexesToRemove.push(entry.index)
      sectionTokens -= entry.tokens
      removeCount += 1

      const existing = removedBySection.get(section) ?? []
      existing.push(entry.line)
      removedBySection.set(section, existing)
    }
  })

  indexesToRemove.sort((a, b) => b - a)
  indexesToRemove.forEach((index) => {
    lines.splice(index, 1)
  })

  tokenCount = countTokensForContent(lines.join("\n"), encoder)
  while (tokenCount > targetThreshold) {
    const remainingEntries = getBulletEntries(
      lines,
      encoder,
      hasTrailingNewline
    )
    if (remainingEntries.length === 0) {
      break
    }

    const sectionTokens = new Map()
    const sectionEntries = new Map()
    SECTIONS.forEach((section) => {
      sectionTokens.set(section, 0)
      sectionEntries.set(section, [])
    })
    remainingEntries.forEach((entry) => {
      const nextTokens = (sectionTokens.get(entry.section) ?? 0) + entry.tokens
      sectionTokens.set(entry.section, nextTokens)
      sectionEntries.get(entry.section)?.push(entry)
    })

    const bulletTokensTotal = remainingEntries.reduce(
      (sum, entry) => sum + entry.tokens,
      0
    )
    const currentHeaderTokens = Math.max(0, tokenCount - bulletTokensTotal)
    const availableBulletTokens = Math.max(0, targetThreshold - currentHeaderTokens)
    const ratioBudgets = computeSectionBudgets(availableBulletTokens)

    let targetSection = null
    let maxOverage = Number.NEGATIVE_INFINITY
    SECTIONS.forEach((section) => {
      const sectionEntryList = sectionEntries.get(section) ?? []
      if (sectionEntryList.length === 0) return
      const overage =
        (sectionTokens.get(section) ?? 0) - (ratioBudgets.get(section) ?? 0)
      if (overage > maxOverage) {
        maxOverage = overage
        targetSection = section
      }
    })

    if (!targetSection || maxOverage <= 0) {
      let maxTokens = Number.NEGATIVE_INFINITY
      SECTIONS.forEach((section) => {
        const sectionEntryList = sectionEntries.get(section) ?? []
        if (sectionEntryList.length === 0) return
        const tokens = sectionTokens.get(section) ?? 0
        if (tokens > maxTokens) {
          maxTokens = tokens
          targetSection = section
        }
      })
    }

    if (!targetSection) {
      break
    }

    const targetEntries = sectionEntries.get(targetSection) ?? []
    const entry = targetEntries[0]
    if (!entry) {
      break
    }

    lines.splice(entry.index, 1)

    const existing = removedBySection.get(entry.section) ?? []
    existing.push(entry.line)
    removedBySection.set(entry.section, existing)

    tokenCount = countTokensForContent(lines.join("\n"), encoder)
  }

  return removedBySection
}

function collectSectionTail(lines, boundary, linesPerSection) {
  const entries = []
  for (let i = boundary.startIndex + 1; i < boundary.endIndex; i += 1) {
    const line = lines[i]
    if (line.startsWith("- ")) {
      const parsedEntry = parseContinuityEntry(line, boundary.section)
      entries.push(parsedEntry ? formatReadEntry(parsedEntry) : line)
    }
  }
  if (linesPerSection >= entries.length) {
    return entries
  }
  return entries.slice(entries.length - linesPerSection)
}

function collectParsedEntries(lines, orderedSections) {
  const entries = []
  const seenExactEntries = new Set()

  orderedSections.forEach((boundary) => {
    for (let i = boundary.startIndex + 1; i < boundary.endIndex; i += 1) {
      const line = lines[i]
      if (!line.startsWith("- ")) {
        continue
      }

      const parsedEntry = parseContinuityEntry(line, boundary.section)
      if (!parsedEntry) {
        continue
      }

      const exactKey = `${parsedEntry.memoryId}|${parsedEntry.contentHash}`
      if (seenExactEntries.has(exactKey)) {
        continue
      }
      seenExactEntries.add(exactKey)
      entries.push(parsedEntry)
    }
  })

  return entries
}

function buildSectionedReadOutput(entriesBySection) {
  const outputLines = []

  SECTIONS.forEach((section, index) => {
    outputLines.push(`## [${section}]`)
    const entries = entriesBySection.get(section) ?? []
    entries.forEach((entry) => outputLines.push(entry))
    if (index < SECTIONS.length - 1) {
      outputLines.push("")
    }
  })

  return outputLines.join("\n")
}

function collectDeltaEntries(parsedEntries, ledger, readConfig) {
  const entriesBySection = new Map(SECTIONS.map((section) => [section, []]))
  let includedCount = 0

  parsedEntries.forEach((entry) => {
    const previousHash = ledger.seen[entry.memoryId]
    const changed = previousHash !== entry.contentHash
    const includePinned = readConfig.includePinned && entry.pinned
    const includeUnresolved =
      readConfig.includeUnresolved && entry.status === "unresolved"

    if (!changed && !includePinned && !includeUnresolved) {
      return
    }

    const sectionEntries = entriesBySection.get(entry.section) ?? []
    sectionEntries.push(formatReadEntry(entry))
    entriesBySection.set(entry.section, sectionEntries)
    ledger.seen[entry.memoryId] = entry.contentHash
    includedCount += 1
  })

  return { entriesBySection, includedCount }
}

export {
  SECTIONS,
  PROVENANCE,
  TEMPLATE,
  MEMORY_TEMPLATE,
  validateText,
  resolveReadConfig,
  resolveCompactionConfig,
  findSectionIndexes,
  getSectionBoundaries,
  computeInsertIndex,
  insertEntriesBySection,
  ensureContinuityFile,
  readContinuityFile,
  ensureMemoryFile,
  getBulletEntries,
  countTokensForContent,
  computeSectionBudgets,
  truncateEntriesToTargetThreshold,
  collectSectionTail,
  collectParsedEntries,
  formatReadEntry,
  buildSectionedReadOutput,
  collectDeltaEntries,
  buildEntry,
  deriveMemoryId,
  hashMemoryContent,
  hashWorktreePath,
  loadContinuityDirectoryConfig,
  loadSessionLedger,
  normalizeMemoryContent,
  parseContinuityEntry,
  resolveLedgerPath,
  resolveConfiguredDirectory,
  resolveContinuityDirectory,
  resolveContinuityPaths,
  resolveGlobalConfigPath,
  resolveProjectConfigPath,
  resolveWorktree,
  saveSessionLedger,
}

export async function executeLegacy(args, context, options = {}) {
    const io = options.fs ?? fs
    const worktree = resolveWorktree(context)
    const ledgerIdentity = options.ledgerIdentity ?? worktree
    const paths = options.paths
    const { continuityPath, memoryPath } = paths
      ? {
          continuityPath: paths.continuityPath ?? path.join(paths.directory, CONTINUITY_FILE_NAME),
          memoryPath: paths.memoryPath ?? path.join(paths.directory, MEMORY_FILE_NAME),
        }
      : await resolveContinuityPaths(worktree, { fs: io })

    if (args.command === "read") {
      if (args.updates && args.updates.length > 0) {
        throw new Error("updates are not supported for read command")
      }
      const readConfig = resolveReadConfig(args.read)

      const content = await readContinuityFile(continuityPath, io)
      const lines = content.split(/\r?\n/)
      const orderedSections = getSectionBoundaries(lines)

      if (readConfig.mode === "tail") {
        const entriesBySection = new Map()
        orderedSections.forEach((boundary) => {
          entriesBySection.set(
            boundary.section,
            collectSectionTail(lines, boundary, readConfig.linesPerSection)
          )
        })
        return buildSectionedReadOutput(entriesBySection)
      }

      const parsedEntries = collectParsedEntries(lines, orderedSections)
      const ledgerPath = resolveLedgerPath(ledgerIdentity, readConfig.sessionId)
      const ledger = await loadSessionLedger(
        ledgerPath,
        ledgerIdentity,
        readConfig.sessionId,
        io
      )
      const { entriesBySection, includedCount } = collectDeltaEntries(
        parsedEntries,
        ledger,
        readConfig
      )

      if (includedCount === 0) {
        return "No new or changed task memories."
      }

      await saveSessionLedger(ledgerPath, ledger, io)
      return buildSectionedReadOutput(entriesBySection)
    }

    if (!args.updates || args.updates.length === 0) {
      throw new Error("updates must be provided for update command")
    }

    const timestamp = options.timestamp ?? `${new Date().toISOString().slice(0, 16)}Z`
    const compactionConfig = resolveCompactionConfig(args.compaction)

    const updatesBySection = new Map()
    args.updates.forEach((update) => {
      validateText(update.text)
      const entry = buildEntry(timestamp, update)
      const entries = updatesBySection.get(update.section) ?? []
      entries.push(entry)
      updatesBySection.set(update.section, entries)
    })

    const content = await ensureContinuityFile(continuityPath, io)
    const hasTrailingNewline = content.endsWith("\n")
    const lines = content.split(/\r?\n/)

    const orderedSections = getSectionBoundaries(lines)
    insertEntriesBySection(lines, orderedSections, updatesBySection)

    const compactionEntriesBySection = new Map()
    let removedBySection = new Map()
    if (compactionConfig.enabled) {
      const encoder = compactionConfig.encoding === DEFAULT_ENCODING
        ? getDefaultEncoder()
        : get_encoding(compactionConfig.encoding)
      try {
        const totalTokens = countTokensForContent(lines.join("\n"), encoder)

        if (totalTokens > compactionConfig.upperTokenThreshold) {
          const compactionEntry = buildEntry(timestamp, {
            section: "DISCOVERIES",
            provenance: "TOOL",
            text: "Compaction triggered: exceeded upper token threshold; truncated oldest entries to at or below lower target; archived to MEMORY.md.",
          })
          compactionEntriesBySection.set("DISCOVERIES", [compactionEntry])
          insertEntriesBySection(
            lines,
            orderedSections,
            compactionEntriesBySection
          )

          const entriesAfter = getBulletEntries(
            lines,
            encoder,
            hasTrailingNewline
          )
          removedBySection =
            truncateEntriesToTargetThreshold(
              lines,
              entriesAfter,
              compactionConfig.lowerTokenThreshold,
              encoder,
              hasTrailingNewline
            ) ?? new Map()

          if (removedBySection.size > 0) {
            const memoryContent = await ensureMemoryFile(memoryPath, io)
            const memoryHasTrailingNewline = memoryContent.endsWith("\n")
            const memoryLines = memoryContent.split(/\r?\n/)
            const memorySections = getSectionBoundaries(memoryLines)
            insertEntriesBySection(memoryLines, memorySections, removedBySection)

            let memoryOutput = memoryLines.join("\n")
            if (memoryHasTrailingNewline && !memoryOutput.endsWith("\n")) {
              memoryOutput += "\n"
            }
            if (!memoryHasTrailingNewline && memoryOutput.endsWith("\n")) {
              memoryOutput = memoryOutput.replace(/\n$/, "")
            }
            await io.writeFile(memoryPath, memoryOutput, "utf8")

          }
        }
      } finally {
        if (encoder !== sharedEncoder) encoder.free()
      }
    }

    let output = lines.join("\n")
    if (hasTrailingNewline && !output.endsWith("\n")) {
      output += "\n"
    }
    if (!hasTrailingNewline && output.endsWith("\n")) {
      output = output.replace(/\n$/, "")
    }

    await io.writeFile(continuityPath, output, "utf8")

    return ""
}
