// Pit Wall Fleet's visual panel: an org chart of what you launched (you → projects → open sessions),
// who is waiting on you, and every worktree, on this computer, on SSH machines and on paired Orca
// servers. It reads everything from the plugin's worker.
import '../src/protocol'
import type { AgentRow, HostRef, HostStatus, RowState, Snapshot, WorktreeRow } from '../src/protocol'
import { short } from '../src/time'
import {
  buildView,
  canBeSeen,
  groupWorktrees,
  hostChips,
  hostTag,
  onHost,
  pruneSeen,
  seenKey,
  type ProjectWorktrees,
  type PrRow,
  type Seen,
  type View
} from '../src/view'

const REFRESH_MS = 5000
const EVENT_DEBOUNCE_MS = 400
const SEEN_KEY = 'seen'
const HOST_KEY = 'host'
type Tab = 'overview' | 'sessions' | 'worktrees' | 'prs'

const STATE: Record<RowState, { tag: string; color: string; legend: string }> = {
  blocked: { tag: 'PERMISSION', color: 'var(--c-blocked)', legend: 'needs permission' },
  waiting: { tag: 'QUESTION', color: 'var(--c-waiting)', legend: 'question' },
  idle: { tag: 'IDLE', color: 'var(--c-idle)', legend: 'idle' },
  done: { tag: 'DONE', color: 'var(--c-done)', legend: 'done' },
  working: { tag: 'WORKING', color: 'var(--c-working)', legend: 'working' }
}

const app = document.getElementById('app') as HTMLElement
let snap: Snapshot | null = null
let seen: Seen = {}
let tab: Tab = 'overview'
/** The host the panel is narrowed to; null shows every host. */
let hostFilter: string | null = null
let error: string | null = null
let lastOk = 0
/** Rows by id, for clicks: the DOM only carries the id. */
let rows = new Map<string, AgentRow>()

// ---------- data ----------

let inFlight = false
async function refresh(): Promise<void> {
  if (inFlight) return
  inFlight = true
  try {
    snap = await orca.plugin.request('snapshot', undefined, { timeoutMs: 20000 })
    lastOk = Date.now()
    error = null
    const pruned = pruneSeen(snap, seen)
    if (pruned) await saveSeen(pruned)
  } catch (e) {
    error = e instanceof Error ? e.message : String(e)
  } finally {
    inFlight = false
    render()
  }
}

async function loadSeen(): Promise<void> {
  try {
    const value = await orca.storage.get(SEEN_KEY)
    seen = value && typeof value === 'object' && !Array.isArray(value) ? (value as Seen) : {}
  } catch {
    seen = {}
  }
  try {
    const value = await orca.storage.get(HOST_KEY)
    hostFilter = typeof value === 'string' ? value : null
  } catch {
    hostFilter = null
  }
}

async function saveSeen(next: Seen): Promise<void> {
  seen = next
  try {
    await orca.storage.set(SEEN_KEY, next)
  } catch (e) {
    console.error('[pit-wall] could not save seen sessions', e)
  }
}

function openRow(row: AgentRow): void {
  if (canBeSeen(row) && !seen[seenKey(row)]) {
    void saveSeen({ ...seen, [seenKey(row)]: true }).then(render)
  }
  open(row.workspaceId, row.host, row.terminalId)
}

function open(workspaceId: string, host: HostRef, terminalId?: string | null): void {
  const input = { workspaceId, hostId: host.id, ...(terminalId ? { terminalId } : {}) }
  orca.plugin.request('open', input).then(
    (answer) => {
      if (answer.ok) return
      error = answer.message ?? 'Could not open this workspace.'
      render()
    },
    (e: unknown) => {
      error = `Could not open: ${e instanceof Error ? e.message : String(e)}`
      render()
    }
  )
}

function setHost(id: string | null): void {
  hostFilter = id
  orca.storage.set(HOST_KEY, id).catch((e: unknown) => console.error('[pit-wall] could not save the host filter', e))
  window.scrollTo(0, 0)
  render()
}

// ---------- html helpers ----------

const esc = (s: string): string =>
  s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!)

const ago = (at: number | null): string => (at ? short(at, Date.now()) : '')

const where = (a: { host: HostRef; project: string; workspace: string }): string => {
  const place = a.project === a.workspace ? a.project : `${a.project} › ${a.workspace}`
  const host = hostTag(a.host)
  return host ? `${host} · ${place}` : place
}

/** A small "on <host>" mark for rows that are not on this computer. */
const hostMark = (host: HostRef): string => {
  const tag = hostTag(host)
  return tag ? `<span class="host-mark" title="${esc(host.kind === 'server' ? 'Paired Orca server' : 'SSH machine')}">${esc(tag)}</span>` : ''
}

/** Worktree rows by id, for clicks: the DOM only carries the id. */
let places = new Map<string, WorktreeRow>()
function placeId(w: WorktreeRow): string {
  places.set(w.key, w)
  return esc(w.key)
}

const initial = (s: string): string => esc((s.trim()[0] ?? '?').toUpperCase())

function rowId(a: AgentRow): string {
  rows.set(a.key, a)
  return esc(a.key)
}

// ---------- pieces ----------

function kpi(label: string, value: number, color: string): string {
  return `<div class="kpi${value ? '' : ' zero'}" style="--c:${color}">
    <div class="label">${label}</div><div class="value">${value}</div></div>`
}

function node(a: AgentRow, isSeen: boolean): string {
  const s = STATE[a.state]
  return `<button class="node${isSeen ? ' seen' : ''}${a.state === 'working' ? ' working' : ''}" data-row="${rowId(a)}"
      title="${esc(`${s.tag} · ${a.title} · ${where(a)}`)}">
    <span class="dot" style="--c:${s.color}"></span>
    <span class="body"><span class="title trunc">${esc(a.title)}</span>${
      a.workspace !== a.project ? `<span class="wt-name trunc">${esc(a.workspace)}</span>` : ''
    }</span>
    <span class="ago">${ago(a.since)}</span>
  </button>`
}

function office(o: View['offices'][number]): string {
  const color = o.fresh ? 'var(--c-waiting)' : o.working ? 'var(--c-working)' : 'var(--c-done)'
  const parts = [
    o.fresh ? `${o.fresh} waiting` : '',
    o.working ? `${o.working} working` : '',
    o.seen ? `${o.seen} seen` : ''
  ].filter(Boolean)
  return `<div class="office${o.fresh ? ' hot' : ''}" data-office>
    <div class="office-head">
      <span class="office-icon" style="--c:${color}">${initial(o.project)}</span>
      <div class="trunc"><b class="trunc">${esc(o.project)}</b><small>${hostMark(o.host)}${parts.join(' · ')}</small></div>
    </div>
    ${o.sessions.map((a) => node(a, canBeSeen(a) && !!seen[seenKey(a)])).join('')}
  </div>`
}

function item(a: AgentRow, isSeen = false): string {
  const s = STATE[a.state]
  const detail =
    a.state === 'working'
      ? a.activity
      : a.state === 'idle'
        ? 'Idle at the prompt, waiting for you'
        : a.lastMessage
          ? `“${a.lastMessage}”`
          : null
  return `<button class="item${isSeen ? ' seen' : ''}" style="--c:${s.color}" data-row="${rowId(a)}">
    <div class="top"><span class="tag">${s.tag}</span><span class="title trunc">${esc(a.title)}</span><span class="ago">${ago(a.since)}</span></div>
    <div class="sub trunc">${esc(where(a))}</div>
    ${detail ? `<div class="msg trunc">${esc(detail)}</div>` : ''}
  </button>`
}

function list(title: string, items: AgentRow[], empty: string, isSeen = false): string {
  return `<h2><span>${title}</span><span>${items.length}</span></h2>
    ${items.length ? items.map((a) => item(a, isSeen)).join('') : `<div class="empty">${empty}</div>`}`
}

function seenList(view: View): string {
  if (!view.looked.length) return ''
  return `<details><summary><h2><span>Opened, already seen</span><span>${view.looked.length}</span></h2></summary>
    ${view.looked.map((a) => item(a, true)).join('')}</details>`
}

const PR_STATE: Record<string, [string, string]> = {
  draft: ['draft', 'var(--muted)'],
  open: ['open', 'var(--c-working)'],
  merged: ['merged', 'var(--c-done)'],
  closed: ['closed', 'var(--muted)']
}
const CHECKS: Record<string, string> = {
  success: 'var(--c-done)',
  failure: 'var(--c-blocked)',
  pending: 'var(--c-waiting)',
  neutral: 'var(--muted)'
}

function prChips(pr: NonNullable<WorktreeRow['pr']>): string[] {
  const [text, color] = PR_STATE[pr.state.toLowerCase()] ?? [pr.state, 'var(--muted)']
  const chips = [`<span class="chip c" style="--c:${color}">PR #${pr.number} ${esc(text)}</span>`]
  if (pr.checks && pr.total)
    chips.push(`<span class="chip c" style="--c:${CHECKS[pr.checks]}">checks ${pr.passed}/${pr.total}</span>`)
  return chips
}

function agentChips(w: WorktreeRow): string[] {
  const chips: string[] = []
  if (w.agentsWaiting)
    chips.push(`<span class="chip c" style="--c:var(--c-waiting)"><span class="dot"></span>${w.agentsWaiting} waiting</span>`)
  if (w.agentsWorking)
    chips.push(`<span class="chip c" style="--c:var(--c-working)"><span class="dot"></span>${w.agentsWorking} working</span>`)
  return chips
}

function worktree(w: WorktreeRow): string {
  // The project is the group's header, so only a branch that differs from the name is worth repeating.
  const sub = w.branch && w.branch !== w.name ? w.branch : ''
  const chips = [...(w.pr ? prChips(w.pr) : []), ...agentChips(w)]
  return `<button class="wt" data-ws="${placeId(w)}">
    <div class="top"><span class="name trunc">${esc(w.name)}</span><span class="ago">${ago(w.lastActivityAt)}</span></div>
    ${sub ? `<div class="muted trunc">${esc(sub)}</div>` : ''}
    ${chips.length ? `<div class="chips">${chips.join('')}</div>` : ''}
  </button>`
}

// ---------- views ----------

function overview(view: View): string {
  const k = view.kpis
  const legend = (['blocked', 'waiting', 'idle', 'done', 'working'] as RowState[])
    .map((s) => `<span><span class="dot" style="--c:${STATE[s].color}"></span>${STATE[s].legend}</span>`)
    .join('')
  return `
    <div class="kpis">
      ${kpi('Waiting on you', k.fresh, 'var(--c-waiting)')}
      ${kpi('Working', k.working, 'var(--c-working)')}
      ${kpi('Idle', k.idle, 'var(--c-idle)')}
      ${kpi('Sessions', k.sessions, 'var(--c-done)')}
      ${kpi('Projects', k.projects, 'var(--c-done)')}
      ${kpi('Worktrees', k.worktrees, 'var(--muted)')}
    </div>
    <div class="chart" id="chart">
      <svg class="wires" id="wires"></svg>
      <div class="me" id="me"><span class="badge">YOU</span>
        <div><b>You · in command</b><small>${k.sessions} open session${k.sessions === 1 ? '' : 's'}</small></div></div>
      ${
        view.offices.length
          ? `<div class="offices">${view.offices.map(office).join('')}</div>`
          : `<div class="empty">No open sessions.</div>`
      }
      <div class="legend">${legend}</div>
    </div>
    ${list('What to do now', view.fresh.slice(0, 6), 'Nothing new. All seen or working.')}
    ${view.fresh.length > 6 ? `<button class="hint" data-tab="sessions">See all ${view.fresh.length} →</button>` : ''}
    <p class="hint">Click a session → jump to its terminal. Finished ones you open move to “already seen”.</p>`
}

function sessions(view: View): string {
  return `
    ${list('Waiting on you', view.fresh, 'Nothing new. All seen or working.')}
    ${list('Working now', view.working, 'No active agents.')}
    ${seenList(view)}`
}

function worktreeGroup(g: ProjectWorktrees): string {
  const color = g.waiting ? 'var(--c-waiting)' : g.working ? 'var(--c-working)' : 'var(--muted)'
  const parts = [
    `${g.worktrees.length} worktree${g.worktrees.length === 1 ? '' : 's'}`,
    g.waiting ? `${g.waiting} waiting` : '',
    g.working ? `${g.working} working` : ''
  ].filter(Boolean)
  return `<section class="wt-group${g.waiting ? ' hot' : ''}">
    <div class="office-head wt-head">
      <span class="office-icon" style="--c:${color}">${initial(g.project)}</span>
      <div class="trunc"><b class="trunc">${esc(g.project)}</b><small>${hostMark(g.host)}${parts.join(' · ')}</small></div>
    </div>
    ${g.worktrees.map(worktree).join('')}
  </section>`
}

function worktrees(s: Snapshot): string {
  const groups = groupWorktrees(s.worktrees)
  return `<h2><span>Worktrees by project</span><span>${s.worktrees.length}</span></h2>${groups.map(worktreeGroup).join('')}`
}

function prItem(w: PrRow, color: string, dim = false): string {
  const chips = [...prChips(w.pr), ...agentChips(w)]
  return `<button class="item${dim ? ' seen' : ''}" style="--c:${color}" data-ws="${placeId(w)}" title="${esc(w.pr.title)}">
    <div class="top"><span class="title trunc">${esc(w.pr.title)}</span><span class="ago">${ago(w.lastActivityAt)}</span></div>
    <div class="sub trunc">${esc(where({ host: w.host, project: w.project, workspace: w.name }))}</div>
    <div class="chips">${chips.join('')}</div>
  </button>`
}

function prList(title: string, items: PrRow[], color: string): string {
  if (!items.length) return ''
  return `<h2><span>${title}</span><span>${items.length}</span></h2>${items.map((w) => prItem(w, color)).join('')}`
}

function prs(view: View): string {
  const p = view.prs
  const finished = p.finished.length
    ? `<details><summary><h2><span>Merged or closed</span><span>${p.finished.length}</span></h2></summary>
      ${p.finished.map((w) => prItem(w, 'var(--line)', true)).join('')}</details>`
    : ''
  if (!p.active && !finished) return `<div class="empty">No pull requests in your worktrees.</div>`
  return `
    ${prList('Checks failing', p.failing, 'var(--c-blocked)')}
    ${prList('Checks running', p.pending, 'var(--c-waiting)')}
    ${prList('Ready for review', p.ready, 'var(--c-done)')}
    ${prList('Drafts', p.drafts, 'var(--muted)')}
    ${p.active ? '' : `<div class="empty">No open pull requests.</div>`}
    ${finished}
    <p class="hint">Click a PR → open its worktree.</p>`
}

const HOST_STATE: Record<HostStatus['state'], { color: string; note: string }> = {
  ok: { color: 'var(--c-done)', note: '' },
  connecting: { color: 'var(--c-waiting)', note: 'connecting…' },
  disconnected: { color: 'var(--c-idle)', note: 'SSH not connected' },
  unreachable: { color: 'var(--c-blocked)', note: 'did not answer' }
}

/** One chip per host, to narrow the panel to it; hidden while this computer is the only host. */
function hostBar(s: Snapshot): string {
  const chips = hostChips(s)
  if (!chips.length) return ''
  const chip = (id: string | null, label: string, color: string, count: string, title: string) =>
    `<button class="host${hostFilter === id ? ' on' : ''}" data-host="${esc(id ?? '')}" title="${esc(title)}" aria-pressed="${hostFilter === id}">
      <span class="dot" style="--c:${color}"></span><span class="trunc">${esc(label)}</span><span class="n">${count}</span></button>`
  const all = chip(null, 'All', 'var(--muted)', String(s.worktrees.length), 'Every host')
  return `<div class="hosts">${all}${chips
    .map((h) => {
      const st = HOST_STATE[h.state]
      const kind = h.kind === 'local' ? 'This computer' : h.kind === 'ssh' ? 'SSH machine' : 'Paired Orca server'
      const title = [kind, st.note, h.error ?? '', `${h.worktrees} worktrees · ${h.waiting} waiting · ${h.working} working`]
        .filter(Boolean)
        .join(' · ')
      return chip(h.id, h.label, h.waiting && h.state === 'ok' ? 'var(--c-waiting)' : st.color, h.state === 'ok' ? String(h.worktrees) : '!', title)
    })
    .join('')}</div>`
}

/** Hosts Pit Wall could not read: their sessions are missing from the panel, so say so. */
function hostAlerts(s: Snapshot): string {
  return s.hosts
    .filter((h) => h.state === 'unreachable')
    .map(
      (h) =>
        `<div class="alert" style="--c:var(--c-blocked)">No answer from “${esc(h.label)}”: its sessions are not shown.${h.error ? ` <span class="muted">${esc(h.error)}</span>` : ''}</div>`
    )
    .join('')
}

function header(): string {
  const live = liveText()
  return `<header>
    <div class="brand"><span class="logo">P</span>PIT WALL <span class="muted">FLEET</span></div>
    <div class="live${live.ok ? '' : ' off'}" id="live"><span class="dot"></span>${esc(live.text)}</div>
  </header>`
}

function tabs(view: View): string {
  const t = (id: Tab, label: string, n?: number) =>
    `<button role="tab" data-tab="${id}" aria-selected="${tab === id}">${label}${n !== undefined ? `<span class="n">${n}</span>` : ''}</button>`
  return `<nav role="tablist">${t('overview', 'Overview')}${t('sessions', 'Sessions', view.kpis.fresh)}${t('worktrees', 'Worktrees', view.kpis.worktrees)}${t('prs', 'PRs', view.prs.active)}</nav>`
}

function render(): void {
  rows = new Map()
  places = new Map()
  if (!snap) {
    app.innerHTML = error
      ? `${header()}<div class="alert" style="--c:var(--c-blocked)">Could not read Orca: ${esc(error)}</div>`
      : `${header()}<p class="muted">Loading…</p>`
    return
  }
  // A filter left on a host Orca no longer knows shows everything again.
  if (hostFilter && !snap.hosts.some((h) => h.id === hostFilter)) hostFilter = null
  const scoped = onHost(snap, hostFilter)
  const view = buildView(scoped, seen)
  const alerts = [
    hostAlerts(snap),
    error ? `<div class="alert" style="--c:var(--c-blocked)">${esc(error)}</div>` : '',
    snap.enrichmentError
      ? `<div class="alert" style="--c:var(--c-waiting)">No PRs or last messages: “orca worktree ps” failed.</div>`
      : ''
  ].join('')
  const body =
    tab === 'overview'
      ? overview(view)
      : tab === 'sessions'
        ? sessions(view)
        : tab === 'worktrees'
          ? worktrees(scoped)
          : prs(view)
  // Keep the reader where they were across the 5 s redraws.
  const y = window.scrollY
  const openDetails = !!app.querySelector('details[open]')
  app.innerHTML = header() + tabs(view) + hostBar(snap) + alerts + body
  if (openDetails) app.querySelector('details')?.setAttribute('open', '')
  window.scrollTo(0, y)
  drawWires()
}

/** Curved wires from you to each project, as on an org chart. */
function drawWires(): void {
  const chart = document.getElementById('chart')
  const svg = document.getElementById('wires')
  const me = document.getElementById('me')
  if (!chart || !svg || !me) return
  const box = chart.getBoundingClientRect()
  const m = me.getBoundingClientRect()
  const x0 = m.left + m.width / 2 - box.left
  const y0 = m.bottom - box.top
  const paths = Array.from(chart.querySelectorAll<HTMLElement>('[data-office]')).map((el) => {
    const r = el.getBoundingClientRect()
    const x1 = r.left + r.width / 2 - box.left
    const y1 = r.top - box.top
    const mid = (y0 + y1) / 2
    return `<path d="M${x0},${y0} C${x0},${mid} ${x1},${mid} ${x1},${y1}" />`
  })
  svg.setAttribute('viewBox', `0 0 ${box.width} ${box.height}`)
  svg.innerHTML = paths.join('')
}

// ---------- events ----------

app.addEventListener('click', (event) => {
  const target = (event.target as HTMLElement).closest<HTMLElement>('[data-row],[data-ws],[data-tab],[data-host]')
  if (!target) return
  if (target.dataset.tab) {
    tab = target.dataset.tab as Tab
    window.scrollTo(0, 0)
    render()
  } else if (target.dataset.row) {
    const row = rows.get(target.dataset.row)
    if (row) openRow(row)
  } else if (target.dataset.ws) {
    const place = places.get(target.dataset.ws)
    if (place) open(place.workspaceId, place.host)
  } else if (target.dataset.host !== undefined) {
    setHost(target.dataset.host || null)
  }
})

new ResizeObserver(() => drawWires()).observe(document.body)

/** "live · 13:58:02" while data is fresh; otherwise how old it is. */
function liveText(): { text: string; ok: boolean } {
  const stale = !lastOk || Date.now() - lastOk > 3 * REFRESH_MS
  if (error || stale) {
    return { text: lastOk ? `no data · last update ${short(lastOk, Date.now())} ago` : 'offline', ok: false }
  }
  return { text: `live · ${new Date().toLocaleTimeString('en-GB', { hour12: false })}`, ok: true }
}

setInterval(() => {
  const live = document.getElementById('live')
  if (!live) return
  const { text, ok } = liveText()
  live.classList.toggle('off', !ok)
  live.lastChild!.textContent = text
}, 1000)

setInterval(() => {
  if (document.visibilityState === 'visible') void refresh()
}, REFRESH_MS)

let debounce: ReturnType<typeof setTimeout> | undefined
orca.on('agent.status.changed', () => {
  clearTimeout(debounce)
  debounce = setTimeout(() => void refresh(), EVENT_DEBOUNCE_MS)
})
orca.on('theme', () => drawWires())
orca.storage.onDidChange(({ key }) => {
  if (key === SEEN_KEY || key === HOST_KEY) void loadSeen().then(render)
})

render()
void loadSeen().then(refresh)
