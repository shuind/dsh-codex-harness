import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { StreamChunk } from '@deepseek-ai/dsh-llm'
import { hostedWebSearchStream, installHostedWebSearch } from '../src/remote.ts'

const originalFetch = globalThis.fetch
const originalDshHome = process.env['DSH_HOME']

afterEach(() => {
  globalThis.fetch = originalFetch
  if (originalDshHome === undefined) delete process.env['DSH_HOME']
  else process.env['DSH_HOME'] = originalDshHome
})

async function fetchInCodexScope(): Promise<Response> {
  let response: Response | undefined
  const stream = hostedWebSearchStream(async function* () {
    response = await globalThis.fetch('https://chatgpt.com/backend-api/codex/responses', {
      method: 'POST',
      body: JSON.stringify({ model: 'gpt-5.6-sol' }),
    })
    yield { type: 'finish', reason: { kind: 'stop' } } as StreamChunk
  })
  for await (const _chunk of stream) { /* drain */ }
  if (response === undefined) throw new Error('test request did not return a response')
  return response
}

async function waitForFiles(directory: string): Promise<string[]> {
  for (let attempt = 0; attempt < 20; attempt++) {
    if (existsSync(directory)) {
      const files = readdirSync(directory)
      if (files.length > 0) return files
    }
    await new Promise<void>(resolve => setImmediate(resolve))
  }
  return []
}

describe('Codex error diagnostics', () => {
  it.each(['error', 'response.failed'])('saves the complete %s SSE payload without changing the response', async (type) => {
    const root = mkdtempSync(join(tmpdir(), 'dsh-codex-errors-'))
    process.env['DSH_HOME'] = root
    const payload = {
      type,
      code: 'server_error',
      message: 'provider failed',
      nested: { request_id: 'request-1', unknown: ['preserved'] },
    }
    const wire = `data: ${JSON.stringify({ type: 'response.created' })}\n\ndata: ${JSON.stringify(payload)}\n\n`
    globalThis.fetch = async () => new Response(wire, {
      headers: { 'content-type': 'text/event-stream; charset=utf-8' },
    })
    const dispose = installHostedWebSearch()
    try {
      const response = await fetchInCodexScope()
      expect(await response.text()).toBe(wire)
      const directory = join(root, 'diagnostics', 'openai-codex-errors')
      const files = await waitForFiles(directory)
      expect(files).toHaveLength(1)
      expect(JSON.parse(readFileSync(join(directory, files[0]!), 'utf8'))).toEqual(payload)
    } finally {
      dispose()
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('leaves the provider response intact when the diagnostics directory cannot be created', async () => {
    const root = mkdtempSync(join(tmpdir(), 'dsh-codex-errors-blocked-'))
    const blocked = join(root, 'not-a-directory')
    writeFileSync(blocked, 'file')
    process.env['DSH_HOME'] = blocked
    const payload = { type: 'error', message: 'provider failed' }
    const wire = `data: ${JSON.stringify(payload)}\n\n`
    globalThis.fetch = async () => new Response(wire, {
      headers: { 'content-type': 'text/event-stream' },
    })
    const dispose = installHostedWebSearch()
    try {
      const response = await fetchInCodexScope()
      expect(await response.text()).toBe(wire)
    } finally {
      dispose()
      rmSync(root, { recursive: true, force: true })
    }
  })
})
