import { randomBytes } from 'node:crypto'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import type { TaskContext, TaskManager } from './tasks.js'

interface MasterTokenEntry {
  masterId: string
  getCwd: () => string
}

export interface MasterMcpServer {
  readonly port: number
  readonly url: string
  issueMasterConfig(masterId: string, getCwd: () => string): {
    command: string
    args: string[]
    env: Record<string, string>
  }
  revokeMaster(masterId: string): void
  close(): Promise<void>
}

const BRIDGE_PATH = join(dirname(fileURLToPath(import.meta.url)), 'mcp-stdio-bridge.js')

const TOOL_DEFINITIONS = [
  {
    name: 'session_spawn',
    description: 'Spawn a persistent background Worker session (visible in the workspace sidebar) for multi-step coding, investigation, refactoring, long test/build runs, or parallel workstreams.',
    inputSchema: {
      type: 'object',
      properties: {
        title: { type: 'string', description: 'Short task title shown in receipts and digests.' },
        prompt: { type: 'string', description: 'Full goal, scope and verification instructions for the worker.' },
        cwd: { type: 'string', description: 'Optional working directory inside the Master workspace.' },
        isolateWorktree: { type: 'boolean', description: 'Create an isolated Git worktree and branch deepduet/<sessionId>.' },
        engine: { type: 'string', description: 'Optional Worker engine override (e.g. "native", "codex-portal").' },
        model: { type: 'string', description: 'Optional Worker model override.' },
        reasoningEffort: { type: 'string', description: 'Optional reasoning effort override.' },
        sandboxMode: { type: 'string', enum: ['read-only', 'workspace-write', 'danger-full-access'], description: 'Optional sandbox policy override.' },
      },
      required: ['title', 'prompt'],
    },
  },
  {
    name: 'session_steer',
    description: 'Send follow-up instructions or a user decision to an idle or failed background worker.',
    inputSchema: {
      type: 'object',
      properties: {
        sessionId: { type: 'string', description: 'Worker session id returned by session_spawn.' },
        instruction: { type: 'string', description: 'Next instruction or decision answer for the worker.' },
      },
      required: ['sessionId', 'instruction'],
    },
  },
  {
    name: 'session_inspect',
    description: 'List active background workers or read one worker status, recent transcript messages and git status.',
    inputSchema: {
      type: 'object',
      properties: {
        sessionId: { type: 'string', description: 'Worker session id; omit to list active tasks.' },
        tailMessages: { type: 'integer', description: 'Recent chat messages to show. Defaults to 5, up to 20.' },
      },
    },
  },
  {
    name: 'session_manage',
    description: 'Stop a managed turn, archive a task, or remove its clean managed worktree.',
    inputSchema: {
      type: 'object',
      properties: {
        sessionId: { type: 'string', description: 'Worker session id.' },
        action: { type: 'string', enum: ['stop', 'archive', 'remove_worktree'] },
      },
      required: ['sessionId', 'action'],
    },
  },
] as const

async function readJsonBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = []
  for await (const chunk of req) {
    chunks.push(typeof chunk === 'string' ? Buffer.from(chunk) : chunk)
  }
  const text = Buffer.concat(chunks).toString('utf8').trim()
  if (!text) return {}
  return JSON.parse(text) as Record<string, unknown>
}

function sendJson(res: ServerResponse, status: number, payload: unknown) {
  const body = JSON.stringify(payload)
  res.writeHead(status, {
    'content-type': 'application/json',
    'content-length': Buffer.byteLength(body),
  })
  res.end(body)
}

export async function startMasterMcpServer(getTasks: () => TaskManager): Promise<MasterMcpServer> {
  const tokens = new Map<string, MasterTokenEntry>()
  const masterToToken = new Map<string, string>()

  const server = createServer(async (req, res) => {
    if (req.method !== 'POST' || req.url !== '/mcp') {
      sendJson(res, 404, { error: 'Not Found' })
      return
    }
    const auth = req.headers.authorization
    const bearer = typeof auth === 'string' && auth.startsWith('Bearer ') ? auth.slice(7).trim() : ''
    const identity = tokens.get(bearer)
    if (!identity) {
      sendJson(res, 401, { error: 'Unauthorized' })
      return
    }

    let body: Record<string, unknown>
    try {
      body = await readJsonBody(req)
    } catch {
      sendJson(res, 400, { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } })
      return
    }

    const id = body.id
    const method = typeof body.method === 'string' ? body.method : ''
    const params = (typeof body.params === 'object' && body.params !== null ? body.params : {}) as Record<string, unknown>

    if (id === undefined) {
      res.writeHead(204).end()
      return
    }

    if (method === 'initialize') {
      sendJson(res, 200, {
        jsonrpc: '2.0',
        id,
        result: {
          protocolVersion: '2024-11-05',
          capabilities: { tools: {} },
          serverInfo: { name: 'deepduet-master-mcp', version: '1.0.0' },
        },
      })
      return
    }

    if (method === 'tools/list') {
      sendJson(res, 200, {
        jsonrpc: '2.0',
        id,
        result: { tools: TOOL_DEFINITIONS },
      })
      return
    }

    if (method === 'tools/call') {
      const toolName = typeof params.name === 'string' ? params.name : ''
      const args = (typeof params.arguments === 'object' && params.arguments !== null ? params.arguments : {}) as Record<string, unknown>
      const tasks = getTasks()
      const taskCtx: TaskContext = {
        masterId: identity.masterId,
        cwd: identity.getCwd(),
      }
      try {
        let value: unknown
        switch (toolName) {
          case 'session_spawn':
            value = await tasks.spawn(taskCtx, args as Parameters<TaskManager['spawn']>[1])
            break
          case 'session_steer':
            value = await tasks.steer(taskCtx, args as Parameters<TaskManager['steer']>[1])
            break
          case 'session_inspect':
            value = await tasks.inspect(taskCtx, args as Parameters<TaskManager['inspect']>[1])
            break
          case 'session_manage':
            value = await tasks.manage(taskCtx, args as Parameters<TaskManager['manage']>[1])
            break
          default:
            sendJson(res, 200, {
              jsonrpc: '2.0',
              id,
              result: {
                content: [{ type: 'text', text: `Unknown DeepDuet tool: ${toolName}` }],
                isError: true,
              },
            })
            return
        }
        sendJson(res, 200, {
          jsonrpc: '2.0',
          id,
          result: {
            content: [{ type: 'text', text: JSON.stringify(value) }],
          },
        })
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        sendJson(res, 200, {
          jsonrpc: '2.0',
          id,
          result: {
            content: [{ type: 'text', text: message }],
            isError: true,
          },
        })
      }
      return
    }

    sendJson(res, 200, {
      jsonrpc: '2.0',
      id,
      error: { code: -32601, message: `Method not found: ${method}` },
    })
  })

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      server.off('error', reject)
      resolve()
    })
  })

  const address = server.address()
  const port = typeof address === 'object' && address ? address.port : 0
  const url = `http://127.0.0.1:${port}/mcp`

  return {
    port,
    url,
    issueMasterConfig(masterId, getCwd) {
      let token = masterToToken.get(masterId)
      if (!token) {
        token = randomBytes(24).toString('hex')
        masterToToken.set(masterId, token)
        tokens.set(token, { masterId, getCwd })
      }
      return {
        command: process.execPath,
        args: [BRIDGE_PATH],
        env: {
          DEEPDUET_MCP_URL: url,
          DEEPDUET_MCP_TOKEN: token,
        },
      }
    },
    revokeMaster(masterId) {
      const token = masterToToken.get(masterId)
      if (token) {
        masterToToken.delete(masterId)
        tokens.delete(token)
      }
    },
    async close() {
      tokens.clear()
      masterToToken.clear()
      await new Promise<void>((resolve) => {
        server.close(() => resolve())
      })
    },
  }
}
