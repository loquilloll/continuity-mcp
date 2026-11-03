import { describe, it } from "node:test"

import { expect } from "./expect.ts"
import fs from "fs/promises"
import os from "os"
import path from "path"
import {
  execute,
  buildEntry,
  deriveMemoryId,
  hashMemoryContent,
  loadContinuityDirectoryConfig,
  loadSessionLedger,
  normalizeMemoryContent,
  parseContinuityEntry,
  resolveConfiguredDirectory,
  resolveContinuityDirectory,
  resolveContinuityPaths,
  resolveGlobalConfigPath,
  resolveLedgerPath,
  resolveProjectConfigPath,
  resolveWorktree,
} from "../src/continuity.ts"
import type { ContinuityArgs } from "../src/continuity.ts"

const tiktoken: any = await import("tiktoken")
const get_encoding =
  tiktoken.get_encoding ??
  tiktoken.default?.get_encoding ??
  tiktoken["module.exports"]?.get_encoding

const FIXTURE = `# CONTINUITY

## [PLANS]
- 2026-02-01T00:00Z [USER] [plan:baseline] Existing plan entry.

## [DECISIONS]
- 2026-02-01T00:00Z [CODE] Existing decision entry.

## [PROGRESS]
- 2026-02-01T00:00Z [TOOL] Existing progress entry.

## [DISCOVERIES]

## [OUTCOMES]
`

const READ_FIXTURE = `# CONTINUITY

## [PLANS]
- 2026-02-01T00:00Z [USER] [plan:baseline] First plan entry.
- 2026-02-02T00:00Z [USER] [plan:baseline] Second plan entry.

## [DECISIONS]
- 2026-02-01T00:00Z [CODE] First decision entry.
- 2026-02-02T00:00Z [CODE] Second decision entry.

## [PROGRESS]
- 2026-02-01T00:00Z [TOOL] First progress entry.
- 2026-02-02T00:00Z [TOOL] Second progress entry.

## [DISCOVERIES]
- 2026-02-01T00:00Z [TOOL] First discovery entry.

## [OUTCOMES]
- 2026-02-01T00:00Z [CODE] First outcome entry.
`

const MIXED_READ_FIXTURE = `# CONTINUITY

## [PLANS]
- 2026-02-01T00:00Z [USER] [plan:baseline] Legacy plan entry.
- [id:plans-202602020000z-user-abcd1234ef56] 2026-02-02T00:00Z [USER] [plan:baseline] Id-prefixed plan entry.

## [DECISIONS]
- 2026-02-01T00:00Z [CODE] Legacy decision entry.

## [PROGRESS]
- [id:progress-202602020000z-tool-baadf00d1234] 2026-02-02T00:00Z [TOOL] Id-prefixed progress entry.

## [DISCOVERIES]
- 2026-02-01T00:00Z [TOOL] Legacy discovery entry.

## [OUTCOMES]
- [id:outcomes-202602020000z-code-deadbeef1234] 2026-02-02T00:00Z [CODE] Id-prefixed outcome entry.
`

const DELTA_FIXTURE = `# CONTINUITY

## [PLANS]
- [id:plans-202602010000z-user-aa11aa11aa11] 2026-02-01T00:00Z [USER] [plan:baseline] Shared plan memory.
- [id:plans-202602010000z-user-aa11aa11aa11] 2026-02-01T00:00Z [USER] [plan:baseline] Shared plan memory.

## [DECISIONS]
- [id:decisions-202602010000z-code-bb22bb22bb22] 2026-02-01T00:00Z [CODE] First decision memory.

## [PROGRESS]
- [id:progress-202602010000z-tool-cc33cc33cc33] 2026-02-01T00:00Z [TOOL] [pin] Pinned progress memory.

## [DISCOVERIES]
- [id:discoveries-202602010000z-tool-dd44dd44dd44] 2026-02-01T00:00Z [TOOL] [status:unresolved] Unresolved discovery memory.

## [OUTCOMES]
- [id:outcomes-202602010000z-code-ee55ee55ee55] 2026-02-01T00:00Z [CODE] Completed outcome memory.
`

const DUMMY_FIXTURE_PATH = path.join(
  process.cwd(),
  "docs",
  "CONTINUITY_DUMMY.md"
)

async function createTempWorktree() {
  return await fs.mkdtemp(path.join(os.tmpdir(), "continuity-tool-"))
}

async function setupFixtureWorktree(fixtures: Record<string, string>) {
  const worktree = await createTempWorktree()
  await Promise.all(
    Object.entries(fixtures).map(async ([relativePath, content]) => {
      const targetPath = path.join(worktree, relativePath)
      await fs.mkdir(path.dirname(targetPath), { recursive: true })
      await fs.writeFile(targetPath, content, "utf8")
    })
  )
  return worktree
}

async function readContinuity(worktree: string, directory = "docs") {
  return await fs.readFile(
    path.join(worktree, directory, "CONTINUITY.md"),
    "utf8"
  )
}

async function readMemory(worktree: string, directory = "docs") {
  return await fs.readFile(path.join(worktree, directory, "MEMORY.md"), "utf8")
}

async function readLedger(worktree: string, sessionId: string) {
  const ledgerPath = resolveLedgerPath(worktree, sessionId)
  return JSON.parse(await fs.readFile(ledgerPath, "utf8"))
}

async function readDummyFixture() {
  const content = await fs.readFile(DUMMY_FIXTURE_PATH, "utf8")
  if (content.includes("## [PLANS]")) {
    return content
  }
  return content.replace(
    /^\[(PLANS|DECISIONS|PROGRESS|DISCOVERIES|OUTCOMES)\]$/gm,
    "## [$1]"
  )
}

function getSectionLines(content: string, section: string) {
  const lines = content.split(/\r?\n/)
  const header = `## [${section}]`
  const startIndex = lines.indexOf(header)
  if (startIndex === -1) {
    throw new Error(`Missing header: ${section}`)
  }
  let endIndex = lines.length
  for (let i = startIndex + 1; i < lines.length; i += 1) {
    if (lines[i].startsWith("## [")) {
      endIndex = i
      break
    }
  }
  return lines.slice(startIndex + 1, endIndex)
}

function getBulletLines(content: string, section: string) {
  return getSectionLines(content, section).filter((line) =>
    line.startsWith("- ")
  )
}

function countTotalTokens(content: string, encoder: any) {
  return encoder.encode(content).length
}

function expectSectionOrder(content: string) {
  const lines = content.split(/\r?\n/)
  const sections = [
    "PLANS",
    "DECISIONS",
    "PROGRESS",
    "DISCOVERIES",
    "OUTCOMES",
  ]
  const indexes = sections.map((section) => lines.indexOf(`## [${section}]`))
  indexes.forEach((index) => expect(index).toBeGreaterThanOrEqual(0))
  for (let i = 1; i < indexes.length; i += 1) {
    expect(indexes[i]).toBeGreaterThan(indexes[i - 1])
  }
}

function extractTimestamp(line: string) {
  const match = line.match(
    /^\- (?:\[id:[^\]]+\] )?(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}Z)/
  )
  if (!match) {
    throw new Error(`Missing timestamp in line: ${line}`)
  }
  return match[1]
}

function extractMemoryId(line: string) {
  const match = line.match(/^\- \[id:([^\]]+)\]/)
  if (!match) {
    throw new Error(`Missing memory ID in line: ${line}`)
  }
  return match[1]
}

describe("continuity", () => {
  it("appends entries after last bullet with shared timestamp", async () => {
    const worktree = await setupFixtureWorktree({
      "docs/CONTINUITY.md": FIXTURE,
    })

    const result = await execute(
      {
        command: "update",
        updates: [
          {
            section: "PLANS",
            provenance: "USER",
            plan: "01-continuity-tool",
            text: "Sample continuity update via test.",
          },
          {
            section: "DECISIONS",
            provenance: "CODE",
            text: "Sample decision entry from test.",
          },
        ],
      },
      { worktree }
    )

    const content = await readContinuity(worktree)
    const plans = getSectionLines(content, "PLANS")
    const decisions = getSectionLines(content, "DECISIONS")

    const planExistingIndex = plans.findIndex((line) =>
      line.includes("Existing plan entry.")
    )
    const planNewIndex = plans.findIndex((line) =>
      line.includes("Sample continuity update via test.")
    )
    expect(planExistingIndex).toBeGreaterThanOrEqual(0)
    expect(planNewIndex).toBeGreaterThan(planExistingIndex)

    const decisionExistingIndex = decisions.findIndex((line) =>
      line.includes("Existing decision entry.")
    )
    const decisionNewIndex = decisions.findIndex((line) =>
      line.includes("Sample decision entry from test.")
    )
    expect(decisionExistingIndex).toBeGreaterThanOrEqual(0)
    expect(decisionNewIndex).toBeGreaterThan(decisionExistingIndex)

    const planLine = plans[planNewIndex]
    const decisionLine = decisions[decisionNewIndex]
    const planTimestamp = extractTimestamp(planLine)
    const decisionTimestamp = extractTimestamp(decisionLine)
    const planMemoryId = extractMemoryId(planLine)
    const decisionMemoryId = extractMemoryId(decisionLine)
    expect(planTimestamp).toBe(decisionTimestamp)
    expect(planTimestamp).toMatch(
      /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}Z$/
    )
    expect(planMemoryId).toBe(
      deriveMemoryId({
        section: "PLANS",
        timestamp: planTimestamp,
        provenance: "USER",
        plan: "01-continuity-tool",
        text: "Sample continuity update via test.",
      })
    )
    expect(decisionMemoryId).toBe(
      deriveMemoryId({
        section: "DECISIONS",
        timestamp: decisionTimestamp,
        provenance: "CODE",
        text: "Sample decision entry from test.",
      })
    )
    expect(result).toBe("")
  })

  it("preserves input order for multiple entries in one section", async () => {
    const worktree = await setupFixtureWorktree({
      "docs/CONTINUITY.md": FIXTURE,
    })

    await execute(
      {
        command: "update",
        updates: [
          {
            section: "PROGRESS",
            provenance: "TOOL",
            text: "First progress entry.",
          },
          {
            section: "PROGRESS",
            provenance: "TOOL",
            text: "Second progress entry.",
          },
        ],
      },
      { worktree }
    )

    const content = await readContinuity(worktree)
    const progress = getSectionLines(content, "PROGRESS")

    const firstIndex = progress.findIndex((line) =>
      line.includes("First progress entry.")
    )
    const secondIndex = progress.findIndex((line) =>
      line.includes("Second progress entry.")
    )

    expect(firstIndex).toBeGreaterThanOrEqual(0)
    expect(secondIndex).toBeGreaterThan(firstIndex)
  })

  it("creates continuity file when missing", async () => {
    const worktree = await createTempWorktree()

    await execute(
      {
        command: "update",
        updates: [
          {
            section: "PLANS",
            provenance: "USER",
            text: "Created from missing file.",
          },
        ],
      },
      { worktree }
    )

    const content = await readContinuity(worktree)
    expect(content).toContain("## [PLANS]")
    expect(content).toContain("## [DECISIONS]")
    expect(content).toContain("## [PROGRESS]")
    expect(content).toContain("## [DISCOVERIES]")
    expect(content).toContain("## [OUTCOMES]")
    expect(content).toContain("Created from missing file.")
  })

  it("falls back to the current working directory when worktree is missing or root-only", () => {
    const cwd = path.resolve(path.join(path.sep, "tmp", "continuity-cwd"))
    const filesystemRoot = path.parse(cwd).root

    expect(resolveWorktree({}, cwd)).toBe(cwd)
    expect(resolveWorktree({ worktree: filesystemRoot }, cwd)).toBe(cwd)
    expect(resolveWorktree({ worktree: cwd }, filesystemRoot)).toBe(cwd)
  })

  it("resolves global and project config paths", () => {
    const previousXdg = process.env.XDG_CONFIG_HOME
    try {
      delete process.env.XDG_CONFIG_HOME
      expect(
        resolveGlobalConfigPath({ homeDirectory: "/tmp/home" })
      ).toBe(path.join("/tmp/home", ".config", "continuity", "continuity.json"))
      process.env.XDG_CONFIG_HOME = "/xdg-config"
      expect(
        resolveGlobalConfigPath({ homeDirectory: "/tmp/home" })
      ).toBe(path.join("/xdg-config", "continuity", "continuity.json"))
    } finally {
      if (previousXdg === undefined) delete process.env.XDG_CONFIG_HOME
      else process.env.XDG_CONFIG_HOME = previousXdg
    }
    expect(resolveProjectConfigPath("/tmp/project")).toBe(
      path.join("/tmp/project", ".continuity", "continuity.json")
    )
  })

  it("resolves configured directories relative to worktree and home", () => {
    const worktree = path.resolve(path.join(path.sep, "tmp", "project"))
    const homeDirectory = path.resolve(path.join(path.sep, "tmp", "home"))
    const sharedDirectory = path.resolve(path.join(path.sep, "tmp", "shared"))

    expect(resolveConfiguredDirectory(".ai-memory", worktree, homeDirectory)).toBe(
      path.join(worktree, ".ai-memory")
    )
    expect(resolveConfiguredDirectory(sharedDirectory, worktree, homeDirectory)).toBe(
      sharedDirectory
    )
    expect(resolveConfiguredDirectory("~", worktree, homeDirectory)).toBe(homeDirectory)
    expect(resolveConfiguredDirectory("~/.continuity", worktree, homeDirectory)).toBe(
      path.join(homeDirectory, ".continuity")
    )
    expect(() => resolveConfiguredDirectory("~other/files", worktree, homeDirectory)).toThrow(
      "Unsupported home-directory path"
    )
  })

  it("derives colocated managed paths with an injected home directory", async () => {
    const configRoot = await createTempWorktree()
    const worktree = await createTempWorktree()
    const homeDirectory = await createTempWorktree()
    const globalConfigPath = path.join(configRoot, "continuity.json")
    await fs.writeFile(globalConfigPath, JSON.stringify({ directory: "~/.memory" }), "utf8")

    await expect(
      resolveContinuityPaths(worktree, { globalConfigPath, homeDirectory })
    ).resolves.toEqual({
      directory: path.join(homeDirectory, ".memory"),
      continuityPath: path.join(homeDirectory, ".memory", "CONTINUITY.md"),
      memoryPath: path.join(homeDirectory, ".memory", "MEMORY.md"),
    })
  })

  it("rejects malformed and invalid directory config files", async () => {
    const configRoot = await createTempWorktree()
    const malformedPath = path.join(configRoot, "malformed.json")
    const invalidPath = path.join(configRoot, "invalid.json")
    await fs.writeFile(malformedPath, "{", "utf8")
    await fs.writeFile(invalidPath, JSON.stringify({ directory: " ", extra: true }), "utf8")

    await expect(loadContinuityDirectoryConfig(malformedPath)).rejects.toThrow(
      malformedPath
    )
    await expect(loadContinuityDirectoryConfig(invalidPath)).rejects.toThrow(invalidPath)
    expect(await loadContinuityDirectoryConfig(path.join(configRoot, "missing.json"))).toBeNull()
  })

  it("uses global config relative to the worktree and creates its directory", async () => {
    const configRoot = await createTempWorktree()
    const worktree = await setupFixtureWorktree({
      ".placeholder": "",
    })
    const globalConfigPath = path.join(configRoot, "continuity.json")
    await fs.writeFile(
      globalConfigPath,
      JSON.stringify({ directory: ".ai-memory" }),
      "utf8"
    )

    await execute(
      {
        command: "update",
        updates: [
          {
            section: "PLANS",
            provenance: "USER",
            text: "Global configured location.",
          },
        ],
      },
      { worktree, globalConfigPath }
    )

    expect(await readContinuity(worktree, ".ai-memory")).toContain(
      "Global configured location."
    )
    await expect(readContinuity(worktree)).rejects.toThrow()
  })

  it("prefers project config over global config", async () => {
    const configRoot = await createTempWorktree()
    const worktree = await setupFixtureWorktree({
      ".continuity/continuity.json": JSON.stringify({ directory: ".project-memory" }),
    })
    const globalConfigPath = path.join(configRoot, "continuity.json")
    await fs.writeFile(
      globalConfigPath,
      JSON.stringify({ directory: ".global-memory" }),
      "utf8"
    )

    await execute(
      {
        command: "update",
        updates: [
          {
            section: "PLANS",
            provenance: "USER",
            text: "Project configured location.",
          },
        ],
      },
      { worktree, globalConfigPath }
    )

    expect(await readContinuity(worktree, ".project-memory")).toContain(
      "Project configured location."
    )
    await expect(readContinuity(worktree, ".global-memory")).rejects.toThrow()
  })

  it("writes to an absolute directory configured globally", async () => {
    const configRoot = await createTempWorktree()
    const externalDirectory = path.join(await createTempWorktree(), "memory")
    const worktree = await createTempWorktree()
    const globalConfigPath = path.join(configRoot, "continuity.json")
    await fs.writeFile(
      globalConfigPath,
      JSON.stringify({ directory: externalDirectory }),
      "utf8"
    )

    await execute(
      {
        command: "update",
        updates: [
          {
            section: "PLANS",
            provenance: "USER",
            text: "Absolute configured location.",
          },
        ],
      },
      { worktree, globalConfigPath }
    )

    expect(await fs.readFile(path.join(externalDirectory, "CONTINUITY.md"), "utf8")).toContain(
      "Absolute configured location."
    )
    await expect(readContinuity(worktree)).rejects.toThrow()
  })

  it("rejects invalid project configuration without writing managed files", async () => {
    const worktree = await setupFixtureWorktree({
      ".continuity/continuity.json": '{"directory":".memory","unexpected":true}',
    })
    const configPath = resolveProjectConfigPath(worktree)

    await expect(
      execute(
        {
          command: "update",
          updates: [
            {
              section: "PLANS",
              provenance: "USER",
              text: "This must not be written.",
            },
          ],
        },
        { worktree }
      )
    ).rejects.toThrow(configPath)
    await expect(readContinuity(worktree)).rejects.toThrow()
    await expect(readContinuity(worktree, ".memory")).rejects.toThrow()
  })

  it("rejects configured paths that are existing files", async () => {
    const worktree = await setupFixtureWorktree({
      ".continuity/continuity.json": JSON.stringify({ directory: "not-a-directory" }),
      "not-a-directory": "file",
    })

    await expect(resolveContinuityDirectory(worktree)).rejects.toThrow(
      "not a directory"
    )
  })

  it("reads delta memories from the configured directory while retaining worktree ledger identity", async () => {
    const worktree = await setupFixtureWorktree({
      ".continuity/continuity.json": JSON.stringify({ directory: ".memory" }),
      ".memory/CONTINUITY.md": DELTA_FIXTURE,
    })
    const sessionId = "configured-delta"

    const output = await execute(
      { command: "read", read: { sessionId } },
      { worktree }
    )

    expect(output).toContain("Shared plan memory.")
    expect(await readLedger(worktree, sessionId)).toMatchObject({
      version: 1,
      sessionId,
    })
  })

  it("fails when a required section header is missing", async () => {
    const missingHeaderFixture = FIXTURE.replace("## [DISCOVERIES]\n\n", "")
    const worktree = await setupFixtureWorktree({
      "docs/CONTINUITY.md": missingHeaderFixture,
    })

    let error: any = null
    try {
      await execute(
        {
          command: "update",
          updates: [
            {
              section: "PLANS",
              provenance: "USER",
              text: "Should fail on missing header.",
            },
          ],
        },
        { worktree }
      )
    } catch (caught) {
      error = caught
    }

    const content = await readContinuity(worktree)
    expect(error).not.toBeNull()
    expect(error?.message).toContain("Missing section header(s): DISCOVERIES")
    expect(content).toBe(missingHeaderFixture)
  })

  it("rejects multi-line text without mutating the file", async () => {
    const worktree = await setupFixtureWorktree({
      "docs/CONTINUITY.md": FIXTURE,
    })
    const before = await readContinuity(worktree)

    let error: any = null
    try {
      await execute(
        {
          command: "update",
          updates: [
            {
              section: "PLANS",
              provenance: "USER",
              text: "Line one.\nLine two.",
            },
          ],
        },
        { worktree }
      )
    } catch (caught) {
      error = caught
    }

    const after = await readContinuity(worktree)
    expect(error).not.toBeNull()
    expect(error?.message).toContain("text must be a single line")
    expect(after).toBe(before)
  })

  it("rejects text that starts with a bracketed token without mutating the file", async () => {
    const worktree = await setupFixtureWorktree({
      "docs/CONTINUITY.md": FIXTURE,
    })
    const before = await readContinuity(worktree)

    let error: any = null
    try {
      await execute(
        {
          command: "update",
          updates: [
            {
              section: "PLANS",
              provenance: "USER",
              text: "[pin] Should be rejected.",
            },
          ],
        },
        { worktree }
      )
    } catch (caught) {
      error = caught
    }

    const after = await readContinuity(worktree)
    expect(error).not.toBeNull()
    expect(error?.message).toContain("text must not start with a bracketed token")
    expect(after).toBe(before)
  })

  it("parses legacy and id-prefixed continuity entries", () => {
    const legacyLine =
      "- 2026-02-01T00:00Z [USER] [plan:baseline] Legacy plan entry."
    const idLine =
      "- [id:plans-202602020000z-user-abcd1234ef56] 2026-02-02T00:00Z [USER] [plan:baseline] [pin] Id-prefixed plan entry."

    const legacyEntry = parseContinuityEntry(legacyLine, "PLANS")
    const idEntry = parseContinuityEntry(idLine, "PLANS")

    expect(legacyEntry).not.toBeNull()
    expect(legacyEntry?.isLegacy).toBe(true)
    expect(legacyEntry?.provenance).toBe("USER")
    expect(legacyEntry?.plan).toBe("baseline")
    expect(legacyEntry?.text).toBe("Legacy plan entry.")
    expect(legacyEntry?.memoryId).toBe(
      deriveMemoryId({
        section: "PLANS",
        timestamp: "2026-02-01T00:00Z",
        provenance: "USER",
        plan: "baseline",
        text: "Legacy plan entry.",
      })
    )

    expect(idEntry).not.toBeNull()
    expect(idEntry?.isLegacy).toBe(false)
    expect(idEntry?.memoryId).toBe(
      "plans-202602020000z-user-abcd1234ef56"
    )
    expect(idEntry?.pinned).toBe(true)
    expect(idEntry?.text).toBe("Id-prefixed plan entry.")
  })

  it("parses status and preserves unknown leading tokens as text", () => {
    const line =
      "- [id:plans-202602020000z-user-abcd1234ef56] 2026-02-02T00:00Z [USER] [foo] [status:active] [pin] Parsed text."

    const entry = parseContinuityEntry(line, "PLANS")

    expect(entry).not.toBeNull()
    expect(entry?.provenance).toBe("USER")
    expect(entry?.status).toBe("active")
    expect(entry?.pinned).toBe(true)
    expect(entry?.text).toBe("[foo] Parsed text.")
  })

  it("returns null for malformed continuity lines", () => {
    expect(parseContinuityEntry("Not a bullet", "PLANS")).toBeNull()
    expect(parseContinuityEntry("- No timestamp here", "PLANS")).toBeNull()
  })

  it("normalizes and hashes memory content deterministically", () => {
    const first = "  Same   content\r\nwith spacing  "
    const second = "Same content\nwith spacing"

    expect(normalizeMemoryContent(first)).toBe("Same content with spacing")
    expect(normalizeMemoryContent(second)).toBe("Same content with spacing")
    expect(hashMemoryContent(first)).toBe(hashMemoryContent(second))
    expect(hashMemoryContent(first)).toMatch(/^sha256:[0-9a-f]{64}$/)
  })

  it("derives deterministic memory ids for sparse inputs", () => {
    const memoryId = deriveMemoryId({
      section: null,
      timestamp: undefined,
      provenance: null,
      plan: null,
      text: "x",
    })

    expect(memoryId).toBe(deriveMemoryId({
      section: null,
      timestamp: undefined,
      provenance: null,
      plan: null,
      text: "x",
    }))
    expect(memoryId).toMatch(/^entry-undated-unknown-[0-9a-f]{12}$/)
  })

  it("accepts plan slugs containing dots when generating ids", async () => {
    const worktree = await setupFixtureWorktree({
      "docs/CONTINUITY.md": FIXTURE,
    })

    await execute(
      {
        command: "update",
        updates: [
          {
            section: "PLANS",
            provenance: "USER",
            plan: "04.layered-memory",
            text: "Plan slug with dot support.",
          },
        ],
      },
      { worktree }
    )

    const content = await readContinuity(worktree)
    expect(content).toContain("[plan:04.layered-memory] Plan slug with dot support.")
    expect(content).toContain("[id:")
  })

  it("round-trips builder output through the parser", () => {
    const timestamp = "2026-02-05T12:34Z"
    const line = buildEntry(timestamp, {
      section: "PLANS",
      provenance: "USER",
      plan: "round.trip",
      text: "Round-trip continuity entry.",
    })

    const parsed = parseContinuityEntry(line, "PLANS")

    expect(parsed).not.toBeNull()
    expect(parsed?.memoryId).toBe(extractMemoryId(line))
    expect(parsed?.timestamp).toBe(timestamp)
    expect(parsed?.provenance).toBe("USER")
    expect(parsed?.plan).toBe("round.trip")
    expect(parsed?.text).toBe("Round-trip continuity entry.")
    expect(parsed?.contentHash).toBe(hashMemoryContent("Round-trip continuity entry."))
    expect(parsed?.isLegacy).toBe(false)
  })

  it("reads latest entries per section without mutating file", async () => {
    const worktree = await setupFixtureWorktree({
      "docs/CONTINUITY.md": READ_FIXTURE,
    })
    const before = await readContinuity(worktree)

    const output = await execute(
      {
        command: "read",
        read: {
          mode: "tail",
          linesPerSection: 1,
        },
      },
      { worktree }
    )

    expect(output).toContain("## [PLANS]")
    expect(output).toContain("Second plan entry.")
    expect(output).not.toContain("First plan entry.")
    expect(output).toContain("## [DECISIONS]")
    expect(output).toContain("Second decision entry.")
    expect(output).not.toContain("First decision entry.")
    expect(output).toContain("## [PROGRESS]")
    expect(output).toContain("Second progress entry.")
    expect(output).not.toContain("First progress entry.")
    expect(output).toContain("## [DISCOVERIES]")
    expect(output).toContain("First discovery entry.")
    expect(output).toContain("## [OUTCOMES]")
    expect(output).toContain("First outcome entry.")

    const after = await readContinuity(worktree)
    expect(after).toBe(before)
  })

  it("reads mixed legacy and id-prefixed entries without mutating file", async () => {
    const worktree = await setupFixtureWorktree({
      "docs/CONTINUITY.md": MIXED_READ_FIXTURE,
    })
    const before = await readContinuity(worktree)

    const output = await execute(
      {
        command: "read",
        read: {
          mode: "tail",
          linesPerSection: 2,
        },
      },
      { worktree }
    )

    expect(output).toContain("Legacy plan entry.")
    expect(output).not.toContain("[id:")
    expect(output).toContain("Id-prefixed progress entry.")
    expect(output).toContain("Legacy discovery entry.")

    const after = await readContinuity(worktree)
    expect(after).toBe(before)
  })

  it("returns new memories on first delta read and seeds ledger", async () => {
    const worktree = await setupFixtureWorktree({
      "docs/CONTINUITY.md": DELTA_FIXTURE,
    })
    const before = await readContinuity(worktree)
    const sessionId = "delta-first-read"

    const output = await execute(
      {
        command: "read",
        read: {
          sessionId,
        },
      },
      { worktree }
    )

    expect(output).toContain("Shared plan memory.")
    expect(output.match(/Shared plan memory\./g)?.length).toBe(1)
    expect(output).toContain("First decision memory.")
    expect(output).toContain("Completed outcome memory.")

    const ledger = await readLedger(worktree, sessionId)
    expect(ledger.version).toBe(1)
    expect(ledger.sessionId).toBe(sessionId)
    expect(Object.keys(ledger.seen)).toContain(
      "plans-202602010000z-user-aa11aa11aa11"
    )

    const after = await readContinuity(worktree)
    expect(after).toBe(before)
  })

  it("returns minimal no-delta output on repeated delta reads", async () => {
    const worktree = await setupFixtureWorktree({
      "docs/CONTINUITY.md": DELTA_FIXTURE,
    })

    const request: ContinuityArgs = {
      command: "read",
      read: {
        mode: "delta",
        sessionId: "delta-repeat-read",
      },
    }

    await execute(request, { worktree })
    const second = await execute(request, { worktree })

    expect(second).toBe("No new or changed task memories.")
  })

  it("supports delta mode on legacy-only continuity files", async () => {
    const worktree = await setupFixtureWorktree({
      "docs/CONTINUITY.md": READ_FIXTURE,
    })

    const request: ContinuityArgs = {
      command: "read",
      read: {
        mode: "delta",
        sessionId: "delta-legacy-only",
      },
    }

    const first = await execute(request, { worktree })
    const second = await execute(request, { worktree })

    expect(first).toContain("Second plan entry.")
    expect(first).toContain("First outcome entry.")
    expect(second).toBe("No new or changed task memories.")
  })

  it("returns changed content again when the same memory id changes", async () => {
    const worktree = await setupFixtureWorktree({
      "docs/CONTINUITY.md": DELTA_FIXTURE,
    })
    const sessionId = "delta-changed-hash"

    await execute(
      {
        command: "read",
        read: {
          mode: "delta",
          sessionId,
        },
      },
      { worktree }
    )

    const updatedFixture = DELTA_FIXTURE.replace(
      /- \[id:plans-202602010000z-user-aa11aa11aa11\] 2026-02-01T00:00Z \[USER\] \[plan:baseline\] Shared plan memory\.\n- \[id:plans-202602010000z-user-aa11aa11aa11\] 2026-02-01T00:00Z \[USER\] \[plan:baseline\] Shared plan memory\./,
      "- [id:plans-202602010000z-user-aa11aa11aa11] 2026-02-01T00:00Z [USER] [plan:baseline] Shared plan memory updated."
    )
    await fs.writeFile(
      path.join(worktree, "docs", "CONTINUITY.md"),
      updatedFixture,
      "utf8"
    )

    const output = await execute(
      {
        command: "read",
        read: {
          mode: "delta",
          sessionId,
        },
      },
      { worktree }
    )

    expect(output).toContain("Shared plan memory updated.")
    expect(output).not.toContain("Shared plan memory.\n")
  })

  it("includes pinned entries only when requested in delta mode", async () => {
    const worktree = await setupFixtureWorktree({
      "docs/CONTINUITY.md": DELTA_FIXTURE,
    })
    const sessionId = "delta-pinned"

    await execute(
      {
        command: "read",
        read: { mode: "delta", sessionId },
      },
      { worktree }
    )

    const withoutPinned = await execute(
      {
        command: "read",
        read: { mode: "delta", sessionId },
      },
      { worktree }
    )
    const withPinned = await execute(
      {
        command: "read",
        read: { mode: "delta", sessionId, includePinned: true },
      },
      { worktree }
    )

    expect(withoutPinned).toBe("No new or changed task memories.")
    expect(withPinned).toContain("Pinned progress memory.")
  })

  it("includes unresolved entries only when requested in delta mode", async () => {
    const worktree = await setupFixtureWorktree({
      "docs/CONTINUITY.md": DELTA_FIXTURE,
    })
    const sessionId = "delta-unresolved"

    await execute(
      {
        command: "read",
        read: { mode: "delta", sessionId },
      },
      { worktree }
    )

    const withUnresolved = await execute(
      {
        command: "read",
        read: {
          mode: "delta",
          sessionId,
          includeUnresolved: true,
        },
      },
      { worktree }
    )

    expect(withUnresolved).toContain("Unresolved discovery memory.")
  })

  it("rejects missing or invalid session ids in delta mode", async () => {
    const worktree = await setupFixtureWorktree({
      "docs/CONTINUITY.md": DELTA_FIXTURE,
    })

    await expect(
      execute(
        {
          command: "read",
          read: {},
        },
        { worktree }
      )
    ).rejects.toThrow("read.sessionId must be provided for delta mode")

    await expect(
      execute(
        {
          command: "read",
          read: { mode: "delta", sessionId: "/bad" },
        },
        { worktree }
      )
    ).rejects.toThrow(
      "read.sessionId must match ^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$"
    )
  })

  it("rejects invalid read mode", async () => {
    const worktree = await setupFixtureWorktree({
      "docs/CONTINUITY.md": DELTA_FIXTURE,
    })

    await expect(
      execute(
        {
          command: "read",
          read: { mode: "weird" },
        } as any,
        { worktree }
      )
    ).rejects.toThrow('read.mode must be either "tail" or "delta"')
  })

  it("stores delta ledger outside the worktree", async () => {
    const worktree = await setupFixtureWorktree({
      "docs/CONTINUITY.md": DELTA_FIXTURE,
    })
    const sessionId = "delta-ledger-path"

    await execute(
      {
        command: "read",
        read: { mode: "delta", sessionId },
      },
      { worktree }
    )

    const ledgerPath = resolveLedgerPath(worktree, sessionId)
    expect(ledgerPath.startsWith(worktree)).toBe(false)
    const ledger = await loadSessionLedger(ledgerPath, worktree, sessionId)
    expect(ledger.sessionId).toBe(sessionId)
  })

  it("recovers from malformed ledger json by reseeding from continuity", async () => {
    const worktree = await setupFixtureWorktree({
      "docs/CONTINUITY.md": DELTA_FIXTURE,
    })
    const sessionId = "delta-corrupt-ledger"
    const ledgerPath = resolveLedgerPath(worktree, sessionId)
    await fs.mkdir(path.dirname(ledgerPath), { recursive: true })
    await fs.writeFile(ledgerPath, "{not-json", "utf8")

    const output = await execute(
      {
        command: "read",
        read: { mode: "delta", sessionId },
      },
      { worktree }
    )

    expect(output).toContain("Shared plan memory.")
    const ledger = await readLedger(worktree, sessionId)
    expect(ledger.version).toBe(1)
  })

  it("recovers from invalid ledger format by reseeding from continuity", async () => {
    const worktree = await setupFixtureWorktree({
      "docs/CONTINUITY.md": DELTA_FIXTURE,
    })
    const sessionId = "delta-invalid-ledger"
    const ledgerPath = resolveLedgerPath(worktree, sessionId)
    await fs.mkdir(path.dirname(ledgerPath), { recursive: true })
    await fs.writeFile(
      ledgerPath,
      JSON.stringify({ version: 999, seen: null }, null, 2),
      "utf8"
    )

    const output = await execute(
      {
        command: "read",
        read: { mode: "delta", sessionId },
      },
      { worktree }
    )

    expect(output).toContain("First decision memory.")
    const ledger = await readLedger(worktree, sessionId)
    expect(ledger.sessionId).toBe(sessionId)
  })

  it("ignores compaction args when reading", async () => {
    const worktree = await setupFixtureWorktree({
      "docs/CONTINUITY.md": READ_FIXTURE,
    })
    const before = await readContinuity(worktree)

    const output = await execute(
      {
        command: "read",
        compaction: {
          enabled: false,
          upperTokenThreshold: 10000,
          lowerTokenThreshold: 5000,
          totalTokenThreshold: 10000,
          encoding: "cl100k_base",
        },
        read: {
          mode: "tail",
          linesPerSection: 1,
        },
      },
      { worktree }
    )

    expect(output).toContain("## [PLANS]")
    expect(output).toContain("Second plan entry.")

    const after = await readContinuity(worktree)
    expect(after).toBe(before)
  })

  it("ignores read args when updating", async () => {
    const worktree = await setupFixtureWorktree({
      "docs/CONTINUITY.md": FIXTURE,
    })

    const result = await execute(
      {
        command: "update",
        updates: [
          {
            section: "PROGRESS",
            provenance: "TOOL",
            text: "Update should ignore read args.",
          },
        ],
        read: {
          linesPerSection: 5,
        },
      },
      { worktree }
    )

    const content = await readContinuity(worktree)
    expect(content).toContain("Update should ignore read args.")
    expect(result).toBe("")
  })

  it("skips compaction when under upper threshold", async () => {
    const fixture = await readDummyFixture()
    const encoder = get_encoding("cl100k_base")
    const totalTokens = countTotalTokens(fixture, encoder)
    encoder.free()
    const upperThreshold = totalTokens + 1000
    const worktree = await setupFixtureWorktree({
      "docs/CONTINUITY.md": fixture,
    })

    await execute(
      {
        command: "update",
        updates: [
          {
            section: "PLANS",
            provenance: "TOOL",
            text: "No-op compaction test update.",
          },
        ],
        compaction: {
          upperTokenThreshold: upperThreshold,
        },
      },
      { worktree }
    )

    const content = await readContinuity(worktree)
    expect(content).toContain("No-op compaction test update.")
    expect(content).not.toContain("Compaction triggered")
    expectSectionOrder(content)

    let memoryError: any = null
    try {
      await readMemory(worktree)
    } catch (error) {
      memoryError = error
    }
    expect(memoryError).not.toBeNull()
  })

  it("archives compaction output beside a configured continuity file", async () => {
    const worktree = await setupFixtureWorktree({
      ".continuity/continuity.json": JSON.stringify({ directory: ".memory" }),
      ".memory/CONTINUITY.md": FIXTURE,
    })

    await execute(
      {
        command: "update",
        updates: [
          {
            section: "PROGRESS",
            provenance: "TOOL",
            text: "Trigger configured compaction.",
          },
        ],
        compaction: { upperTokenThreshold: 50 },
      },
      { worktree }
    )

    expect(await readContinuity(worktree, ".memory")).toContain("# CONTINUITY")
    expect(await readMemory(worktree, ".memory")).toContain(
      "Existing plan entry."
    )
    await expect(readMemory(worktree)).rejects.toThrow()
  })

  it("truncates over-limit sections and archives removed lines", async () => {
    const fixture = await readDummyFixture()
    const worktree = await setupFixtureWorktree({
      "docs/CONTINUITY.md": fixture,
    })

    const firstPlanEntry = getBulletLines(fixture, "PLANS")[0]

    const encoder = get_encoding("cl100k_base")
    const fixtureTokens = countTotalTokens(fixture, encoder)
    encoder.free()
    const upperThreshold = 10000
    const lowerThreshold = 5000
    expect(fixtureTokens).toBeGreaterThan(upperThreshold)
    await execute(
      {
        command: "update",
        updates: [
          {
            section: "PROGRESS",
            provenance: "TOOL",
            text: "Trigger compaction with update.",
          },
        ],
      },
      { worktree }
    )

    const content = await readContinuity(worktree)
    const memory = await readMemory(worktree)
    const resultEncoder = get_encoding("cl100k_base")
    const totalTokens = countTotalTokens(content, resultEncoder)
    resultEncoder.free()

    expect(content).toContain("Compaction triggered")
    expect(content).not.toContain(firstPlanEntry)
    expect(memory).toContain(firstPlanEntry)
    expect(totalTokens).toBeLessThanOrEqual(lowerThreshold)
    expectSectionOrder(content)
    expectSectionOrder(memory)
  })

  it("compacts mixed legacy and id-prefixed entries", async () => {
    const baseFixture = await readDummyFixture()
    const fixture = baseFixture.replace(
      "## [DECISIONS]",
      "- [id:plans-202602020000z-user-abcd1234ef56] 2026-02-02T00:00Z [USER] [plan:baseline] Id-prefixed extra plan entry.\n\n## [DECISIONS]"
    )
    const worktree = await setupFixtureWorktree({
      "docs/CONTINUITY.md": fixture,
    })

    await execute(
      {
        command: "update",
        updates: [
          {
            section: "PROGRESS",
            provenance: "TOOL",
            text: "Trigger compaction with mixed entry formats.",
          },
        ],
      },
      { worktree }
    )

    const content = await readContinuity(worktree)
    const memory = await readMemory(worktree)

    expect(content).toContain("Compaction triggered")
    expect(memory).toMatch(/- (?:\[id:[^\]]+\] )?\d{4}-\d{2}-\d{2}T\d{2}:\d{2}Z/)
  })

  it("normalizes mismatched lower threshold to half of upper", async () => {
    const fixture = await readDummyFixture()
    const worktree = await setupFixtureWorktree({
      "docs/CONTINUITY.md": fixture,
    })

    const upperThreshold = 10000
    const derivedLowerThreshold = 5000

    await execute(
      {
        command: "update",
        updates: [
          {
            section: "PROGRESS",
            provenance: "TOOL",
            text: "Trigger compaction with mismatched lower threshold.",
          },
        ],
        compaction: {
          upperTokenThreshold: upperThreshold,
          lowerTokenThreshold: 4000,
        },
      },
      { worktree }
    )

    const content = await readContinuity(worktree)
    const encoder = get_encoding("cl100k_base")
    const totalTokens = countTotalTokens(content, encoder)
    encoder.free()

    expect(content).toContain("Compaction triggered")
    expect(totalTokens).toBeLessThanOrEqual(derivedLowerThreshold)
  })

  it("truncates oldest lines first when legacy total threshold exceeded", async () => {
    const fixture = await readDummyFixture()
    const encoder = get_encoding("cl100k_base")
    const totalTokens = countTotalTokens(fixture, encoder)
    encoder.free()

    const totalThreshold = totalTokens - 1000
    const worktree = await setupFixtureWorktree({
      "docs/CONTINUITY.md": fixture,
    })

    const firstPlansEntry = getBulletLines(fixture, "PLANS")[0]

    await execute(
      {
        command: "update",
        updates: [
          {
            section: "PROGRESS",
            provenance: "TOOL",
            text: "Trigger truncation for oldest-first test.",
          },
        ],
        compaction: {
          totalTokenThreshold: totalThreshold,
        },
      },
      { worktree }
    )

    const content = await readContinuity(worktree)
    const memory = await readMemory(worktree)

    expect(content).not.toContain(firstPlansEntry)
    expect(memory).toContain(firstPlansEntry)
  })
})
