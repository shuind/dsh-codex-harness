import { describe, expect, it } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import type { JobHooks, JobId, JobStart } from '@deepseek-ai/dsh-jobs'
import type { ShellExecRequest, ShellExecSpec, ShellProcess } from '@deepseek-ai/dsh-shell'
import type { ToolDefinition, ToolRunContext } from '@deepseek-ai/dsh-tools'
import { apply, enrichCodexModel } from '../src/index.ts'
import { normalizeWaitMs, runExecCommand, runWriteStdin } from '../src/exec.ts'
import { CODEX_SETTINGS_ENTRY, CODEX_SETTINGS_NAMESPACE } from '../src/settings.ts'
import {
  addCodexApplyPatch,
  addHostedWebSearch,
  hostedWebSearchStream,
  installHostedWebSearch,
  remoteCompactStream,
  rewriteCodexApplyPatchHistory,
  rewriteCodexResponsesBody,
  replaceRemoteCompactions,
} from '../src/remote.ts'

async function collectChunks(stream: AsyncIterable<unknown>): Promise<unknown[]> {
  const chunks: unknown[] = []
  for await (const chunk of stream) chunks.push(chunk)
  return chunks
}

function mount(
  settings?: { get(ns: unknown): unknown; update(ns: unknown, patch: object): Promise<void> },
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
    get: () => settings,
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

describe('Codex tool catalog', () => {
  it('normalizes unified exec wait times to Codex polling bounds', () => {
    expect(normalizeWaitMs(0, 0)).toBe(250)
    expect(normalizeWaitMs(100, 10_000)).toBe(250)
    expect(normalizeWaitMs(0, 0, false, true)).toBe(process.platform === 'win32' ? 10_000 : 250)
    expect(normalizeWaitMs(31_000, 0, false, true)).toBe(30_000)
    expect(normalizeWaitMs(0, 0, true)).toBe(5_000)
    expect(normalizeWaitMs(400_000, 0, true)).toBe(300_000)
  })

  it('forwards cancellation to pipe-backed exec processes', async () => {
    const controller = new AbortController()
    let resolved: ShellExecRequest | undefined
    let started: ShellExecSpec | undefined
    let kills = 0
    const shellProcess: ShellProcess = {
      status: 'running',
      exitCode: null,
      signal: null,
      // Resolve the initial wait immediately so this cancellation test does not
      // spend the native Windows 10-second initial-yield floor in real time.
      done: Promise.resolve(),
      readOutput: () => ({ delta: '', lossy: false }),
      kill: () => {
        kills++
        shellProcess.status = 'killed'
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

  it('detaches a pipe-backed command into the DSH job registry', async () => {
    const controller = new AbortController()
    const agent = { session: { header: {} } } as unknown as ToolRunContext['agent']
    let resolved: ShellExecRequest | undefined
    let resolveDone!: () => void
    let kills = 0
    const shellProcess: ShellProcess = {
      status: 'running',
      exitCode: null,
      signal: null,
      done: new Promise<void>(resolve => { resolveDone = resolve }),
      readOutput: () => ({ delta: 'background output\n', lossy: false }),
      kill: () => {
        kills++
        shellProcess.status = 'killed'
        resolveDone()
        return true
      },
    }
    let specSeen: JobStart | undefined
    let hooks: JobHooks | undefined
    const jobs = {
      start: (spec: JobStart): JobId => {
        specSeen = spec
        hooks = spec.run()
        return 'bash-1' as JobId
      },
    }
    const ctx = {
      shell: {
        resolve: (request: ShellExecRequest): ShellExecSpec => {
          resolved = request
          return request as unknown as ShellExecSpec
        },
        start: (): ShellProcess => shellProcess,
      },
      get: (name: string) => name === 'jobs' ? jobs : undefined,
    } as unknown as Context

    const result = await runExecCommand(ctx, {
      cmd: 'long-running command',
      run_in_background: true,
      max_output_tokens: 128,
    }, {
      agent,
      signal: controller.signal,
    } as unknown as ToolRunContext, {
      defaultYieldTimeMs: 10_000,
      maxOutputBytes: 1024,
    })

    expect(result.job_id).toBe('bash-1')
    expect(result.output).toContain('Use job_output with job_id "bash-1"')
    expect(specSeen).toMatchObject({ kind: 'bash', label: 'long-running command', owner: agent, outputLimitBytes: 512 })
    expect(resolved?.signal).toBeUndefined()
    expect(hooks).toBeDefined()

    // The tool-call signal is no longer the job's lifetime after detachment.
    controller.abort()
    expect(kills).toBe(0)

    shellProcess.status = 'completed'
    shellProcess.exitCode = 0
    resolveDone()
    await expect(hooks!.done).resolves.toEqual({ status: 'completed', detail: 'exit code: 0' })
  })

  it('does not spawn a background command without a jobs capability', async () => {
    const agent = { session: { header: {} } } as unknown as ToolRunContext['agent']
    let starts = 0
    const ctx = {
      shell: {
        resolve: (request: ShellExecRequest): ShellExecSpec => request as unknown as ShellExecSpec,
        start: (): ShellProcess => {
          starts++
          throw new Error('unexpected process start')
        },
      },
      get: () => undefined,
    } as unknown as Context

    await expect(runExecCommand(ctx, { cmd: 'long-running command', run_in_background: true }, {
      agent,
      signal: new AbortController().signal,
    } as unknown as ToolRunContext, {
      defaultYieldTimeMs: 10_000,
      maxOutputBytes: 1024,
    })).rejects.toThrow('background jobs unavailable')
    expect(starts).toBe(0)
  })

  it('rejects background PTY requests instead of silently changing execution mode', async () => {
    const agent = { session: { header: {} } } as unknown as ToolRunContext['agent']
    const ctx = { get: () => undefined } as unknown as Context

    await expect(runExecCommand(ctx, {
      cmd: 'long-running command',
      tty: true,
      run_in_background: true,
    }, {
      agent,
      signal: new AbortController().signal,
    } as unknown as ToolRunContext, {
      defaultYieldTimeMs: 10_000,
      maxOutputBytes: 1024,
    })).rejects.toThrow('only supported for pipe-backed commands')
  })

  it('kills a pipe-backed exec session when a later write_stdin call is cancelled', async () => {
    const startSignal = new AbortController().signal
    const stopController = new AbortController()
    const agent = { session: { header: {} } } as unknown as ToolRunContext['agent']
    let kills = 0
    const shellProcess: ShellProcess = {
      status: 'running',
      exitCode: null,
      signal: null,
      // Resolve the initial wait immediately; the later poll remains pending
      // until cancellation invokes kill().
      done: Promise.resolve(),
      readOutput: () => ({ delta: '', lossy: false }),
      kill: () => {
        kills++
        shellProcess.status = 'killed'
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
        ? { get: () => ({ providers: { relay: { api: 'openai-responses', baseURL: 'https://relay.example/v1', apiKeyEnv: 'RELAY_KEY' } } }) }
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
      get: (namespace: unknown) => namespace === CODEX_SETTINGS_NAMESPACE
        ? { ...CODEX_SETTINGS_ENTRY, contextWindow: 400_000 }
        : { providers: { relay: { api: 'openai-responses', baseURL: 'https://relay.example/v1' } } },
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
      get: (namespace: unknown) => namespace === CODEX_SETTINGS_NAMESPACE
        ? { ...CODEX_SETTINGS_ENTRY, contextWindow: 400_000, remoteCompactionEnabled: false }
        : { providers: { relay: { api: 'openai-responses', baseURL: 'https://relay.example/v1' } } },
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
      'Runs a shell command. By default it uses pipes: a running session can be polled for output but does not accept stdin. Set tty=true before starting a command that needs interactive input; background jobs use pipes.',
      'Polls output from an existing unified exec session. Non-empty chars can be sent only to a session created with tty=true; pipe-backed sessions accept empty chars for polling only.',
      'Edits files using Codex patch syntax with Begin/End Patch markers and file update directives. In hunk lines, the first character is the operation marker; repeat a source-leading marker when the source line itself starts with one.',
      'Updates the task plan.\nProvide an optional explanation and a list of plan items, each with a step and status.\nAt most one step can be in_progress at a time.',
    ])
  })

  it('keeps Codex prompt and core tools out of the global enhancement layer', () => {
    const global = mount(undefined, { globalEnhancements: true, codexCore: false })
    expect(global.definitions).toEqual([])
    expect(global.promptSections).toEqual([])

    const codex = mount(undefined, { globalEnhancements: false, codexCore: true })
    expect(codex.definitions.map(tool => tool.name)).toEqual([
      'exec_command',
      'write_stdin',
      'apply_patch',
      'update_plan',
    ])
    expect(codex.promptSections).toEqual(['codex:base'])
  })

  it('rejects stale calls after a Codex tool capability is disabled', async () => {
    const settingsValue = {
      ...CODEX_SETTINGS_ENTRY,
      terminalToolsEnabled: false,
      patchToolEnabled: false,
      planToolEnabled: false,
    }
    const { definitions } = mount({
      get: () => settingsValue,
      update: async () => {},
    })
    const execution = {
      signal: new AbortController().signal,
      deferContext: () => {},
      concludeTurn: () => {},
    } as unknown as ToolRunContext

    await expect(definitions.find(tool => tool.name === 'exec_command')!.execute({
      cmd: 'echo no',
    }, execution)).rejects.toThrow('disabled in Codex Harness plugin settings')
    await expect(definitions.find(tool => tool.name === 'apply_patch')!.execute({
      input: '*** Begin Patch\n*** End Patch',
    }, execution)).rejects.toThrow('disabled in Codex Harness plugin settings')
    await expect(definitions.find(tool => tool.name === 'update_plan')!.execute({
      plan: [],
    }, execution)).rejects.toThrow('disabled in Codex Harness plugin settings')
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
        run_in_background: { type: 'boolean', description: 'Run as a DSH background job and return its job id immediately; collect output with job_output and stop it with job_kill. Only supported for pipe-backed commands.' },
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
        job_id: { type: 'string' },
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

  it('renders a background job id in the unified exec result', () => {
    const { definitions } = mount()
    const exec = definitions.find(definition => definition.name === 'exec_command')!
    const value = {
      wall_time_seconds: 0.01,
      job_id: 'bash-1',
      output: 'Started background job bash-1.',
    }
    expect(exec.output.render({}, value as never)).toEqual([{
      type: 'text',
      text: 'Wall time: 0.0100 seconds\nBackground job ID: bash-1\nOutput:\nStarted background job bash-1.',
    }])
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
