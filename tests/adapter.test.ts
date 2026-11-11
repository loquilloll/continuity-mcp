import { afterEach, beforeEach, describe, it } from "node:test"

import { expect } from "./expect.ts"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { execFile } from "node:child_process"
import { createHash } from "node:crypto"
import { promisify } from "node:util"

import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js"
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js"
import { CreateMessageRequestSchema } from "@modelcontextprotocol/sdk/types.js"

import { createServer } from "../src/index.ts"

const exec = promisify(execFile)
const CLIENT_NAME = "mcp-test-client"

// Isolates sidecar resolution (OPENCODE_CONFIG_DIR/XDG_CONFIG_HOME) from the host machine.
let previousOpencodeDir: string | undefined
let previousXdg: string | undefined
let isolatedConfigRoot: string

beforeEach(async () => {
  previousOpencodeDir = process.env.OPENCODE_CONFIG_DIR
  previousXdg = process.env.XDG_CONFIG_HOME
  isolatedConfigRoot = await fs.mkdtemp(path.join(os.tmpdir(), "continuity-mcp-cfg-"))
  process.env.OPENCODE_CONFIG_DIR = isolatedConfigRoot
  delete process.env.XDG_CONFIG_HOME
})

afterEach(async () => {
  if (previousOpencodeDir === undefined) delete process.env.OPENCODE_CONFIG_DIR
  else process.env.OPENCODE_CONFIG_DIR = previousOpencodeDir
  if (previousXdg === undefined) delete process.env.XDG_CONFIG_HOME
  else process.env.XDG_CONFIG_HOME = previousXdg
  delete process.env.CONTINUITY_WORKTREE
  await fs.rm(isolatedConfigRoot, { recursive: true, force: true })
})

async function createTempGitWorktree() {
  const worktree = await fs.mkdtemp(path.join(os.tmpdir(), "continuity-mcp-adapter-"))
  await exec("git", ["init", "--initial-branch=main"], { cwd: worktree })
  await fs.writeFile(path.join(worktree, "README.md"), "# tmp\n", "utf8")
  await exec("git", ["add", "-A"], { cwd: worktree })
  await exec(
    "git",
    ["-c", "user.name=test", "-c", "user.email=test@example.com", "commit", "--no-gpg-sign", "-m", "init"],
    { cwd: worktree },
  )
  return worktree
}

interface SamplingPlan {
  sampling?: boolean
  modelText?: string
}

async function connectInMemory(worktree: string, plan: SamplingPlan = {}) {
  process.env.CONTINUITY_WORKTREE = worktree
  const server = createServer()
  const client = new Client(
    { name: CLIENT_NAME, version: "1.0.0" },
    plan.sampling === false ? {} : { capabilities: { sampling: {} } },
  )
  if (plan.sampling !== false) {
    client.setRequestHandler(CreateMessageRequestSchema, async () => ({
      role: "assistant" as const,
      content: { type: "text" as const, text: plan.modelText ?? '{"checkpoint":[],"proposals":[]}' },
      model: "canned-test-model",
      stopReason: "endTurn" as const,
    }))
  }
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
  await Promise.all([client.connect(clientTransport), server.connect(serverTransport)])
  return { server, client }
}

function callContinuity(client: Client, arguments_: Record<string, unknown>) {
  return client.callTool({ name: "continuity", arguments: arguments_ })
}

const UPDATE = {
  command: "update",
  updates: [{ section: "PROGRESS", provenance: "TOOL", plan: "01-v2-port", text: "Adapter store entry." }],
}

describe("mcp adapter (v2 branch-isolated)", () => {
  it("registers one continuity tool with the new command schema", async () => {
    const worktree = await createTempGitWorktree()
    const { server, client } = await connectInMemory(worktree)

    const { tools } = await client.listTools()
    expect(tools.length).toBe(1)
    expect(tools[0].name).toBe("continuity")
    expect(tools[0].title).toBe("Continuity")
    expect(tools[0].description?.length).toBeGreaterThan(0)
    const schema = tools[0].inputSchema as { properties: Record<string, { enum?: string[] }> }
    expect(schema.properties.command.enum).toEqual(["read", "update", "status", "distill", "search"])

    await client.close()
    await server.close()
  })

  it("update writes to the branch store under .git/opencode-continuity", async () => {
    const worktree = await createTempGitWorktree()
    const { server, client } = await connectInMemory(worktree)

    const result: any = await callContinuity(client, UPDATE)
    expect(result.isError).toBeUndefined()

    const branchesDir = path.join(worktree, ".git", "opencode-continuity", "branches")
    const branches = await fs.readdir(branchesDir)
    expect(branches.length).toBe(1)
    const state = JSON.parse(
      await fs.readFile(path.join(branchesDir, branches[0], "state.json"), "utf8"),
    )
    expect(state.identity.kind).toBe("branch")
    expect(state.identity.name).toBe("refs/heads/main")

    await client.close()
    await server.close()
  })

  it("delta read defaults sessionId to the client name", async () => {
    const worktree = await createTempGitWorktree()
    const { server, client } = await connectInMemory(worktree)
    await callContinuity(client, UPDATE)

    const result: any = await callContinuity(client, { command: "read" })
    expect(result.isError).toBeUndefined()
    expect(result.content[0].text).toContain("Adapter store entry.")

    // runtime.js writes ledgers/<sha256(sessionId)>.json under the branch dir
    const branchesDir = path.join(worktree, ".git", "opencode-continuity", "branches")
    const [branch] = await fs.readdir(branchesDir)
    const sessionHash = createHash("sha256").update(CLIENT_NAME).digest("hex")
    const ledgerPath = path.join(branchesDir, branch, "ledgers", `${sessionHash}.json`)
    const ledger = JSON.parse(await fs.readFile(ledgerPath, "utf8"))
    expect(Object.keys(ledger.seen).length).toBeGreaterThan(0)

    await client.close()
    await server.close()
  })

  it("search finds entries by substring", async () => {
    const worktree = await createTempGitWorktree()
    const { server, client } = await connectInMemory(worktree)
    await callContinuity(client, {
      command: "update",
      updates: [{ section: "DISCOVERIES", provenance: "CODE", text: "Searchable needle entry." }],
    })

    const result: any = await callContinuity(client, { command: "search", query: "needle" })
    expect(result.isError).toBeUndefined()
    expect(result.content[0].text).toContain("needle")

    await client.close()
    await server.close()
  })

  it("status reports store state without generation", async () => {
    const worktree = await createTempGitWorktree()
    const { server, client } = await connectInMemory(worktree)
    await callContinuity(client, UPDATE)

    const result: any = await callContinuity(client, { command: "status" })
    expect(result.isError).toBeUndefined()
    const status = JSON.parse(result.content[0].text)
    expect(Object.keys(status).sort()).toEqual(["config", "memory", "scope", "state"])

    await client.close()
    await server.close()
  })

  it("distill generates via client sampling", async () => {
    const worktree = await createTempGitWorktree()
    const { server, client } = await connectInMemory(worktree)
    await callContinuity(client, UPDATE)

    const result: any = await callContinuity(client, { command: "distill" })
    expect(result.isError).toBeUndefined()
    const report = JSON.parse(result.content[0].text)
    expect(typeof report).toBe("object")

    await client.close()
    await server.close()
  })

  it("distill errors clearly when the client lacks sampling", async () => {
    const worktree = await createTempGitWorktree()
    const { server, client } = await connectInMemory(worktree, { sampling: false })
    await callContinuity(client, UPDATE)

    const result: any = await callContinuity(client, { command: "distill" })
    expect(result.isError).toBeUndefined()
    const report = JSON.parse(result.content[0].text)
    expect(report.status).toBe("blocked")
    expect(report.error).toContain("sampling")

    await client.close()
    await server.close()
  })

  it("round-trips update and read over a spawned stdio server", async () => {
    const worktree = await createTempGitWorktree()
    const serverEntry = path.resolve(import.meta.dirname!, "..", "src", "index.ts")

    const transport = new StdioClientTransport({
      command: "node",
      args: [serverEntry],
      env: {
        PATH: process.env.PATH ?? "",
        OPENCODE_CONFIG_DIR: isolatedConfigRoot,
        CONTINUITY_WORKTREE: worktree,
      },
      stderr: "ignore",
    })
    const client = new Client({ name: CLIENT_NAME, version: "1.0.0" })
    await client.connect(transport)

    const updateResult: any = await callContinuity(client, UPDATE)
    expect(updateResult.isError).toBeUndefined()

    const readResult: any = await callContinuity(client, { command: "read" })
    expect(readResult.content[0].text).toContain("Adapter store entry.")

    await client.close()
  })
})
