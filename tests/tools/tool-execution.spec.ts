import { afterEach, describe, expect, it, vi } from 'vitest'
import { readFile, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { BlockAssembler } from '@deepseek-ai/dsh-llm'
import type { ToolCallBlock } from '@deepseek-ai/dsh-llm'
import { FsError } from '@deepseek-ai/dsh-fs'
import { sandboxDenialMarker } from '@deepseek-ai/dsh-sandbox'
import * as PiAiPlugin from '@deepseek-ai/dsh-llm-pi-ai'
import { call, ControlledShell, createToolHarness, rawCall } from '../fixtures/tool-execution-fixture.ts'

type Harness = Awaited<ReturnType<typeof createToolHarness>>
const harnesses: Harness[] = []
async function harness(options?: Parameters<typeof createToolHarness>[0]) {
  const value = await createToolHarness(options)
  harnesses.push(value)
  return value
}
afterEach(async () => {
  vi.useRealTimers()
  for (const value of harnesses.splice(0).reverse()) await value.dispose()
  vi.restoreAllMocks()
})
const resultText = (result: { content: Array<{ type: string; text?: string }> }) =>
  result.content.map(block => block.text ?? '').join('\n')

function customToolSse(input: string): string {
  const item = { type: 'custom_tool_call', id: 'ctc_patch_1', call_id: 'call_patch_1', name: 'apply_patch', input, status: 'completed' }
  const middle = Math.floor(input.length / 2)
  return sse([
    { type: 'response.created', response: { id: 'resp_protocol_1', status: 'in_progress', output: [] } },
    { type: 'response.output_item.added', output_index: 0, item: { ...item, input: '', status: 'in_progress' } },
    { type: 'response.custom_tool_call_input.delta', output_index: 0, item_id: item.id, delta: input.slice(0, middle) },
    { type: 'response.custom_tool_call_input.delta', output_index: 0, item_id: item.id, delta: input.slice(middle) },
    { type: 'response.custom_tool_call_input.done', output_index: 0, item_id: item.id, input },
    { type: 'response.output_item.done', output_index: 0, item },
    { type: 'response.completed', response: { id: 'resp_protocol_1', status: 'completed', output: [item], usage: {
      input_tokens: 10, output_tokens: 5, total_tokens: 15,
    } } },
  ])
}
function textSse(): string {
  const item = { type: 'message', id: 'msg_done', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: 'Done.', annotations: [] }] }
  return sse([
    { type: 'response.created', response: { id: 'resp_protocol_2', status: 'in_progress', output: [] } },
    { type: 'response.output_item.done', output_index: 0, item },
    { type: 'response.completed', response: { id: 'resp_protocol_2', status: 'completed', output: [item], usage: {
      input_tokens: 20, output_tokens: 2, total_tokens: 22,
    } } },
  ])
}
function sse(events: Array<{ type: string; [key: string]: unknown }>): string {
  return events.map(event => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join('')
}

describe('real Context + ToolsService + native executor', () => {
  it('creates, updates, moves, and deletes real files through the official filesystem provider', async () => {
    const h = await harness()
    const patches = [
      { input: '*** Begin Patch\n*** Add File: note.txt\n+one\n*** End Patch', operation: 'created', path: 'note.txt' },
      { input: '*** Begin Patch\n*** Update File: note.txt\n@@\n-one\n+two\n*** End Patch', operation: 'updated', path: 'note.txt' },
      { input: '*** Begin Patch\n*** Update File: note.txt\n*** Move to: moved.txt\n*** End Patch', operation: 'moved', path: 'note.txt', moveTo: 'moved.txt' },
      { input: '*** Begin Patch\n*** Delete File: moved.txt\n*** End Patch', operation: 'deleted', path: 'moved.txt' },
    ]
    for (const [index, patch] of patches.entries()) {
      const batch = await h.dispatch([call('apply_patch', { input: patch.input })])
      expect(batch.results).toHaveLength(1)
      const result = batch.results[0]!.result
      expect(result.isError, `${patch.operation}: ${resultText(result)}`).toBe(false)
      expect(result.value).toEqual({ files: [{
        path: patch.path, operation: patch.operation,
        ...patch.moveTo === undefined ? {} : { moveTo: patch.moveTo },
      }] })
      expect(resultText(result)).toContain('Success. Updated the following files:')
      if (index < 2) expect(await readFile(join(h.root, 'note.txt'), 'utf8')).toBe(index === 0 ? 'one\n' : 'two\n')
      if (index === 2) {
        expect(await readFile(join(h.root, 'moved.txt'), 'utf8')).toBe('two\n')
        await expect(stat(join(h.root, 'note.txt'))).rejects.toMatchObject({ code: 'ENOENT' })
      }
    }
    await expect(stat(join(h.root, 'moved.txt'))).rejects.toMatchObject({ code: 'ENOENT' })
    expect(h.session.snapshotEvents().filter(event => event.type === 'tool/result')).toHaveLength(4)
  })

  it('preserves missing-file and schema errors as failed results and durable tool/result events', async () => {
    const h = await harness()
    const missing = await h.dispatch([call('apply_patch', {
      input: '*** Begin Patch\n*** Update File: missing.txt\n@@\n-before\n+after\n*** End Patch',
    })])
    expect(missing.results[0]!.result.isError).toBe(true)
    expect(resultText(missing.results[0]!.result)).toContain('apply_patch: file not found:')
    const invalid = await h.dispatch([
      call('exec_command', { cmd: 123 }),
      call('write_stdin', { session_id: 'invalid' }),
      call('apply_patch', { input: 123 }),
      call('update_plan', { plan: [{ step: 'Work', status: 'wrong' }] }),
    ])
    for (const outcome of invalid.results) {
      expect(outcome.result).toMatchObject({ isError: true, error: { info: { code: 'INVALID_ARGS' } } })
    }
    const logged = h.session.snapshotEvents().filter(event => event.type === 'tool/result')
    expect(logged).toHaveLength(5)
    expect(logged.every(event => event.data.message.isError === true)).toBe(true)
    expect(logged.slice(1).every(event => event.data.error?.code === 'INVALID_ARGS')).toBe(true)
    await expect(stat(join(h.root, 'missing.txt'))).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('keeps raw non-JSON native arguments invalid rather than hiding protocol failures', async () => {
    const h = await harness()
    const batch = await h.dispatch([rawCall('apply_patch', '*** Begin Patch\n*** Add File: raw.txt\n+not written\n*** End Patch')])
    expect(batch.results[0]!.result).toMatchObject({ isError: true, error: { info: { code: 'INVALID_ARGS' } } })
    await expect(stat(join(h.root, 'raw.txt'))).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('writes update_plan state through native dispatch to the actual Session log', async () => {
    const h = await harness()
    const batch = await h.dispatch([call('update_plan', {
      plan: [{ step: 'Review', status: 'completed' }, { step: 'Verify', status: 'in_progress' }],
    })])
    expect(batch.results[0]!.result).toMatchObject({ isError: false, value: {} })
    expect(resultText(batch.results[0]!.result)).toBe('Plan updated')
    expect(h.session.snapshotEvents().findLast(event => event.type === 'todo/write')?.data).toEqual({ todos: [
      { content: 'Review', status: 'completed' }, { content: 'Verify', status: 'in_progress' },
    ] })
  })

  it('dispatches exec_command then write_stdin against a deterministic ShellExecutor (no OS process)', async () => {
    const h = await harness()
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    const pending = h.dispatch([call('exec_command', { cmd: 'running', yield_time_ms: 0 })])
    await vi.advanceTimersByTimeAsync(30_000)
    const started = await pending
    expect(started.results[0]!.result).toMatchObject({ isError: false, value: { session_id: 1 } })
    const provider = h.ctx.shell as ControlledShell
    provider.processes[0]!.complete()
    const polled = await h.dispatch([call('write_stdin', { session_id: 1, chars: '' })])
    expect(polled.results[0]!.result).toMatchObject({ isError: false, value: { exit_code: 0, output: 'finished\n' } })
    const retired = await h.dispatch([call('write_stdin', { session_id: 1 })])
    expect(retired.results[0]!.result.isError).toBe(true)
    expect(resultText(retired.results[0]!.result)).toContain('unknown unified exec session 1')
  })

  it('distinguishes shell infrastructure failure from an ordinary nonzero exit', async () => {
    const h = await harness()
    const failed = await h.dispatch([call('exec_command', { cmd: 'infrastructure-failure' })])
    expect(failed.results[0]!.result).toMatchObject({ isError: true, error: {
      message: 'deterministic shell preparation failed', info: { code: 'TEST_SPAWN_FAILED' },
    } })
    const nonzero = await h.dispatch([call('exec_command', { cmd: 'nonzero-exit' })])
    expect(nonzero.results[0]!.result).toMatchObject({ isError: false, value: { exit_code: 7 } })
  })

  it('does not advertise legacy shell/login controls on exec_command', async () => {
    const h = await harness()
    const definition = h.ctx.tools.get('exec_command')!
    expect(definition.parameters.properties).not.toHaveProperty('shell')
    expect(definition.parameters.properties).not.toHaveProperty('login')
    expect(definition.description).toContain('host-configured shell')
  })

  it('includes cwd hint on missing relative apply_patch paths and appends sandbox denial marker on FS_SANDBOX_DENIED', async () => {
    const h = await harness()
    const missing = await h.dispatch([call('apply_patch', {
      input: '*** Begin Patch\n*** Update File: nope.txt\n@@\n-a\n+b\n*** End Patch',
    })])
    expect(resultText(missing.results[0]!.result)).toContain(`(cwd: ${h.root})`)

    h.ctx.provide('sandboxPolicy', { resolve: () => ({ mode: 'read-only', workspaceRoot: h.root }) } as never)
    vi.spyOn(h.ctx.fs, 'writeText').mockRejectedValueOnce(new FsError('blocked by sandbox', 'FS_SANDBOX_DENIED'))
    const denied = await h.dispatch([call('apply_patch', {
      input: '*** Begin Patch\n*** Add File: blocked.txt\n+hi\n*** End Patch',
    })])
    expect(denied.results[0]!.result.isError).toBe(true)
    expect(resultText(denied.results[0]!.result)).toContain(sandboxDenialMarker('read-only'))
  })

  it('rejects update_plan while plan/mode is active in the session', async () => {
    const h = await harness()
    h.session.append('plan/mode' as never, { active: true } as never)
    const batch = await h.dispatch([call('update_plan', {
      plan: [{ step: 'Should fail in plan mode', status: 'in_progress' }],
    })])
    expect(batch.results[0]!.result.isError).toBe(true)
    expect(resultText(batch.results[0]!.result)).toContain('not allowed in plan mode')
  })

  it('validates multi-file apply_patch atomically before mutating any file on disk', async () => {
    const h = await harness()
    await writeFile(join(h.root, 'a.txt'), 'before\n', 'utf8')
    const batch = await h.dispatch([call('apply_patch', {
      input: '*** Begin Patch\n*** Add File: b.txt\n+created\n*** Update File: a.txt\n@@\n-before\n+after\n*** Update File: missing.txt\n@@\n-nope\n+yes\n*** End Patch',
    })])
    expect(batch.results[0]!.result.isError).toBe(true)
    expect(resultText(batch.results[0]!.result)).toContain('apply_patch: file not found:')
    expect(await readFile(join(h.root, 'a.txt'), 'utf8')).toBe('before\n')
    await expect(stat(join(h.root, 'b.txt'))).rejects.toMatchObject({ code: 'ENOENT' })
  })
})

describe('mock HTTP SSE -> real current pi-ai parser -> native executor -> official filesystem', () => {
  it.each([
    { name: 'success', input: '*** Begin Patch\n*** Add File: protocol.txt\n+from custom tool\n*** End Patch', isError: false },
    { name: 'missing path', input: '*** Begin Patch\n*** Update File: missing.txt\n@@\n-before\n+after\n*** End Patch', isError: true },
  ])('preserves $name and replays a correlated custom tool result', async ({ input, isError }) => {
    const requests: Record<string, any>[] = []
    const fetch = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      const request = new Request(input, init)
      expect(new URL(request.url).host).toBe('codex-protocol.invalid')
      requests.push(JSON.parse(await request.text()))
      return new Response(requests.length === 1 ? customToolSse(inputPatch) : textSse(), {
        headers: { 'content-type': 'text/event-stream', 'x-request-id': `mock-${requests.length}` },
      })
    })
    const inputPatch = input
    const h = await harness({ globalEnhancements: true })
    h.ctx.provide('credentials', { resolve: async () => ({ value: 'sk-not-a-real-key' }) } as never)
    await h.ctx.plugin(PiAiPlugin, { providers: { relay: {
      api: 'openai-responses', baseURL: 'https://codex-protocol.invalid/v1', apiKeyEnv: 'TEST_PROTOCOL_KEY',
      transport: 'sse', models: [{ id: 'gpt-5.4', contextWindow: 400_000, maxTokens: 1024, input: ['text'], reasoningEfforts: false }],
      retryPolicy: { mode: 'normal', maxRetries: 0 },
    } } })
    const toolSet = await h.admit()
    const tools = h.ctx.tools.schemas(h.agent, toolSet)
    const assembler = new BlockAssembler()
    for await (const chunk of h.ctx.llm.stream({
      provider: 'relay', model: 'gpt-5.4', messages: h.session.deriveMessages(), tools, signal: h.signal,
    })) assembler.push(chunk)
    expect(assembler.finish.kind).toBe('tool-calls')
    const calls = assembler.blocks().filter((block): block is ToolCallBlock => block.type === 'tool-call')
    expect(calls).toHaveLength(1)
    expect(calls[0]!.name).toBe('apply_patch')
    expect(JSON.parse(calls[0]!.arguments)).toEqual({ input: inputPatch })
    expect(requests[0]!.tools.find((tool: any) => tool.name === 'apply_patch')).toMatchObject({ type: 'custom', format: { type: 'grammar' } })
    const batch = await h.dispatch(calls, toolSet, assembler.message({ provider: 'relay', model: 'gpt-5.4' }))
    expect(batch.results[0]!.result.isError).toBe(isError)
    if (isError) expect(resultText(batch.results[0]!.result)).toContain('file not found')
    else expect(await readFile(join(h.root, 'protocol.txt'), 'utf8')).toBe('from custom tool\n')
    const next = new BlockAssembler()
    for await (const chunk of h.ctx.llm.stream({
      provider: 'relay', model: 'gpt-5.4', messages: h.session.deriveMessages(), tools, signal: h.signal,
    })) next.push(chunk)
    expect(next.finish.kind).toBe('stop')
    const replayCall = requests[1]!.input.find((item: any) => item.type === 'custom_tool_call')
    const replayResult = requests[1]!.input.find((item: any) => item.type === 'custom_tool_call_output')
    expect(replayCall).toMatchObject({ name: 'apply_patch', input: inputPatch })
    expect(replayResult.call_id).toBe(replayCall.call_id)
    expect(replayResult.output).toContain(isError ? 'file not found' : 'Success.')
    expect(fetch).toHaveBeenCalledTimes(2)
  })
})
