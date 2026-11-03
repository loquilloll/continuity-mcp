import { afterEach, beforeEach, describe, it } from "node:test"

import { expect } from "./expect.ts"
import fs from "fs/promises"
import os from "os"
import path from "path"

import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js"
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js"

import { createServer } from "../src/index.ts"
import { resolveLedgerPath } from "../src/continuity.ts"

const CLIENT_NAME = "mcp-test-client"

const DELTA_FIXTURE = `# CONTINUITY

## [PLANS]
- [id:plans-202602010000z-user-aa11aa11aa11] 2026-02-01T00:00Z [USER] [plan:baseline] Adapter plan memory.

## [DECISIONS]
- [id:decisions-202602010000z-code-bb22bb22bb22] 2026-02-01T00:00Z [CODE] Adapter decision memory.

## [PROGRESS]

## [DISCOVERIES]

## [OUTCOMES]
`

// Isolates sidecar resolution (XDG_CONFIG_HOME) and the worktree from the host machine.
let previousXdg: string | undefined
let isolatedConfigRoot: string

beforeEach(async () => {
  previousXdg = process.env.XDG_CONFIG_HOME
  isolatedConfigRoot = await fs.mkdtemp(path.join(os.tmpdir(), "continuity-mcp-cfg-"))
  process.env.XDG_CONFIG_HOME = isolatedConfigRoot
})

afterEach(async () => {
  if (previousXdg === undefined) delete process.env.XDG_CONFIG_HOME
  else process.env.XDG_CONFIG_HOME = previousXdg
  delete process.env.CONTINUITY_WORKTREE
  await fs.rm(isolatedConfigRoot, { recursive: true, force: true })
})

async function createTempWorktree() {
  return fs.mkdtemp(path.join(os.tmpdir(), "continuity-mcp-adapter-"))
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

async function connectInMemory(worktree: string) {
  process.env.CONTINUITY_WORKTREE = worktree
  const server = createServer()
  const client = new Client({ name: CLIENT_NAME, version: "1.0.0" })
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
  await Promise.all([client.connect(clientTransport), server.connect(serverTransport)])
  return { server, client }
}

function callContinuity(client: Client, arguments_: Record<string, unknown>) {
  return client.callTool({ name: "continuity", arguments: arguments_ })
}

describe("mcp adapter", () => {
  it("registers one continuity tool with description and input schema", async () => {
    const worktree = await createTempWorktree()
    const { server, client } = await connectInMemory(worktree)

    const { tools } = await client.listTools()
    expect(tools.length).toBe(1)
    expect(tools[0].name).toBe("continuity")
    expect(tools[0].title).toBe("Continuity")
    expect(tools[0].description?.length).toBeGreaterThan(0)
    expect(tools[0].inputSchema.type).toBe("object")
    expect(Object.keys(tools[0].inputSchema.properties ?? {})).toEqual([
      "command",
      "updates",
      "compaction",
      "read",
    ])

    await client.close()
    await server.close()
  })

  it("writes updates under the CONTINUITY_WORKTREE and returns empty text", async () => {
    const worktree = await createTempWorktree()
    const { server, client } = await connectInMemory(worktree)

    const result: any = await callContinuity(client, {
      command: "update",
      updates: [
        { section: "PLANS", provenance: "USER", text: "Adapter update entry." },
      ],
    })

    expect(result.isError).toBeUndefined()
    expect(result.content).toEqual([{ type: "text", text: "" }])

    const content = await fs.readFile(
      path.join(worktree, "docs", "CONTINUITY.md"),
      "utf8"
    )
    expect(content).toContain("Adapter update entry.")

    await client.close()
    await server.close()
  })

  it("auto-fills sessionId from the client name for delta reads", async () => {
    const worktree = await setupFixtureWorktree({
      "docs/CONTINUITY.md": DELTA_FIXTURE,
    })
    const { server, client } = await connectInMemory(worktree)

    const result: any = await callContinuity(client, { command: "read" })
    expect(result.content[0].text).toContain("Adapter plan memory.")

    const ledgerPath = resolveLedgerPath(worktree, CLIENT_NAME)
    const ledger = JSON.parse(await fs.readFile(ledgerPath, "utf8"))
    expect(ledger.sessionId).toBe(CLIENT_NAME)

    await client.close()
    await server.close()
  })

  it("surfaces core errors as isError tool results", async () => {
    const worktree = await createTempWorktree()
    const { server, client } = await connectInMemory(worktree)

    const result: any = await callContinuity(client, {
      command: "read",
      read: { mode: "tail" },
    })

    expect(result.isError).toBe(true)
    expect(result.content[0].text).toContain("CONTINUITY.md not found")

    await client.close()
    await server.close()
  })

  it("round-trips update and tail read over a spawned stdio server", async () => {
    const worktree = await createTempWorktree()
    const serverEntry = path.resolve(import.meta.dirname!, "..", "src", "index.ts")

    const transport = new StdioClientTransport({
      command: "node",
      args: [serverEntry],
      env: {
        PATH: process.env.PATH ?? "",
        XDG_CONFIG_HOME: isolatedConfigRoot,
        CONTINUITY_WORKTREE: worktree,
      },
      stderr: "ignore",
    })
    const client = new Client({ name: CLIENT_NAME, version: "1.0.0" })
    await client.connect(transport)

    const updateResult: any = await callContinuity(client, {
      command: "update",
      updates: [
        {
          section: "PROGRESS",
          provenance: "TOOL",
          plan: "01-mcp-port",
          text: "Spawned server update entry.",
        },
      ],
    })
    expect(updateResult.isError).toBeUndefined()

    const readResult: any = await callContinuity(client, {
      command: "read",
      read: { mode: "tail" },
    })
    expect(readResult.content[0].text).toContain("Spawned server update entry.")

    await client.close()
  })
})
