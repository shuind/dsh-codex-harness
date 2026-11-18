import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { JobOutcome, JobSpec } from '@deepseek-ai/dsh-jobs'
import { createAssistantMessage, HarnessError } from '@deepseek-ai/dsh-llm'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import SandboxPolicyService from '@deepseek-ai/dsh-sandbox-policy'
import { escalationHintMarker, sandboxDenialMarker } from '@deepseek-ai/dsh-sandbox'
import type { SandboxMode } from '@deepseek-ai/dsh-sandbox'
import type { ShellExecSpec, ShellExecution } from '@deepseek-ai/dsh-shell'
import ApprovalService from '@deepseek-ai/dsh-user-approval'
import type { ApprovalOutcome } from '@deepseek-ai/dsh-user-approval'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolsService from '@deepseek-ai/dsh-tools'
import * as NativeExecutor from '@deepseek-ai/dsh-tool-executor-native'
import { createScope } from '@deepseek-ai/dsh-scope'
import { randomUUID } from 'node:crypto'
import { registerCodexExecAndPlan } from '../../src/entries/index.ts'
import { call, ControlledShell } from '../fixtures/tool-execution-fixture.ts'

/** A deterministic enforcing seam for policy transport tests; it does not spawn an OS process. */
class ConfiningShell extends ControlledShell {
  override get sandboxMode(): SandboxMode { return 'workspace-write' }
  readonly requests: ShellExecSpec[] = []
  override async execute(spec: ShellExecSpec): Promise<ShellExecution> {
    this.requests.push(spec)
    const process = await super.execute(spec)
    const original = process.result
    const mode = spec.sandboxPolicy!.mode
    process.result = async () => {
      const result = await original()
      if (spec.command === 'denied-result') return { ...result, exitCode: 1, sandbox: { mode, denied: true } }
      if (spec.command === 'runner-failed') return { ...result, exitCode: 1, sandbox: { mode, denied: false, runnerFailed: true } }
      return { ...result, ...process.sandbox === undefined ? {} : { sandbox: process.sandbox } }
    }
    if (spec.command === 'denied-result' || spec.command === 'runner-failed') process.exitCode = 1
    if (spec.command === 'runner-throws') {
      process.sandbox = { mode, denied: false, runnerFailed: true }
      process.result = async () => { throw new HarnessError('runner setup failed', 'SANDBOX_RUNNER_FAILED') }
    }
    return process
  }
}

const roots: Context[] = []
afterEach(async () => {
  vi.useRealTimers()
  for (const ctx of roots.splice(0).reverse()) await ctx.fiber.dispose()
})
async function harness(options: { mode?: SandboxMode; approval?: boolean; answer?: ApprovalOutcome; confines?: boolean; policy?: boolean; maxOutputBytes?: number } = {}) {
  const ctx = new Context()
  roots.push(ctx)
  await ctx.plugin(SessionStore)
  await ctx.plugin(SessionProjectionRegistry)
  await ctx.plugin(SystemPrompt, {})
  await ctx.plugin(ToolsService)
  await ctx.plugin(NativeExecutor)
  await ctx.plugin(options.confines === false ? ControlledShell : ConfiningShell, { cwd: process.cwd() })
  if (options.policy !== false) await ctx.plugin(SandboxPolicyService, { mode: options.mode ?? 'read-only', workspaceRoot: process.cwd() })
  if (options.approval !== false) await ctx.plugin(ApprovalService, { policy: 'ask' })
  const answer = options.answer === undefined ? undefined : vi.fn(async () => options.answer!)
  if (answer !== undefined) ctx.on('approval/request', answer)
  const session = ctx.sessions.create(SessionId(`exec-sandbox-${randomUUID()}`), { meta: { cwd: process.cwd() } })
  const agent = { id: session.id, session, status: 'idle', options: {} } as Agent
  const scope = createScope(ctx, agent)
  Object.assign(agent, { ctx: scope.ctx })
  registerCodexExecAndPlan(scope.ctx, { plan: false, ...options.maxOutputBytes === undefined ? {} : { maxOutputBytes: options.maxOutputBytes } })
  session.append('turn/start', { turn: 1 })
  let step = 0
  return {
    ctx, scope, agent, session, answer,
    async execute(args: Record<string, unknown>, name = 'exec_command') {
      const block = call(name, args)
      const signal = new AbortController().signal
      const toolSet = await ctx.tools.resolve({ agent, modelSelection: { provider: 'test', model: 'test' }, signal })
      step++
      session.append('step/start', { turn: 1, step })
      session.append('assistant/message', { turn: 1, step, message: createAssistantMessage({ content: [block], source: { provider: 'test', model: 'test' } }), stream: [] }, { surfaceOp: 'append' })
      try { return { block, result: (await ctx.tools.execute({ calls: [block], agent, toolSet, signal, log: { turn: 1, step } })).results[0]!.result } }
      finally { toolSet.dispose(); session.append('step/end', { turn: 1, step }) }
    },
  }
}
const permission = { sandbox_permissions: 'workspace-write', justification: 'Allow this exact test command once.' }

describe('Codex execution uses the public sandbox approval choreography', () => {
  it('advertises both official targets for a confining capability and scopes an audited grant to one exact command', async () => {
    const h = await harness({ answer: 'allowed-once' })
    const definition = h.ctx.tools.get('exec_command', h.agent)!
    expect((definition.parameters.properties as any).sandbox_permissions.enum).toEqual(['workspace-write', 'danger-full-access'])
    expect(definition.parameters.properties).toHaveProperty('justification')
    const cmd = "Write-Output '原样';\n$env:NOTE = 'a;b'"
    const standing = h.ctx.sandboxPolicy.resolve({ session: h.session })
    const { block, result } = await h.execute({ cmd, ...permission })
    expect(result.isError).toBe(false)
    const provider = h.ctx.shell as ConfiningShell
    expect(provider.requests[0]).toMatchObject({ command: cmd, sandboxPolicy: { ...standing, mode: 'workspace-write' } })
    expect(h.ctx.sandboxPolicy.resolve({ session: h.session })).toEqual(standing)
    expect(h.ctx.sandboxPolicy.overrideOf(h.session)).toBeUndefined()
    expect(h.answer).toHaveBeenCalledOnce()
    expect(h.session.snapshotEvents().find(event => event.type === 'approval/asked')?.data).toMatchObject({ toolName: 'exec_command', callId: block.id, reason: expect.stringContaining(permission.justification) })
    expect(h.session.snapshotEvents().find(event => event.type === 'approval/decided')?.data).toMatchObject({ outcome: 'allowed-once' })
    expect(h.session.snapshotEvents().some(event => event.type === 'sandbox/mode')).toBe(false)
    await h.execute({ cmd })
    expect(provider.requests[1]!.sandboxPolicy).toEqual(standing)
    expect(h.answer).toHaveBeenCalledOnce()
  })

  it.each(['rejected', 'cancelled', 'unavailable'] as const)('does not execute after the official approval outcome %s', async answer => {
    const h = await harness({ answer })
    const { result } = await h.execute({ cmd: 'complete', ...permission })
    expect(result.isError).toBe(true)
    expect(h.answer).toHaveBeenCalledOnce()
    expect((h.ctx.shell as ConfiningShell).requests).toHaveLength(0)
    expect(h.session.snapshotEvents().find(event => event.type === 'approval/decided')?.data).toMatchObject({ outcome: answer })
  })

  it('fails closed through the actual approval service when no answerer exists', async () => {
    const h = await harness()
    const { result } = await h.execute({ cmd: 'complete', ...permission })
    expect(result).toMatchObject({ isError: true, error: { message: expect.stringContaining('no approval channel is available') } })
    expect(h.session.snapshotEvents().find(event => event.type === 'approval/decided')?.data).toMatchObject({ outcome: 'unavailable' })
    expect((h.ctx.shell as ConfiningShell).requests).toHaveLength(0)
  })

  it('fails closed without an approval service and permits only a non-widening restatement without asking', async () => {
    const h = await harness({ approval: false })
    expect((await h.execute({ cmd: 'complete', ...permission })).result).toMatchObject({ isError: true, error: { message: expect.stringContaining('no approval service is composed') } })
    expect((h.ctx.shell as ConfiningShell).requests).toHaveLength(0)
    const same = await harness({ approval: false, mode: 'workspace-write' })
    expect((await same.execute({ cmd: 'complete', ...permission })).result.isError).toBe(false)
    expect((same.ctx.shell as ConfiningShell).requests[0]!.sandboxPolicy!.mode).toBe('workspace-write')
  })

  it.each([
    { sandbox_permissions: 'unknown', justification: 'Reason.' },
    { sandbox_permissions: 'read-only', justification: 'Reason.' },
    { sandbox_permissions: 'workspace-write' },
    { justification: 'Orphan reason.' },
    { sandbox_permissions: 'workspace-write', justification: '   ' },
  ])('rejects invalid mode/pairing before approval or execution: %j', async args => {
    const h = await harness({ answer: 'allowed-once' })
    expect((await h.execute({ cmd: 'complete', ...args })).result.isError).toBe(true)
    expect(h.answer).not.toHaveBeenCalled()
    expect((h.ctx.shell as ConfiningShell).requests).toHaveLength(0)
  })

  it('rejects a narrower target under a full standing mode and requires the policy service at registration', async () => {
    const h = await harness({ mode: 'danger-full-access', answer: 'allowed-once' })
    expect((await h.execute({ cmd: 'complete', ...permission })).result).toMatchObject({ isError: true, error: { message: expect.stringContaining('not strictly wider') } })
    expect(h.answer).not.toHaveBeenCalled()
    await expect(harness({ policy: false })).rejects.toThrow('a sandboxing shell requires ctx.sandboxPolicy')
  })

  it('does not advertise or honor permission arguments without a confining capability', async () => {
    const h = await harness({ confines: false, answer: 'allowed-once' })
    expect(h.ctx.tools.get('exec_command', h.agent)!.parameters.properties).not.toHaveProperty('sandbox_permissions')
    expect(h.ctx.tools.get('exec_command', h.agent)!.parameters.properties).not.toHaveProperty('justification')
    expect((await h.execute({ cmd: 'complete', ...permission })).result).toMatchObject({ isError: true, error: { message: expect.stringContaining('no sandboxing executor to escalate') } })
    expect(h.answer).not.toHaveBeenCalled()
    expect((h.ctx.shell as ControlledShell).processes).toHaveLength(0)
  })

  it('rejects confined PTYs and existing-session escalation without asking or starting ungoverned work', async () => {
    const h = await harness({ answer: 'allowed-once' })
    expect((await h.execute({ cmd: 'complete', tty: true, ...permission })).result).toMatchObject({ isError: true, error: { message: expect.stringContaining('tty=true cannot carry the sandbox policy') } })
    expect((await h.execute({ session_id: 1, ...permission }, 'write_stdin')).result).toMatchObject({ isError: true, error: { message: expect.stringContaining('cannot change an existing command sandbox') } })
    expect(h.answer).not.toHaveBeenCalled()
    expect((h.ctx.shell as ConfiningShell).requests).toHaveLength(0)
  })

  it('retains result-only denial/hint and runner-failure markers beyond the command output cap', async () => {
    const h = await harness({ maxOutputBytes: 1 })
    const denied = (await h.execute({ cmd: 'denied-result' })).result
    expect(denied.isError).toBe(false)
    expect((denied.value as { output: string }).output).toContain(sandboxDenialMarker('read-only'))
    expect((denied.value as { output: string }).output).toContain(escalationHintMarker('command'))
    expect((denied.value as { exit_code: number }).exit_code).toBe(1)
    const runner = (await h.execute({ cmd: 'runner-failed' })).result
    expect((runner.value as { output: string }).output).toContain('the sandbox runner itself failed under read-only mode — the command did not run')
    expect((runner.value as { output: string }).output).not.toContain('escalation available')
    const thrown = (await h.execute({ cmd: 'runner-throws' })).result
    expect(thrown).toMatchObject({ isError: true, error: { info: { code: 'SANDBOX_RUNNER_FAILED' }, message: expect.stringContaining('the command did not run') } })
  })

  it('retains sandbox notes in background job outcomes (deterministic registry admission)', async () => {
    const h = await harness({ answer: 'allowed-once' })
    let done!: Promise<JobOutcome>
    h.ctx.provide('jobs', {
      readAt: () => {},
      start(spec: JobSpec) { done = spec.run({} as never).done; return 'bash-sandbox-test' },
    } as never)
    expect((await h.execute({ cmd: 'denied-result', run_in_background: true, ...permission })).result)
      .toMatchObject({ isError: false, value: { job_id: 'bash-sandbox-test' } })
    const outcome = await done
    expect(outcome.detail).toContain(sandboxDenialMarker('workspace-write'))
    expect(outcome.detail).toContain(escalationHintMarker('command'))
    expect(h.ctx.sandboxPolicy.resolve({ session: h.session }).mode).toBe('read-only')
  })

  it('preserves sandbox facts on a later write_stdin result', async () => {
    const h = await harness()
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    const pending = h.execute({ cmd: 'running', yield_time_ms: 0 })
    await vi.advanceTimersByTimeAsync(30_000)
    expect((await pending).result).toMatchObject({ isError: false, value: { session_id: 1 } })
    const process = (h.ctx.shell as ConfiningShell).processes[0]!
    process.sandbox = { mode: 'read-only', denied: true }
    process.complete(1)
    const polled = (await h.execute({ session_id: 1 }, 'write_stdin')).result
    expect((polled.value as { output: string }).output).toContain(sandboxDenialMarker('read-only'))
    expect((polled.value as { output: string }).output).toContain(escalationHintMarker('command'))
  })
})
