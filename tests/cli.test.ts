import { afterEach, describe, it } from "node:test"

import { expect } from "./expect.ts"
import assert from "node:assert"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { execFile } from "node:child_process"
import { promisify } from "node:util"

const exec = promisify(execFile)
const CLI = path.join(import.meta.dirname, "..", "src", "cli.ts")

const roots: string[] = []
const git = (cwd: string, ...args: string[]) =>
  execFile("git", args, {
    cwd,
    encoding: "utf8",
    env: { ...process.env, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: path.join(path.dirname(cwd), "empty.gitconfig") },
  })

/** Snapshot config env, isolate it, and create a committed git repo; returns the repo path. */
async function setup(): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "continuity-cli-"))
  roots.push(root)
  const repo = path.join(root, "repo")
  await fs.mkdir(repo)
  await fs.writeFile(path.join(root, "empty.gitconfig"), "")
  await git(repo, "init", "-b", "main")
  await git(repo, "-c", "user.name=Cli Test", "-c", "user.email=cli@example.invalid", "commit", "--allow-empty", "-m", "initial")
  process.env.OPENCODE_CONFIG_DIR = path.join(root, "global-config")
  delete process.env.XDG_CONFIG_HOME
  delete process.env.CONTINUITY_WORKTREE
  return repo
}

const cli = (repo: string, ...args: string[]) =>
  exec(process.execPath, [CLI, ...args], { cwd: repo, encoding: "utf8" })

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })))
})

describe("CLI over the shared store", () => {
  it("update, read, and search through the same tool entry point", async () => {
    const repo = await setup()

    await cli(repo, "update", "--section", "PROGRESS", "--provenance", "USER", "--text", "switched auth to tokens")
    const read = await cli(repo, "read", "--mode", "tail")
    expect(read.stdout).toContain("switched auth to tokens")

    const search = await cli(repo, "search", "auth", "to", "tokens")
    expect(search.stdout.toLowerCase()).toContain("switched auth to tokens")
  })

  it("rejects invalid usage with a nonzero exit code", async () => {
    const repo = await setup()

    await assert.rejects(cli(repo, "update", "--section", "NOPE", "--provenance", "USER", "--text", "x"))
    await assert.rejects(cli(repo, "frobnicate"), /Unknown or missing command/)
    await assert.rejects(cli(repo, "distill"), /exactly one of --prompt or --apply/)
  })

  it("manual distill: --prompt then --apply promotes a cited source into shared knowledge", async () => {
    const repo = await setup()

    await cli(repo, "update", "--section", "DISCOVERIES", "--provenance", "CODE", "--text", "cli distill e2e fact")
    const phaseA = await cli(repo, "distill", "--prompt")
    // The request is one instruction line plus one JSON line; the payload carries the citable sources.
    const lines = phaseA.stdout.trim().split("\n")
    const payload = JSON.parse(lines[lines.length - 1]!)
    assert.ok(payload.sources.length >= 1)
    const { id, contentHash } = payload.sources[0]

    const answer = path.join(path.dirname(repo), "distill-answer.json")
    await fs.writeFile(answer, JSON.stringify({
      checkpoint: [],
      proposals: [{ operation: "add", targetId: null, priorHash: null, text: "distilled: cli distill e2e fact", classification: "no-contradiction", reason: "e2e", citations: [{ id, contentHash }] }],
    }))
    const phaseB = await cli(repo, "distill", "--apply", answer)
    expect(phaseB.stdout).toContain('"completed"')

    const read = await cli(repo, "read", "--mode", "tail")
    expect(read.stdout).toContain("distilled: cli distill e2e fact")
    const status = await cli(repo, "status")
    expect(status.stdout).toContain('"pendingCount": 0')
  })

  it("manual distill rejects fabricated citations and leaves sources pending", async () => {
    const repo = await setup()

    await cli(repo, "update", "--section", "OUTCOMES", "--provenance", "CODE", "--text", "must stay pending")
    await cli(repo, "distill", "--prompt")
    const bad = path.join(path.dirname(repo), "distill-bad.json")
    await fs.writeFile(bad, JSON.stringify({
      checkpoint: [],
      proposals: [{ operation: "add", targetId: null, priorHash: null, text: "fabricated", classification: "no-contradiction", reason: "e2e", citations: [{ id: "made-up", contentHash: `sha256:${"0".repeat(64)}` }] }],
    }))
    await assert.rejects(cli(repo, "distill", "--apply", bad))
    const status = await cli(repo, "status")
    expect(status.stdout).toContain('"pendingCount": 1')
  })
})
