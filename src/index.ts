#!/usr/bin/env bun
/**
 * continuity-mcp — MCP stdio server entry.
 *
 * Registers one tool, `continuity`, that reads/updates CONTINUITY.md in the
 * configured continuity directory (default <worktree>/docs; sidecars:
 * <worktree>/.continuity/continuity.json,
 * $XDG_CONFIG_HOME|~/.config/continuity/continuity.json).
 *
 * The worktree comes from $CONTINUITY_WORKTREE (recommended — clients such as
 * VS Code or Claude Desktop do not spawn the server with the project
 * directory as cwd), falling back to the process working directory.
 *
 * Run: bun src/index.ts
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js"
import { z } from "zod"

import { execute as executeContinuity } from "./continuity.js"
import type { ContinuityArgs } from "./continuity.js"

const DESCRIPTION =
  "Read or update CONTINUITY.md in the configured continuity directory. " +
  'READ: defaults to mode="delta", returning only new/changed memories for the ' +
  'calling client (sessionId defaults to the MCP client name; set mode="tail" ' +
  "for the latest entries per section). " +
  "UPDATE: appends validated entries (updates[]) with optional token-budget compaction."

const SectionSchema = z.enum([
  "PLANS",
  "DECISIONS",
  "PROGRESS",
  "DISCOVERIES",
  "OUTCOMES",
])

const ProvenanceSchema = z.enum([
  "USER",
  "CODE",
  "TOOL",
  "ASSUMPTION",
  "UNCONFIRMED",
])

const inputSchema = {
  command: z.enum(["read", "update"]).describe("Operation mode."),
  updates: z
    .array(
      z.object({
        section: SectionSchema.describe(
          "PLANS, DECISIONS, PROGRESS, DISCOVERIES, or OUTCOMES.",
        ),
        provenance: ProvenanceSchema.describe(
          "USER, CODE, TOOL, ASSUMPTION, or UNCONFIRMED.",
        ),
        plan: z
          .string()
          .regex(/^[a-z0-9][a-z0-9.-]*$/)
          .optional()
          .describe("Optional plan slug."),
        text: z
          .string()
          .min(1)
          .max(400)
          .describe("Single-line, non-blank, 1-400 characters."),
      }),
    )
    .optional()
    .describe("Required for update. Entries to append."),
  compaction: z
    .object({
      enabled: z.boolean().optional(),
      upperTokenThreshold: z.number().int().min(1).optional(),
      lowerTokenThreshold: z.number().int().min(1).optional(),
      totalTokenThreshold: z.number().int().min(1).optional(),
      encoding: z.string().optional(),
    })
    .optional()
    .describe("Optional token-budget compaction settings for update."),
  read: z
    .object({
      linesPerSection: z.number().int().min(1).optional(),
      mode: z
        .enum(["tail", "delta"])
        .optional()
        .describe(
          '"delta" (default) returns only new/changed memories for the session; "tail" returns the latest linesPerSection entries per section.',
        ),
      sessionId: z
        .string()
        .optional()
        .describe("Defaults to the MCP client name."),
      includePinned: z.boolean().optional(),
      includeUnresolved: z.boolean().optional(),
    })
    .optional()
    .describe("Optional read output configuration."),
}

export function createServer(): McpServer {
  const server = new McpServer({ name: "continuity-mcp", version: "1.0.0" })

  /** Delta sessions default to the connected client's name (stable across server restarts). */
  const defaultSessionId = (): string => {
    const name = server.server.getClientVersion()?.name ?? "default"
    const sanitized = name
      .replace(/[^A-Za-z0-9._-]+/g, "-")
      .replace(/^[-.]+|[-.]+$/g, "")
    return sanitized || "default"
  }

  // Serializes updates within this process — the SDK may deliver calls concurrently.
  // shortcut: cross-process writers (e.g. the pi tool on the same files) remain unprotected
  let updateChain: Promise<unknown> = Promise.resolve()
  const serializeUpdate = <T>(run: () => Promise<T>): Promise<T> => {
    const next = updateChain.then(run, run)
    updateChain = next.catch(() => {})
    return next
  }

  server.registerTool(
    "continuity",
    { title: "Continuity", description: DESCRIPTION, inputSchema },
    async (params) => {
      const args = { ...params } as ContinuityArgs
      const context = {
        worktree: process.env.CONTINUITY_WORKTREE?.trim() || process.cwd(),
      }

      try {
        if (
          args.command === "read" &&
          (args.read?.mode ?? "delta") === "delta" &&
          !args.read?.sessionId
        ) {
          args.read = { ...args.read, sessionId: defaultSessionId() }
        }
        const run = () => executeContinuity(args, context)
        const text =
          args.command === "update" ? await serializeUpdate(run) : await run()
        return { content: [{ type: "text" as const, text }] }
      } catch (error) {
        return {
          content: [
            {
              type: "text" as const,
              text: error instanceof Error ? error.message : String(error),
            },
          ],
          isError: true,
        }
      }
    },
  )

  return server
}

if (import.meta.main) {
  await createServer().connect(new StdioServerTransport())
}
