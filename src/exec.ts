/** Codex `exec_command` and `write_stdin` execution over dsh capability seams. */

import type { Context } from '@deepseek-ai/cordis'
import { randomBytes } from 'node:crypto'
import { resolve as resolvePath } from 'node:path'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { JobOutcome } from '@deepseek-ai/dsh-jobs'
import type { ToolExecution } from '@deepseek-ai/dsh-tools'
import type { ShellExecRequest, ShellProcess, ShellProcessRead } from '@deepseek-ai/dsh-shell'
import type {
  TerminalSendRequest,
  TerminalSendResult,
  TerminalSessionId,
  TerminalSpawnRequest,
} from '@deepseek-ai/dsh-terminal'
import type {} from '@deepseek-ai/dsh-fs'
import type {} from '@deepseek-ai/dsh-sandbox-policy'
import type {} from '@deepseek-ai/dsh-shell-env'
import type {} from '@deepseek-ai/dsh-terminal'

/** The exact model-facing argument vocabulary of Codex's unified exec tool. */
export interface ExecCommandArgs {
  cmd: string
  workdir?: string
  tty?: boolean
  run_in_background?: boolean
  yield_time_ms?: number
  max_output_tokens?: number
  shell?: string
  login?: boolean
}

/** The exact model-facing argument vocabulary of Codex's stdin poll tool. */
export interface WriteStdinArgs {
  session_id: number
  chars?: string
  yield_time_ms?: number
  max_output_tokens?: number
}

/** Canonical result fields shared by both unified exec tools. */
export interface ExecResult {
  chunk_id?: string
  wall_time_seconds: number
  output: string
  session_id?: number
  job_id?: string
  exit_code?: number
  original_token_count?: number
}

type StoredSession =
  | { kind: 'shell'; process: ShellProcess }
  | { kind: 'terminal'; owner: Agent; id: TerminalSessionId }

// rc.5 exposed these optional controls; rc.6 moved them into the mounted
// providers. Keep passing them when an older provider accepts them while
// allowing the rc.6 service definitions to type-check.
type CodexShellExecRequest = ShellExecRequest & { login?: boolean }
type CodexTerminalSpawnRequest = TerminalSpawnRequest & { shell?: string; login?: boolean }
type CodexTerminalSendRequest = TerminalSendRequest & { waitMs?: number }

interface AgentExecState {
  nextId: number
  sessions: Map<number, StoredSession>
}

const STATES = new WeakMap<Agent, AgentExecState>()
const MIN_YIELD_TIME_MS = 250
const WINDOWS_INITIAL_EXEC_YIELD_TIME_MS = 10_000
const MIN_EMPTY_YIELD_TIME_MS = 5_000
const MAX_YIELD_TIME_MS = 30_000
const MAX_EMPTY_YIELD_TIME_MS = 300_000
const DEFAULT_OUTPUT_TOKENS = 10_000
const APPROX_BYTES_PER_TOKEN = 4

function stateFor(agent: Agent): AgentExecState {
  const current = STATES.get(agent)
  if (current !== undefined) return current
  const created: AgentExecState = { nextId: 0, sessions: new Map() }
  STATES.set(agent, created)
  return created
}

function positiveFinite(name: string, value: number | undefined): void {
  if (value !== undefined && (!Number.isFinite(value) || value < 0)) {
    throw new Error(`${name} must be a non-negative finite number`)
  }
}

export function normalizeWaitMs(
  value: number | undefined,
  fallback: number,
  empty = false,
  initialExec = false,
): number {
  const lower = empty
    ? MIN_EMPTY_YIELD_TIME_MS
    : initialExec && process.platform === 'win32'
      ? WINDOWS_INITIAL_EXEC_YIELD_TIME_MS
      : MIN_YIELD_TIME_MS
  const upper = empty ? MAX_EMPTY_YIELD_TIME_MS : MAX_YIELD_TIME_MS
  return Math.max(lower, Math.min(upper, Math.trunc(value ?? fallback)))
}

function outputLimit(maxOutputBytes: number, maxOutputTokens: number | undefined): number {
  const tokens = maxOutputTokens ?? DEFAULT_OUTPUT_TOKENS
  if (maxOutputTokens !== undefined) positiveFinite('max_output_tokens', maxOutputTokens)
  return Math.max(1, Math.min(maxOutputBytes, Math.trunc(tokens * APPROX_BYTES_PER_TOKEN)))
}

function limitOutput(text: string, maxBytes: number): string {
  if (Buffer.byteLength(text, 'utf8') <= maxBytes) return text
  let end = Math.min(text.length, maxBytes)
  while (end > 0 && Buffer.byteLength(text.slice(0, end), 'utf8') > maxBytes) end--
  return `${text.slice(0, end)}\n[output truncated]`
}

function newChunkId(): string {
  return randomBytes(3).toString('hex')
}

function withChunkId(result: Omit<ExecResult, 'chunk_id'>): ExecResult {
  return { chunk_id: newChunkId(), ...result }
}

/** Render the ordinary Responses tool result text used by Codex's unified exec tools. */
export function renderExecResult(result: ExecResult): string {
  const sections: string[] = []
  if (result.chunk_id !== undefined) sections.push(`Chunk ID: ${result.chunk_id}`)
  sections.push(`Wall time: ${result.wall_time_seconds.toFixed(4)} seconds`)
  if (result.exit_code !== undefined) sections.push(`Process exited with code ${result.exit_code}`)
  if (result.session_id !== undefined) sections.push(`Process running with session ID ${result.session_id}`)
  if (result.job_id !== undefined) sections.push(`Background job ID: ${result.job_id}`)
  if (result.original_token_count !== undefined) sections.push(`Original token count: ${result.original_token_count}`)
  sections.push('Output:', result.output)
  return sections.join('\n')
}

function sessionCwd(exec: ToolExecution, workdir: string | undefined): string | undefined {
  const base = exec.agent?.session.header.cwd ?? process.cwd()
  if (workdir === undefined) return exec.agent?.session.header.cwd
  return resolvePath(base, workdir)
}

function readShellOutput(read: ShellProcessRead, maxBytes: number): string {
  return limitOutput(read.delta, maxBytes)
}

function terminalResult(result: TerminalSendResult, maxBytes: number, startedAt: number): ExecResult {
  const output = limitOutput(result.viewport, maxBytes)
  return withChunkId({
    wall_time_seconds: (performance.now() - startedAt) / 1000,
    output,
    ...result.sessionStatus.kind === 'exited' ? {
      ...result.sessionStatus.exitCode === null ? {} : { exit_code: result.sessionStatus.exitCode },
    } : {},
  })
}

/** Map a detached shell process onto the generic DSH job outcome contract. */
function backgroundOutcome(process: ShellProcess): JobOutcome {
  if (process.status === 'killed') {
    return {
      status: 'killed',
      detail: process.signal !== null ? `signal: ${process.signal}` : 'killed before exit',
    }
  }
  return { status: 'completed', detail: `exit code: ${process.exitCode ?? 0}` }
}

function sleep(ms: number, signal: AbortSignal): Promise<'elapsed' | 'aborted'> {
  return new Promise(resolve => {
    let timer: ReturnType<typeof setTimeout> | undefined
    const finish = (result: 'elapsed' | 'aborted') => {
      if (timer !== undefined) clearTimeout(timer)
      signal.removeEventListener('abort', onAbort)
      resolve(result)
    }
    const onAbort = () => finish('aborted')
    if (signal.aborted) {
      finish('aborted')
      return
    }
    signal.addEventListener('abort', onAbort, { once: true })
    timer = setTimeout(() => finish('elapsed'), ms)
  })
}

async function waitForShell(process: ShellProcess, ms: number, signal: AbortSignal): Promise<boolean> {
  const timer = sleep(ms, signal)
  const completed = await Promise.race([
    process.done.then(() => true),
    timer.then(result => result === 'aborted' ? false : undefined),
  ])
  if (signal.aborted) signal.throwIfAborted()
  return completed === true || process.status !== 'running'
}

/** Stop a pipe-backed session when the current Codex tool is cancelled. */
async function stopShellOnAbort(process: ShellProcess, signal: AbortSignal): Promise<void> {
  if (!signal.aborted || process.status !== 'running') return
  process.kill()
  await process.done
}

function allocateSession(agent: Agent, session: StoredSession): number {
  const state = stateFor(agent)
  const id = ++state.nextId
  state.sessions.set(id, session)
  return id
}

function storedSession(agent: Agent, id: number): StoredSession {
  const session = stateFor(agent).sessions.get(id)
  if (session === undefined) throw new Error(`unknown unified exec session ${id}`)
  return session
}

function forgetSession(agent: Agent, id: number): void {
  stateFor(agent).sessions.delete(id)
}

function commandFor(args: ExecCommandArgs): string {
  // The selected dsh shell provider owns the actual executable and login
  // defaults. These fields remain accepted so Codex's argument contract is
  // stable; dsh's shell capability is the deployment extension point.
  return args.cmd
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
  const workdir = sessionCwd(exec, args.workdir)
  const startedAt = performance.now()
  if (args.run_in_background === true && args.tty === true) {
    throw new Error('run_in_background is only supported for pipe-backed commands; omit tty')
  }
  if (args.tty === true) {
    const agent = exec.agent
    const terminals = ctx.get('terminals')
    if (agent === undefined || terminals === undefined) {
      throw new Error('exec_command with tty=true requires the dsh terminal capability and an owning agent session')
    }
    const spawnRequest: CodexTerminalSpawnRequest = {
      type: 'shell',
      ...args.shell === undefined ? {} : { shell: args.shell },
      login: args.login ?? true,
      ...workdir === undefined ? {} : { cwd: workdir },
    }
    const spawned = await terminals.spawn(agent, spawnRequest, exec.signal)
    let retained = false
    let closeReason = 'Codex command failed'
    try {
      const sendRequest: CodexTerminalSendRequest = {
        text: commandFor(args),
        submit: true,
        waitMs: normalizeWaitMs(args.yield_time_ms, config.defaultYieldTimeMs, false, true),
        signal: exec.signal,
      }
      const operation = terminals.startSend(agent, spawned.sessionId, sendRequest)
      const result = await operation.done
      const output = terminalResult(result, maxBytes, startedAt)
      if (result.sessionStatus.kind === 'running') {
        output.session_id = allocateSession(agent, { kind: 'terminal', owner: agent, id: spawned.sessionId })
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

  const policy = ctx.get('sandboxPolicy')?.resolve(exec.agent === undefined ? {} : { session: exec.agent.session })
  const dshEnv = ctx.get('shellEnv')?.collect(exec)
  // Background jobs intentionally omit the tool-call signal. Once this call
  // returns, the job lifetime belongs to the jobs registry, not the request.
  const shellRequest: CodexShellExecRequest = {
    command: commandFor(args),
    ...args.shell === undefined ? {} : { shell: args.shell },
    login: args.login ?? true,
    ...workdir === undefined ? {} : { workdir },
    stdoutMaxBytes: maxBytes,
    ...dshEnv === undefined ? {} : { dshEnv },
    ...policy === undefined ? {} : { sandboxPolicy: policy },
  }

  if (args.run_in_background === true) {
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
    const id = jobs.start({
      kind: 'bash',
      label: args.cmd,
      owner,
      outputLimitBytes: maxBytes,
      run: () => {
        const process = ctx.shell.start(ctx.shell.resolve(shellRequest))
        return {
          cancel: () => void process.kill(),
          done: process.done.then(() => backgroundOutcome(process)),
          readOutput: () => readShellOutput(process.readOutput(), maxBytes),
        }
      },
    })
    return withChunkId({
      wall_time_seconds: (performance.now() - startedAt) / 1000,
      job_id: id,
      output: `Started background job ${id}. Use job_output with job_id "${id}" to read output.`,
    })
  }

  const process = ctx.shell.start(ctx.shell.resolve({
    ...shellRequest,
    signal: exec.signal,
  }))
  try {
    await waitForShell(process, normalizeWaitMs(args.yield_time_ms, config.defaultYieldTimeMs, false, true), exec.signal)
    const output = readShellOutput(process.readOutput(), maxBytes)
    if (process.status === 'running') {
      if (exec.agent === undefined) {
        process.kill()
        await process.done
        return withChunkId({
          wall_time_seconds: (performance.now() - startedAt) / 1000,
          output: readShellOutput(process.readOutput(), maxBytes),
        })
      }
      return withChunkId({
        wall_time_seconds: (performance.now() - startedAt) / 1000,
        output,
        session_id: allocateSession(exec.agent, { kind: 'shell', process }),
      })
    }
    return withChunkId({
      wall_time_seconds: (performance.now() - startedAt) / 1000,
      output,
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
    if (chars.length > 0) {
      throw new Error('this unified exec session uses pipes and does not accept stdin; rerun exec_command with tty=true')
    }
    try {
      await waitForShell(session.process, normalizeWaitMs(args.yield_time_ms, config.pollYieldTimeMs, true), exec.signal)
      const output = readShellOutput(session.process.readOutput(), maxBytes)
      if (session.process.status !== 'running') {
        forgetSession(agent, args.session_id)
        return withChunkId({
          wall_time_seconds: (performance.now() - startedAt) / 1000,
          output,
          ...session.process.exitCode === null ? {} : { exit_code: session.process.exitCode },
        })
      }
      return withChunkId({
        wall_time_seconds: (performance.now() - startedAt) / 1000,
        output,
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
  const sendRequest: CodexTerminalSendRequest = {
    text: chars,
    submit: false,
    waitMs: normalizeWaitMs(
      args.yield_time_ms,
      chars.length > 0 ? config.writeYieldTimeMs : config.pollYieldTimeMs,
      chars.length === 0,
    ),
    signal: exec.signal,
  }
  let retained = false
  let closeReason = 'Codex command failed'
  try {
    const operation = terminals.startSend(agent, session.id, sendRequest)
    const result = await operation.done
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
    // A failed send must not strand either side of the two-level session
    // registry: the local numeric id and the underlying PTY must be retired
    // together. A successful running result is the only retained case.
    if (!retained) {
      forgetSession(agent, args.session_id)
      await terminals.kill(agent, session.id, closeReason)
    }
  }
}
