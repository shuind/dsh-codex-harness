import { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import LocalFileSystem from '@deepseek-ai/dsh-fs-local'
import LlmRuntime, { createAssistantMessage, createUserMessage, HarnessError, ToolCallId } from '@deepseek-ai/dsh-llm'
import type { AssistantMessage, ToolCallBlock } from '@deepseek-ai/dsh-llm'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import ShellExecutor from '@deepseek-ai/dsh-shell'
import type { ShellExecRequest, ShellExecSpec, ShellExecution } from '@deepseek-ai/dsh-shell'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolsService from '@deepseek-ai/dsh-tools'
import type { ResolvedToolSet } from '@deepseek-ai/dsh-tools'
import * as NativeExecutor from '@deepseek-ai/dsh-tool-executor-native'
import { randomUUID } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { apply as applyCodex } from '../../src/entries/index.ts'

/** A real ShellExecutor registration with deterministic process handles, NOT an OS process. */
export class ControlledShell extends ShellExecutor {
  readonly processes: Array<ShellExecution & { complete(code?: number): void }> = []
  constructor(ctx: Context, private readonly config: { cwd: string }) {
    super(ctx)
    ctx.effect(() => async () => {
      for (const process of this.processes) if (process.status === 'running') process.kill()
      await Promise.all(this.processes.map(process => process.done))
    })
  }

  override resolve(request: ShellExecRequest): ShellExecSpec {
    return {
      ...request, workdir: request.workdir ?? this.config.cwd,
      timeoutMs: request.timeoutMs ?? 10_000, onExpiry: request.onExpiry ?? 'kill',
      stdoutMaxBytes: request.stdoutMaxBytes ?? 1024, sandboxPolicy: request.sandboxPolicy,
    }
  }

  override async execute(spec: ShellExecSpec): Promise<ShellExecution> {
    let settle!: () => void
    let output = ''
    let consumed = 0
    let failure: Error | undefined
    const process: ShellExecution & { complete(code?: number): void } = {
      status: 'running', exitCode: null, signal: null,
      done: new Promise<void>(resolve => { settle = resolve }),
      complete(code = 0) { process.status = 'completed'; process.exitCode = code; output += 'finished\n'; settle() },
      kill() { process.status = 'killed'; process.exitCode = 1; settle(); return true },
      readOutput() { const delta = output.slice(consumed); consumed = output.length; return { delta, lossy: false } },
      observed: {
        stdout: { readFrom: from => ({ text: output.slice(from), nextOffset: output.length, lossy: false }) },
        stderr: { readFrom: () => ({ text: '', nextOffset: 0, lossy: false }) },
      },
      async result() {
        await process.done
        if (failure !== undefined) throw failure
        return {
          exitCode: process.exitCode, signal: process.signal, timedOut: false, aborted: false,
          timeoutMs: spec.timeoutMs, stdout: { text: output, truncated: false }, stderr: { text: '', truncated: false },
        }
      },
    }
    this.processes.push(process)
    if (spec.command === 'infrastructure-failure') {
      failure = new HarnessError('deterministic shell preparation failed', 'TEST_SPAWN_FAILED')
      output = 'spawn failed: deterministic shell preparation failed\n'
      process.status = 'killed'
      settle()
    } else if (spec.command !== 'running') process.complete(spec.command === 'nonzero-exit' ? 7 : 0)
    return process
  }
}

export function call(name: string, args: unknown): ToolCallBlock {
  return rawCall(name, JSON.stringify(args))
}
export function rawCall(name: string, args: string): ToolCallBlock {
  return { type: 'tool-call', id: ToolCallId(`call_${randomUUID().replaceAll('-', '')}`), name, arguments: args }
}

export async function createToolHarness(options: {
  globalEnhancements?: boolean
  installShell?: (ctx: Context, root: string) => Promise<void>
} = {}) {
  const root = await mkdtemp(join(tmpdir(), 'dsh-native-tools-'))
  const ctx = new Context()
  try {
    await ctx.plugin(SessionStore)
    await ctx.plugin(SystemPrompt, {})
    await ctx.plugin(ToolsService)
    await ctx.plugin(NativeExecutor)
    await ctx.plugin(LocalFileSystem, { cwd: root })
    await ctx.plugin(LlmRuntime)
    if (options.installShell === undefined) await ctx.plugin(ControlledShell, { cwd: root })
    else await options.installShell(ctx, root)
    applyCodex(ctx, { globalEnhancements: options.globalEnhancements ?? false })
    const session = ctx.sessions.create(SessionId(`native-${randomUUID()}`), { meta: { cwd: root } })
    // This owner supplies scope/session to the real dispatcher; it is not an AgentLoop driver.
    const agent = { id: session.id, session, ctx, status: 'idle', options: { provider: 'relay', model: 'gpt-5.4' } } as Agent
    session.append('turn/start', { turn: 1 })
    session.append('user/message', createUserMessage({
      content: [{ type: 'text', text: 'Exercise native tools in the temporary test workspace.' }], source: { kind: 'user' },
    }), { surfaceOp: 'append' })
    let step = 0
    const signal = new AbortController().signal
    const admit = () => ctx.tools.resolve({ agent, modelSelection: agent.options as { provider: string; model: string }, signal })
    return {
      ctx, root, agent, session, signal, admit,
      async dispatch(calls: readonly ToolCallBlock[], admitted?: ResolvedToolSet, message?: AssistantMessage) {
        const toolSet = admitted ?? await admit()
        step++
        session.append('step/start', { turn: 1, step })
        session.append('assistant/message', {
          turn: 1, step,
          message: message ?? createAssistantMessage({ content: [...calls], source: { provider: 'relay', model: 'gpt-5.4' } }),
          stream: [],
        }, { surfaceOp: 'append' })
        try {
          return await ctx.tools.execute({ calls, agent, signal, toolSet, log: { turn: 1, step } })
        } finally {
          toolSet.dispose()
          session.append('step/end', { turn: 1, step })
        }
      },
      async dispose() {
        try { session.append('turn/end', { turn: 1, reason: { kind: 'completed' } }) }
        finally { await ctx.fiber.dispose(); await rm(root, { recursive: true, force: true }) }
      },
    }
  } catch (error) {
    await ctx.fiber.dispose()
    await rm(root, { recursive: true, force: true })
    throw error
  }
}
