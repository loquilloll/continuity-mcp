// vendored from opencode-continuity-tool@d3c55ec - local edits marked mcp:
// Timers only wake durable branch state; restart and competing processes share the disk schedule.
import { withStore, readState } from "./storage.js"
import { runDistillation } from "./distill.js"
const millis = (value) => typeof value === "number" ? value : value == null ? 0 : Date.parse(value)

export function createScheduler({ generate, report = console.error, clock = Date.now, setTimer = setTimeout, clearTimer = clearTimeout }) {
  const branches = new Map()
  const sessions = new Map()
  let closed = false

  function busy(branch) {
    return [...sessions.values()].some((session) => session.key === branch.key && !session.idle)
  }

  async function arm(branch) {
    if (closed) return
    const revision = branch.armRevision = (branch.armRevision ?? 0) + 1
    const state = await withStore(branch.scope, () => readState(branch.scope))
    if (closed || branch.armRevision !== revision) return
    if (branch.timer) clearTimer(branch.timer)
    branch.timer = null
    if (!state.pendingCount) return
    const due = Math.max(state.nextEligibleAt == null ? clock() + 2.5 * 3_600_000 : millis(state.nextEligibleAt), millis(state.claim?.deadline), branch.retryAt ?? 0)
    const delay = Math.max(100, Math.min(2_147_483_647, due - clock()))
    branch.timer = setTimer(() => { void tick(branch).catch(report) }, busy(branch) && due <= clock() ? 60_000 : delay)
    branch.timer?.unref?.()
  }

  async function tick(branch) {
    if (closed || branch.running) return
    branch.running = true
    try {
      if (!busy(branch)) await runDistillation(branch.scope, { generate, manual: false, workspace: branch.scope.workspace, now: clock })
    } catch (error) {
      report(`[continuity] ${error.message}`)
      branch.retryAt = clock() + 2.5 * 3_600_000
    } finally {
      branch.running = false
      if (!closed) await arm(branch)
    }
  }

  return {
    async remember(scope, sessionID, idle = false) {
      if (closed) return
      const key = `${scope.storeId}:${scope.branchKey}`
      let branch = branches.get(key)
      if (!branch) { branch = { key, scope, timer: null, running: false }; branches.set(key, branch) }
      if (sessionID) sessions.set(sessionID, { key, idle })
      await arm(branch)
    },
    async status(sessionID, idle) {
      const session = sessions.get(sessionID)
      if (!session) return
      session.idle = idle
      const branch = branches.get(session.key)
      if (idle) await tick(branch)
    },
    forget(sessionID) {
      // A deleted/dead session must not keep its branch busy forever.
      sessions.delete(sessionID)
    },
    close() {
      closed = true
      for (const branch of branches.values()) if (branch.timer) clearTimer(branch.timer)
      branches.clear()
      sessions.clear()
    },
  }
}
