#!/usr/bin/env node
/**
 * continuity-mcp — CLI host adapter.
 *
 * Thin argv-to-args shim over the same continuityTool.execute the MCP server
 * uses, for humans: read/update/search/status from the terminal, against the
 * same branch-isolated store. distill needs MCP sampling and is rejected here
 * with a pointer to the server.
 *
 * Run: node src/cli.ts <command> [options]   (npm run cli -- <command> …)
 */

import { parseArgs } from "node:util"
import path from "node:path"
import fs from "node:fs/promises"

import { SECTIONS, PROVENANCE } from "./core.js"
import { continuityTool, globalConfigRoot } from "./index.ts"
import { continuityScope } from "./runtime.js"
import { prepareDistillation } from "./distill.js"

const USAGE = `continuity — branch-isolated continuity memory (CLI over the same store as the MCP server)

Usage: continuity <command> [options]

Commands:
  read      Shared knowledge + branch checkpoint + new entries (default mode: delta)
  update    Append one deliberate entry (needs --section, --provenance, --text)
  search    Substring search over retained entries; query is the words after the command
  status    Pending distillation, claims, errors, config, capacity
  distill   Manual two-phase distillation — you provide the model:
            1) --prompt   print the distillation request (takes no claim; any store
                          state it reports as JSON status means nothing to distill)
            2) answer it with any model (or the distill skill driving your agent),
               save the JSON answer, then --apply <file|-> commits it ("-" = stdin)

Options:
  --section <${SECTIONS.join("|")}>            update
  --provenance <${PROVENANCE.join("|")}>  update
  --text <line, max 400 chars>      update
  --plan <slug>                     update, optional
  --mode <tail|delta>               read (default delta)
  --memory <id>                     read, targeted retrieval
  --session <id>                    read, delta session (default "cli")
  --lines <n>                       read, lines per section
  --all                             search every branch
  --branch <name>                   target another branch of this repository
  --worktree <path>                 project root (else $CONTINUITY_WORKTREE, else cwd)
  -h, --help                        show this help

Examples:
  continuity update --section PROGRESS --provenance USER --text "switched auth to tokens"
  continuity read --mode tail
  continuity search token refresh
  continuity search --all flaky
`

function fail(message: string, code = 1): never {
  console.error(message)
  process.exit(code)
}

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    section: { type: "string" }, provenance: { type: "string" }, text: { type: "string" },
    plan: { type: "string" }, mode: { type: "string" }, memory: { type: "string" },
    session: { type: "string" }, lines: { type: "string" }, branch: { type: "string" },
    worktree: { type: "string" }, all: { type: "boolean" },
    prompt: { type: "boolean" }, apply: { type: "string" },
    help: { type: "boolean", short: "h" },
  },
})

if (values.help) {
  console.log(USAGE)
  process.exit(0)
}

const command = positionals[0]
if (!command || !["read", "update", "search", "status", "distill"].includes(command)) {
  fail(`Unknown or missing command: ${command ?? "(none)"}\n\n${USAGE}`, 2)
}

async function readStdin(): Promise<string> {
  let data = ""
  for await (const chunk of process.stdin) data += chunk
  return data
}

// Same args shape the tool schema defines (schema.js); the runtime validates details.
const args: Record<string, unknown> = { command, ...(values.branch ? { branch: values.branch } : {}) }
if (command === "read") {
  const lines = values.lines ? Number.parseInt(values.lines, 10) : undefined
  if (values.lines !== undefined && (!lines || lines < 1)) fail("--lines must be a positive integer")
  args.read = {
    ...(values.mode ? { mode: values.mode } : {}),
    ...(values.memory ? { memoryId: values.memory } : {}),
    ...(values.session ? { sessionId: values.session } : {}),
    ...(lines ? { linesPerSection: lines } : {}),
  }
} else if (command === "update") {
  for (const flag of ["section", "provenance", "text"] as const) {
    if (!values[flag]) fail(`update requires --${flag}\n\n${USAGE}`, 2)
  }
  args.updates = [{
    section: values.section, provenance: values.provenance, text: values.text,
    ...(values.plan ? { plan: values.plan } : {}),
  }]
} else if (command === "search") {
  const query = positionals.slice(1).join(" ")
  if (!query) fail(`search requires a query\n\n${USAGE}`, 2)
  args.query = query
  if (values.all) args.all = true
}

const worktree = path.resolve(
  values.worktree || process.env.CONTINUITY_WORKTREE?.trim() || process.cwd(),
)

try {
  if (command === "distill") {
    // Manual two-phase distillation: the user (or their agent, via the distill skill) is the model.
    if (!!values.prompt === !!values.apply) fail(`distill needs exactly one of --prompt or --apply <file|->\n\n${USAGE}`, 2)
    if (values.prompt) {
      const scope = await continuityScope({ command: "distill" }, { worktree })
      if (!scope.isGit) fail("distill requires the transactional Git store")
      const result = await prepareDistillation(scope, { manual: true, workspace: scope.workspace }) as {
        status?: string, selected?: unknown[], prompt?: string
      }
      if (result.status !== "prepared") {
        console.log(JSON.stringify(result, null, 2))
        process.exitCode = result.status === "blocked" ? 1 : 0
      } else {
        console.error(`distill: ${result.selected?.length} source(s) selected — answer with any model, then commit with: node src/cli.ts distill --apply <answer-file>`)
        console.log(result.prompt)
      }
    } else {
      const answer = values.apply === "-" ? await readStdin() : await fs.readFile(values.apply!, "utf8")
      const text = await continuityTool.execute({ command: "distill" }, { worktree, sessionID: "cli" }, {
        generate: async () => answer,
        globalConfigRoot: globalConfigRoot(),
      })
      console.log(text)
      // The distill path always returns a JSON status object; surface failures in the exit code.
      const result = JSON.parse(text) as { status?: string }
      process.exitCode = result.status === "blocked" ? 1 : 0
    }
  } else {
    const text = await continuityTool.execute(args, { worktree, sessionID: "cli" }, { globalConfigRoot: globalConfigRoot() })
    if (text) console.log(text)
  }
} catch (error) {
  fail(error instanceof Error ? error.message : String(error))
}
