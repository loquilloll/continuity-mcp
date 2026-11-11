#!/usr/bin/env node
/**
 * continuity-mcp — MCP stdio server entry (v2: branch-isolated continuity).
 *
 * Registers one tool, `continuity`, over the vendored SDK-independent runtime
 * (read/update/status/search/distill). The store lives under
 * <git-common-dir>/opencode-continuity/ (non-git workspaces keep the legacy
 * docs/CONTINUITY.md behavior via the core's legacy path).
 *
 * - Worktree: $CONTINUITY_WORKTREE (recommended — clients such as VS Code or
 *   Claude Desktop do not spawn the server with the project directory as cwd),
 *   falling back to the process working directory.
 * - Session: delta reads default to the connected MCP client's name.
 * - Distill: model generation runs via MCP sampling — the client pays and
 *   chooses the actual model; the configured model is a hint only.
 * - Config: workspace .opencode/continuity.jsonc + global
 *   OPENCODE_CONFIG_DIR|XDG_CONFIG_HOME|~/.config /opencode/continuity.jsonc
 *   (shared with the opencode plugin; see schema/runtime docs).
 *
 * Uses the low-level Server (not McpServer.registerTool) so the vendored
 * upstream JSON Schema is served as-is, without a zod conversion.
 *
 * Run: node src/index.ts
 */

import os from "node:os"
import path from "node:path"
import { pathToFileURL } from "node:url"

import { Server } from "@modelcontextprotocol/sdk/server/index.js"
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js"
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js"

import { executeContinuity } from "./runtime.js"
import { executeLegacy } from "./core.js"
import { resolveScope } from "./storage.js"
import { input as inputSchema, description } from "./schema.js"

const DESCRIPTION =
  description +
  " In MCP, the delta read sessionId defaults to the connected client's name."

// Mirrors upstream plugin.js globalConfigRoot so global settings are shared with the opencode plugin.
function globalConfigRoot(): string {
  return process.env.OPENCODE_CONFIG_DIR ??
    path.join(
      process.env.XDG_CONFIG_HOME || path.join(os.homedir(), ".config"),
      "opencode",
    )
}

// Host wrapper equivalent of upstream src/continuity.js execute() — the MCP host has no
// @opencode-ai/plugin tool() wrapper, so the non-Git dispatch lives here.
export const continuityTool = {
  async execute(args: any, context: { worktree: string }, options: Record<string, unknown> = {}) {
    if (typeof context?.worktree !== "string") throw new Error("Continuity requires an attributed workspace")
    const scope = await resolveScope({ workspace: context.worktree, branch: undefined })
    // Keep the historical non-Git custom-tool contract; plugins always use the transactional runtime.
    if (!scope.isGit && ["read", "update"].includes(args.command) && !args.branch && !args.read?.memoryId) {
      return executeLegacy(args, context)
    }
    if (!scope.isGit) {
      throw new Error("Non-Git standalone continuity supports legacy read/update only. Targeted reads, status and distillation require the plugin's transactional store; use a normal read for legacy journal IDs.")
    }
    return executeContinuity(args, context, options)
  },
}

export function createServer(): Server {
  const server = new Server(
    { name: "continuity-mcp", version: "2.0.0" },
    { capabilities: { tools: { listChanged: false } } },
  )

  /** Delta sessions default to the connected client's name (stable across server restarts). */
  const defaultSessionId = (): string => {
    const name = server.getClientVersion()?.name ?? "default"
    const sanitized = name
      .replace(/[^A-Za-z0-9._-]+/g, "-")
      .replace(/^[-.]+|[-.]+$/g, "")
    return sanitized || "default"
  }

  /** Distillation generation via MCP sampling (server → client request). */
  const generate = async ({
    prompt,
    model,
    signal,
    maxOutputTokens,
  }: {
    prompt: string
    model?: string
    signal?: AbortSignal
    maxOutputTokens?: number
  }): Promise<string> => {
    if (!server.getClientCapabilities()?.sampling) {
      throw new Error("client does not support sampling; distill unavailable")
    }
    const result = await server.createMessage(
      {
        messages: [{ role: "user" as const, content: { type: "text" as const, text: prompt } }],
        maxTokens: maxOutputTokens ?? 8000,
        ...(model ? { modelPreferences: { hints: [{ name: model }] } } : {}),
      },
      { signal },
    )
    if (result.content.type !== "text") {
      throw new Error(`sampling returned ${result.content.type} content; text required`)
    }
    return result.content.text
  }

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: [
      {
        name: "continuity",
        title: "Continuity",
        description: DESCRIPTION,
        inputSchema,
      },
    ],
  }))

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    if (request.params.name !== "continuity") {
      return {
        content: [{ type: "text" as const, text: `Unknown tool: ${request.params.name}` }],
        isError: true,
      }
    }
    const params = request.params.arguments ?? {}
    const context = {
      worktree: path.resolve(process.env.CONTINUITY_WORKTREE?.trim() || process.cwd()),
      sessionID: defaultSessionId(),
    }

    try {
      const text = await continuityTool.execute(params, context, {
        generate,
        globalConfigRoot: globalConfigRoot(),
      })
      return { content: [{ type: "text" as const, text: text ?? "" }] }
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
  })

  return server
}

// Node equivalent of bun's import.meta.main (type stripping keeps import.meta).
const isMain =
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href

if (isMain) {
  await createServer().connect(new StdioServerTransport())
}
