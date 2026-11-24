// Pit Wall Fleet's worker. Read-only: it reads workspaces and agents through the plugin API and,
// for what the API does not expose, runs the read-only `orca` commands src/fleet.ts lists.
// The only action it takes is showing a workspace or terminal when the person clicks a row.
import type { OrcaWorkerApi } from 'orca/worker'
import { execFile } from 'node:child_process'
import { createFleet } from './fleet'
import { buildSnapshot, hostRef, type ApiWorkspace, type HostEntry } from './model'
import type { Snapshot } from './protocol'

declare const process: { env: Record<string, string | undefined> }

/** `PIT_WALL_ORCA_BIN` overrides where `orca` is looked up (the tests point it nowhere). */
function cliCandidates(): string[] {
  const override = process.env.PIT_WALL_ORCA_BIN
  return override
    ? [override]
    : ['orca', 'orca-ide', '/Applications/Orca.app/Contents/Resources/bin/orca']
}
const AGENT_CALLS_IN_PARALLEL = 6

type CliError = Error & { missing?: boolean }

/** Runs `bin args` and resolves with the `result` of Orca's JSON envelope. */
function run<T>(bin: string, args: string[], timeout: number): Promise<T> {
  return new Promise((resolve, reject) => {
    execFile(bin, args, { timeout, maxBuffer: 32 * 1024 * 1024 }, (error, stdout) => {
      // A refusal still prints its envelope: its message says more than the exit code.
      let parsed: { ok?: boolean; result?: T; error?: { message?: string } } | null = null
      try {
        parsed = JSON.parse(stdout)
      } catch {
        parsed = null
      }
      if (parsed?.ok && !error) return resolve(parsed.result as T)
      const failure: CliError = new Error(
        parsed?.error?.message ?? error?.message ?? `orca ${args.slice(0, 2).join(' ')} failed`
      )
      failure.missing = error?.code === 'ENOENT'
      reject(failure)
    })
  })
}

async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length)
  let next = 0
  const lanes = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const i = next++
      out[i] = await fn(items[i])
    }
  })
  await Promise.all(lanes)
  return out
}

const message = (e: unknown): string => (e instanceof Error ? e.message : String(e))

export default function activate(orca: OrcaWorkerApi): void {
  let workingBin: string | null = null

  /** Runs an `orca` command with the first binary that exists, and remembers which. */
  async function cli<T>(args: string[], timeout: number): Promise<T> {
    let last: unknown = new Error('orca not found')
    for (const bin of workingBin ? [workingBin] : cliCandidates()) {
      try {
        const result = await run<T>(bin, args, timeout)
        workingBin = bin
        return result
      } catch (e) {
        last = e
        // Only a missing binary sends us to the next candidate; a real refusal is the answer.
        if (!(e as CliError).missing) {
          workingBin = bin
          throw e
        }
      }
    }
    workingBin = null
    throw last
  }

  const fleet = createFleet(cli, { log: (line) => orca.log(line) })

  async function workspaces(): Promise<ApiWorkspace[]> {
    const { workspaces } = await orca.host.call('workspace.list', { includeStatus: true })
    return mapLimit(workspaces, AGENT_CALLS_IN_PARALLEL, async (w) => {
      const answer = await orca.host
        .call('agents.list', { workspaceId: w.id })
        .catch(() => ({ agents: [] }))
      return {
        id: w.id,
        kind: w.kind,
        name: w.name,
        project: w.project,
        branch: w.branch,
        hostId: w.hostId,
        status: w.status ?? null,
        agents: answer.agents
      }
    })
  }

  let lastHosts: HostEntry[] = []

  orca.panels.handle('snapshot', async (): Promise<Snapshot> => {
    const [ws, { local, hosts, servers }] = await Promise.all([workspaces(), fleet.read()])
    lastHosts = hosts
    return buildSnapshot(ws, local.worktrees, Date.now(), local.error, { hosts, servers })
  })

  orca.panels.handle('open', async ({ workspaceId, terminalId, hostId }) => {
    if (terminalId) {
      try {
        const { focused } = await orca.host.call('terminal.focus', { terminalId })
        if (focused) return { ok: true }
      } catch (e) {
        orca.log(`terminal.focus failed, opening the workspace: ${String(e)}`)
      }
    }
    try {
      await orca.host.call('workspace.open', { workspaceId })
      return { ok: true }
    } catch (e) {
      const host = hostRef(hostId, lastHosts)
      if (host.kind !== 'server') throw e
      orca.log(`workspace.open failed for a workspace on ${host.label}: ${String(e)}`)
      return {
        ok: false,
        message: `This workspace lives on the paired server “${host.label}”. Open it from Orca's sidebar, or on that machine.`
      }
    }
  })
}
