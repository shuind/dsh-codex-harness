/** Codex `exec_command` and `write_stdin` execution over DSH 0.2.2+ capability seams. */

import type { Context } from '@deepseek-ai/cordis'
import { resolve as resolvePath } from 'node:path'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { JobOutcome, JobSpec } from '@deepseek-ai/dsh-jobs'
import type { ToolExecution } from '@deepseek-ai/dsh-tools'
import type { ShellExecRequest, ShellExecution, ShellProcess } from '@deepseek-ai/dsh-shell'
import { approveEscalation, validateEscalationArgs } from '@deepseek-ai/dsh-sandbox'
import type { SandboxExecutionPolicy } from '@deepseek-ai/dsh-sandbox'
import type {} from '@deepseek-ai/dsh-user-approval'
import type {
  TerminalSendRequest,
  TerminalSessionId,
  TerminalSpawnRequest,
} from '@deepseek-ai/dsh-terminal'
import type {} from '@deepseek-ai/dsh-fs'
import type {} from '@deepseek-ai/dsh-sandbox-policy'
import type {} from '@deepseek-ai/dsh-shell-env'
import type {} from '@deepseek-ai/dsh-terminal'
import {
  assertShellCompleted,
  backgroundOutcome,
  hasInteractivePrompt,
  normalizeWaitMs,
  outputLimit,
  positiveFinite,
  readShellOutput,
  sandboxNotes,
  terminalResult,
  withChunkId,
} from './exec-output.ts'
import type { ExecCommandArgs, ExecResult, WriteStdinArgs } from './exec-output.ts'

export { normalizeWaitMs, renderExecResult, sanitizePipeOutput } from './exec-output.ts'
export type { ExecCommandArgs, ExecResult, WriteStdinArgs } from './exec-output.ts'

type StoredSessionData =
  | { kind: 'shell'; process: ShellProcess; escalationAvailable: boolean }
  | { kind: 'terminal'; owner: Agent; id: TerminalSessionId }

type StoredSession = StoredSessionData & { lastUsed: number }

interface AgentExecState {
  nextId: number
  clock: number
  sessions: Map<number, StoredSession>
}

const STATES = new WeakMap<Agent, AgentExecState>()
const MAX_UNIFIED_EXEC_SESSIONS = 64
const PROTECTED_RECENT_SESSIONS = 8

function stateFor(agent: Agent): AgentExecState {
  const current = STATES.get(agent)
  if (current !== undefined) return current
  const created: AgentExecState = { nextId: 0, clock: 0, sessions: new Map() }
  STATES.set(agent, created)
  return created
}

function sessionCwd(ctx: Context, exec: ToolExecution, workdir: string | undefined): string | undefined {
  const directories = ctx.get('workingDirectory') as { get(session: Agent['session']): string } | undefined
  const cwd = exec.agent === undefined
    ? undefined
    : directories?.get(exec.agent.session) ?? exec.agent.session.header.cwd
  return workdir === undefined ? cwd : resolvePath(cwd ?? process.cwd(), workdir)
}

async function startShell(ctx: Context, request: ShellExecRequest): Promise<ShellExecution> {
  const shell = ctx.get('shell')
  if (shell === undefined) throw new Error('exec_command requires ctx.shell')
  return shell.execute(shell.resolve(request))
}

async function waitForShell(process: ShellProcess, ms: number, signal: AbortSignal): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined
  let onAbort: () => void = () => {}
  const elapsed = new Promise<boolean | undefined>(resolve => {
    onAbort = () => resolve(false)
    if (signal.aborted) {
      onAbort()
      return
    }
    signal.addEventListener('abort', onAbort, { once: true })
    timer = setTimeout(() => resolve(undefined), ms)
  })
  try {
    const completed = await Promise.race([process.done.then(() => true), elapsed])
    if (signal.aborted) signal.throwIfAborted()
    return completed === true || process.status !== 'running'
  } finally {
    if (timer !== undefined) clearTimeout(timer)
    signal.removeEventListener('abort', onAbort)
  }
}

/** Stop a pipe-backed session when the current Codex tool is cancelled. */
async function stopShellOnAbort(process: ShellProcess, signal: AbortSignal): Promise<void> {
  if (!signal.aborted || process.status !== 'running') return
  process.kill()
  await process.done
}

function allocateSession(ctx: Context, agent: Agent, session: StoredSessionData): number {
  const state = stateFor(agent)
  while (state.sessions.size >= MAX_UNIFIED_EXEC_SESSIONS) {
    const byRecency = [...state.sessions.entries()].sort((a, b) => b[1].lastUsed - a[1].lastUsed)
    const protectedIds = new Set(byRecency.slice(0, PROTECTED_RECENT_SESSIONS).map(([id]) => id))
    const unprotected = byRecency.filter(([id]) => !protectedIds.has(id))
    const exited = [...unprotected].reverse().find(([, entry]) => entry.kind === 'shell' && entry.process.status !== 'running')
    const victim = exited ?? unprotected.at(-1)
    if (victim === undefined) break
    const [victimId, evicted] = victim
    state.sessions.delete(victimId)
    if (evicted.kind === 'shell') {
      if (evicted.process.status === 'running') evicted.process.kill()
    } else {
      void ctx.get('terminals')?.kill(evicted.owner, evicted.id, 'Codex session cap reached')?.catch(() => {})
    }
  }
  const id = ++state.nextId
  state.sessions.set(id, { ...session, lastUsed: ++state.clock })
  return id
}

function storedSession(agent: Agent, id: number): StoredSession {
  const state = stateFor(agent)
  const session = state.sessions.get(id)
  if (session === undefined) throw new Error(`unknown unified exec session ${id}`)
  session.lastUsed = ++state.clock
  return session
}

function forgetSession(agent: Agent, id: number): void {
  const state = STATES.get(agent)
  if (state === undefined) return
  state.sessions.delete(id)
  if (state.sessions.size === 0) STATES.delete(agent)
}

/** Kill any yielded pipe-backed shell processes retained by a disposed Agent. */
export function disposeAgentExecSessions(agent: Agent): void {
  const state = STATES.get(agent)
  if (state === undefined) return
  STATES.delete(agent)
  for (const session of state.sessions.values()) {
    if (session.kind === 'shell' && session.process.status === 'running') {
      session.process.kill()
    }
  }
  state.sessions.clear()
}

async function runTtyCommand(
  ctx: Context,
  args: ExecCommandArgs,
  exec: ToolExecution,
  workdir: string | undefined,
  maxBytes: number,
  startedAt: number,
): Promise<ExecResult> {
  const agent = exec.agent
  const terminals = ctx.get('terminals')
  if (agent === undefined || terminals === undefined) {
    throw new Error('exec_command with tty=true requires the dsh terminal capability and an owning agent session')
  }
  const spawnRequest: TerminalSpawnRequest = {
    type: 'shell',
    ...workdir === undefined ? {} : { cwd: workdir },
  }
  const spawned = await terminals.spawn(agent, spawnRequest, exec.signal)
  let retained = false
  let closeReason = 'Codex command failed'
  try {
    const sendRequest: TerminalSendRequest = { text: args.cmd, submit: true, signal: exec.signal }
    const result = await terminals.startSend(agent, spawned.sessionId, sendRequest).done
    const output = terminalResult(result, maxBytes, startedAt)
    if (result.sessionStatus.kind === 'running') {
      output.session_id = allocateSession(ctx, agent, { kind: 'terminal', owner: agent, id: spawned.sessionId })
      retained = true
    } else {
      closeReason = 'Codex command exited'
    }
    return output
  } finally {
    // A PTY is published by spawn before the first send starts. Do not leave
    // that session behind when send setup or its foreground operation fails.
    if (!retained) await terminals.kill(agent, spawned.sessionId, closeReason)
  }
}

function startBackgroundJob(
  ctx: Context,
  args: ExecCommandArgs,
  exec: ToolExecution,
  shellRequest: ShellExecRequest,
  confines: boolean,
  maxBytes: number,
  startedAt: number,
): ExecResult {
  const owner = exec.agent
  if (owner === undefined) throw new Error('run_in_background requires an owning agent session')
  const jobs = ctx.get('jobs')
  if (jobs === undefined) {
    throw new Error('background jobs unavailable: load @deepseek-ai/dsh-jobs and @deepseek-ai/dsh-tool-jobs')
  }
  if (exec.signal.aborted) {
    exec.signal.throwIfAborted()
    throw new Error('tool call aborted')
  }
  let process: ShellProcess | undefined
  let cancelled = false
  const lifetime = new AbortController()
  const jobSpec: JobSpec = {
    kind: 'bash',
    label: args.cmd,
    owner: owner.id,
    outputLimitBytes: maxBytes,
    output: (['stdout', 'stderr'] as const).map(channel => ({
      channel,
      read: (fromByte: number) => process?.observed?.[channel].readFrom(fromByte)
        ?? { text: '', nextOffset: fromByte, lossy: false },
    })),
    run: () => {
      const prepared = startShell(ctx, { ...shellRequest, signal: lifetime.signal })
      const done = (async (): Promise<JobOutcome> => {
        try {
          process = await prepared
          if (cancelled) process.kill()
          await process.done
          const completed = await assertShellCompleted(process, confines)
          return backgroundOutcome(process, confines, completed?.sandbox ?? process.sandbox)
        } catch (error) {
          if (cancelled) return { status: 'killed', detail: 'cancelled during shell preparation' }
          return {
            status: 'failed',
            detail: [error instanceof Error ? error.message : String(error), ...sandboxNotes(process?.sandbox, confines)].join('; '),
          }
        }
      })()
      return {
        cancel: () => {
          cancelled = true
          lifetime.abort()
          process?.kill()
        },
        done,
      }
    },
  }
  const id = jobs.start(jobSpec)
  return withChunkId({
    wall_time_seconds: (performance.now() - startedAt) / 1000,
    job_id: id,
    output: `Started background job ${id}. Use job_output with job_id "${id}" to read output.`,
  })
}

/** Execute one Codex command through the configured pipe or PTY capability. */
export async function runExecCommand(
  ctx: Context,
  args: ExecCommandArgs,
  exec: ToolExecution,
  config: { defaultYieldTimeMs: number; maxOutputBytes: number },
): Promise<ExecResult> {
  if (args.cmd.trim().length === 0) throw new Error('cmd must be a non-empty string')
  positiveFinite('yield_time_ms', args.yield_time_ms)
  const maxBytes = outputLimit(config.maxOutputBytes, args.max_output_tokens)
  validateEscalationArgs(args.sandbox_permissions, args.justification)
  const confines = ctx.get('shell')?.sandboxMode !== undefined
  const policyService = ctx.get('sandboxPolicy')
  if (confines && policyService === undefined) throw new Error('exec_command: a sandboxing shell requires ctx.sandboxPolicy')
  if (confines && args.tty === true) throw new Error('exec_command: tty=true cannot carry the sandbox policy; use pipe-backed execution on this host')
  let policy: SandboxExecutionPolicy | undefined = policyService?.resolve(exec.agent === undefined ? {} : { session: exec.agent.session })
  if (args.sandbox_permissions !== undefined) {
    if (!confines) throw new Error('sandbox_permissions is not available in this composition (no sandboxing executor to escalate)')
    const approvedMode = await approveEscalation({
      requestedMode: args.sandbox_permissions,
      justification: args.justification!,
      effectiveMode: policy!.mode,
      subject: 'command',
    }, {
      approver: ctx.get('approval'),
      agent: exec.agent,
      callId: exec.callId,
      toolName: 'exec_command',
      signal: exec.signal,
    })
    exec.signal.throwIfAborted()
    policy = { ...policy!, mode: approvedMode }
  }
  const workdir = sessionCwd(ctx, exec, args.workdir)
  const startedAt = performance.now()
  if (args.run_in_background === true && args.tty === true) {
    throw new Error('run_in_background is only supported for pipe-backed commands; omit tty')
  }
  if (args.tty === true) return runTtyCommand(ctx, args, exec, workdir, maxBytes, startedAt)

  const dshEnv = ctx.get('shellEnv')?.collect(exec)
  const shellRequest: ShellExecRequest = {
    command: args.cmd,
    onExpiry: 'none',
    ...workdir === undefined ? {} : { workdir },
    stdoutMaxBytes: maxBytes,
    ...dshEnv === undefined ? {} : { dshEnv },
    ...policy === undefined ? {} : { sandboxPolicy: policy },
  }
  if (args.run_in_background === true) {
    return startBackgroundJob(ctx, args, exec, shellRequest, confines, maxBytes, startedAt)
  }

  const process = await startShell(ctx, { ...shellRequest, signal: exec.signal })
  try {
    await waitForShell(process, normalizeWaitMs(args.yield_time_ms, config.defaultYieldTimeMs, false, true), exec.signal)
    const read = process.readOutput()
    if (process.status === 'running') {
      if (exec.agent === undefined) {
        process.kill()
        await process.done
        const completed = await assertShellCompleted(process, confines)
        const formatted = readShellOutput(
          { ...read, delta: read.delta + process.readOutput().delta },
          maxBytes,
          completed?.sandbox ?? process.sandbox,
          confines,
        )
        return withChunkId({
          wall_time_seconds: (performance.now() - startedAt) / 1000,
          output: formatted.output,
          ...formatted.originalTokenCount === undefined ? {} : { original_token_count: formatted.originalTokenCount },
        })
      }
      const formatted = readShellOutput(read, maxBytes, process.sandbox, confines)
      const interactiveHint = '[exec: command appears waiting on interactive stdin over pipes; interrupt with write_stdin chars="\\u0003" and rerun with a non-interactive flag or tty=true]'
      const output = hasInteractivePrompt(formatted.output)
        ? `${formatted.output}${formatted.output.length > 0 && !formatted.output.endsWith('\n') ? '\n' : ''}${interactiveHint}`
        : formatted.output
      return withChunkId({
        wall_time_seconds: (performance.now() - startedAt) / 1000,
        output,
        ...formatted.originalTokenCount === undefined ? {} : { original_token_count: formatted.originalTokenCount },
        session_id: allocateSession(ctx, exec.agent, { kind: 'shell', process, escalationAvailable: confines }),
      })
    }
    const completed = await assertShellCompleted(process, confines)
    const formatted = readShellOutput(read, maxBytes, completed?.sandbox ?? process.sandbox, confines)
    return withChunkId({
      wall_time_seconds: (performance.now() - startedAt) / 1000,
      output: formatted.output,
      ...formatted.originalTokenCount === undefined ? {} : { original_token_count: formatted.originalTokenCount },
      ...process.exitCode === null ? {} : { exit_code: process.exitCode },
    })
  } finally {
    await stopShellOnAbort(process, exec.signal)
  }
}

/** Poll or write to one session returned by {@link runExecCommand}. */
export async function runWriteStdin(
  ctx: Context,
  args: WriteStdinArgs,
  exec: ToolExecution,
  config: { pollYieldTimeMs: number; writeYieldTimeMs: number; maxOutputBytes: number },
): Promise<ExecResult> {
  const escalation = args as WriteStdinArgs & { sandbox_permissions?: unknown; justification?: unknown }
  if (escalation.sandbox_permissions !== undefined || escalation.justification !== undefined) {
    throw new Error('write_stdin cannot change an existing command sandbox; use exec_command for an approved one-shot retry')
  }
  positiveFinite('yield_time_ms', args.yield_time_ms)
  if (!Number.isSafeInteger(args.session_id) || args.session_id <= 0) {
    throw new Error('session_id must be a positive integer')
  }
  const agent = exec.agent
  if (agent === undefined) throw new Error('write_stdin requires an owning agent session')
  const session = storedSession(agent, args.session_id)
  const maxBytes = outputLimit(config.maxOutputBytes, args.max_output_tokens)
  const startedAt = performance.now()
  const chars = args.chars ?? ''
  if (session.kind === 'shell') {
    if (chars === '\u0003') {
      session.process.kill()
    } else if (chars.length > 0) {
      throw new Error('this unified exec session uses pipes and does not accept stdin; send "\\u0003" to interrupt or rerun exec_command with tty=true')
    }
    try {
      const waitMs = normalizeWaitMs(
        args.yield_time_ms,
        chars === '\u0003' ? config.writeYieldTimeMs : config.pollYieldTimeMs,
        chars.length === 0,
      )
      await waitForShell(session.process, waitMs, exec.signal)
      const read = session.process.readOutput()
      if (session.process.status !== 'running') {
        forgetSession(agent, args.session_id)
        const completed = await assertShellCompleted(session.process, session.escalationAvailable)
        const formatted = readShellOutput(read, maxBytes, completed?.sandbox ?? session.process.sandbox, session.escalationAvailable)
        return withChunkId({
          wall_time_seconds: (performance.now() - startedAt) / 1000,
          output: formatted.output,
          ...formatted.originalTokenCount === undefined ? {} : { original_token_count: formatted.originalTokenCount },
          ...session.process.exitCode === null ? {} : { exit_code: session.process.exitCode },
        })
      }
      const formatted = readShellOutput(read, maxBytes, session.process.sandbox, session.escalationAvailable)
      return withChunkId({
        wall_time_seconds: (performance.now() - startedAt) / 1000,
        output: formatted.output,
        ...formatted.originalTokenCount === undefined ? {} : { original_token_count: formatted.originalTokenCount },
        session_id: args.session_id,
      })
    } finally {
      if (exec.signal.aborted) {
        try {
          await stopShellOnAbort(session.process, exec.signal)
        } finally {
          forgetSession(agent, args.session_id)
        }
      }
    }
  }

  const terminals = ctx.get('terminals')
  if (terminals === undefined) throw new Error('the dsh terminal capability is no longer available')
  const sendRequest: TerminalSendRequest = { text: chars, submit: false, signal: exec.signal }
  let retained = false
  let closeReason = 'Codex command failed'
  try {
    const result = await terminals.startSend(agent, session.id, sendRequest).done
    const output = terminalResult(result, maxBytes, startedAt)
    if (result.sessionStatus.kind === 'running') {
      output.session_id = args.session_id
      retained = true
    } else {
      closeReason = 'Codex command exited'
      forgetSession(agent, args.session_id)
    }
    return output
  } finally {
    if (!retained) {
      forgetSession(agent, args.session_id)
      await terminals.kill(agent, session.id, closeReason)
    }
  }
}
