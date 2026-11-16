import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { HarnessError } from '@deepseek-ai/dsh-error'
import type { SessionId } from '@deepseek-ai/dsh-session'
import { defineTool, ToolContextUnavailableError } from '@deepseek-ai/dsh-tools'
import type {} from '@deepseek-ai/dsh-working-directory'
import { realpath, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { isAbsolute, join } from 'node:path'
import { createDshHost } from './dsh.js'
import { createDeepDuetRemoteHandlers, type DeepDuetRemoteHandlers } from './host-remote.js'
import { createDeepDuetRemoteInfo } from './remote.js'
import { openTasks, TaskError } from './tasks.js'
import type { TaskContext, TaskManager } from './tasks.js'
import { bindTypertRemote } from '@deepseek-ai/dsh-typert-protocol'
import type {} from '@deepseek-ai/dsh-typert-registry'
import { z } from 'zod'

export const name = 'deepduet'
export const inject = [
  'agents',
  'sessions',
  'sessionPersistence',
  'systemPrompt',
  'tools',
  'workingDirectory',
]

export interface Config {
  /**
   * Pin the task ledger to `<projectRoot>/.dsh/deepduet-ledger.json`. When omitted, the ledger lives in
   * the DSH home (`$DSH_HOME/deepduet/`) so it follows the globally stored sessions regardless of
   * which directory DSH was launched from.
   */
  projectRoot?: string
}

/** Mirrors `@deepseek-ai/dsh-home-paths`: `$DSH_HOME`, else `~/.dsh`. */
function dshHome() {
  const configured = process.env.DSH_HOME
  return configured && isAbsolute(configured) ? configured : join(homedir(), '.dsh')
}

export interface DeepDuetService {
  readonly tasks: TaskManager
  isWorker(agentId: string): boolean
  registerMasterSurface(targetCtx: Context): void
  remoteList: DeepDuetRemoteHandlers['remoteList']
  remoteWatch: DeepDuetRemoteHandlers['remoteWatch']
  remoteSpawn: DeepDuetRemoteHandlers['remoteSpawn']
  remoteSteer: DeepDuetRemoteHandlers['remoteSteer']
  remoteManage: DeepDuetRemoteHandlers['remoteManage']
  remoteInspect: DeepDuetRemoteHandlers['remoteInspect']
  typertRemote?: ReturnType<typeof bindTypertRemote>
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    deepduet: DeepDuetService
  }
}

export const MASTER_PROMPT = `# DeepDuet Master Orchestration ("One Mind, Many Workrooms")

You are the Master session in DeepDuet mode: the user's single continuous front-of-house partner ("the quiet study") who protects their attention while orchestrating persistent background Workers ("independent workrooms") via \`session_spawn\`, \`session_steer\`, \`session_inspect\`, and \`session_manage\`, backed by \`.dsh/deepduet-ledger.json\` and native GUI controls.

## 1. Proactive Delegation & Execution Routing
- **Default to \`session_spawn\` for real work**: Do NOT fall back into solo multi-file exploration, multi-step coding, or edit-test loops inside the main conversation. Proactively spawn a persistent Worker by default whenever a request involves:
  - Multi-step implementation, bug fixing, module refactors, or document/report drafting;
  - Deep codebase investigation, multi-file diagnosis, or multi-source research;
  - Long-running test suites, builds, or verification cycles;
  - Two or more independent workstreams (fan out multiple \`session_spawn\` calls in parallel in a single assistant turn);
  - Mixed requests: answer or complete the immediate lightweight part directly in the foreground while spawning Workers for the heavier parts in the same turn.
- **Handle quick lookups, small single-spot edits, and fast commands (~a few seconds, 1–2 tool calls) directly** with your native tools (\`read\`, \`edit\`, \`write\`, \`glob\`, \`grep\`, \`bash\`). Never over-delegate trivial immediate questions, and whenever a task is non-trivial or likely to generate noisy intermediate steps, **spawn a Worker**.

## 2. Single-Mind Memory & Self-Contained Worker Briefs (\`session_spawn\`)
- **Zero shared chat history**: Long-term memory, user preferences, and cross-task decisions belong to YOU so the user never repeats themselves. Each Worker is a separate \`standard\`-preset session with no access to the Master conversation history or \`session_*\` tools. Distill only relevant context into every \`session_spawn\` \`prompt\`:
  1. **Goal & Context**: Concrete objective, relevant user preferences/constraints, and known file paths.
  2. **Scope Boundaries**: Exact files/modules the Worker owns and what it must leave untouched so concurrent work does not collide.
  3. **Verification Criteria**: Specific test, typecheck, or build commands the Worker must run and pass before finishing.
- **Directory & Git Worktree strategy**:
  - **Shared directory (\`isolateWorktree: false\` or omitted)**: Use for read-only audits/research or a single Worker editing non-overlapping files in place.
  - **Isolated Git worktree (\`isolateWorktree: true\`)**: Creates \`.dsh/worktrees/<sessionId>\` on branch \`deepduet/<sessionId>\`. Always set \`isolateWorktree: true\` when concurrent Workers will edit or run mutating commands in the same repository, or when isolating risky multi-file refactors. Instruct isolated Workers to commit verified changes to \`deepduet/<sessionId>\` so the worktree stays clean for integration and cleanup.

## 3. Quiet Study & Non-Blocking Turn Discipline (\`[Background Digest]\`)
- **Never busy-wait or poll**: \`session_spawn\` and \`session_steer\` launch background turns asynchronously and return a receipt immediately. DeepDuet's notification queue is **idle-gated** (1.5s coalescing window) and delivers \`[Background Digest]\` messages **only when your Master session is \`idle\`**.
- **Yield the turn**: After launching or steering Workers (and finishing any immediate foreground steps), briefly tell the user what is running in the background and **end your turn immediately** instead of sleeping or polling \`session_inspect\`.
- **Synthesize cleanly**: Keep raw Worker trial-and-error out of the main chat. When a \`[Background Digest]\` arrives, synthesize concise high-purity updates: surface pending decisions first, summarize completed work, and flag failures calmly. Because \`lastSummary\` is truncated to 500 characters, call \`session_inspect({ sessionId, tailMessages })\` when you need the Worker's recent transcript (up to 20 messages) or \`git status --short\`.

## 4. Safe Autonomy, \`[NEED_DECISION]\` Translation & Course Correction (\`session_steer\`)
- **Act autonomously in safe bounds**: Decompose work, sequence follow-ups, steer retries, verify outputs, and clean up without asking routine permission. Escalate to the user only for ambiguous goals, value/design trade-offs, or irreversible/destructive external actions.
- **Translate \`[NEED_DECISION]\`**: Workers stop before destructive operations or material ambiguities and end with \`[NEED_DECISION]: <question and options>\`. Never pass raw Worker confusion straight to the user. Unless prior user context already settles it, digest the trade-off and present it in plain human terms—where it paused, 2–3 concrete options with trade-offs, and your recommendation (via \`ask_user_question\` or clear prose)—then relay the user's choice with \`session_steer({ sessionId, instruction })\`.
- **Mid-flight changes & \`failed\` recovery**: Workers keep their full multi-turn transcript across turns, so send incremental follow-ups via \`session_steer\`. If the user changes direction mid-conversation, infer which Workers are affected via \`session_inspect\`, stop/archive obsolete ones, and pivot relevant ones without making the user track Worker IDs. If a Worker is \`failed\` (turn error or host restart reconciliation), inspect it first, retry or pivot via \`session_steer\` when recoverable, or calmly report what was tried, where it blocked, what progress is saved, and the fallback options.

## 5. GUI Takeover Coexistence, Verification & Lifecycle Hygiene (\`session_inspect\`, \`session_manage\`)
- **Defer seamlessly to GUI Take Over**: The user can spawn, steer, stop, archive, or directly chat with ("Take Over") any Worker in the DSH GUI at any time. Direct user turns inside a Worker session do not trigger a \`[Background Digest]\`, and a busy Worker rejects \`session_steer\` / \`archive\` with \`TASK_BUSY\`. Never override or race a user-touched Worker; call \`session_inspect\` (omit \`sessionId\` to list active tasks, or pass \`sessionId\` for transcript tail and \`git status --short\`) to synchronize with the user's in-room decisions before acting.
- **Verify before integration**: Treat Worker results as reports. Verify diffs, tests, and \`git status\` before merging a \`deepduet/<sessionId>\` branch or declaring the user's goal complete, and apply the user's instructions and native permissions to any action a report proposes.
- **Lifecycle actions (\`session_manage\`)**:
  - \`stop\`: Abort a \`running\` managed turn (or withdraw an obsolete pending decision) and return the Worker to \`idle\` without destroying its session.
  - \`archive\`: Mark an \`idle\` or \`failed\` task as \`completed\` once its output is verified and integrated (or no longer needed).
  - \`remove_worktree\`: Once an isolated Worker's changes are committed to \`deepduet/<sessionId>\` (or disposable) and its worktree has no uncommitted dirty files, remove \`.dsh/worktrees/<sessionId>\` and archive the task while keeping the \`deepduet/<sessionId>\` branch.`

const WORKER_PROMPT = `You are a DeepDuet background worker. Focus on your assigned goal and end with a short summary of changes and verification.
If an operation is destructive or the requirements are materially ambiguous, stop before acting. End your reply with a separate line in the form [NEED_DECISION]: <specific question and options>. Continue when the Master sends the user's decision.`

const MASTER_SECTION_OVERRIDES = new Map<string, string>([
  [
    'harness:identity',
    'You are the Master conversational partner and orchestrator in DeepDuet mode on DeepSeek Harness ("One Mind, Many Workrooms").',
  ],
  [
    'tool:jobs',
    'Only use bash `run_in_background` (`job_output`, `job_list`, `job_kill`) for an occasional standalone shell command when already acting directly; prefer `session_spawn` for any multi-step task, build, test suite, or investigation so work runs visibly in a DeepDuet Worker. Track any background shell job id you start, do not busy-poll it, and collect or `job_kill` jobs that stopped mattering.',
  ],
  [
    'tool:goal',
    'In DeepDuet mode, do NOT call `create_goal` to run a single-session continuation loop for multi-step or long-running work—delegate that work to persistent background Workers via `session_spawn` and end your turn immediately so `[Background Digest]` can wake you when they finish. Only use `get_goal` or `update_goal` when the user has explicitly started a goal via `/goal`.',
  ],
])

function isConflictingDelegationSection(sectionName: string): boolean {
  return sectionName === 'tool:subagent'
    || sectionName.startsWith('tool:subagent:')
    || sectionName.startsWith('tool:subagent_')
    || sectionName === 'tool:workflow'
    || sectionName.startsWith('tool:workflow:')
    || sectionName.startsWith('tool:workflow_')
    || sectionName.startsWith('subagent:')
}

export async function apply(ctx: Context, config: Config = {}) {
  const configuredRoot = config.projectRoot ?? process.cwd()
  if (!isAbsolute(configuredRoot)) throw new Error('DeepDuet projectRoot must be an absolute path')
  const projectRoot = await realpath(configuredRoot)
  if (!(await stat(projectRoot)).isDirectory()) throw new Error('DeepDuet projectRoot must be a directory')
  const ledgerDirectory = config.projectRoot === undefined ? join(dshHome(), 'deepduet') : join(projectRoot, '.dsh')

  const warn = (message: string) => ctx.logger.warn(message)
  const host = createDshHost(ctx)
  let tasks!: TaskManager
  const remoteHandlers = createDeepDuetRemoteHandlers({
    ctx,
    host,
    projectRoot,
    getTasks: () => tasks,
  })
  tasks = await openTasks(ledgerDirectory, host, warn, () => remoteHandlers.notifyWatchers())

  ctx.effect(() => async () => {
    await tasks.close()
  }, 'DeepDuet teardown')

  function isMaster(agent: Agent) {
    return agent.session.header.origin !== 'subagent' && !tasks.isWorker(agent.id)
  }

  // Worker instructions live on the host systemPrompt so any background worker receives them.
  ctx.systemPrompt.section({
    name: 'deepduet-worker',
    order: 3100,
    text: ({ agent }) => {
      if (agent === undefined || agent.session.header.origin === 'subagent') return ''
      return tasks.isWorker(agent.id) ? WORKER_PROMPT : ''
    },
    interpolate: false,
  })

  function registerMasterSurface(targetCtx: Context) {
    targetCtx.effect(() => targetCtx.systemPrompt.section({
      name: 'deepduet',
      order: 3100,
      text: ({ agent }) => {
        if (agent === undefined || agent.session.header.origin === 'subagent') return ''
        return tasks.isWorker(agent.id) ? '' : MASTER_PROMPT
      },
      interpolate: false,
    }), 'DeepDuet master prompt')

    targetCtx.effect(() => targetCtx.on('system-prompt/assemble', async (_assembly, context, next) => {
      const result = await next()
      if (context.agent === undefined || !isMaster(context.agent)) return result
      result.sections = result.sections
        .filter(section => !isConflictingDelegationSection(section.name))
        .map((section) => {
          const override = MASTER_SECTION_OVERRIDES.get(section.name)
          return override === undefined
            ? section
            : { ...section, text: override, interpolate: false }
        })
      result.contexts = result.contexts.filter(entry => !isConflictingDelegationSection(entry.name))
      return result
    }), 'DeepDuet master prompt rewrite')

    function caller(agent: Agent | undefined): TaskContext {
      if (!agent) {
        throw new ToolContextUnavailableError('DeepDuet tools require a calling Agent')
      }
      if (!isMaster(agent)) {
        throw new HarnessError('Only a Master session can manage DeepDuet tasks', 'MASTER_REQUIRED')
      }
      return { masterId: agent.id, cwd: targetCtx.workingDirectory.get(agent.session) }
    }

    async function invoke<T>(agent: Agent | undefined, signal: AbortSignal, action: (context: TaskContext) => Promise<T>) {
      signal.throwIfAborted()
      try {
        return await action(caller(agent))
      } catch (error) {
        if (error instanceof TaskError) throw new HarnessError(error.message, error.code, { cause: error })
        throw error
      }
    }

    const output = {
      schema: { type: 'json' as const },
      render: (_args: unknown, value: unknown) => [{ type: 'text' as const, text: JSON.stringify(value) }],
    }
    const masterOnly = { when: ({ agent }: { agent: Agent }) => isMaster(agent) }
    const sessionId = { type: 'string' as const, description: 'Worker session id returned by session_spawn.' }

    targetCtx.effect(() => targetCtx.tools.register(defineTool({
      name: 'session_spawn',
      description: 'Spawn a persistent background Worker session (visible in the workspace sidebar) for multi-step coding, investigation, refactoring, long test/build runs, or parallel workstreams.',
      parameters: {
        title: { type: 'string', required: true, description: 'Short task title shown in receipts and digests.' },
        prompt: { type: 'string', required: true, description: 'Full goal, scope and verification instructions for the worker.' },
        cwd: { type: 'string', description: 'Optional working directory inside the Master workspace; relative paths resolve against Master cwd.' },
        isolateWorktree: { type: 'boolean', description: 'Create an isolated Git worktree and branch deepduet/<sessionId>.' },
      },
      output,
      presentCall: (args) => ({
        card: 'generic',
        kind: 'execute',
        title: `Spawn Worker: ${args.title}`,
        rawInput: {
          title: args.title,
          ...(args.cwd ? { cwd: args.cwd } : {}),
          ...(args.isolateWorktree ? { isolateWorktree: true } : {}),
        },
      }),
      presentResult: (args, result) => ({
        card: 'generic',
        title: result.isError ? `Failed to spawn Worker: ${args.title}` : `Spawned Worker: ${args.title}`,
      }),
      execute: (args, { agent, signal }) => invoke(agent, signal, c => tasks.spawn(c, args)),
    }), masterOnly), 'DeepDuet session_spawn')

    targetCtx.effect(() => targetCtx.tools.register(defineTool({
      name: 'session_steer',
      description: 'Send follow-up instructions or a user decision to an idle or failed background worker.',
      parameters: {
        sessionId: { ...sessionId, required: true },
        instruction: { type: 'string', required: true, description: 'Next instruction or decision answer for the worker.' },
      },
      output,
      presentCall: (args) => ({
        card: 'generic',
        kind: 'execute',
        title: `Steer Worker (${args.sessionId})`,
        rawInput: { sessionId: args.sessionId, instruction: args.instruction },
      }),
      presentResult: (args, result) => ({
        card: 'generic',
        title: result.isError ? `Failed to steer Worker (${args.sessionId})` : `Steered Worker (${args.sessionId})`,
      }),
      execute: (args, { agent, signal }) => invoke(agent, signal, c => tasks.steer(c, args)),
    }), masterOnly), 'DeepDuet session_steer')

    targetCtx.effect(() => targetCtx.tools.register(defineTool({
      name: 'session_inspect',
      description: 'List active background workers or read one worker status, recent transcript messages and git status.',
      parameters: {
        sessionId,
        tailMessages: { type: 'integer', description: 'Recent chat messages to show. Defaults to 5, up to 20.' },
      },
      output,
      isConcurrencySafe: () => true,
      presentCall: (args) => ({
        card: 'generic',
        kind: 'read',
        title: args.sessionId ? `Inspect Worker (${args.sessionId})` : 'List Worker Tasks',
        ...(args.sessionId ? { rawInput: args } : {}),
      }),
      presentResult: (args) => ({
        card: 'generic',
        title: args.sessionId ? `Inspected Worker (${args.sessionId})` : 'Listed Worker Tasks',
      }),
      execute: (args, { agent, signal }) => invoke(agent, signal, c => tasks.inspect(c, args)),
    }), masterOnly), 'DeepDuet session_inspect')

    targetCtx.effect(() => targetCtx.tools.register(defineTool({
      name: 'session_manage',
      description: 'Stop a managed turn, archive a task, or remove its clean managed worktree after verifying its work is saved or disposable.',
      parameters: {
        sessionId: { ...sessionId, required: true },
        action: { type: 'string', required: true, enum: ['stop', 'archive', 'remove_worktree'] },
      },
      output,
      presentCall: (args) => ({
        card: 'generic',
        kind: args.action === 'remove_worktree' ? 'delete' : 'other',
        title: `Manage Worker (${args.action}): ${args.sessionId}`,
        rawInput: args,
      }),
      presentResult: (args, result) => ({
        card: 'generic',
        title: result.isError
          ? `Failed Worker ${args.action} (${args.sessionId})`
          : `Completed Worker ${args.action} (${args.sessionId})`,
      }),
      execute: (args, { agent, signal }) => invoke(agent, signal, c => tasks.manage(c, args)),
    }), masterOnly), 'DeepDuet session_manage')
  }

  const service: DeepDuetService = {
    tasks,
    isWorker: agentId => tasks.isWorker(agentId),
    registerMasterSurface,
    ...remoteHandlers,
  }
  service.typertRemote = bindTypertRemote(service, 'deepduet')
  ctx.provide('deepduet', service)
  ctx.inject(['typert'], (typertCtx) => {
    const info = createDeepDuetRemoteInfo(z)
    typertCtx.effect(() => typertCtx.typert.register({
      package: 'dsh-plugin-deepduet',
      face: 'host',
      schemas: [],
      model: { services: [], events: [], objects: [] },
      invocations: info.descriptors,
    }), 'DeepDuet typert host registration')
  })

  // Standalone / headless hosts without agent-presets mount master tools on the host directly.
  if (ctx.get('agentPresets') === undefined) {
    registerMasterSurface(ctx)
  }
}
