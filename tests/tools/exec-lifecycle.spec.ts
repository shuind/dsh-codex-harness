import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { getEventListeners } from 'node:events'
import type { Context } from '@deepseek-ai/cordis'
import type { ShellExecRequest, ShellExecSpec, ShellProcess } from '@deepseek-ai/dsh-shell'
import type { ToolExecution } from '@deepseek-ai/dsh-tools'
import { disposeAgentExecSessions, runExecCommand, runWriteStdin } from '../../src/tools/exec-runner.ts'

function fixture() {
  let finish!: () => void
  let buffer = ''
  const process: ShellProcess = {
    status: 'running', exitCode: null, signal: null,
    done: new Promise<void>(resolve => { finish = resolve }),
    readOutput: vi.fn(() => {
      const delta = buffer
      buffer = ''
      return { delta, lossy: false }
    }),
    kill: vi.fn(() => {
      process.status = 'killed'
      finish()
      return true
    }),
  }
  const ctx = {
    get: (name: string) => name === 'shell' ? ctx.shell : undefined,
    shell: {
      resolve: (request: ShellExecRequest) => request as unknown as ShellExecSpec,
      execute: vi.fn(async () => process),
    },
  } as unknown as Context
  const controller = new AbortController()
  const agent = { session: { header: {} } } as unknown as ToolExecution['agent']
  const exec = { agent, signal: controller.signal } as ToolExecution
  const config = { defaultYieldTimeMs: 30_000, maxOutputBytes: 1024 }
  return {
    ctx, process, controller, exec, config, agent: agent!,
    emit: (text: string) => { buffer += text },
    complete: () => { process.status = 'completed'; process.exitCode = 0; finish() },
  }
}

describe('unified exec lifecycle', () => {
  beforeEach(() => { vi.useFakeTimers() })
  afterEach(() => { vi.clearAllTimers(); vi.useRealTimers() })

  it('disposes the deadline and abort listener when initial execution completes early', async () => {
    const f = fixture()
    const pending = runExecCommand(f.ctx, { cmd: 'echo done' }, f.exec, f.config)
    for (let i = 0; i < 5; i++) await Promise.resolve()
    expect(vi.getTimerCount()).toBe(1)
    expect(getEventListeners(f.controller.signal, 'abort')).toHaveLength(1)
    f.emit('done')
    f.complete()
    await expect(pending).resolves.toMatchObject({ output: 'done', exit_code: 0 })
    expect(vi.getTimerCount()).toBe(0)
    expect(getEventListeners(f.controller.signal, 'abort')).toHaveLength(0)
    expect(f.process.kill).not.toHaveBeenCalled()
  })

  it('disposes a five-minute poll deadline when the process completes early', async () => {
    const f = fixture()
    const started = runExecCommand(f.ctx, { cmd: 'long command' }, f.exec, f.config)
    await vi.advanceTimersByTimeAsync(30_000)
    const { session_id } = await started
    expect(vi.getTimerCount()).toBe(0)
    expect(getEventListeners(f.controller.signal, 'abort')).toHaveLength(0)
    const pending = runWriteStdin(f.ctx, { session_id: session_id!, yield_time_ms: 300_000 }, f.exec, {
      pollYieldTimeMs: 300_000, writeYieldTimeMs: 250, maxOutputBytes: 1024,
    })
    expect(vi.getTimerCount()).toBe(1)
    f.complete()
    await expect(pending).resolves.toMatchObject({ exit_code: 0 })
    expect(vi.getTimerCount()).toBe(0)
    expect(getEventListeners(f.controller.signal, 'abort')).toHaveLength(0)
  })

  it('kills yielded pipe-backed shell sessions when disposing an agent', async () => {
    const f = fixture()
    const started = runExecCommand(f.ctx, { cmd: 'tail -f log' }, f.exec, f.config)
    await vi.advanceTimersByTimeAsync(30_000)
    const { session_id } = await started
    expect(session_id).toBe(1)
    expect(f.process.kill).not.toHaveBeenCalled()

    disposeAgentExecSessions(f.agent)
    expect(f.process.kill).toHaveBeenCalledTimes(1)
    await expect(runWriteStdin(f.ctx, { session_id: session_id! }, f.exec, {
      pollYieldTimeMs: 5_000, writeYieldTimeMs: 250, maxOutputBytes: 1024,
    })).rejects.toThrow('unknown unified exec session')
  })

  it('preserves the abort reason and kills the process while disposing the wait', async () => {
    const f = fixture()
    const pending = runExecCommand(f.ctx, { cmd: 'long command' }, f.exec, f.config)
    await Promise.resolve()
    const reason = new Error('cancelled')
    const rejected = expect(pending).rejects.toBe(reason)
    f.controller.abort(reason)
    await rejected
    expect(f.process.kill).toHaveBeenCalledTimes(1)
    expect(vi.getTimerCount()).toBe(0)
    expect(getEventListeners(f.controller.signal, 'abort')).toHaveLength(0)
  })

  it.each([
    { maxOutputBytes: 1024, max_output_tokens: undefined, expected: 'beforeafter', tokenCount: undefined },
    { maxOutputBytes: 8, max_output_tokens: undefined, expected: 'befo\n…1 tokens truncated…\nfter', tokenCount: 3 },
    { maxOutputBytes: 1024, max_output_tokens: 1, expected: 'be\n…2 tokens truncated…\ner', tokenCount: 3 },
  ])('retains head+tail ownerless output under byte/token limits: $expected', async ({ maxOutputBytes, max_output_tokens, expected, tokenCount }) => {
    const f = fixture()
    f.emit('before')
    const kill = f.process.kill
    f.process.kill = vi.fn(() => { f.emit('after'); return kill() })
    const pending = runExecCommand(f.ctx, { cmd: 'long command', max_output_tokens }, {
      signal: f.controller.signal,
    } as ToolExecution, { ...f.config, maxOutputBytes })
    await vi.advanceTimersByTimeAsync(30_000)
    await expect(pending).resolves.toMatchObject({
      output: expected,
      ...tokenCount === undefined ? {} : { original_token_count: tokenCount },
    })
    expect(f.process.kill).toHaveBeenCalledTimes(1)
    expect(f.process.readOutput).toHaveBeenCalledTimes(2)
    expect(vi.getTimerCount()).toBe(0)
    expect(getEventListeners(f.controller.signal, 'abort')).toHaveLength(0)
  })

  it('truncates multi-byte UTF-8 output symmetrically on code point boundaries and reports original_token_count', async () => {
    const f = fixture()
    // 3x 4-byte emoji = 12 UTF-8 bytes; max_output_tokens=2 -> 8 bytes keeps 1 head + 1 tail emoji.
    f.emit('😀😀😀')
    f.complete()
    const result = await runExecCommand(f.ctx, { cmd: 'echo emoji', max_output_tokens: 2 }, f.exec, {
      defaultYieldTimeMs: 30_000,
      maxOutputBytes: 1024,
    })
    expect(result.output).toBe('😀\n…1 tokens truncated…\n😀')
    expect(result.output).not.toContain('\uFFFD')
    expect(result.original_token_count).toBe(3)
  })

  it('sanitizes pipe progress CRs/NULs, hints interactive prompts, interrupts via \\u0003, and enforces 64-session LRU', async () => {
    const f = fixture()
    f.emit('10%\x00\r100%\r\nProceed? [y/N]\n')
    const started = runExecCommand(f.ctx, { cmd: 'installer', yield_time_ms: 0 }, f.exec, f.config)
    for (let t = 0; t < 5; t++) await Promise.resolve()
    await vi.advanceTimersByTimeAsync(30_000)
    const first = await started
    expect(first.output).toContain('100%\r\nProceed? [y/N]')
    expect(first.output).not.toContain('\x00')
    expect(first.output).not.toContain('10%')
    expect(first.output).toContain('interrupt with write_stdin chars="\\u0003"')

    const interrupted = await runWriteStdin(f.ctx, { session_id: first.session_id!, chars: '\u0003' }, f.exec, {
      pollYieldTimeMs: 5_000, writeYieldTimeMs: 250, maxOutputBytes: 1024,
    })
    expect(interrupted.session_id).toBeUndefined()
    expect(f.process.kill).toHaveBeenCalledTimes(1)

    // Fill 65 yielded sessions to verify oldest unprotected session is evicted when inserting the 65th.
    const processes: ShellProcess[] = []
    ;(f.ctx.shell as { execute: unknown }).execute = vi.fn(async () => {
      let end!: () => void
      const proc: ShellProcess = {
        status: 'running', exitCode: null, signal: null,
        done: new Promise<void>(resolve => { end = resolve }),
        readOutput: () => ({ delta: '', lossy: false }),
        kill: vi.fn(() => { proc.status = 'killed'; end(); return true }),
      }
      processes.push(proc)
      return proc
    })
    const ids: number[] = []
    for (let i = 0; i < 65; i++) {
      const run = runExecCommand(f.ctx, { cmd: `bg-${i}`, yield_time_ms: 0 }, f.exec, { ...f.config, defaultYieldTimeMs: 0 })
      for (let t = 0; t < 5; t++) await Promise.resolve()
      await vi.advanceTimersByTimeAsync(30_000)
      ids.push((await run).session_id!)
    }
    expect(processes[0]!.kill).toHaveBeenCalledTimes(1)
    expect(processes[64]!.kill).not.toHaveBeenCalled()
    await expect(runWriteStdin(f.ctx, { session_id: ids[0]! }, f.exec, {
      pollYieldTimeMs: 5_000, writeYieldTimeMs: 250, maxOutputBytes: 1024,
    })).rejects.toThrow('unknown unified exec session')
  })
})
