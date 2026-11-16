import { createInterface } from 'node:readline'

const url = process.env.DEEPDUET_MCP_URL
const token = process.env.DEEPDUET_MCP_TOKEN

if (!url || !token) {
  process.stderr.write('Missing DEEPDUET_MCP_URL or DEEPDUET_MCP_TOKEN\n')
  process.exit(1)
}

const rl = createInterface({ input: process.stdin, crlfDelay: Infinity })

rl.on('line', async (line) => {
  const trimmed = line.trim()
  if (!trimmed) return
  let parsed: { id?: unknown; method?: string }
  try {
    parsed = JSON.parse(trimmed) as { id?: unknown; method?: string }
  } catch {
    return
  }

  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${token}`,
      },
      body: trimmed,
    })
    if (parsed.id === undefined) return
    const text = await res.text()
    if (text) {
      process.stdout.write(`${text.trim()}\n`)
    }
  } catch (error) {
    if (parsed.id !== undefined) {
      process.stdout.write(`${JSON.stringify({
        jsonrpc: '2.0',
        id: parsed.id,
        error: { code: -32000, message: error instanceof Error ? error.message : String(error) },
      })}\n`)
    }
  }
})
