import { createTypertRemoteInfo } from '@deepseek-ai/dsh-typert-protocol/remote-info'
import type { z as ZodNamespace } from 'zod'

export type WorkerStatus = 'running' | 'idle' | 'failed' | 'completed'

export interface DeepDuetWorktree {
  repoRoot: string
  path: string
  branch: string
}

export interface TaskRecord {
  sessionId: string
  masterId: string
  title: string
  goal: string
  cwd: string
  status: WorkerStatus
  needsDecision: boolean
  decisionQuestion?: string
  lastSummary?: string
  worktree?: DeepDuetWorktree
  createdAt: number
  updatedAt: number
}

export interface DeepDuetSpawnParams {
  masterId: string
  title: string
  prompt: string
  cwd?: string
  isolateWorktree?: boolean
}

export interface DeepDuetSteerParams {
  masterId: string
  sessionId: string
  instruction: string
}

export interface DeepDuetManageParams {
  masterId: string
  sessionId: string
  action: 'stop' | 'archive' | 'remove_worktree'
}

export interface DeepDuetInspectParams {
  masterId: string
  sessionId: string
  tailMessages?: number
}

export interface DeepDuetTasksSnapshot {
  tasks: TaskRecord[]
}

export interface DeepDuetTaskReceipt {
  sessionId: string
  title: string
  status: string
  needsDecision: boolean
  decisionQuestion?: string
  lastSummary?: string
  worktree?: { repoRoot: string; path: string; branch: string }
}

export interface DeepDuetSpawnReceipt {
  sessionId: string
  title: string
  cwd: string
  status: string
  worktree?: { repoRoot: string; path: string; branch: string }
}

export interface DeepDuetInspectResult {
  task: TaskRecord
  session: {
    id: string
    title?: string
    cwd?: string
    busy: boolean
    messages: { role: string; text: string }[]
  }
  gitStatus: { text: string } | { unavailable: true }
}

export function createDeepDuetRemoteInfo(z: typeof ZodNamespace) {
  const worktreeSchema = z.object({
    repoRoot: z.string(),
    path: z.string(),
    branch: z.string(),
  })

  const taskSchema = z.object({
    sessionId: z.string(),
    masterId: z.string(),
    title: z.string(),
    goal: z.string(),
    cwd: z.string(),
    status: z.enum(['running', 'idle', 'failed', 'completed']),
    needsDecision: z.boolean(),
    decisionQuestion: z.string().optional(),
    lastSummary: z.string().optional(),
    worktree: worktreeSchema.optional(),
    createdAt: z.number(),
    updatedAt: z.number(),
  })

  const snapshotSchema = z.object({
    tasks: z.array(taskSchema),
  })

  const spawnReceiptSchema = z.object({
    sessionId: z.string(),
    title: z.string(),
    cwd: z.string(),
    status: z.string(),
    worktree: worktreeSchema.optional(),
  })

  const taskReceiptSchema = z.object({
    sessionId: z.string(),
    title: z.string(),
    status: z.string(),
    needsDecision: z.boolean(),
    decisionQuestion: z.string().optional(),
    lastSummary: z.string().optional(),
    worktree: worktreeSchema.optional(),
  })

  const inspectResultSchema = z.object({
    task: taskSchema,
    session: z.object({
      id: z.string(),
      title: z.string().optional(),
      cwd: z.string().optional(),
      busy: z.boolean(),
      messages: z.array(z.object({
        role: z.string(),
        text: z.string(),
      })),
    }),
    gitStatus: z.union([
      z.object({ text: z.string() }),
      z.object({ unavailable: z.literal(true) }),
    ]),
  })

  const strictSchema = <T extends ZodNamespace.ZodType>(
    typeSymbol: string,
    create: () => T,
    jsonSchema: Record<string, unknown>,
  ) => ({
    mode: 'strict' as const,
    typeSymbol,
    create,
    jsonSchema,
  })

  const param = <T extends ZodNamespace.ZodType>(
    name: string,
    description: string,
    typeSymbol: string,
    create: () => T,
    jsonSchema: Record<string, unknown>,
  ) => {
    const codec = strictSchema(typeSymbol, create, jsonSchema)
    return {
      name,
      description,
      source: 'json' as const,
      codec,
      strictCodec: codec,
    }
  }

  return createTypertRemoteInfo({
    package: 'dsh-plugin-deepduet',
    methods: {
      'deepduet/list': {
        service: 'deepduet',
        description: 'List all DeepDuet worker tasks from the ledger.',
        implementation: 'remoteList',
        invocation: { kind: 'direct' },
        parameters: [],
        result: strictSchema(
          'dsh-plugin-deepduet#DeepDuetTasksSnapshot',
          () => snapshotSchema,
          { type: 'object' },
        ),
      },
      'deepduet/watch': {
        service: 'deepduet',
        description: 'Stream live DeepDuet worker task snapshots.',
        implementation: 'remoteWatch',
        mode: 'stream',
        invocation: { kind: 'direct' },
        parameters: [],
        cancellation: { parameter: 'signal' },
        result: strictSchema(
          'dsh-plugin-deepduet#DeepDuetTasksSnapshot',
          () => snapshotSchema,
          { type: 'object' },
        ),
      },
      'deepduet/spawn': {
        service: 'deepduet',
        description: 'Spawn a DeepDuet background worker from GUI.',
        implementation: 'remoteSpawn',
        invocation: { kind: 'direct' },
        parameters: [
          param(
            'input',
            'Worker creation options',
            'dsh-plugin-deepduet#DeepDuetSpawnParams',
            () => z.object({
              masterId: z.string().min(1),
              title: z.string().min(1),
              prompt: z.string().min(1),
              cwd: z.string().optional(),
              isolateWorktree: z.boolean().optional(),
            }),
            { type: 'object' },
          ),
        ],
        result: strictSchema(
          'dsh-plugin-deepduet#DeepDuetSpawnReceipt',
          () => spawnReceiptSchema,
          { type: 'object' },
        ),
      },
      'deepduet/steer': {
        service: 'deepduet',
        description: 'Steer or answer decision for a DeepDuet worker from GUI.',
        implementation: 'remoteSteer',
        invocation: { kind: 'direct' },
        parameters: [
          param(
            'input',
            'Steer instruction parameters',
            'dsh-plugin-deepduet#DeepDuetSteerParams',
            () => z.object({
              masterId: z.string().min(1),
              sessionId: z.string().min(1),
              instruction: z.string().min(1),
            }),
            { type: 'object' },
          ),
        ],
        result: strictSchema(
          'dsh-plugin-deepduet#DeepDuetTaskReceipt',
          () => taskReceiptSchema,
          { type: 'object' },
        ),
      },
      'deepduet/manage': {
        service: 'deepduet',
        description: 'Stop, archive, or remove worktree of a DeepDuet worker from GUI.',
        implementation: 'remoteManage',
        invocation: { kind: 'direct' },
        parameters: [
          param(
            'input',
            'Manage action parameters',
            'dsh-plugin-deepduet#DeepDuetManageParams',
            () => z.object({
              masterId: z.string().min(1),
              sessionId: z.string().min(1),
              action: z.enum(['stop', 'archive', 'remove_worktree']),
            }),
            { type: 'object' },
          ),
        ],
        result: strictSchema(
          'dsh-plugin-deepduet#DeepDuetTaskReceipt',
          () => taskReceiptSchema,
          { type: 'object' },
        ),
      },
      'deepduet/inspect': {
        service: 'deepduet',
        description: 'Inspect live transcript tail and git status of a DeepDuet worker.',
        implementation: 'remoteInspect',
        invocation: { kind: 'direct' },
        parameters: [
          param(
            'input',
            'Inspect request parameters',
            'dsh-plugin-deepduet#DeepDuetInspectParams',
            () => z.object({
              masterId: z.string().min(1),
              sessionId: z.string().min(1),
              tailMessages: z.number().int().min(0).max(20).optional(),
            }),
            { type: 'object' },
          ),
        ],
        result: strictSchema(
          'dsh-plugin-deepduet#DeepDuetInspectResult',
          () => inspectResultSchema,
          { type: 'object' },
        ),
      },
    },
  } as never, z)
}
