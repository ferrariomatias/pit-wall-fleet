// The panel <-> worker contract, declared once: src/panel.tsx and src/worker.ts both read it.

export type AgentState = 'working' | 'blocked' | 'waiting' | 'done'
/**
 * What the panel shows. `idle`: Orca's API still says "working" but `orca worktree ps` sees no
 * working agent there (the session was cut off without telling Orca): it is waiting on you.
 */
export type RowState = AgentState | 'idle'

/** Where a workspace lives: this computer, an SSH machine Orca reaches, or a paired Orca server. */
export type HostKind = 'local' | 'ssh' | 'server'
export type HostRef = { id: string; kind: HostKind; label: string }

/**
 * One host and what Pit Wall could read from it. `disconnected`: an SSH target Orca is not
 * connected to. `unreachable`: a paired server that did not answer. `connecting`: a server whose
 * first answer has not arrived yet.
 */
export type HostStatus = HostRef & {
  state: 'ok' | 'disconnected' | 'unreachable' | 'connecting'
  error: string | null
  worktrees: number
  waiting: number
  working: number
}

/** One agent session, ready to draw. */
export type AgentRow = {
  key: string
  state: RowState
  /** Since when it has been in `state` (ms epoch). */
  since: number
  host: HostRef
  project: string
  workspace: string
  workspaceId: string
  title: string
  /** Last thing the agent said, flattened to one line and cut. */
  lastMessage: string | null
  /** For working agents: the tool it is running now, e.g. "Bash · npm test". */
  activity: string | null
  /** Terminal to focus on click; null when Orca no longer has one, and for sessions on a paired
   *  server, whose terminal handles belong to that server. */
  terminalId: string | null
}

export type PrInfo = {
  number: number
  state: string
  title: string
  checks: 'success' | 'failure' | 'pending' | 'neutral' | null
  passed: number
  total: number
}

export type WorktreeRow = {
  key: string
  workspaceId: string
  host: HostRef
  project: string
  name: string
  branch: string | null
  kind: 'worktree' | 'folder'
  pr: PrInfo | null
  lastActivityAt: number | null
  agentsWaiting: number
  agentsWorking: number
}

export type Snapshot = {
  generatedAt: number
  waiting: AgentRow[]
  working: AgentRow[]
  worktrees: WorktreeRow[]
  /** Every host Orca knows, this computer first; a host with no rows is still listed. */
  hosts: HostStatus[]
  /** Set when `orca worktree ps` could not run: PRs and last messages are missing. */
  enrichmentError: string | null
}

declare module 'orca' {
  interface PluginRequests {
    /** Everything the panel draws, read fresh from Orca. */
    snapshot: { output: Snapshot }
    /** Shows a terminal (when given and still open) or else the workspace. */
    open: {
      input: { workspaceId: string; terminalId?: string | null; hostId?: string | null }
      /** `message`: why it could not be shown, e.g. the workspace lives on a paired server. */
      output: { ok: boolean; message?: string }
    }
  }
}
