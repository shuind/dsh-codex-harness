import { describe, expect, it } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import type { ShellExecRequest, ShellExecSpec, ShellProcess } from '@deepseek-ai/dsh-shell'
import type { ToolDefinition, ToolRunContext } from '@deepseek-ai/dsh-tools'
import { apply, enrichCodexModel } from '../src/index.ts'
import { normalizeWaitMs, runExecCommand, runWriteStdin } from '../src/exec.ts'
import {
  addHostedWebSearch,
  hostedWebSearchStream,
  installHostedWebSearch,
  remoteCompactStream,
  replaceRemoteCompactions,
} from '../src/remote.ts'

function mount(settings?: { get(ns: unknown): unknown; update(ns: unknown, patch: object): Promise<void> }): {
  definitions: ToolDefinition[]
  promptSections: string[]
} {
  const definitions: ToolDefinition[] = []
  const promptSections: string[] = []
  const ctx = {
    tools: { register: (definition: ToolDefinition) => { definitions.push(definition) } },
    systemPrompt: { section: (section: { name: string }) => { promptSections.push(section.name) } },
    fs: { sandboxMode: undefined },
    get: () => settings,
    on: () => () => {},
    inject: () => {},
  } as unknown as Context
  apply(ctx)
  return { definitions, promptSections }
}

describe('Codex tool catalog', () => {
  it('normalizes unified exec wait times to Codex polling bounds', () => {
    expect(normalizeWaitMs(0, 0)).toBe(250)
    expect(normalizeWaitMs(100, 10_000)).toBe(250)
    expect(normalizeWaitMs(31_000, 0)).toBe(30_000)
    expect(normalizeWaitMs(0, 0, true)).toBe(5_000)
    expect(normalizeWaitMs(400_000, 0, true)).toBe(300_000)
  })

  it('forwards cancellation to pipe-backed exec processes', async () => {
    const controller = new AbortController()
    let resolved: ShellExecRequest | undefined
    let started: ShellExecSpec | undefined
    let resolveDone!: () => void
    let kills = 0
    const shellProcess: ShellProcess = {
      status: 'running',
      exitCode: null,
      signal: null,
      done: new Promise<void>(resolve => { resolveDone = resolve }),
      readOutput: () => ({ delta: '', lossy: false }),
      kill: () => {
        kills++
        shellProcess.status = 'killed'
        resolveDone()
        return true
      },
    }
    const ctx = {
      shell: {
        resolve: (request: ShellExecRequest): ShellExecSpec => {
          resolved = request
          return request as unknown as ShellExecSpec
        },
        start: (spec: ShellExecSpec): ShellProcess => {
          started = spec
          spec.signal?.addEventListener('abort', () => { shellProcess.kill() }, { once: true })
          return shellProcess
        },
      },
      get: () => undefined,
    } as unknown as Context
    const exec = { signal: controller.signal } as unknown as ToolRunContext
    const pending = runExecCommand(ctx, { cmd: 'sleep 60', yield_time_ms: 30 }, exec, {
      defaultYieldTimeMs: 10,
      maxOutputBytes: 1024,
    })

    expect(resolved?.signal).toBe(controller.signal)
    expect(started?.signal).toBe(controller.signal)
    const reason = new Error('cancelled by test')
    controller.abort(reason)
    await expect(pending).rejects.toBe(reason)
    await shellProcess.done
    expect(kills).toBe(1)
    expect(shellProcess.status).toBe('killed')
  })

  it('kills a pipe-backed exec session when a later write_stdin call is cancelled', async () => {
    const startSignal = new AbortController().signal
    const stopController = new AbortController()
    const agent = { session: { header: {} } } as unknown as ToolRunContext['agent']
    let resolveDone!: () => void
    let kills = 0
    const shellProcess: ShellProcess = {
      status: 'running',
      exitCode: null,
      signal: null,
      done: new Promise<void>(resolve => { resolveDone = resolve }),
      readOutput: () => ({ delta: '', lossy: false }),
      kill: () => {
        kills++
        shellProcess.status = 'killed'
        resolveDone()
        return true
      },
    }
    const ctx = {
      shell: {
        resolve: (request: ShellExecRequest): ShellExecSpec => request as unknown as ShellExecSpec,
        start: (): ShellProcess => shellProcess,
      },
      get: () => undefined,
    } as unknown as Context
    const start = await runExecCommand(ctx, { cmd: 'sleep 60', yield_time_ms: 0 }, {
      agent,
      signal: startSignal,
    } as unknown as ToolRunContext, {
      defaultYieldTimeMs: 10,
      maxOutputBytes: 1024,
    })
    expect(start.session_id).toBe(1)

    const pending = runWriteStdin(ctx, { session_id: 1, yield_time_ms: 30_000 }, {
      agent,
      signal: stopController.signal,
    } as unknown as ToolRunContext, {
      pollYieldTimeMs: 30_000,
      writeYieldTimeMs: 30_000,
      maxOutputBytes: 1024,
    })
    const reason = new Error('cancelled later poll')
    stopController.abort(reason)
    await expect(pending).rejects.toBe(reason)
    await shellProcess.done
    expect(kills).toBe(1)
    expect(shellProcess.status).toBe('killed')

    await expect(runWriteStdin(ctx, { session_id: 1 }, {
      agent,
      signal: new AbortController().signal,
    } as unknown as ToolRunContext, {
      pollYieldTimeMs: 0,
      writeYieldTimeMs: 0,
      maxOutputBytes: 1024,
    })).rejects.toThrow('unknown unified exec session')
  })

  it('cleans up a PTY when the initial send cannot start', async () => {
    const agent = { session: { header: {} } } as unknown as ToolRunContext['agent']
    const reason = new Error('send setup failed')
    let killed = 0
    let closeReason = ''
    const ctx = {
      get: (name: string) => name === 'terminals' ? {
        spawn: async () => ({ sessionId: 'pty-1' }),
        startSend: () => { throw reason },
        kill: async (_owner: unknown, _id: unknown, cleanupReason: string) => {
          killed++
          closeReason = cleanupReason
          return true
        },
      } : undefined,
    } as unknown as Context

    await expect(runExecCommand(ctx, { cmd: 'echo test', tty: true }, {
      agent,
      signal: new AbortController().signal,
    } as unknown as ToolRunContext, {
      defaultYieldTimeMs: 10,
      maxOutputBytes: 1024,
    })).rejects.toBe(reason)
    expect(killed).toBe(1)
    expect(closeReason).toBe('Codex command failed')
  })

  it('cleans up a PTY when the initial send operation rejects', async () => {
    const agent = { session: { header: {} } } as unknown as ToolRunContext['agent']
    const reason = new Error('PTY transport failed')
    let killed = 0
    const ctx = {
      get: (name: string) => name === 'terminals' ? {
        spawn: async () => ({ sessionId: 'pty-2' }),
        startSend: () => ({ done: Promise.reject(reason) }),
        kill: async () => {
          killed++
          return true
        },
      } : undefined,
    } as unknown as Context

    await expect(runExecCommand(ctx, { cmd: 'echo test', tty: true }, {
      agent,
      signal: new AbortController().signal,
    } as unknown as ToolRunContext, {
      defaultYieldTimeMs: 10,
      maxOutputBytes: 1024,
    })).rejects.toBe(reason)
    expect(killed).toBe(1)
  })

  it('cleans up a stored PTY when a later send cannot start', async () => {
    const agent = { session: { header: {} } } as unknown as ToolRunContext['agent']
    const reason = new Error('later send setup failed')
    let sends = 0
    let killed = 0
    const ctx = {
      get: (name: string) => name === 'terminals' ? {
        spawn: async () => ({ sessionId: 'pty-stored-setup' }),
        startSend: () => {
          sends++
          if (sends > 1) throw reason
          return {
            done: Promise.resolve({
              viewport: 'running',
              sessionStatus: { kind: 'running' },
            }),
          }
        },
        kill: async () => {
          killed++
          return true
        },
      } : undefined,
    } as unknown as Context

    const started = await runExecCommand(ctx, { cmd: 'echo test', tty: true }, {
      agent,
      signal: new AbortController().signal,
    } as unknown as ToolRunContext, {
      defaultYieldTimeMs: 10,
      maxOutputBytes: 1024,
    })
    expect(started.session_id).toBe(1)

    await expect(runWriteStdin(ctx, { session_id: 1, chars: 'next' }, {
      agent,
      signal: new AbortController().signal,
    } as unknown as ToolRunContext, {
      pollYieldTimeMs: 5_000,
      writeYieldTimeMs: 250,
      maxOutputBytes: 1024,
    })).rejects.toBe(reason)
    expect(killed).toBe(1)
    await expect(runWriteStdin(ctx, { session_id: 1 }, {
      agent,
      signal: new AbortController().signal,
    } as unknown as ToolRunContext, {
      pollYieldTimeMs: 5_000,
      writeYieldTimeMs: 250,
      maxOutputBytes: 1024,
    })).rejects.toThrow('unknown unified exec session')
  })

  it('cleans up a stored PTY when a later send operation rejects', async () => {
    const agent = { session: { header: {} } } as unknown as ToolRunContext['agent']
    const reason = new Error('later PTY transport failed')
    let sends = 0
    let killed = 0
    const ctx = {
      get: (name: string) => name === 'terminals' ? {
        spawn: async () => ({ sessionId: 'pty-stored-done' }),
        startSend: () => {
          sends++
          return sends === 1
            ? {
                done: Promise.resolve({
                  viewport: 'running',
                  sessionStatus: { kind: 'running' },
                }),
              }
            : { done: Promise.reject(reason) }
        },
        kill: async () => {
          killed++
          return true
        },
      } : undefined,
    } as unknown as Context

    const started = await runExecCommand(ctx, { cmd: 'echo test', tty: true }, {
      agent,
      signal: new AbortController().signal,
    } as unknown as ToolRunContext, {
      defaultYieldTimeMs: 10,
      maxOutputBytes: 1024,
    })
    expect(started.session_id).toBe(1)

    await expect(runWriteStdin(ctx, { session_id: 1, chars: 'next' }, {
      agent,
      signal: new AbortController().signal,
    } as unknown as ToolRunContext, {
      pollYieldTimeMs: 5_000,
      writeYieldTimeMs: 250,
      maxOutputBytes: 1024,
    })).rejects.toBe(reason)
    expect(killed).toBe(1)
    await expect(runWriteStdin(ctx, { session_id: 1 }, {
      agent,
      signal: new AbortController().signal,
    } as unknown as ToolRunContext, {
      pollYieldTimeMs: 5_000,
      writeYieldTimeMs: 250,
      maxOutputBytes: 1024,
    })).rejects.toThrow('unknown unified exec session')
  })

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

  it('leaves GPT requests without web_search untouched', async () => {
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
            body: JSON.stringify({ model: 'gpt-5.4', tools: [{ type: 'function', name: 'apply_patch' }] }),
          })
        })
      })().next()
    } finally {
      dispose()
      globalThis.fetch = originalFetch
    }
    expect(requests).toEqual([{ model: 'gpt-5.4', tools: [{ type: 'function', name: 'apply_patch' }] }])
  })

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
        ? { get: () => ({ providers: { relay: { api: 'openai-responses', baseURL: 'https://relay.example/v1', apiKeyEnv: 'RELAY_KEY' } } }) }
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

  it('uses the configured Responses route for remote compaction and returns a replay marker', async () => {
    const originalFetch = globalThis.fetch
    let requestUrl = ''
    let requestBody: Record<string, unknown> | undefined
    globalThis.fetch = async (input, init) => {
      const request = new Request(input, init)
      requestUrl = request.url
      requestBody = JSON.parse(await request.text()) as Record<string, unknown>
      return Response.json({ output: [{ type: 'compaction', encrypted_content: 'opaque' }] })
    }
    const ctx = {
      get: (name: string) => name === 'settings'
        ? { get: () => ({ providers: { relay: { api: 'openai-responses', baseURL: 'https://relay.example/v1', apiKeyEnv: 'RELAY_KEY' } } }) }
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
  })

  it('adds image and reasoning defaults only to GPT models', () => {
    expect(enrichCodexModel({ id: 'gpt-5.4' })).toMatchObject({
      input: ['text', 'image'],
      reasoningEfforts: {
        low: 'low',
        medium: 'medium',
        high: 'high',
        xhigh: 'xhigh',
        max: 'max',
      },
    })
    expect(enrichCodexModel({ id: 'qwen3' })).toEqual({ id: 'qwen3' })
    expect(enrichCodexModel({
      id: 'gpt-5.4',
      input: ['text'],
      reasoningEfforts: { off: null, minimal: 'minimal', low: 'low' },
    })).toEqual({ id: 'gpt-5.4', input: ['text'], reasoningEfforts: { low: 'low' } })
    expect(enrichCodexModel({ id: 'gpt-5.4', input: ['text'], reasoningEfforts: false }))
      .toEqual({ id: 'gpt-5.4', input: ['text'], reasoningEfforts: false })
  })

  it('writes missing GPT capabilities into the configured llm-pi-ai model profile', async () => {
    const updates: object[] = []
    const settings = {
      get: () => ({
        providers: {
          relay: {
            models: [{ id: 'gpt-5.4', input: [], reasoningEfforts: {} }, { id: 'qwen3' }],
          },
        },
      }),
      update: (_ns: unknown, patch: object) => { updates.push(patch); return Promise.resolve() },
    }
    mount(settings)
    await Promise.resolve()
    expect(updates).toHaveLength(1)
    expect(updates[0]).toMatchObject({
      providers: {
        relay: {
          models: [{ id: 'gpt-5.4', input: ['text', 'image'] }, { id: 'qwen3' }],
        },
      },
    })
  })

  it('keeps modelOverrides keyed by id without inserting an invalid id field', async () => {
    const updates: object[] = []
    const settings = {
      get: () => ({ providers: { relay: { modelOverrides: { 'gpt-5.4': {} } } } }),
      update: (_ns: unknown, patch: object) => { updates.push(patch); return Promise.resolve() },
    }
    mount(settings)
    await Promise.resolve()
    expect(updates[0]).toMatchObject({
      providers: {
        relay: {
          modelOverrides: {
            'gpt-5.4': { input: ['text', 'image'], reasoningEfforts: { medium: 'medium' } },
          },
        },
      },
    })
    expect(JSON.stringify(updates[0])).not.toContain('"id":"gpt-5.4"')
  })

  it('registers only the four Codex core tools with exact descriptions', () => {
    const { definitions, promptSections } = mount()
    expect(definitions.map(definition => definition.name)).toEqual([
      'exec_command',
      'write_stdin',
      'apply_patch',
      'update_plan',
    ])
    expect(promptSections).toEqual(['codex:base'])
    expect(definitions.map(definition => definition.description)).toEqual([
      'Runs a command in a PTY, returning output or a session ID for ongoing interaction.',
      'Writes characters to an existing unified exec session and returns recent output.',
      'The `apply_patch` tool can be used to edit files. This is a FREEFORM tool, so do not wrap the patch in JSON.',
      'Updates the task plan.\nProvide an optional explanation and a list of plan items, each with a step and status.\nAt most one step can be in_progress at a time.',
    ])
  })

  it('keeps Codex parameter names and result schemas model-visible', () => {
    const { definitions } = mount()
    const exec = definitions.find(definition => definition.name === 'exec_command')
    const patch = definitions.find(definition => definition.name === 'apply_patch')
    expect(exec?.parameters).toEqual({
      type: 'object',
      properties: {
        cmd: { type: 'string', description: 'Shell command to execute.' },
        workdir: { type: 'string', description: 'Working directory for the command. Defaults to the turn cwd.' },
        tty: { type: 'boolean', description: 'True allocates a PTY for the command; false or omitted uses plain pipes.' },
        yield_time_ms: { type: 'number', description: 'Wait before yielding output. Defaults to 10000 ms; effective range is 250-30000 ms.' },
        max_output_tokens: { type: 'number', description: 'Output token budget. Defaults to 10000 tokens; larger requests may be capped by policy.' },
        shell: { type: 'string', description: "Shell binary to launch. Defaults to the user's default shell." },
        login: { type: 'boolean', description: 'True runs the shell with -l/-i semantics; false disables them. Defaults to true.' },
      },
      required: ['cmd'],
    })
    expect(exec?.output.schema).toEqual({
      type: 'object',
      additionalProperties: false,
      properties: {
        chunk_id: { type: 'string' },
        wall_time_seconds: { type: 'number' },
        exit_code: { type: 'number' },
        session_id: { type: 'number' },
        original_token_count: { type: 'number' },
        output: { type: 'string' },
      },
      required: ['wall_time_seconds', 'output'],
    })
    expect(patch?.parameters).toEqual({
      type: 'object',
      properties: {
        input: { type: 'string', description: 'The complete patch text.' },
      },
      required: ['input'],
    })
    const stdin = definitions.find(definition => definition.name === 'write_stdin')
    expect(stdin?.parameters).toMatchObject({
      properties: {
        session_id: {
          type: 'number',
          description: 'Identifier of the running unified exec session.',
        },
      },
    })
    const plan = definitions.find(definition => definition.name === 'update_plan')
    expect(plan?.parameters).toEqual({
      type: 'object',
      properties: {
        explanation: { type: 'string', description: 'Optional explanation for this plan update.' },
        plan: {
          type: 'array',
          description: 'The list of steps',
          items: {
              type: 'object',
              additionalProperties: false,
              properties: {
              step: { type: 'string', description: 'Task step text.' },
              status: { type: 'string', enum: ['pending', 'in_progress', 'completed'], description: 'Step status.' },
            },
            required: ['step', 'status'],
          },
        },
      },
      required: ['plan'],
    })
  })

  it('renders Codex-compatible apply_patch and plan results', () => {
    const { definitions } = mount()
    const patch = definitions.find(definition => definition.name === 'apply_patch')!
    const plan = definitions.find(definition => definition.name === 'update_plan')!
    expect(patch.output.render({}, { files: [{ path: 'a.ts', operation: 'updated' }] } as never))
      .toEqual([{ type: 'text', text: 'Success. Updated the following files:\nM a.ts\n' }])
    expect(plan.output.render({}, {} as never)).toEqual([{ type: 'text', text: 'Plan updated' }])
  })

  it('renders both unified exec results in Codex response text format', () => {
    const { definitions } = mount()
    const exec = definitions.find(definition => definition.name === 'exec_command')!
    const stdin = definitions.find(definition => definition.name === 'write_stdin')!
    const value = {
      chunk_id: 'abc123',
      wall_time_seconds: 1.25,
      exit_code: 0,
      output: 'done\n',
    }
    const expected = 'Chunk ID: abc123\nWall time: 1.2500 seconds\nProcess exited with code 0\nOutput:\ndone\n'
    expect(exec.output.render({}, value as never)).toEqual([{ type: 'text', text: expected }])
    expect(stdin.output.render({}, value as never)).toEqual([{ type: 'text', text: expected }])
  })

  it('writes update_plan state to the session event stream', async () => {
    const { definitions } = mount()
    const plan = definitions.find(definition => definition.name === 'update_plan')!
    const events: unknown[] = []
    const execution = {
      agent: { session: { append: (type: string, data: unknown) => { events.push({ type, data }) } } },
      deferContext: () => {},
      concludeTurn: () => {},
    } as unknown as ToolRunContext
    await plan.execute({
      plan: [{ step: 'Inspect the repository', status: 'completed' }, { step: 'Implement the fix', status: 'in_progress' }],
    }, execution)
    expect(events).toEqual([{
      type: 'todo/write',
      data: { todos: [
        { content: 'Inspect the repository', status: 'completed' },
        { content: 'Implement the fix', status: 'in_progress' },
      ] },
    }])
  })
})
