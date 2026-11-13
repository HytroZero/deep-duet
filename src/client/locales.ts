export const NS = 'deepduet' as const

export const zh = {
  // Sidebar badges & context menu
  'status.running': '运行中',
  'status.needsDecision': '待决策',
  'status.failed': '失败',
  'status.idle': '空闲',
  'status.completed': '已完成',
  'menu.openPanel': '打开 DeepDuet 编排面板',
  'menu.openMaster': '回到主控会话 (Master)',
  'menu.stopWorker': '停止当前轮次 (Stop)',
  'menu.archiveWorker': '归档此 Worker',
  'menu.removeWorktree': '清理 Worktree',

  // Header actions
  'header.workersCount': 'Workers: {count}',
  'header.runningCount': '{count} 运行',
  'header.decisionNeeded': '{count} 项待决策',
  'header.openOrchestrator': 'DeepDuet 面板',
  'header.workerTag': 'Worker',
  'header.backToMaster': '返回 Master',

  // Input dock
  'dock.decisionBadge': '需要决策 · {title}',
  'dock.replyPlaceholder': '输入你的决策或后续指令，直接发送给该 Worker...',
  'dock.replySubmit': '回复并继续',
  'dock.replySending': '发送中...',
  'dock.openWorker': '打开会话',
  'dock.workerBanner': '当前正在直接接管后台 Worker：{title}',
  'dock.workerWorktree': '分支：{branch}',
  'dock.stopTurn': '停止运行',

  // Right sidebar tab
  'tab.title': 'DeepDuet',
  'tab.guideTitle': 'DeepDuet 多会话协作',
  'tab.guideDesc': '查看 Master 派发的后台 Worker，处理阻塞决策、查看 Git 变更并随时接管或派生新 Worker。',
  'panel.header': 'DeepDuet 编排',
  'panel.newWorker': '新建 Worker',
  'panel.refresh': '刷新',
  'panel.filterAll': '当前会话',
  'panel.filterGlobal': '全部工程',
  'panel.emptyTitle': '当前暂无关联的 Worker',
  'panel.emptyHint': '可在 Master 对话中下达复杂并行任务，或点击右上角“新建 Worker”直接派发。',
  'panel.noActiveSession': '请先选择或新建一个会话，然后再派生 Worker。',

  // Spawn form
  'spawn.heading': '派生新后台 Worker',
  'spawn.titleLabel': '任务标题',
  'spawn.titlePlaceholder': '例如：实现用户认证接口与单测',
  'spawn.promptLabel': '目标与验收要求',
  'spawn.promptPlaceholder': '清晰描述任务范围、修改约束及如何验证完成...',
  'spawn.worktreeLabel': '使用独立 Git Worktree 隔离工作区',
  'spawn.submit': '派发 Worker',
  'spawn.submitting': '正在派发...',
  'spawn.cancel': '取消',

  // Inspector
  'inspect.title': 'Worker 详情',
  'inspect.inspectBtn': '检查状态',
  'inspect.openChat': '打开对话',
  'inspect.openMaster': '回到 Master',
  'inspect.stop': '停止',
  'inspect.archive': '归档',
  'inspect.removeWorktree': '移除 Worktree',
  'inspect.cwd': '工作目录',
  'inspect.worktree': 'Worktree 分支',
  'inspect.summary': '最新摘要',
  'inspect.decision': '阻塞问题',
  'inspect.gitStatus': 'Git 状态',
  'inspect.gitClean': '工作区干净 (clean)',
  'inspect.gitUnavailable': '当前目录非 Git 仓库或不可用',
  'inspect.messages': '最近消息',
  'inspect.noMessages': '暂无消息记录',
  'inspect.steerLabel': '发送指令 / 决策回复',
  'inspect.steerPlaceholder': '输入指令发送给空闲的 Worker...',
  'inspect.steerBusyHint': 'Worker 正在运行中，等待空闲或先停止后再发送指令。',
  'inspect.send': '发送指令',
  'inspect.confirmArchive': '确认归档',

  // Tool call views
  'tool.spawn.title': '派生 Worker',
  'tool.steer.title': '引导 Worker',
  'tool.inspect.title': '检查 Worker',
  'tool.manage.title': '管理 Worker',
  'tool.openWorker': '打开 Worker 会话',
  'tool.isolated': '隔离 Worktree',
  'tool.running': '执行中...',
  'tool.action': '操作：{action}',
} as const

export type DeepDuetLocaleKey = keyof typeof zh

export const en: Record<DeepDuetLocaleKey, string> = {
  // Sidebar badges & context menu
  'status.running': 'Running',
  'status.needsDecision': 'Needs decision',
  'status.failed': 'Failed',
  'status.idle': 'Idle',
  'status.completed': 'Done',
  'menu.openPanel': 'Open DeepDuet panel',
  'menu.openMaster': 'Go to Master session',
  'menu.stopWorker': 'Stop current turn',
  'menu.archiveWorker': 'Archive worker',
  'menu.removeWorktree': 'Remove worktree',

  // Header actions
  'header.workersCount': 'Workers: {count}',
  'header.runningCount': '{count} running',
  'header.decisionNeeded': '{count} decision needed',
  'header.openOrchestrator': 'DeepDuet',
  'header.workerTag': 'Worker',
  'header.backToMaster': 'Back to Master',

  // Input dock
  'dock.decisionBadge': 'Decision needed · {title}',
  'dock.replyPlaceholder': 'Reply to unblock or steer this worker...',
  'dock.replySubmit': 'Send Decision',
  'dock.replySending': 'Sending...',
  'dock.openWorker': 'Open Session',
  'dock.workerBanner': 'Taking over background Worker: {title}',
  'dock.workerWorktree': 'Branch: {branch}',
  'dock.stopTurn': 'Stop Turn',

  // Right sidebar tab
  'tab.title': 'DeepDuet',
  'tab.guideTitle': 'DeepDuet Multi-Session',
  'tab.guideDesc': 'Monitor background workers, unblock pending decisions, inspect git state, and spawn or steer tasks.',
  'panel.header': 'DeepDuet Orchestrator',
  'panel.newWorker': 'New Worker',
  'panel.refresh': 'Refresh',
  'panel.filterAll': 'This Session',
  'panel.filterGlobal': 'All Project',
  'panel.emptyTitle': 'No DeepDuet workers yet',
  'panel.emptyHint': 'Delegate parallel tasks from a Master session or click "New Worker" above.',
  'panel.noActiveSession': 'Open or create a session first before spawning a worker.',

  // Spawn form
  'spawn.heading': 'Spawn Background Worker',
  'spawn.titleLabel': 'Task Title',
  'spawn.titlePlaceholder': 'e.g. Implement auth API and unit tests',
  'spawn.promptLabel': 'Goal & Verification',
  'spawn.promptPlaceholder': 'Describe scope, constraints, and how to verify completion...',
  'spawn.worktreeLabel': 'Isolate in a dedicated Git worktree',
  'spawn.submit': 'Spawn Worker',
  'spawn.submitting': 'Spawning...',
  'spawn.cancel': 'Cancel',

  // Inspector
  'inspect.title': 'Worker Details',
  'inspect.inspectBtn': 'Inspect',
  'inspect.openChat': 'Open Chat',
  'inspect.openMaster': 'Open Master',
  'inspect.stop': 'Stop',
  'inspect.archive': 'Archive',
  'inspect.removeWorktree': 'Remove Worktree',
  'inspect.cwd': 'Working Dir',
  'inspect.worktree': 'Worktree Branch',
  'inspect.summary': 'Last Summary',
  'inspect.decision': 'Decision Question',
  'inspect.gitStatus': 'Git Status',
  'inspect.gitClean': 'Working tree clean',
  'inspect.gitUnavailable': 'Git status unavailable for this directory',
  'inspect.messages': 'Recent Messages',
  'inspect.noMessages': 'No messages recorded yet',
  'inspect.steerLabel': 'Steer / Answer Decision',
  'inspect.steerPlaceholder': 'Send follow-up instruction to this idle worker...',
  'inspect.steerBusyHint': 'Worker is running. Wait until idle or stop the turn before steering.',
  'inspect.send': 'Send',
  'inspect.confirmArchive': 'Confirm Archive',

  // Tool call views
  'tool.spawn.title': 'Spawn Worker',
  'tool.steer.title': 'Steer Worker',
  'tool.inspect.title': 'Inspect Worker',
  'tool.manage.title': 'Manage Worker',
  'tool.openWorker': 'Open Worker Session',
  'tool.isolated': 'Isolated Worktree',
  'tool.running': 'Running...',
  'tool.action': 'Action: {action}',
}

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    deepduet: DeepDuetLocaleKey
  }
}
