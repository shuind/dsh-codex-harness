import { describe, expect, it } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import type { ToolDefinition } from '@deepseek-ai/dsh-tools'
import { apply } from '../../src/entries/index.ts'
import { CODEX_SETTINGS_ENTRY } from '../../src/contracts/settings.ts'
import { hostedWebSearchStream, installHostedWebSearch } from '../../src/responses/fetch-transport.ts'
import { remoteCompactStream } from '../../src/responses/remote-compact.ts'

async function collectChunks(stream: AsyncIterable<unknown>): Promise<unknown[]> {
  const chunks: unknown[] = []
  for await (const chunk of stream) chunks.push(chunk)
  return chunks
}

function mount(
  settings?: { describe?: () => Array<{ ns: string; value: unknown }>; update?(ns: string, patch: object): Promise<void> },
  config: Parameters<typeof apply>[1] = {},
): {
  definitions: ToolDefinition[]
  promptSections: string[]
  listeners: Map<string, Array<(...args: any[]) => unknown>>
} {
  const definitions: ToolDefinition[] = []
  const promptSections: string[] = []
  const listeners = new Map<string, Array<(...args: any[]) => unknown>>()
  const ctx = {
    tools: { register: (definition: ToolDefinition) => { definitions.push(definition) } },
    systemPrompt: { section: (section: { name: string }) => { promptSections.push(section.name) } },
    fs: { sandboxMode: undefined },
    get: (name: string) => name === 'tools' ? ctx.tools : name === 'shell' ? {} : name === 'settings' ? settings : undefined,
    on: (event: string, listener: (...args: any[]) => unknown) => {
      const entries = listeners.get(event) ?? []
      entries.push(listener)
      listeners.set(event, entries)
      return () => {}
    },
    inject: () => {},
    logger: { warn: () => {} },
  } as unknown as Context
  apply(ctx, config)
  return { definitions, promptSections, listeners }
}

describe('Codex Responses fetch fallback and capability cache', () => {
  it('restores a compaction marker even when the request has no web_search tool', async () => {
    const originalFetch = globalThis.fetch
    const requests: object[] = []
    globalThis.fetch = async (input, init) => {
      const request = new Request(input, init)
      requests.push(JSON.parse(await request.text()))
      return Response.json({ ok: true })
    }
    const dispose = installHostedWebSearch()
    try {
      await (async function* () {
        yield* hostedWebSearchStream(async function* () {
          await globalThis.fetch('https://relay.example/v1/responses', {
            method: 'POST',
            body: JSON.stringify({
              model: 'gpt-5.4',
              input: [{
                role: 'user',
                content: [{ type: 'input_text', text: '<codex-remote-compaction>opaque</codex-remote-compaction>' }],
              }],
            }),
          })
        })
      })().next()
    } finally {
      dispose()
      globalThis.fetch = originalFetch
    }
    expect(requests).toEqual([{ model: 'gpt-5.4', input: [{ type: 'compaction', encrypted_content: 'opaque' }] }])
  })

  it('keeps the marker restoration active when remote compaction falls back locally', async () => {
    const originalFetch = globalThis.fetch
    const requests: object[] = []
    let calls = 0
    globalThis.fetch = async (input, init) => {
      calls += 1
      const request = new Request(input, init)
      const body = JSON.parse(await request.text())
      if (calls === 1) throw new TypeError('compact endpoint unavailable')
      requests.push(body)
      return Response.json({ ok: true })
    }
    const ctx = {
      get: (name: string) => name === 'settings'
        ? { describe: () => [{ ns: 'llm-pi-ai', value: { providers: { relay: { api: 'openai-responses', baseURL: 'https://relay.example/v1', apiKeyEnv: 'RELAY_KEY' } } } }] }
        : { resolve: async () => ({ value: 'secret' }) },
      logger: { warn: () => {} },
    } as unknown as Context
    const dispose = installHostedWebSearch()
    try {
      const chunks = remoteCompactStream(ctx, {
        provider: 'relay',
        model: 'gpt-5.4',
        messages: [
          { role: 'user', content: [{ type: 'text', text: 'history' }] },
          { role: 'user', content: [{ type: 'text', text: 'compact now' }] },
        ],
        purpose: 'compaction',
      } as never, async function* () {
        await globalThis.fetch('https://relay.example/v1/responses', {
          method: 'POST',
          body: JSON.stringify({
            model: 'gpt-5.4',
            input: [{
              role: 'user',
              content: [{ type: 'input_text', text: '<codex-remote-compaction>opaque</codex-remote-compaction>' }],
            }],
          }),
        })
        yield { type: 'text-delta', index: 0, text: '<codex-remote-compaction>opaque</codex-remote-compaction>' } as never
      })
      for await (const _chunk of chunks) {
        // Consume the fallback stream; its own adapter performs the fetch.
      }
    } finally {
      dispose()
      globalThis.fetch = originalFetch
    }
    expect(requests).toEqual([{ model: 'gpt-5.4', input: [{ type: 'compaction', encrypted_content: 'opaque' }] }])
  })

  it('preserves compaction replacement on fallback and avoids blind double-sends on auth/rate/server/abort/context errors', async () => {
    const originalFetch = globalThis.fetch
    // 1) Fallback request must keep <codex-remote-compaction> replaced even when hosted web_search is rejected.
    const sent: Record<string, unknown>[] = []
    let calls = 0
    globalThis.fetch = async (input, init) => {
      calls++
      const req = new Request(input, init)
      sent.push(JSON.parse(await req.text()))
      if (calls === 1) return new Response('invalid tool web_search', { status: 400 })
      return Response.json({ ok: true })
    }
    const dispose = installHostedWebSearch()
    try {
      await (async function* () {
        yield* hostedWebSearchStream(async function* () {
          await globalThis.fetch('https://relay.example/v1/responses', {
            method: 'POST',
            body: JSON.stringify({
              model: 'gpt-5.4',
              tools: [{ type: 'function', name: 'web_search' }],
              input: [{ role: 'user', content: [{ type: 'input_text', text: '<codex-remote-compaction>enc</codex-remote-compaction>' }] }],
            }),
          })
        })
      })().next()
      expect(calls).toBe(2)
      expect(sent[1]!.input).toEqual([{ type: 'compaction', encrypted_content: 'enc' }])
      expect(sent[1]!.tools).toEqual([{ type: 'function', name: 'web_search' }])

      // 2) Auth, rate limit, server 5xx, context_length_exceeded, and AbortError must NOT double-send.
      for (const failure of [
        new Response('unauthorized', { status: 401 }),
        new Response('rate limited', { status: 429 }),
        new Response('server error', { status: 503 }),
        new Response('context_length_exceeded', { status: 400 }),
      ]) {
        let count = 0
        globalThis.fetch = async () => { count++; return failure }
        await (async function* () {
          yield* hostedWebSearchStream(async function* () {
            const res = await globalThis.fetch('https://relay.example/v1/responses', {
              method: 'POST',
              body: JSON.stringify({ model: 'gpt-5.4', tools: [{ type: 'function', name: 'apply_patch' }] }),
            })
            expect(res.status).toBe(failure.status)
          })
        })().next()
        expect(count).toBe(1)
      }

      let abortCalls = 0
      globalThis.fetch = async () => {
        abortCalls++
        const err = new Error('aborted')
        err.name = 'AbortError'
        throw err
      }
      await expect((async function* () {
        yield* hostedWebSearchStream(async function* () {
          await globalThis.fetch('https://relay.example/v1/responses', {
            method: 'POST',
            body: JSON.stringify({ model: 'gpt-5.4', tools: [{ type: 'function', name: 'apply_patch' }] }),
          })
        })
      })().next()).rejects.toThrow('aborted')
      expect(abortCalls).toBe(1)
    } finally {
      dispose()
      globalThis.fetch = originalFetch
    }
  })

  it('caches per-capability rejections by endpoint and model and drops only the failed hosted tool', async () => {
    const originalFetch = globalThis.fetch
    const seenTools: unknown[][] = []
    globalThis.fetch = async (input, init) => {
      const req = new Request(input, init)
      const body = JSON.parse(await req.text()) as { tools: Array<{ type: string; name?: string }> }
      seenTools.push(body.tools.map(t => ({ type: t.type, name: t.name })))
      if (body.tools.some(t => t.type === 'web_search')) {
        return new Response('web_search tool is unsupported on this relay', { status: 400 })
      }
      return Response.json({ ok: true })
    }
    let dispose = installHostedWebSearch()
    try {
      const payload = JSON.stringify({
        model: 'gpt-5.4',
        tools: [{ type: 'function', name: 'web_search' }, { type: 'function', name: 'apply_patch' }],
      })
      // Turn 1: fails on web_search -> retries keeping custom apply_patch!
      await (async function* () {
        yield* hostedWebSearchStream(async function* () {
          await globalThis.fetch('https://cache.example/v1/responses', { method: 'POST', body: payload })
        })
      })().next()
      expect(seenTools).toHaveLength(2)
      expect(seenTools[1]).toEqual([
        { type: 'function', name: 'web_search' },
        { type: 'custom', name: 'apply_patch' },
      ])
      // Turn 2 on same (url, model): hits negative cache for web_search, sends 1 request with custom apply_patch!
      await (async function* () {
        yield* hostedWebSearchStream(async function* () {
          await globalThis.fetch('https://cache.example/v1/responses', { method: 'POST', body: payload })
        })
      })().next()
      expect(seenTools).toHaveLength(3)
    } finally {
      dispose()
      globalThis.fetch = originalFetch
    }
    // Re-mounting clears capability cache so fresh plugins re-probe.
    dispose = installHostedWebSearch()
    let freshCalls = 0
    globalThis.fetch = async () => { freshCalls++; return Response.json({ ok: true }) }
    try {
      await (async function* () {
        yield* hostedWebSearchStream(async function* () {
          await globalThis.fetch('https://cache.example/v1/responses', {
            method: 'POST',
            body: JSON.stringify({ model: 'gpt-5.4', tools: [{ type: 'function', name: 'web_search' }] }),
          })
        })
      })().next()
      expect(freshCalls).toBe(1)
    } finally {
      dispose()
      globalThis.fetch = originalFetch
    }
  })
})
