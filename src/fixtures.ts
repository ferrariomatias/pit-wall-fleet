// A snapshot to render in tests and `orca plugin check` scenarios.
import type { HostRef, Snapshot } from './protocol'

const local: HostRef = { id: 'local', kind: 'local', label: 'This computer' }

export function sampleSnapshot(now: number): Snapshot {
  return {
    generatedAt: now,
    enrichmentError: null,
    hosts: [{ ...local, state: 'ok', error: null, worktrees: 3, waiting: 2, working: 1 }],
    waiting: [
      {
        key: 'a1',
        state: 'blocked',
        since: now - 3 * 60_000,
        host: local,
        project: 'api',
        workspace: 'feature/order-platform',
        workspaceId: 'w2',
        title: 'Registrar plataforma del pedido',
        lastMessage: '¿Puedo ejecutar las migraciones contra la base de datos local?',
        activity: null,
        terminalId: 'term_a1'
      },
      {
        key: 'a2',
        state: 'done',
        since: now - 40_000,
        host: local,
        project: 'storefront',
        workspace: 'menu-top-category',
        workspaceId: 'w1',
        title: 'Categoría TOP en pedidos iOS/Android',
        lastMessage: 'He abierto el PR #143 en borrador; los 6 checks pasan.',
        activity: null,
        terminalId: 'term_a2'
      }
    ],
    working: [
      {
        key: 'a3',
        state: 'working',
        since: now - 12 * 60_000,
        host: local,
        project: 'web',
        workspace: 'feat/app-banner',
        workspaceId: 'w3',
        title: 'Banner de la app nativa',
        lastMessage: null,
        activity: 'Bash · pnpm test --filter web',
        terminalId: 'term_a3'
      }
    ],
    worktrees: [
      {
        key: 'w1',
        workspaceId: 'w1',
        host: local,
        project: 'storefront',
        name: 'menu-top-category',
        branch: 'feature/menu-top-category',
        kind: 'worktree',
        pr: { number: 143, state: 'draft', title: 'feat: top category', checks: 'success', passed: 6, total: 6 },
        lastActivityAt: now - 40_000,
        agentsWaiting: 1,
        agentsWorking: 0
      },
      {
        key: 'w2',
        workspaceId: 'w2',
        host: local,
        project: 'api',
        name: 'feature/order-platform',
        branch: 'feature/order-platform',
        kind: 'worktree',
        pr: { number: 5485, state: 'open', title: 'feat(bills)', checks: 'failure', passed: 11, total: 13 },
        lastActivityAt: now - 3 * 60_000,
        agentsWaiting: 1,
        agentsWorking: 0
      },
      {
        key: 'w4',
        workspaceId: 'w4',
        host: local,
        project: 'notes',
        name: 'drafts',
        branch: null,
        kind: 'folder',
        pr: null,
        lastActivityAt: now - 2 * 86_400_000,
        agentsWaiting: 0,
        agentsWorking: 0
      }
    ]
  }
}
