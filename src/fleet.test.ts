import { assert, test } from 'orca/testing'
import { createFleet, environmentIds, type Cli } from './fleet'

type Answer = unknown | Error | Promise<unknown>

/** A stand-in for the `orca` CLI: answers by its arguments and records every call. */
function fakeCli(answers: Record<string, Answer>): { cli: Cli; calls: string[] } {
  const calls: string[] = []
  const cli = (async (args: string[]) => {
    const key = args.join(' ')
    calls.push(key)
    const answer = answers[key]
    if (answer === undefined) throw new Error(`unexpected: orca ${key}`)
    if (answer instanceof Error) throw answer
    return answer
  }) as Cli
  return { cli, calls }
}

const HOSTS = {
  hosts: [
    { kind: 'local', id: 'local', name: 'this machine' },
    { kind: 'ssh', id: 'ssh-1', name: 'vps', connected: true },
    { kind: 'environment', id: 'env_1', name: 'work-laptop' }
  ]
}
const LOCAL = { worktrees: [{ worktreeId: 'a' }], hostScope: { hostIds: ['local'], omittedHostIds: ['runtime:env_1'] } }

test('reads this machine, the host names and each paired server', async () => {
  const { cli, calls } = fakeCli({
    'worktree ps --json': LOCAL,
    'host list --json': HOSTS,
    'worktree ps --json --environment env_1': { worktrees: [{ worktreeId: 'b' }] }
  })
  const read = await createFleet(cli).read()
  assert.deepEqual(read.local, { worktrees: [{ worktreeId: 'a' }], omitted: ['runtime:env_1'], error: null })
  assert.equal(read.hosts.length, 3)
  assert.deepEqual(read.servers, [{ hostId: 'runtime:env_1', worktrees: [{ worktreeId: 'b' }], error: null }])
  // Only read-only listings, and the server once though two sources name it.
  assert.deepEqual(calls.sort(), ['host list --json', 'worktree ps --json', 'worktree ps --json --environment env_1'])
})

test('a server that fails is reported, and everything else still reads', async () => {
  const { cli } = fakeCli({
    'worktree ps --json': LOCAL,
    'host list --json': HOSTS,
    'worktree ps --json --environment env_1': new Error('connect ETIMEDOUT')
  })
  const read = await createFleet(cli).read()
  assert.equal(read.local.error, null)
  assert.deepEqual(read.servers, [{ hostId: 'runtime:env_1', worktrees: null, error: 'connect ETIMEDOUT' }])
})

test('without the CLI nothing remote is asked and the error is kept', async () => {
  const { cli, calls } = fakeCli({
    'worktree ps --json': new Error('spawn orca ENOENT'),
    'host list --json': new Error('spawn orca ENOENT')
  })
  const read = await createFleet(cli).read()
  assert.deepEqual(read, { local: { worktrees: null, omitted: [], error: 'spawn orca ENOENT' }, hosts: [], servers: [] })
  assert.equal(calls.length, 2)
})

test('a slow server does not hold the snapshot: it reads as pending, then lands', async () => {
  let land: (value: unknown) => void = () => {}
  const slow = new Promise((resolve) => (land = resolve))
  const { cli, calls } = fakeCli({
    'worktree ps --json': LOCAL,
    'host list --json': HOSTS,
    'worktree ps --json --environment env_1': slow
  })
  let clock = 0
  const fleet = createFleet(cli, { serverWaitMs: 5, now: () => clock })
  const first = await fleet.read()
  assert.deepEqual(first.servers, [{ hostId: 'runtime:env_1', worktrees: null, error: null, pending: true }])
  // Asked again while the first read is still out: no second call to that server.
  clock += 5000
  await fleet.read()
  assert.equal(calls.filter((c) => c.includes('--environment')).length, 1)
  land({ worktrees: [{ worktreeId: 'b' }] })
  await slow
  await new Promise((resolve) => setTimeout(resolve, 0))
  const later = await fleet.read()
  assert.deepEqual(later.servers[0].worktrees, [{ worktreeId: 'b' }])
})

test('answers are reused within their window', async () => {
  const { cli, calls } = fakeCli({
    'worktree ps --json': LOCAL,
    'host list --json': HOSTS,
    'worktree ps --json --environment env_1': { worktrees: [] }
  })
  let clock = 1000
  const fleet = createFleet(cli, { now: () => clock })
  await fleet.read()
  clock += 1000
  await fleet.read()
  assert.equal(calls.length, 3)
  // Past the local window, within the hosts and server windows.
  clock += 5000
  await fleet.read()
  assert.deepEqual(calls.slice(3), ['worktree ps --json'])
})

test('server ids come from host list and from what the local listing omits', () => {
  const entries = HOSTS.hosts as Parameters<typeof environmentIds>[0]
  assert.deepEqual(environmentIds(entries, ['runtime:env_1', 'runtime:env%202', 'ssh:x', 'runtime:%E0%A4%A']), ['env_1', 'env 2'])
})

test('an id that could read as a flag is never passed to the CLI', async () => {
  const { cli, calls } = fakeCli({
    'worktree ps --json': { worktrees: [], hostScope: { hostIds: ['local'], omittedHostIds: ['runtime:--pairing-code'] } },
    'host list --json': { hosts: [] }
  })
  const read = await createFleet(cli).read()
  assert.equal(read.servers[0].worktrees, null)
  assert.ok(read.servers[0].error)
  assert.equal(calls.length, 2)
})
