import { assert, test } from 'orca/testing'
import {
  buildSnapshot,
  flatten,
  hostRef,
  type ApiWorkspace,
  type CliWorktree,
  type Fleet,
  type HostEntry
} from './model'

const NOW = 1_000_000_000

const api: ApiWorkspace[] = [
  {
    id: 'identity:wt2:local:aaa',
    kind: 'worktree',
    name: 'menu-top',
    project: 'storefront',
    branch: 'feature/menu-top',
    status: { state: 'active', lastActivityAt: NOW - 60_000 },
    agents: [
      { terminalId: 'term_1', title: 'Claude Code', agent: 'claude', state: 'waiting', stateStartedAt: NOW - 5_000 },
      { terminalId: 'term_2', title: 'Refactor', agent: 'claude', state: 'working', stateStartedAt: NOW - 1_000 }
    ]
  },
  {
    id: 'proj::/path/web',
    kind: 'folder',
    name: 'drafts',
    project: 'web',
    branch: null,
    status: { state: 'inactive', lastActivityAt: NOW - 3_600_000 },
    agents: [
      // The API lost this pane's terminal; the CLI still has it, stamped 1 ms apart.
      { terminalId: null, title: null, agent: 'claude', state: 'done', stateStartedAt: NOW - 90_000 },
      // Closed session: no terminal anywhere.
      { terminalId: null, title: null, agent: 'claude', state: 'done', stateStartedAt: NOW - 999_999 }
    ]
  },
  {
    id: 'proj::/path/web',
    kind: 'folder',
    name: 'Blog',
    project: 'web',
    branch: null,
    status: null,
    agents: []
  }
]

const cli: CliWorktree[] = [
  {
    worktreeId: 'x::/whatever',
    displayName: 'menu-top',
    identity: { key: 'wt2:local:aaa' },
    linkedPR: {
      number: 143,
      state: 'draft',
      title: 'feat: top',
      checksStatus: 'success',
      checksSummary: { passed: 6, total: 6 }
    },
    agents: [
      { address: 'term_1', state: 'waiting', conversationName: 'Categoría TOP', lastAssistantMessage: '**¿Sigo** con `iOS`?\n\n| a | b |\n|---|---|' },
      { address: 'term_2', state: 'working', conversationName: 'Refactor', toolName: 'Bash', toolInput: 'npm test' }
    ]
  },
  { worktreeId: 'proj::/path/web', displayName: 'Blog', agents: [] },
  {
    worktreeId: 'proj::/path/web',
    displayName: 'drafts',
    agents: [{ address: 'term_9', state: 'done', stateStartedAt: NOW - 90_001, conversationName: 'Update drafts', lastAssistantMessage: 'Hecho.' }]
  }
]

test('sorts agents into waiting and working, enriched from the CLI', () => {
  const snap = buildSnapshot(api, cli, NOW)
  assert.deepEqual(
    snap.waiting.map((a) => [a.title, a.state, a.terminalId, a.lastMessage]),
    [
      ['Update drafts', 'done', 'term_9', 'Hecho.'], // waited longest: first
      ['Categoría TOP', 'waiting', 'term_1', '¿Sigo con iOS?']
    ]
  )
  assert.deepEqual(
    snap.working.map((a) => [a.title, a.activity]),
    [['Refactor', 'Bash · npm test']]
  )
  assert.equal(snap.enrichmentError, null)
})

test('lists every worktree with branch, PR and counts, latest activity first', () => {
  const snap = buildSnapshot(api, cli, NOW)
  assert.deepEqual(
    snap.worktrees.map((w) => [w.name, w.branch, w.pr?.number ?? null, w.pr?.checks ?? null, w.agentsWaiting, w.agentsWorking]),
    [
      ['menu-top', 'feature/menu-top', 143, 'success', 1, 1],
      ['drafts', null, null, null, 1, 0],
      ['Blog', null, null, null, 0, 0]
    ]
  )
})

test('works without the CLI: API data only', () => {
  const snap = buildSnapshot(api, null, NOW, 'spawn orca ENOENT')
  assert.equal(snap.enrichmentError, 'spawn orca ENOENT')
  // The folder agent had no terminal in the API and none to borrow: it is left out.
  assert.deepEqual(
    snap.waiting.map((a) => [a.title, a.lastMessage]),
    [['Claude Code', null]]
  )
  assert.equal(snap.worktrees[0].pr, null)
})

test('flatten keeps one readable line and cuts it', () => {
  assert.equal(flatten('# Hecho\n\n- uno\n- [dos](http://x)'), 'Hecho uno dos')
  assert.equal(flatten(''), null)
  const long = flatten('a'.repeat(500))
  assert.equal(long?.length, 140)
  assert.ok(long?.endsWith('…'))
})

test('an agent the API still calls working, but the CLI does not, is idle and waits on you', () => {
  const stuck: ApiWorkspace[] = [
    {
      id: 'identity:wt2:local:bbb',
      kind: 'worktree',
      name: 'voice-to-order',
      project: 'storefront',
      branch: 'feature/voice-to-order',
      status: null,
      agents: [{ terminalId: 'term_5', title: 'Voz', agent: 'claude', state: 'working', stateStartedAt: NOW - 86_400_000 }]
    }
  ]
  const seen: CliWorktree[] = [{ worktreeId: 'x', identity: { key: 'wt2:local:bbb' }, agents: [] }]
  const snap = buildSnapshot(stuck, seen, NOW)
  assert.deepEqual(snap.working, [])
  assert.deepEqual(snap.waiting.map((a) => [a.title, a.state]), [['Voz', 'idle']])
  // Without the CLI there is nothing to contradict the API: it stays working.
  assert.equal(buildSnapshot(stuck, null, NOW).working.length, 1)
})

test('cleanTitle drops Claude markup from session titles', async () => {
  const { cleanTitle } = await import('./model')
  assert.equal(cleanTitle('<local-command-caveat>Caveat: x</local-command-caveat> Revisar PR'), 'Revisar PR')
  assert.equal(cleanTitle('<command-name>/clear</command-name>'), null)
  assert.equal(cleanTitle('Categoría TOP'), 'Categoría TOP')
})

// ---------- hosts: SSH machines and paired Orca servers ----------

const hosts: HostEntry[] = [
  { kind: 'local', id: 'local', name: 'this machine' },
  { kind: 'ssh', id: 'ssh-17-abc', name: 'vps-prod', connected: true },
  { kind: 'ssh', id: 'ssh-18-def', name: 'old-box', connected: false },
  { kind: 'environment', id: 'env_1', name: 'work-laptop' },
  { kind: 'environment', id: 'env_2', name: 'build-server' }
]

const sshWorkspace: ApiWorkspace = {
  id: 'identity:wt2:ssh:ccc',
  kind: 'worktree',
  name: 'deploy-fix',
  project: 'storefront',
  branch: 'fix/deploy',
  hostId: 'ssh:ssh-17-abc',
  status: { state: 'working', lastActivityAt: NOW - 10_000 },
  agents: [{ terminalId: 'term_7', title: 'Deploy', agent: 'claude', state: 'blocked', stateStartedAt: NOW - 30_000 }]
}

const serverRows: CliWorktree[] = [
  {
    worktreeId: 'r1::/srv/api/wt/billing',
    identity: { key: 'wt2:local:srv1' },
    displayName: 'billing-audit',
    repo: 'api',
    branch: 'refs/heads/feat/billing-audit',
    isArchived: false,
    lastActivityAt: NOW - 20_000,
    linkedPR: { number: 77, state: 'open', title: 'Audit billing', checksStatus: 'pending', checksSummary: { passed: 2, total: 5 } },
    agents: [
      { address: 'term_s1', state: 'waiting', stateStartedAt: NOW - 600_000, agentType: 'codex', conversationName: 'Audit', lastAssistantMessage: 'Which **plan** first?' },
      { address: 'term_s2', state: 'working', stateStartedAt: NOW - 5_000, agentType: 'claude', toolName: 'Bash', toolInput: 'pnpm test' },
      // Cut off without telling Orca: idle at its prompt.
      { address: 'term_s3', state: 'working', stateStartedAt: NOW - 9_000, agentType: 'claude', interrupted: true },
      // Closed session: no live terminal.
      { state: 'done', stateStartedAt: NOW - 1 }
    ]
  },
  { worktreeId: 'r1::/srv/api/wt/old', displayName: 'old', repo: 'api', isArchived: true, agents: [] }
]

const fleet: Fleet = {
  hosts,
  servers: [
    { hostId: 'runtime:env_1', worktrees: serverRows, error: null },
    { hostId: 'runtime:env_2', worktrees: null, error: 'connect ETIMEDOUT' }
  ]
}

test('an SSH workspace is named by its target, as `orca host list` names it', () => {
  const snap = buildSnapshot([sshWorkspace], [], NOW, null, fleet)
  const row = snap.waiting.find((a) => a.terminalId === 'term_7')!
  assert.deepEqual(row.host, { id: 'ssh:ssh-17-abc', kind: 'ssh', label: 'vps-prod' })
  // Orca reaches SSH terminals itself: the row keeps its terminal to focus.
  assert.equal(row.terminalId, 'term_7')
  assert.equal(snap.worktrees.find((w) => w.name === 'deploy-fix')!.host.label, 'vps-prod')
})

test("a paired server's workspaces come from its own worktree ps", () => {
  const snap = buildSnapshot(api, cli, NOW, null, fleet)
  const remote = snap.worktrees.filter((w) => w.host.kind === 'server')
  assert.deepEqual(
    remote.map((w) => [w.host.label, w.project, w.name, w.branch, w.pr?.number, w.agentsWaiting, w.agentsWorking, w.workspaceId]),
    [['work-laptop', 'api', 'billing-audit', 'feat/billing-audit', 77, 2, 1, 'identity:wt2:local:srv1']]
  )
  assert.deepEqual(
    snap.waiting.filter((a) => a.host.kind === 'server').map((a) => [a.title, a.state, a.lastMessage, a.terminalId]),
    [
      ['Audit', 'waiting', 'Which plan first?', null],
      ['claude', 'idle', null, null]
    ]
  )
  assert.deepEqual(
    snap.working.filter((a) => a.host.kind === 'server').map((a) => [a.title, a.activity]),
    [['claude', 'Bash · pnpm test']]
  )
  // Local rows are untouched by the fleet.
  assert.equal(snap.waiting.filter((a) => a.host.kind === 'local').length, 2)
})

test('every host is listed with what could be read from it', () => {
  const snap = buildSnapshot([...api, sshWorkspace], cli, NOW, null, fleet)
  assert.deepEqual(
    snap.hosts.map((h) => [h.label, h.kind, h.state, h.worktrees, h.waiting, h.working]),
    [
      ['This computer', 'local', 'ok', 3, 2, 1],
      ['vps-prod', 'ssh', 'ok', 1, 1, 0],
      ['old-box', 'ssh', 'disconnected', 0, 0, 0],
      ['work-laptop', 'server', 'ok', 1, 2, 1],
      ['build-server', 'server', 'unreachable', 0, 0, 0]
    ]
  )
  assert.equal(snap.hosts[4].error, 'connect ETIMEDOUT')
})

test('a server still answering for the first time reads as connecting', () => {
  const snap = buildSnapshot([], [], NOW, null, {
    hosts,
    servers: [{ hostId: 'runtime:env_1', worktrees: null, error: null, pending: true }]
  })
  assert.equal(snap.hosts.find((h) => h.label === 'work-laptop')!.state, 'connecting')
})

test('a server workspace the API also lists shows once, with the server row as its details', () => {
  const listed: ApiWorkspace = {
    id: 'identity:wt2:local:srv1',
    kind: 'worktree',
    name: 'billing-audit',
    project: 'api',
    branch: 'feat/billing-audit',
    hostId: 'runtime:env_1',
    status: null,
    agents: []
  }
  const snap = buildSnapshot([listed], [], NOW, null, fleet)
  assert.equal(snap.worktrees.length, 1)
  assert.equal(snap.worktrees[0].pr?.number, 77)
  assert.equal(snap.waiting.length + snap.working.length, 3)
})

test('without a host directory a host is shown by its id, and nothing is dropped', () => {
  assert.deepEqual(hostRef('ssh:my%20box'), { id: 'ssh:my%20box', kind: 'ssh', label: 'my box' })
  assert.deepEqual(hostRef('runtime:env_9'), { id: 'runtime:env_9', kind: 'server', label: 'env_9' })
  assert.deepEqual(hostRef(null), { id: 'local', kind: 'local', label: 'This computer' })
  assert.equal(buildSnapshot(api, cli, NOW).hosts.length, 1)
})
