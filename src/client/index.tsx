import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-api-gateway/client'
import type {} from '@deepseek-ai/dsh-api-session-controller/client'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type { MenuAction } from '@deepseek-ai/dsh-client-ui-context-menu/client'
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type {} from '@deepseek-ai/dsh-client-ui-session/client'
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
import type {} from '@deepseek-ai/dsh-client-ui-sidebar-right/client'
import type { PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type {} from '@deepseek-ai/dsh-client-ui-tool/client'
import type {} from '@deepseek-ai/dsh-client-ui-workspace/client'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import { DeepDuetSettingsSection } from './DeepDuetSettingsSection'
import { DeepDuetSidebarTab, DeepDuetSidebarTabTitle } from './DeepDuetSidebarTab'
import {
  DeepDuetHeaderActions,
  DeepDuetInputDock,
  DeepDuetToolView,
  DeepDuetWorkerHover,
  DeepDuetWorkerLeading,
  DeepDuetWorkerTrailing,
} from './DeepDuetSurface'
import { NS, en, zh } from './locales'
import { createDeepDuetStore } from './store'

export { createDeepDuetStore, useDeepDuetSelector } from './store'
export type { DeepDuetClientStore, DeepDuetStoreState } from './store'

declare module '@deepseek-ai/dsh-client-ui-sidebar-right/client' {
  interface SidebarRightTabParamsMap {
    deepduet: undefined
  }
}

export const inject = [
  'remote',
  'locale',
  'slots',
  'uiWorkspace',
  'sidebarRight',
  'sidebarRightTabs',
] as const

const TAB_ID = 'dsh-plugin-deepduet'
const DEEPDUET_TOOLS = ['session_spawn', 'session_steer', 'session_inspect', 'session_manage'] as const

export function apply(ctx: Context): void {
  const store = createDeepDuetStore(ctx)
  ctx.effect(() => store.start(), 'deepduet: remote watch store')

  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'deepduet: locales')
  const t = ctx.locale.bind(NS)

  const openSession = (sessionId: string) => {
    ctx.uiWorkspace.openSession(sessionId as SessionId)
  }

  const openOrchestrator = (taskSessionId?: string) => {
    if (taskSessionId) store.selectTask(taskSessionId)
    void ctx.sidebarRight.openTab('deepduet')
  }

  const surfaceProps = { store, t, openSession, openOrchestrator }
  const sidebarProps = { store, t, openSession }
  const injectSurface = () => ({
    hooks: { deepduet: store.snapshot },
    ...surfaceProps,
  })
  const injectSidebar = () => ({
    hooks: { deepduet: store.snapshot },
    ...sidebarProps,
  })

  const registerSlot = <K extends keyof import('@deepseek-ai/dsh-client-ui-slots').SlotMap & string>(
    spec: Record<string, unknown> & { name: K },
    component: (props: any) => any,
    label: string,
  ) => {
    const slots = ctx.slots as unknown as {
      inject?: (name: K, cb: () => () => void) => () => void
      register: (spec: Record<string, unknown>, component: (props: any) => any) => () => void
    }
    ctx.effect(
      () => (typeof slots.inject === 'function'
        ? slots.inject(spec.name, () => slots.register(spec, component))
        : slots.register(spec, component)),
      label,
    )
  }

  ctx.effect(() => ctx.sidebarRightTabs.register({
    id: TAB_ID,
    kind: 'deepduet',
    title: () => t('tab.title'),
    guide: [{
      id: 'deepduet',
      order: 20,
      title: () => t('tab.guideTitle'),
      description: () => t('tab.guideDesc'),
    }],
  }), 'deepduet: sidebar-right tab type')

  registerSlot(
    { name: 'sidebar.right.pane.tab', key: TAB_ID, locale: NS, inject: injectSidebar },
    (props: PropsRuntime<'sidebar.right.pane.tab'>) => <DeepDuetSidebarTab {...sidebarProps} {...props} />,
    'deepduet: sidebar-right tab body',
  )
  registerSlot(
    { name: 'sidebar.right.pane.tab.title', key: TAB_ID, locale: NS, inject: injectSidebar },
    (props: PropsRuntime<'sidebar.right.pane.tab.title'>) => <DeepDuetSidebarTabTitle {...sidebarProps} {...props} />,
    'deepduet: sidebar-right tab title',
  )

  registerSlot(
    { name: 'sidebar.session.row.leading', id: 'deepduet-row-leading', locale: NS, inject: injectSurface },
    (props: PropsRuntime<'sidebar.session.row.leading'>) => <DeepDuetWorkerLeading {...surfaceProps} {...props} />,
    'deepduet: sidebar row leading',
  )
  registerSlot(
    { name: 'sidebar.session.row.trailing', id: 'deepduet-row-trailing', locale: NS, inject: injectSurface },
    (props: PropsRuntime<'sidebar.session.row.trailing'>) => <DeepDuetWorkerTrailing {...surfaceProps} {...props} />,
    'deepduet: sidebar row trailing',
  )
  registerSlot(
    { name: 'sidebar.session.row.hover', id: 'deepduet-row-hover', locale: NS, inject: injectSurface },
    (props: PropsRuntime<'sidebar.session.row.hover'>) => <DeepDuetWorkerHover {...surfaceProps} {...props} />,
    'deepduet: sidebar row hover',
  )

  registerSlot(
    { name: 'conversation.session.header.actions', id: 'deepduet-header-actions', locale: NS, inject: injectSurface },
    (props: PropsRuntime<'conversation.session.header.actions'>) => <DeepDuetHeaderActions {...surfaceProps} {...props} />,
    'deepduet: header actions',
  )
  registerSlot(
    { name: 'conversation.input.dock', id: 'deepduet-input-dock', locale: NS, inject: injectSurface },
    (props: PropsRuntime<'conversation.input.dock'>) => <DeepDuetInputDock {...surfaceProps} {...props} />,
    'deepduet: input dock',
  )

  registerSlot(
    {
      name: 'settings.section',
      id: 'deepduet',
      order: 24,
      label: () => t('settings.nav'),
      locale: NS,
      inject: injectSurface,
    },
    (props: PropsRuntime<'settings.section'>) => <DeepDuetSettingsSection {...surfaceProps} {...props} />,
    'deepduet: settings section',
  )

  for (const toolKey of DEEPDUET_TOOLS) {
    registerSlot(
      { name: 'tool.call.toolview', key: toolKey, locale: NS, inject: injectSurface },
      (props: PropsRuntime<'tool.call.toolview', typeof toolKey>) => <DeepDuetToolView {...surfaceProps} {...props} />,
      `deepduet: toolview ${toolKey}`,
    )
  }

  ctx.inject(['contextMenus'], (menuCtx) => {
    menuCtx.effect(() => menuCtx.contextMenus.register({
      id: 'deepduet-session-actions',
      target: 'session',
      order: 45,
      observe: () => [store.snapshot],
      resolve: ({ sessionId }) => {
        const snapshot = store.snapshot.getSnapshot()
        const task = snapshot.bySessionId[sessionId]
        const workers = snapshot.byMasterId[sessionId] ?? []
        if (!task && workers.length === 0) return []
        if (!task) {
          return [{
            id: 'deepduet-open-panel',
            label: t('menu.openPanel'),
            run: () => openOrchestrator(workers[0]?.sessionId),
          }]
        }
        const actions: MenuAction[] = [
          {
            id: 'deepduet-open-panel',
            label: t('menu.openPanel'),
            run: () => openOrchestrator(task.sessionId),
          },
          {
            id: 'deepduet-open-master',
            label: t('menu.openMaster'),
            run: () => openSession(task.masterId),
          },
        ]
        if (task.status === 'running') {
          actions.push({
            id: 'deepduet-stop',
            label: t('menu.stopWorker'),
            run: async () => {
              await store.manage({ masterId: task.masterId, sessionId: task.sessionId, action: 'stop' })
            },
          })
        } else {
          if (task.worktree) {
            actions.push({
              id: 'deepduet-remove-worktree',
              label: t('menu.removeWorktree'),
              run: async () => {
                await store.manage({ masterId: task.masterId, sessionId: task.sessionId, action: 'remove_worktree' })
              },
            })
          }
          actions.push({
            id: 'deepduet-archive',
            label: t('menu.archiveWorker'),
            danger: true,
            separatorBefore: true,
            run: async () => {
              await store.manage({ masterId: task.masterId, sessionId: task.sessionId, action: 'archive' })
            },
          })
        }
        return actions
      },
    }), 'deepduet: session context menu')
  })
}
