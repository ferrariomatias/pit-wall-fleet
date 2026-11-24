// Pure logic: joins what the plugin API reports with what `orca worktree ps --json` adds
// (PRs, session titles, last messages), adds the workspaces of paired Orca servers, which only
// their own `worktree ps` lists, names every row's host, and sorts it into the panel's sections.
// No Orca calls here, so src/model.test.ts can feed it fixtures.
import type {
  AgentRow,
  AgentState,
  HostRef,
  HostStatus,
  PrInfo,
  Snapshot,
  WorktreeRow
} from './protocol'

/** A `workspace.list` row with its `agents.list` answer. */
export type ApiWorkspace = {
  id: string
  kind: 'worktree' | 'folder'
  name: string
  project?: string | null
  branch: string | null
  /** `local`, `ssh:<target>` or `runtime:<environment>`; null or absent reads as this computer. */
  hostId?: string | null
  status?: { state: string; lastActivityAt: number | null } | null
  agents: ApiAgent[]
}

export type ApiAgent = {
  terminalId: string | null
  title: string | null
  agent: string | null
  state: AgentState
  stateStartedAt: number
  sessionId?: string | null
  task?: { title: string } | null
}

/** The subset of one `orca worktree ps --json` worktree this panel reads. */
export type CliWorktree = {
  worktreeId: string
  displayName?: string
  identity?: { key?: string } | null
  hostId?: string | null
  workspaceKind?: string
  repo?: string
  branch?: string
  isArchived?: boolean
  linkedPR?: {
    number: number
    state: string
    title?: string
    checksStatus?: string | null
    checksSummary?: { passed?: number; total?: number } | null
  } | null
  lastActivityAt?: number | null
  agents?: CliAgent[]
}

export type CliAgent = {
  address?: string
  state?: string
  stateStartedAt?: number
  agentType?: string | null
  displayName?: string | null
  conversationName?: string | null
  taskTitle?: string | null
  lastAssistantMessage?: string | null
  toolName?: string | null
  toolInput?: string | null
  interrupted?: boolean
  hasLivePty?: boolean
}

/** One row of `orca host list --json`: this machine, an SSH target or a paired Orca server. */
export type HostEntry = {
  kind: 'local' | 'ssh' | 'environment'
  id: string
  name: string
  /** SSH targets only: whether Orca is connected to it now. */
  connected?: boolean
}

/** What one paired server's own `worktree ps` answered; `worktrees` is null when it did not. */
export type ServerRead = {
  /** `runtime:<environment id>`. */
  hostId: string
  worktrees: CliWorktree[] | null
  error: string | null
  /** The first answer has not arrived yet. */
  pending?: boolean
}

export type Fleet = { hosts?: HostEntry[]; servers?: ServerRead[] }

const MESSAGE_MAX = 140
const ACTIVITY_MAX = 60
/** API and CLI stamps of the same state can differ by a few ms. */
const SAME_STATE_MS = 2000

export const LOCAL_HOST: HostRef = { id: 'local', kind: 'local', label: 'This computer' }

function decode(part: string): string {
  try {
    return decodeURIComponent(part)
  } catch {
    return part
  }
}

/** `runtime:<environment id>`, as Orca spells a paired server's host. */
export const serverHostId = (environmentId: string): string =>
  `runtime:${encodeURIComponent(environmentId)}`

/** The host an Orca host id names, with the name `orca host list` gives it when it lists it. */
export function hostRef(hostId: string | null | undefined, directory: HostEntry[] = []): HostRef {
  if (!hostId || hostId === 'local') return LOCAL_HOST
  const cut = hostId.indexOf(':')
  const scheme = cut < 0 ? '' : hostId.slice(0, cut)
  const target = decode(hostId.slice(cut + 1))
  if (scheme === 'ssh') {
    const entry = directory.find((h) => h.kind === 'ssh' && h.id === target)
    return { id: hostId, kind: 'ssh', label: entry?.name || target }
  }
  if (scheme === 'runtime') {
    const entry = directory.find((h) => h.kind === 'environment' && h.id === target)
    return { id: hostId, kind: 'server', label: entry?.name || target }
  }
  // A host kind this plugin does not know yet: shown by its id, never dropped.
  return { id: hostId, kind: 'ssh', label: hostId }
}

/** One readable line from an agent's markdown answer. */
export function flatten(text: string | null | undefined, max = MESSAGE_MAX): string | null {
  if (!text) return null
  const line = text
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/^\s*\|.*\|\s*$/gm, ' ') // table rows
    .replace(/^\s*#+\s*/gm, '')
    .replace(/\*\*|__|`/g, '')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/^\s*[-*]\s+/gm, '')
    .replace(/\s+/g, ' ')
    .trim()
  if (!line) return null
  return line.length > max ? `${line.slice(0, max - 1).trimEnd()}…` : line
}

function cliWorktreeFor(ws: ApiWorkspace, cli: CliWorktree[]): CliWorktree | undefined {
  // Git worktrees: the API id is `identity:<identity.key>`.
  const byKey = cli.find((c) => c.identity?.key && `identity:${c.identity.key}` === ws.id)
  if (byKey) return byKey
  // Folders share `<projectId>::<path>` when several point at one path; the name tells them apart.
  const sameId = cli.filter((c) => c.worktreeId === ws.id)
  return sameId.find((c) => c.displayName === ws.name) ?? (sameId.length === 1 ? sameId[0] : undefined)
}

function matchAgent(agent: ApiAgent, pool: CliAgent[]): CliAgent | undefined {
  if (agent.terminalId) {
    const exact = pool.find((c) => c.address === agent.terminalId)
    if (exact) return exact
  }
  let best: CliAgent | undefined
  let bestDelta = SAME_STATE_MS
  for (const c of pool) {
    if (c.state !== agent.state || typeof c.stateStartedAt !== 'number') continue
    const delta = Math.abs(c.stateStartedAt - agent.stateStartedAt)
    if (delta <= bestDelta) {
      best = c
      bestDelta = delta
    }
  }
  return best
}

function prInfo(pr: CliWorktree['linkedPR']): PrInfo | null {
  if (!pr) return null
  const checks = pr.checksStatus
  return {
    number: pr.number,
    state: pr.state,
    title: pr.title ?? `PR #${pr.number}`,
    checks:
      checks === 'success' || checks === 'failure' || checks === 'pending' || checks === 'neutral'
        ? checks
        : null,
    passed: pr.checksSummary?.passed ?? 0,
    total: pr.checksSummary?.total ?? 0
  }
}

function activityOf(cli: CliAgent | undefined): string | null {
  if (!cli?.toolName) return null
  const input = flatten(cli.toolInput, ACTIVITY_MAX)
  return input ? `${cli.toolName} · ${input}` : cli.toolName
}

/** Session titles can carry Claude's internal markup (`<local-command-caveat>…`): drop it. */
export function cleanTitle(title: string | null | undefined): string | null {
  if (!title) return null
  const text = title
    .replace(/<([a-z-]+)>[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<\/?[a-z-]+>/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim()
  return text || null
}

const isTerminal = (id: string | null | undefined): id is string => !!id && id.startsWith('term_')
const AGENT_STATES: readonly string[] = ['working', 'blocked', 'waiting', 'done']
const isAgentState = (s: string | undefined): s is AgentState => !!s && AGENT_STATES.includes(s)
const branchName = (branch: string | null | undefined): string | null =>
  branch ? branch.replace(/^refs\/heads\//, '') || null : null

type Place = { host: HostRef; workspaceId: string; workspace: string; project: string }

/** Agents of a workspace the plugin API lists, enriched from the CLI's row for it. */
function apiAgentRows(ws: ApiWorkspace, cw: CliWorktree | undefined, place: Place): AgentRow[] {
  const pool = [...(cw?.agents ?? [])]
  const rows: AgentRow[] = []
  ws.agents.forEach((agent, index) => {
    const match = matchAgent(agent, pool)
    if (match) pool.splice(pool.indexOf(match), 1)
    // The API sometimes loses the terminal of a pane that is still open; the CLI keeps it.
    const terminalId = isTerminal(agent.terminalId)
      ? agent.terminalId
      : isTerminal(match?.address)
        ? match.address
        : null
    // An agent with no open terminal is a closed session: nobody is waiting there.
    if (!terminalId) return
    const genericTitle = !agent.title || agent.title === 'Claude Code' || agent.title === agent.agent
    const title =
      agent.task?.title ??
      cleanTitle(match?.taskTitle) ??
      cleanTitle(match?.conversationName) ??
      (genericTitle ? null : agent.title) ??
      agent.title ??
      agent.agent ??
      'Agent'
    // The API can keep "working" after a session is cut off (Esc, Ctrl-C, a crash). When the CLI
    // answered for this workspace and does not see it working, it is idle at its prompt.
    const stale = agent.state === 'working' && !!cw && match?.state !== 'working'
    rows.push({
      key: `${place.host.id}|${ws.id}|${ws.name}|${terminalId}|${index}`,
      state: stale ? 'idle' : agent.state,
      since: agent.stateStartedAt,
      host: place.host,
      project: place.project,
      workspace: place.workspace,
      workspaceId: place.workspaceId,
      title,
      lastMessage: flatten(match?.lastAssistantMessage),
      activity: agent.state === 'working' && !stale ? activityOf(match) : null,
      // A paired server's terminal handles belong to that server: this Orca cannot focus them.
      terminalId: place.host.kind === 'server' ? null : terminalId
    })
  })
  return rows
}

/** Agents of a workspace only a paired server's `worktree ps` lists: the CLI row is all there is. */
function cliAgentRows(cw: CliWorktree, place: Place, now: number): AgentRow[] {
  const rows: AgentRow[] = []
  ;(cw.agents ?? []).forEach((agent, index) => {
    if (!isAgentState(agent.state)) return
    // As above: a session with no live terminal is closed.
    if (!isTerminal(agent.address) && agent.hasLivePty !== true) return
    const idle = agent.state === 'working' && agent.interrupted === true
    rows.push({
      key: `${place.host.id}|${place.workspaceId}|${place.workspace}|${agent.address ?? ''}|${index}`,
      state: idle ? 'idle' : agent.state,
      since: typeof agent.stateStartedAt === 'number' ? agent.stateStartedAt : now,
      host: place.host,
      project: place.project,
      workspace: place.workspace,
      workspaceId: place.workspaceId,
      title:
        cleanTitle(agent.taskTitle) ??
        cleanTitle(agent.conversationName) ??
        cleanTitle(agent.displayName) ??
        agent.agentType ??
        'Agent',
      lastMessage: flatten(agent.lastAssistantMessage),
      activity: agent.state === 'working' && !idle ? activityOf(agent) : null,
      terminalId: null
    })
  })
  return rows
}

/** The id the plugin API would give a CLI row: its host-qualified identity, else its raw id. */
const cliWorkspaceId = (cw: CliWorktree): string =>
  cw.identity?.key && !cw.worktreeId.startsWith('folder:') ? `identity:${cw.identity.key}` : cw.worktreeId

export function buildSnapshot(
  workspaces: ApiWorkspace[],
  cli: CliWorktree[] | null,
  now: number,
  enrichmentError: string | null = null,
  fleet: Fleet = {}
): Snapshot {
  const directory = fleet.hosts ?? []
  const servers = fleet.servers ?? []
  const waiting: AgentRow[] = []
  const working: AgentRow[] = []
  const worktrees: WorktreeRow[] = []

  // Hosts, this computer first, then in the order Orca lists them.
  const hosts = new Map<string, HostStatus>()
  const host = (ref: HostRef): HostStatus => {
    let status = hosts.get(ref.id)
    if (!status) {
      status = { ...ref, state: 'ok', error: null, worktrees: 0, waiting: 0, working: 0 }
      hosts.set(ref.id, status)
    }
    return status
  }
  host(LOCAL_HOST)
  for (const entry of directory) {
    if (entry.kind === 'ssh') {
      const status = host(hostRef(`ssh:${encodeURIComponent(entry.id)}`, directory))
      if (entry.connected === false) status.state = 'disconnected'
    } else if (entry.kind === 'environment') {
      host(hostRef(serverHostId(entry.id), directory))
    }
  }
  const serverRows = new Map<string, CliWorktree[]>()
  for (const read of servers) {
    const status = host(hostRef(read.hostId, directory))
    if (read.worktrees) serverRows.set(read.hostId, read.worktrees)
    else {
      status.state = read.pending ? 'connecting' : 'unreachable'
      status.error = read.error
    }
  }

  const add = (rows: AgentRow[], row: Omit<WorktreeRow, 'agentsWaiting' | 'agentsWorking'>): void => {
    const agentsWorking = rows.filter((r) => r.state === 'working').length
    const agentsWaiting = rows.length - agentsWorking
    for (const r of rows) (r.state === 'working' ? working : waiting).push(r)
    worktrees.push({ ...row, agentsWaiting, agentsWorking })
    const status = host(row.host)
    status.worktrees++
    status.waiting += agentsWaiting
    status.working += agentsWorking
  }

  // What the plugin API lists: this computer and the SSH machines Orca reaches.
  const listed = new Set<string>()
  for (const ws of workspaces) {
    const ref = hostRef(ws.hostId, directory)
    // A paired server's workspace, should the API list one: its details are in that server's rows.
    const pool = ref.kind === 'server' ? (serverRows.get(ref.id) ?? null) : cli
    const cw = pool ? cliWorktreeFor(ws, pool) : undefined
    const place: Place = {
      host: ref,
      workspaceId: ws.id,
      workspace: ws.name,
      project: ws.project ?? cw?.repo ?? cw?.displayName ?? ws.name
    }
    listed.add(`${ref.id}|${ws.id}|${ws.name}`)
    const rows =
      ref.kind === 'server' && cw && ws.agents.length === 0
        ? cliAgentRows(cw, place, now)
        : apiAgentRows(ws, cw, place)
    add(rows, {
      key: `${ref.id}|${ws.id}|${ws.name}`,
      workspaceId: ws.id,
      host: ref,
      project: place.project,
      name: ws.name,
      branch: branchName(ws.branch),
      kind: ws.kind,
      pr: prInfo(cw?.linkedPR),
      lastActivityAt: ws.status?.lastActivityAt ?? cw?.lastActivityAt ?? null
    })
  }

  // What only a paired server's own `worktree ps` lists.
  for (const [hostId, rows] of serverRows) {
    const ref = hostRef(hostId, directory)
    for (const cw of rows) {
      if (cw.isArchived) continue
      const id = cliWorkspaceId(cw)
      const name = cw.displayName ?? branchName(cw.branch) ?? id
      const key = `${ref.id}|${id}|${name}`
      if (listed.has(key)) continue
      listed.add(key)
      const folder = cw.workspaceKind === 'folder-workspace' || id.startsWith('folder:')
      const place: Place = { host: ref, workspaceId: id, workspace: name, project: cw.repo || name }
      add(cliAgentRows(cw, place, now), {
        key,
        workspaceId: id,
        host: ref,
        project: place.project,
        name,
        branch: folder ? null : branchName(cw.branch),
        kind: folder ? 'folder' : 'worktree',
        pr: prInfo(cw.linkedPR),
        lastActivityAt: cw.lastActivityAt ?? null
      })
    }
  }

  // Longest wait first.
  waiting.sort((a, b) => a.since - b.since)
  // Most recently started first.
  working.sort((a, b) => b.since - a.since)
  worktrees.sort((a, b) => (b.lastActivityAt ?? 0) - (a.lastActivityAt ?? 0))

  return { generatedAt: now, waiting, working, worktrees, hosts: [...hosts.values()], enrichmentError }
}
