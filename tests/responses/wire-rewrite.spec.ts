import { describe, expect, it } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import type { ToolDefinition } from '@deepseek-ai/dsh-tools'
import { apply } from '../../src/entries/index.ts'
import { CODEX_SETTINGS_ENTRY } from '../../src/contracts/settings.ts'
import {
  addCodexApplyPatch,
  addHostedWebSearch,
  replaceRemoteCompactions,
  rewriteCodexApplyPatchHistory,
  rewriteCodexResponsesBody,
} from '../../src/responses/wire-rewrite.ts'
import { hostedWebSearchStream, installHostedWebSearch } from '../../src/responses/fetch-transport.ts'

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

describe('Codex Responses wire rewrites', () => {
  it('emits a native Responses hosted web_search tool and removes the local function tool', () => {
    const body = addHostedWebSearch({
      model: 'gpt-5.4',
      tools: [
        { type: 'function', name: 'web_search', parameters: {} },
        { type: 'function', name: 'apply_patch', parameters: {} },
      ],
    })
    expect(body.tools).toEqual([
      { type: 'function', name: 'apply_patch', parameters: {} },
      { type: 'web_search', external_web_access: true },
    ])
  })

  it('emits apply_patch as a Responses custom tool with the Codex Lark grammar', () => {
    const body = addCodexApplyPatch({
      model: 'gpt-5.4',
      tools: [{
        type: 'function',
        name: 'apply_patch',
        description: 'patch files',
        parameters: { type: 'object' },
      }, {
        type: 'function',
        name: 'exec_command',
      }],
    })
    expect(body.tools).toEqual([{
      type: 'custom',
      name: 'apply_patch',
      description: 'patch files',
      format: expect.objectContaining({
        type: 'grammar',
        syntax: 'lark',
        definition: expect.stringContaining('start: begin_patch hunk+ end_patch'),
      }),
    }, {
      type: 'function',
      name: 'exec_command',
    }])
  })

  it('replays generic apply_patch history as Responses custom tool items', () => {
    const patch = '*** Begin Patch\n*** Add File: note.txt\n+hello\n*** End Patch'
    expect(rewriteCodexApplyPatchHistory({
      input: [
        {
          type: 'function_call',
          id: 'fc-1',
          call_id: 'call-1',
          name: 'apply_patch',
          arguments: JSON.stringify({ input: patch }),
        },
        { type: 'function_call_output', call_id: 'call-1', output: 'ok' },
      ],
    })).toEqual({
      input: [
        {
          type: 'custom_tool_call',
          id: 'fc-1',
          call_id: 'call-1',
          name: 'apply_patch',
          input: patch,
        },
        { type: 'custom_tool_call_output', call_id: 'call-1', output: 'ok' },
      ],
    })
  })

  it('composes hosted search, compaction, and apply_patch rewrites at one wire boundary', () => {
    const body = rewriteCodexResponsesBody({
      model: 'gpt-5.4',
      input: [{
        type: 'message',
        role: 'user',
        content: [{ type: 'input_text', text: '<codex-remote-compaction>opaque</codex-remote-compaction>' }],
      }],
      tools: [
        { type: 'function', name: 'web_search' },
        { type: 'function', name: 'apply_patch', description: 'patch files', parameters: {} },
      ],
    })
    expect(body.tools).toEqual([
      { type: 'custom', name: 'apply_patch', description: 'patch files', format: expect.any(Object) },
      { type: 'web_search', external_web_access: true },
    ])
    expect(body.input).toEqual([{ type: 'compaction', encrypted_content: 'opaque' }])
  })

  it('keeps disabled hosted and custom-tool capabilities on the generic Responses path', () => {
    const body = rewriteCodexResponsesBody({
      model: 'gpt-5.4',
      tools: [
        { type: 'function', name: 'web_search' },
        { type: 'function', name: 'apply_patch', description: 'patch files', parameters: {} },
      ],
    }, {
      hostedWebSearch: false,
      customApplyPatch: false,
    })
    expect(body.tools).toEqual([
      { type: 'function', name: 'web_search' },
      { type: 'function', name: 'apply_patch', description: 'patch files', parameters: {} },
    ])
  })

  it('leaves deferred web_search definitions untouched until activated', () => {
    const deferred = rewriteCodexResponsesBody({
      model: 'gpt-5.4',
      tools: [{ type: 'function', name: 'web_search', defer_loading: true }],
    })
    expect(deferred.tools).toEqual([{ type: 'function', name: 'web_search', defer_loading: true }])

    const active = rewriteCodexResponsesBody({
      model: 'gpt-5.4',
      tools: [{ type: 'function', name: 'web_search' }],
    })
    expect(active.tools).toEqual([{ type: 'web_search', external_web_access: true }])
  })

  it('restores a remote compaction item at the final Responses wire boundary', () => {
    expect(replaceRemoteCompactions({
      input: [{
        type: 'message',
        role: 'user',
        content: [{ type: 'input_text', text: '<compacted-summary><codex-remote-compaction>opaque</codex-remote-compaction></compacted-summary>' }],
      }],
    })).toEqual({
      input: [{ type: 'compaction', encrypted_content: 'opaque' }],
    })
  })

  it('limits hosted request rewriting to the Codex stream scope and preserves fallback errors', async () => {
    const originalFetch = globalThis.fetch
    const requests: object[] = []
    globalThis.fetch = async (input, init) => {
      const request = new Request(input, init)
      requests.push(JSON.parse(await request.text()))
      return Response.json({ ok: true })
    }
    const dispose = installHostedWebSearch()
    try {
      await globalThis.fetch('https://relay.example/v1/responses', {
        method: 'POST',
        body: JSON.stringify({ model: 'gpt-5.4', tools: [{ type: 'function', name: 'web_search' }] }),
      })
      await (async function* () {
        yield* hostedWebSearchStream(async function* () {
          await globalThis.fetch('https://relay.example/v1/responses', {
            method: 'POST',
            body: JSON.stringify({ model: 'gpt-5.4', tools: [{ type: 'function', name: 'web_search' }] }),
          })
        })
      })().next()
    } finally {
      dispose()
      globalThis.fetch = originalFetch
    }
    expect(requests[0]).toEqual({ model: 'gpt-5.4', tools: [{ type: 'function', name: 'web_search' }] })
    expect(requests[1]).toEqual({
      model: 'gpt-5.4',
      tools: [{ type: 'web_search', external_web_access: true }],
    })
  })

  it('falls back to the untouched local request when hosted fetch throws', async () => {
    const originalFetch = globalThis.fetch
    const requests: object[] = []
    let calls = 0
    globalThis.fetch = async (input, init) => {
      calls += 1
      if (calls === 1) throw new TypeError('network unavailable')
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
            body: JSON.stringify({ model: 'gpt-5.4', tools: [{ type: 'function', name: 'web_search' }] }),
          })
        })
      })().next()
    } finally {
      dispose()
      globalThis.fetch = originalFetch
    }
    expect(calls).toBe(2)
    expect(requests).toEqual([{ model: 'gpt-5.4', tools: [{ type: 'function', name: 'web_search' }] }])
  })

  it('leaves GPT requests without Codex-managed tools untouched', async () => {
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
            body: JSON.stringify({ model: 'gpt-5.4', tools: [{ type: 'function', name: 'exec_command' }] }),
          })
        })
      })().next()
    } finally {
      dispose()
      globalThis.fetch = originalFetch
    }
    expect(requests).toEqual([{ model: 'gpt-5.4', tools: [{ type: 'function', name: 'exec_command' }] }])
  })

  it('forwards Fast service tier through the official Responses adapter boundary', async () => {
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
              tools: [{ type: 'function', name: 'exec_command' }],
            }),
          })
        }, { serviceTier: 'priority' })
      })().next()
    } finally {
      dispose()
      globalThis.fetch = originalFetch
    }
    expect(requests).toEqual([{
      model: 'gpt-5.4',
      tools: [{ type: 'function', name: 'exec_command' }],
      service_tier: 'priority',
    }])
  })

  it('rewrites apply_patch at the Responses wire boundary and preserves its raw input', async () => {
    const originalFetch = globalThis.fetch
    const requests: object[] = []
    const patch = '*** Begin Patch\n*** Add File: note.txt\n+hello\n*** End Patch'
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
              tools: [{ type: 'function', name: 'apply_patch', description: 'patch files', parameters: {} }],
              input: [
                {
                  type: 'function_call',
                  call_id: 'call-1',
                  name: 'apply_patch',
                  arguments: JSON.stringify({ input: patch }),
                },
                { type: 'function_call_output', call_id: 'call-1', output: 'ok' },
              ],
            }),
          })
        })
      })().next()
    } finally {
      dispose()
      globalThis.fetch = originalFetch
    }
    expect(requests).toEqual([{
      model: 'gpt-5.4',
      tools: [{
        type: 'custom',
        name: 'apply_patch',
        description: 'patch files',
        format: expect.objectContaining({ type: 'grammar', syntax: 'lark' }),
      }],
      input: [
        { type: 'custom_tool_call', call_id: 'call-1', name: 'apply_patch', input: patch },
        { type: 'custom_tool_call_output', call_id: 'call-1', output: 'ok' },
      ],
    }])
  })

  it('falls back to the untouched apply_patch request when custom tools are rejected', async () => {
    const originalFetch = globalThis.fetch
    const requests: object[] = []
    let calls = 0
    globalThis.fetch = async (input, init) => {
      calls += 1
      const request = new Request(input, init)
      const body = JSON.parse(await request.text())
      if (calls === 1) return new Response('custom tools unsupported', { status: 400 })
      requests.push(body)
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
              tools: [{ type: 'function', name: 'apply_patch', description: 'patch files', parameters: {} }],
            }),
          })
        })
      })().next()
    } finally {
      dispose()
      globalThis.fetch = originalFetch
    }
    expect(calls).toBe(2)
    expect(requests).toEqual([{
      model: 'gpt-5.4',
      tools: [{ type: 'function', name: 'apply_patch', description: 'patch files', parameters: {} }],
    }])
  })
})
