// What Pit Wall Fleet reads through the `orca` CLI, behind one function (`cli`) so that
// src/fleet.test.ts can answer for it. Three read-only commands:
//   orca worktree ps --json                          PRs, checks, session titles, last messages
//   orca host list --json                            the names of SSH targets and paired servers
//   orca worktree ps --json --environment <server>   the workspaces of each paired Orca server
import { serverHostId, type CliWorktree, type HostEntry, type ServerRead } from './model'

/** Runs `orca <args>` and resolves with the `result` of its JSON envelope. */
export type Cli = <T>(args: string[], timeoutMs: number) => Promise<T>

export const CLI_TIMEOUT_MS = 8000
/** The panel refreshes every few seconds; the CLI answer is reused within this window. */
const CLI_CACHE_MS = 4000
const HOSTS_CACHE_MS = 30_000
/** A paired server is another machine: asked less often, given longer, never waited on for long. */
const SERVER_CACHE_MS = 10_000
const SERVER_TIMEOUT_MS = 15_000
const SERVER_WAIT_MS = 4000
const SERVERS_MAX = 12
/** An environment id is passed as one argument to `orca`, never through a shell; still, only
 *  plain ids are sent, so one can never read as a flag. */
const ENVIRONMENT_ID = /^[A-Za-z0-9][A-Za-z0-9._:@-]{0,199}$/

type PsResult = {
  worktrees?: CliWorktree[]
  hostScope?: { hostIds?: string[]; omittedHostIds?: string[] }
}
export type LocalRead = { worktrees: CliWorktree[] | null; omitted: string[]; error: string | null }
export type FleetRead = { local: LocalRead; hosts: HostEntry[]; servers: ServerRead[] }

const message = (e: unknown): string => (e instanceof Error ? e.message : String(e))

/** Paired servers: the ones `orca host list` names, plus any the local listing says it omits. */
export function environmentIds(hosts: HostEntry[], omitted: string[]): string[] {
  const ids = new Set(hosts.filter((h) => h.kind === 'environment').map((h) => h.id))
  for (const hostId of omitted) {
    if (!hostId.startsWith('runtime:')) continue
    try {
      ids.add(decodeURIComponent(hostId.slice('runtime:'.length)))
    } catch {
      // An id that does not decode names no server we could ask.
    }
  }
  return [...ids].slice(0, SERVERS_MAX)
}

export type FleetOptions = {
  log?: (message: string) => void
  now?: () => number
  /** How long a snapshot waits on one paired server before going out without it. */
  serverWaitMs?: number
}

export function createFleet(cli: Cli, options: FleetOptions = {}): { read: () => Promise<FleetRead> } {
  const log = options.log ?? (() => {})
  const now = options.now ?? Date.now
  const serverWaitMs = options.serverWaitMs ?? SERVER_WAIT_MS

  /** One read at a time, reused for `ttl` ms after it lands. */
  function cached<T>(ttl: number, read: () => Promise<T>): () => Promise<T> {
    let at: number | null = null
    let value: T | undefined
    let inFlight: Promise<T> | null = null
    return async () => {
      if (at !== null && now() - at < ttl) return value as T
      inFlight ??= read().finally(() => (inFlight = null))
      value = await inFlight
      at = now()
      return value
    }
  }

  const local = cached<LocalRead>(CLI_CACHE_MS, async () => {
    try {
      const result = await cli<PsResult>(['worktree', 'ps', '--json'], CLI_TIMEOUT_MS)
      return {
        worktrees: result.worktrees ?? [],
        omitted: result.hostScope?.omittedHostIds ?? [],
        error: null
      }
    } catch (e) {
      log(`orca worktree ps failed: ${message(e)}`)
      return { worktrees: null, omitted: [], error: message(e) }
    }
  })

  const directory = cached<HostEntry[]>(HOSTS_CACHE_MS, async () => {
    try {
      const { hosts } = await cli<{ hosts?: HostEntry[] }>(['host', 'list', '--json'], CLI_TIMEOUT_MS)
      return (hosts ?? []).filter(
        (h) => typeof h?.id === 'string' && typeof h.name === 'string' && typeof h.kind === 'string'
      )
    } catch (e) {
      log(`orca host list failed: ${message(e)}`)
      return []
    }
  })

  type Slot = { at: number | null; read: ServerRead | null; inFlight: Promise<void> | null }
  const slots = new Map<string, Slot>()

  /**
   * One paired server's workspaces. The snapshot never waits long on another machine: past
   * `serverWaitMs` it goes out with that server's last answer (or "connecting") and the read
   * carries on for the next refresh.
   */
  async function server(environmentId: string): Promise<ServerRead> {
    const hostId = serverHostId(environmentId)
    if (!ENVIRONMENT_ID.test(environmentId)) {
      return { hostId, worktrees: null, error: 'this server id cannot be passed to the orca CLI' }
    }
    let slot = slots.get(environmentId)
    if (!slot) slots.set(environmentId, (slot = { at: null, read: null, inFlight: null }))
    const mine = slot
    if (mine.read && mine.at !== null && now() - mine.at < SERVER_CACHE_MS) return mine.read
    mine.inFlight ??= cli<PsResult>(
      ['worktree', 'ps', '--json', '--environment', environmentId],
      SERVER_TIMEOUT_MS
    )
      .then(
        (result) => {
          mine.read = { hostId, worktrees: result.worktrees ?? [], error: null }
        },
        (e) => {
          log(`orca worktree ps --environment ${environmentId} failed: ${message(e)}`)
          mine.read = { hostId, worktrees: null, error: message(e) }
        }
      )
      .finally(() => {
        mine.at = now()
        mine.inFlight = null
      })
    let timer: ReturnType<typeof setTimeout> | undefined
    await Promise.race([
      mine.inFlight,
      new Promise<void>((resolve) => (timer = setTimeout(resolve, serverWaitMs)))
    ])
    clearTimeout(timer)
    return mine.read ?? { hostId, worktrees: null, error: null, pending: true }
  }

  return {
    async read() {
      const [localRead, hosts] = await Promise.all([local(), directory()])
      const servers = await Promise.all(environmentIds(hosts, localRead.omitted).map(server))
      return { local: localRead, hosts, servers }
    }
  }
}
