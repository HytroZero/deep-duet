import { execFileSync } from 'node:child_process'
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import { Context } from '@deepseek-ai/cordis'
import { mountAgentLoopTestDependencies, mountAgentLoopTestHarness } from '@deepseek-ai/dsh-agent-loop-testkit'
import { brandString } from '@deepseek-ai/dsh-brand'
import SandboxProvider from '@deepseek-ai/dsh-sandbox'
import type { ConfinedArgv } from '@deepseek-ai/dsh-sandbox'
import SandboxPolicy from '@deepseek-ai/dsh-sandbox-policy'
import type { SessionId } from '@deepseek-ai/dsh-session'
import * as JsonlPersistence from '@deepseek-ai/dsh-session-persistence-jsonl'
import SessionTitle from '@deepseek-ai/dsh-session-title'
import { defineTool } from '@deepseek-ai/dsh-tools'
import Approval from '@deepseek-ai/dsh-user-approval'
import { LlmAdapter } from '@deepseek-ai/dsh-llm'
import type { ContentBlock, StreamChunk } from '@deepseek-ai/dsh-llm'
import * as deepduetPlugin from './index.js'

class PreviewSandbox extends SandboxProvider {
  async confine(argv: readonly string[]): Promise<ConfinedArgv> {
    return {
      argv: [...argv],
      enforcement: 'partial',
      denialSignatures: [],
      runnerFailureRules: [],
    }
  }
}

function textOf(message: { content: readonly ContentBlock[] } | undefined) {
  if (!message) return ''
  return message.content.flatMap(block => block.type === 'text' ? [block.text] : []).join('\n')
}

async function* streamText(text: string, reasoning?: string, signal?: AbortSignal): AsyncGenerator<StreamChunk> {
  if (reasoning) {
    yield { type: 'block-start', index: 0, blockType: 'reasoning' }
    for (const chunk of reasoning.match(/.{1,12}/g) ?? [reasoning]) {
      signal?.throwIfAborted()
      yield { type: 'reasoning-delta', index: 0, text: chunk }
      await sleep(20, undefined, { signal })
    }
    yield { type: 'block-end', index: 0, block: { type: 'reasoning', text: reasoning } }
  }
  const textIndex = reasoning ? 1 : 0
  yield { type: 'block-start', index: textIndex, blockType: 'text' }
  for (const chunk of text.match(/.{1,10}/gs) ?? [text]) {
    signal?.throwIfAborted()
    yield { type: 'text-delta', index: textIndex, text: chunk }
    await sleep(18, undefined, { signal })
  }
  yield { type: 'block-end', index: textIndex, block: { type: 'text', text } }
  yield { type: 'finish', reason: { kind: 'stop' } }
}

function* streamToolCall(id: string, name: string, args: Record<string, unknown>): Generator<StreamChunk> {
  const serialized = JSON.stringify(args)
  yield { type: 'block-start', index: 0, blockType: 'tool-call' }
  yield { type: 'tool-call-delta', index: 0, id: id as never, name, argumentsDelta: serialized }
  yield { type: 'block-end', index: 0, block: { type: 'tool-call', id: id as never, name, arguments: serialized } }
  yield { type: 'finish', reason: { kind: 'tool-calls' } }
}

class InteractiveStudioModel extends LlmAdapter {
  private counter = 0

  async *stream(options: Parameters<LlmAdapter['stream']>[0]): AsyncGenerator<StreamChunk> {
    const systemText = textOf(options.messages.find(m => m.role === 'system'))
    const isWorker = systemText.includes('You are a DeepDuet background worker')
    const latest = options.messages.findLast(m => m.role !== 'user' || ['user', 'deepduet'].includes(m.source?.kind ?? ''))
    const lastUser = options.messages.findLast(m => m.role === 'user' && ['user', 'deepduet'].includes(m.source?.kind ?? ''))
    const input = textOf(lastUser)

    if (isWorker) {
      if (latest?.role === 'tool') {
        const resultText = textOf(latest)
        yield* streamText(
          `敏感操作已处理（结果：${resultText}）。后台任务本轮检查已完成。`,
          '工具审批结果已返回，整理本次执行摘要。',
          options.signal,
        )
        return
      }
      if (/重构|迁移|refactor|decision|方案/i.test(input)) {
        yield* streamText(
          `已完成初步代码扫描与依赖分析，发现两处核心模块存在历史兼容字段。\n[NEED_DECISION]: 希望采用方案 A（保留 v1 字段兼容，零风险）还是方案 B（升级为 v2 结构并重写迁移脚本）？`,
          '扫描项目目录并对比接口兼容性，发现需要用户确认迁移策略。',
          options.signal,
        )
        return
      }
      yield* streamText(
        `已完成任务「${input.slice(0, 40)}」的后台执行与验证，工作区状态正常。`,
        '分析任务要求，核对工作区状态并生成简洁总结。',
        options.signal,
      )
      return
    }

    if (latest?.role === 'tool') {
      const toolResult = textOf(latest)
      if (latest.isError) {
        yield* streamText(`操作未完成：${toolResult}`, undefined, options.signal)
        return
      }
      yield* streamText(
        `已启动后台 Worker：${toolResult}`,
        undefined,
        options.signal,
      )
      return
    }

    if (input.startsWith('[Background Digest]')) {
      yield* streamText(
        `收到后台进度汇总：\n${input}`,
        '整理后台汇总简报。',
        options.signal,
      )
      return
    }

    if (/后台|并行|派发|重构|迁移|巡检|测试|worker|spawn|refactor/i.test(input)) {
      const isolate = /worktree|分支|重构|迁移|refactor/i.test(input)
      yield* streamToolCall(`call-${++this.counter}`, 'session_spawn', {
        title: input.slice(0, 24),
        prompt: input,
        isolateWorktree: isolate,
      })
      return
    }

    yield* streamText(
      `收到：「${input}」。这是轻量级响应。`,
      '轻量问题直接回复。',
      options.signal,
    )
  }
}

async function main() {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'deepduet-preview-')))
  const repoDir = join(root, 'workspace')
  await mkdir(repoDir, { recursive: true })
  await writeFile(join(repoDir, 'README.md'), '# Demo Workspace\n\nDeepDuet preview repository.\n')
  execFileSync('git', ['init', '-q'], { cwd: repoDir })
  execFileSync('git', ['-c', 'user.name=Preview', '-c', 'user.email=preview@deepduet.local', '-c', 'commit.gpgsign=false', 'add', '.'], { cwd: repoDir })
  execFileSync('git', ['-c', 'user.name=Preview', '-c', 'user.email=preview@deepduet.local', '-c', 'commit.gpgsign=false', 'commit', '-qm', 'init'], { cwd: repoDir })

  const ctx = new Context()
  await mountAgentLoopTestDependencies(ctx, { workingDirectory: true })
  await ctx.plugin(PreviewSandbox)
  await ctx.plugin(SandboxPolicy, { mode: 'workspace-write', workspaceRoot: repoDir })
  await ctx.plugin(Approval, { policy: 'ask' })
  await ctx.plugin(SessionTitle, { fallbackMaxWords: 8, fallbackMaxBytes: 64, maxTitleBytes: 120 })
  await ctx.plugin(JsonlPersistence, { root: join(root, 'sessions') })

  const harness = await mountAgentLoopTestHarness(ctx)
  ctx.llm.registerAdapter(['mock'], new InteractiveStudioModel())

  ctx.tools.register(defineTool({
    name: 'workspace_cleanup',
    description: 'Clean up temporary cache directory (requires approval).',
    parameters: { target: { type: 'string', required: true, description: 'Target directory to remove.' } },
    output: { schema: { type: 'string' }, render: (_args, text) => [{ type: 'text', text: String(text) }] },
    execute: async args => `Cleaned ${String(args.target)}`,
  }))

  const eng = await harness.create(brandString<SessionId>('master-eng'), { provider: 'mock', model: 'mock' }, { cwd: repoDir })
  ctx.sessionTitle.rename(eng.session, 'Engineering')
  await ctx.sessions.flush(eng.session)

  await ctx.plugin(deepduetPlugin, { projectRoot: repoDir })

  eng.followup({
    id: 'msg-preview-1',
    role: 'user',
    source: { kind: 'user' },
    content: [{ type: 'text', text: '帮我后台重构账本模块并隔离 worktree' }],
    createdAt: Date.now(),
  } as never)
  await eng.whenIdle()

  console.log(`\nDeepDuet headless smoke completed in ${repoDir}`)
  await ctx.fiber.dispose().catch(() => {})
  await rm(root, { recursive: true, force: true }).catch(() => {})
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
