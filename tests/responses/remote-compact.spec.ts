import { zstdCompressSync } from 'node:zlib'
import { describe, expect, it } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import type { ToolDefinition } from '@deepseek-ai/dsh-tools'
import { apply } from '../../src/entries/index.ts'
import { CODEX_SETTINGS_ENTRY, CODEX_SETTINGS_NAMESPACE } from '../../src/contracts/settings.ts'
import { rewriteCodexApplyPatchHistory } from '../../src/responses/wire-rewrite.ts'
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

describe('Codex remote compaction and stream repair', () => {
  it('uses the configured Responses route for remote compaction and returns a replay marker', async () => {
    const originalFetch = globalThis.fetch
    let requestUrl = ''
    let requestBody: Record<string, unknown> | undefined
    globalThis.fetch = async (input, init) => {
      const request = new Request(input, init)
      requestUrl = request.url
      requestBody = JSON.parse(await request.text()) as Record<string, unknown>
      return Response.json({
        output: [{ type: 'compaction', encrypted_content: 'opaque' }],
        usage: {
          input_tokens: 283,
          input_tokens_details: { cached_tokens: 256, cache_write_tokens: 7 },
          output_tokens: 69,
          output_tokens_details: { reasoning_tokens: 24 },
          total_tokens: 352,
        },
      })
    }
    const ctx = {
      get: (name: string) => name === 'settings'
        ? { describe: () => [{ ns: 'llm-pi-ai', value: { providers: { relay: { api: 'openai-responses', baseURL: 'https://relay.example/v1', apiKeyEnv: 'RELAY_KEY' } } } }] }
        : { resolve: async () => ({ value: 'secret' }) },
      logger: { warn: () => {} },
    } as unknown as Context
    const chunks: unknown[] = []
    try {
      for await (const chunk of remoteCompactStream(ctx, {
        provider: 'relay',
        model: 'gpt-5.4',
        messages: [
          { role: 'user', content: [{ type: 'text', text: 'history' }] },
          { role: 'user', content: [{ type: 'text', text: 'compact now' }] },
        ],
        purpose: 'compaction',
      } as never, async function* () { yield { type: 'finish', reason: { kind: 'stop' } } as never })) {
        chunks.push(chunk)
      }
    } finally {
      globalThis.fetch = originalFetch
    }
    expect(requestUrl).toBe('https://relay.example/v1/responses/compact')
    expect(requestBody).toMatchObject({ model: 'gpt-5.4', input: [{ role: 'user' }] })
    expect(chunks).toContainEqual(expect.objectContaining({ type: 'text-delta', text: '<codex-remote-compaction>opaque</codex-remote-compaction>' }))
    expect(chunks).toContainEqual({
      type: 'usage',
      usage: { inputTokens: 20, outputTokens: 69, cacheReadTokens: 256, cacheWriteTokens: 7 },
    })
    expect(chunks).not.toContainEqual({ type: 'usage', usage: { inputTokens: 0, outputTokens: 0 } })
  })

  it('does not fabricate zero usage when compact usage is missing or inconsistent', async () => {
    const originalFetch = globalThis.fetch
    const responses = [
      { output: [{ type: 'compaction', encrypted_content: 'missing' }] },
      {
        output: [{ type: 'compaction', encrypted_content: 'inconsistent' }],
        usage: {
          input_tokens: 10,
          input_tokens_details: { cached_tokens: 8, cache_write_tokens: 5 },
          output_tokens: 2,
        },
      },
    ]
    let responseIndex = 0
    globalThis.fetch = async () => Response.json(responses[responseIndex++] ?? responses[0])
    const ctx = {
      get: (name: string) => name === 'settings'
        ? { describe: () => [{ ns: 'llm-pi-ai', value: { providers: { relay: { api: 'openai-responses', baseURL: 'https://relay.example/v1', apiKeyEnv: 'RELAY_KEY' } } } }] }
        : { resolve: async () => ({ value: 'secret' }) },
      logger: { warn: () => {} },
    } as unknown as Context
    try {
      for (const expectedText of ['missing', 'inconsistent']) {
        const chunks: unknown[] = []
        for await (const chunk of remoteCompactStream(ctx, {
          provider: 'relay',
          model: 'gpt-5.4',
          messages: [
            { role: 'user', content: [{ type: 'text', text: 'history' }] },
            { role: 'user', content: [{ type: 'text', text: 'compact now' }] },
          ],
          purpose: 'compaction',
        } as never, async function* () { yield { type: 'finish', reason: { kind: 'stop' } } as never })) {
          chunks.push(chunk)
        }
        expect(chunks).toContainEqual(expect.objectContaining({
          type: 'text-delta',
          text: `<codex-remote-compaction>${expectedText}</codex-remote-compaction>`,
        }))
        expect(chunks.some(chunk => (chunk as { type?: unknown }).type === 'usage')).toBe(false)
      }
    } finally {
      globalThis.fetch = originalFetch
    }
  })

  it('repairs old pi-ai overflow once through ordinary and compaction streams', async () => {
    const settings = {
      describe: () => [
        { ns: CODEX_SETTINGS_NAMESPACE, value: { ...CODEX_SETTINGS_ENTRY, contextWindow: 400_000 } },
        { ns: 'llm-pi-ai', value: { providers: { relay: { api: 'openai-responses', baseURL: 'https://relay.example/v1' } } } },
      ],
      update: async () => {},
    }
    const { listeners } = mount(settings)
    const listener = listeners.get('llm/stream')?.[0]
    expect(listener).toBeDefined()
    const overflow = {
      type: 'finish' as const,
      reason: {
        kind: 'error' as const,
        failure: {
          message: 'pi-ai detected context overflow for model "gpt-5.6-luna"',
          code: 'CONTEXT_WINDOW_EXCEEDED',
        },
      },
    }
    const source = async function* () {
      yield {
        type: 'usage',
        usage: { inputTokens: 867, outputTokens: 90, cacheReadTokens: 282_240 },
      } as never
      yield overflow as never
    }
    let ordinaryCalls = 0
    const ordinary = listener!({
      provider: 'relay',
      model: 'gpt-5.6-luna',
      messages: [],
      contextWindow: 400_000,
    }, () => {
      ordinaryCalls += 1
      return source()
    }) as AsyncIterable<unknown>
    expect((await collectChunks(ordinary)).at(-1)).toEqual({ type: 'finish', reason: { kind: 'stop' } })
    expect(ordinaryCalls).toBe(1)

    let titleCalls = 0
    const title = listener!({
      provider: 'relay',
      model: 'gpt-5.6-luna',
      messages: [],
      contextWindow: 400_000,
      purpose: 'session-title',
    }, () => {
      titleCalls += 1
      return source()
    }) as AsyncIterable<unknown>
    expect((await collectChunks(title)).at(-1)).toEqual(overflow)
    expect(titleCalls).toBe(1)

    const originalFetch = globalThis.fetch
    let compactionCalls = 0
    globalThis.fetch = async () => { throw new TypeError('compact endpoint unavailable') }
    try {
      const compaction = listener!({
        provider: 'relay',
        model: 'gpt-5.6-luna',
        messages: [],
        contextWindow: 400_000,
        purpose: 'compaction',
      }, () => {
        compactionCalls += 1
        return source()
      }) as AsyncIterable<unknown>
      expect((await collectChunks(compaction)).at(-1)).toEqual({ type: 'finish', reason: { kind: 'stop' } })
      expect(compactionCalls).toBe(1)
    } finally {
      globalThis.fetch = originalFetch
    }
  })

  it('repairs compaction overflow from the live setting when remote compaction is disabled', async () => {
    const settings = {
      describe: () => [
        { ns: CODEX_SETTINGS_NAMESPACE, value: { ...CODEX_SETTINGS_ENTRY, contextWindow: 400_000, remoteCompactionEnabled: false } },
        { ns: 'llm-pi-ai', value: { providers: { relay: { api: 'openai-responses', baseURL: 'https://relay.example/v1' } } } },
      ],
      update: async () => {},
    }
    const { listeners } = mount(settings)
    const listener = listeners.get('llm/stream')?.[0]
    expect(listener).toBeDefined()
    const source = async function* () {
      yield {
        type: 'usage',
        usage: { inputTokens: 867, outputTokens: 90, cacheReadTokens: 282_240 },
      } as never
      yield {
        type: 'finish',
        reason: {
          kind: 'error',
          failure: {
            message: 'pi-ai detected context overflow for model "gpt-5.6-luna"',
            code: 'CONTEXT_WINDOW_EXCEEDED',
          },
        },
      } as never
    }
    const compaction = listener!({
      provider: 'relay',
      model: 'gpt-5.6-luna',
      messages: [],
      purpose: 'compaction',
    }, source) as AsyncIterable<unknown>

    expect((await collectChunks(compaction)).at(-1)).toEqual({ type: 'finish', reason: { kind: 'stop' } })
  })

  it('forwards service_tier and custom apply_patch to responses/compact and retries 400/422 before local fallback', async () => {
    const originalFetch = globalThis.fetch
    const compactBodies: Array<Record<string, unknown>> = []
    globalThis.fetch = async (input, init) => {
      const req = new Request(input, init)
      const body = JSON.parse(await req.text()) as Record<string, unknown>
      compactBodies.push(body)
      if (compactBodies.length === 1) return new Response('custom grammar unsupported on compact', { status: 422 })
      return Response.json({ output: [{ type: 'compaction', encrypted_content: 'compact-ok' }] })
    }
    const ctx = {
      get: (name: string) => name === 'settings'
        ? { describe: () => [{ ns: 'llm-pi-ai', value: { providers: { relay: { api: 'openai-responses', baseURL: 'https://relay.example/v1', apiKeyEnv: 'RELAY_KEY' } } } }] }
        : { resolve: async () => ({ value: 'secret' }) },
      logger: { warn: () => {} },
    } as unknown as Context
    try {
      const chunks = await collectChunks(remoteCompactStream(ctx, {
        provider: 'relay',
        model: 'gpt-5.4',
        messages: [
          { role: 'user', content: [{ type: 'text', text: 'history' }] },
          { role: 'user', content: [{ type: 'text', text: 'compact' }] },
        ],
        tools: [{ name: 'apply_patch', description: 'patch', parameters: {} }, { name: 'web_search', description: 'search', parameters: {} }],
        purpose: 'compaction',
      } as never, async function* () { yield { type: 'text-delta', index: 0, text: 'fallback' } as never }, { serviceTier: 'priority' }))

      expect(compactBodies).toHaveLength(2)
      expect(compactBodies[0]!.service_tier).toBe('priority')
      expect((compactBodies[0]!.tools as Array<{ type: string; name: string }>).map(t => `${t.type}:${t.name}`)).toEqual([
        'custom:apply_patch',
        'web_search:undefined',
      ])
      expect((compactBodies[1]!.tools as Array<{ type: string; name: string }>).map(t => `${t.type}:${t.name}`)).toEqual([
        'function:apply_patch',
        'function:web_search',
      ])
      expect(chunks).toContainEqual(expect.objectContaining({
        type: 'text-delta',
        text: '<codex-remote-compaction>compact-ok</codex-remote-compaction>',
      }))
    } finally {
      globalThis.fetch = originalFetch
    }
  })

  it('presents diff/terminal cards, drops fc_ ids on custom_tool_call, rewrites zstd bodies, and fixes compact wire details', async () => {
    const { definitions } = mount()
    const patchTool = definitions.find(d => d.name === 'apply_patch')!
    const execTool = definitions.find(d => d.name === 'exec_command')!
    const samplePatch = '*** Begin Patch\n*** Update File: a.ts\n@@\n-old\n+new\n*** End Patch'
    expect(patchTool.presentCall?.({ input: samplePatch })).toEqual({
      card: 'diff',
      title: 'Apply patch (1 file)',
      diffs: [{ path: 'a.ts', oldText: 'old', newText: 'new' }],
      locations: [{ path: 'a.ts' }],
    })
    expect(patchTool.presentResult?.({ input: samplePatch }, { content: [], isError: false })).toEqual({
      card: 'diff',
      title: 'Apply patch (1 file)',
      diffs: [{ path: 'a.ts', oldText: 'old', newText: 'new' }],
    })
    expect(execTool.presentCall?.({ cmd: 'sleep 10', run_in_background: true })).toMatchObject({ card: 'generic', kind: 'execute' })
    expect(execTool.presentResult?.({ cmd: 'echo ok' }, { content: [], isError: false, meta: { output: 'ok\n', exitCode: 0 } }))
      .toEqual({ card: 'terminal', output: 'ok\n', exitCode: 0 })

    // OpenAI function-call fc_* item ids are omitted on custom_tool_call replay.
    const replayed = rewriteCodexApplyPatchHistory({
      input: [
        { type: 'function_call', id: 'fc_123', call_id: 'call_1', name: 'apply_patch', arguments: JSON.stringify({ input: samplePatch }) },
        { type: 'function_call_output', call_id: 'call_1', output: 'ok' },
      ],
    })
    expect(replayed.input).toEqual([
      { type: 'custom_tool_call', call_id: 'call_1', name: 'apply_patch', input: samplePatch },
      { type: 'custom_tool_call_output', call_id: 'call_1', output: 'ok' },
    ])

    // zstd-compressed Responses requests (openai-codex-responses SSE) are decoded and rewritten.
    const originalFetch = globalThis.fetch
    let zstdSeen = false
    globalThis.fetch = async (input, init) => {
      const req = new Request(input, init)
      if (req.headers.get('content-encoding') === 'zstd') zstdSeen = true
      return Response.json({ ok: true })
    }
    const dispose = installHostedWebSearch()
    try {
      const payload = JSON.stringify({ model: 'gpt-5.4', tools: [{ type: 'function', name: 'web_search' }] })
      await (async function* () {
        yield* hostedWebSearchStream(async function* () {
          await globalThis.fetch('https://zstd.example/v1/responses', {
            method: 'POST',
            headers: { 'content-encoding': 'zstd' },
            body: typeof zstdCompressSync === 'function' ? new Uint8Array(zstdCompressSync(Buffer.from(payload))) : payload,
          })
        })
      })().next()
      expect(typeof zstdCompressSync !== 'function' || zstdSeen).toBe(true)

      // Remote compaction splits composite ids, maps images to placeholders, sends prompt_cache_key, omits max_output_tokens, and caches 404.
      let compactCalls = 0
      let capturedCompact: Record<string, unknown> | undefined
      globalThis.fetch = async (input, init) => {
        compactCalls++
        capturedCompact = JSON.parse(await new Request(input, init).text()) as Record<string, unknown>
        return new Response('not found', { status: 404 })
      }
      const ctx = {
        get: (name: string) => name === 'settings'
          ? { describe: () => [{ ns: 'llm-pi-ai', value: { providers: { relay: { api: 'openai-responses', baseURL: 'https://compact-404.invalid/v1', apiKeyEnv: 'K' } } } }] }
          : { resolve: async () => ({ value: 'secret' }) },
        logger: { warn: () => {} },
      } as unknown as Context
      const opts = {
        provider: 'relay',
        model: 'gpt-5.4',
        sessionId: 'sess-cache-1',
        maxTokens: 4096,
        messages: [
          { role: 'user', content: [{ type: 'text', text: 'look' }, { type: 'image', attachment: {} }] },
          { role: 'assistant', content: [{ type: 'tool-call', id: 'call_abc|fc_xyz', name: 'read', arguments: '{}' }] },
          { role: 'tool', toolCallId: 'call_abc|fc_xyz', content: [{ type: 'text', text: 'ok' }] },
          { role: 'user', content: [{ type: 'text', text: 'local instruction' }] },
        ],
        purpose: 'compaction',
      } as never
      await collectChunks(remoteCompactStream(ctx, opts, async function* () { yield { type: 'finish', reason: { kind: 'stop' } } as never }))
      await collectChunks(remoteCompactStream(ctx, opts, async function* () { yield { type: 'finish', reason: { kind: 'stop' } } as never }))
      expect(compactCalls).toBe(1)
      expect(capturedCompact?.prompt_cache_key).toBe('sess-cache-1')
      expect(capturedCompact).not.toHaveProperty('max_output_tokens')
      expect(capturedCompact?.input).toEqual([
        { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'look[image omitted]' }] },
        { type: 'function_call', call_id: 'call_abc', name: 'read', arguments: '{}' },
        { type: 'function_call_output', call_id: 'call_abc', output: 'ok' },
      ])
    } finally {
      dispose()
      globalThis.fetch = originalFetch
    }
  })
})
