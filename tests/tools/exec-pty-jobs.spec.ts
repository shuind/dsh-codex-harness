import { describe, expect, it } from 'vitest'
import type { JobHooks, JobId, JobStart } from '@deepseek-ai/dsh-jobs'
import type { ShellExecRequest, ShellExecSpec, ShellExecution, ShellProcess } from '@deepseek-ai/dsh-shell'
import type { ToolRunContext } from '@deepseek-ai/dsh-tools'
import { normalizeWaitMs, runExecCommand, runWriteStdin } from '../../src/tools/exec-runner.ts'
import { CODEX_SETTINGS_ENTRY } from '../../src/contracts/settings.ts'

describe('Codex unified exec and PTY lifecycle', () => {
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
        execute: async (spec: ShellExecSpec): Promise<ShellExecution> => {
          started = spec
          spec.signal?.addEventListener('abort', () => { shellProcess.kill() }, { once: true })
          return shellProcess as unknown as ShellExecution
        },
      },
      get: (name: string) => name === 'shell' ? ctx.shell : undefined,
    } as unknown as Context
    const exec = { signal: controller.signal } as unknown as ToolRunContext
    const pending = runExecCommand(ctx, { cmd: 'sleep 60', yield_time_ms: 30 }, exec, {
      defaultYieldTimeMs: 10,
      maxOutputBytes: 1024,
    })

    await Promise.resolve()
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
    const agent = { id: 'session-1', session: { header: {} } } as unknown as ToolRunContext['agent']
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
        execute: async (): Promise<ShellExecution> => shellProcess as unknown as ShellExecution,
      },
      get: (name: string) => name === 'shell' ? ctx.shell : name === 'jobs' ? jobs : undefined,
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
    expect(specSeen).toMatchObject({ kind: 'bash', label: 'long-running command', owner: 'session-1', outputLimitBytes: 512 })
    expect(specSeen?.output?.map(source => source.channel)).toEqual(['stdout', 'stderr'])
    expect(resolved?.signal).toBeDefined()
    expect(resolved?.signal).not.toBe(controller.signal)
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
        execute: async (): Promise<ShellExecution> => {
          starts++
          throw new Error('unexpected process start')
        },
      },
      get: (name: string) => name === 'shell' ? ctx.shell : undefined,
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
    const ctx = { get: (name: string) => name === 'shell' ? {} : undefined } as unknown as Context

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
        execute: async (): Promise<ShellExecution> => shellProcess as unknown as ShellExecution,
      },
      get: (name: string) => name === 'shell' ? ctx.shell : undefined,
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
      get: (name: string) => name === 'shell' ? {} : name === 'terminals' ? {
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
      get: (name: string) => name === 'shell' ? {} : name === 'terminals' ? {
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
      get: (name: string) => name === 'shell' ? {} : name === 'terminals' ? {
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
      get: (name: string) => name === 'shell' ? {} : name === 'terminals' ? {
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
})
