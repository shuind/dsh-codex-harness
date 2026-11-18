/** Output truncation, `\r` sanitization, timing bounds, and rendering for unified exec. */

import { randomBytes } from 'node:crypto'
import { HarnessError } from '@deepseek-ai/dsh-llm'
import type { JobOutcome } from '@deepseek-ai/dsh-jobs'
import type { ShellExecution, ShellProcess, ShellProcessRead, ShellRunResult } from '@deepseek-ai/dsh-shell'
import { escalationHintMarker, sandboxDenialMarker } from '@deepseek-ai/dsh-sandbox'
import type { TerminalSendResult } from '@deepseek-ai/dsh-terminal'

/** The exact model-facing argument vocabulary of Codex's unified exec tool. */
export interface ExecCommandArgs {
  cmd: string
  workdir?: string
  tty?: boolean
  run_in_background?: boolean
  yield_time_ms?: number
  max_output_tokens?: number
  sandbox_permissions?: string
  justification?: string
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

const MIN_YIELD_TIME_MS = 250
const WINDOWS_INITIAL_EXEC_YIELD_TIME_MS = 10_000
const MIN_EMPTY_YIELD_TIME_MS = 5_000
const MAX_YIELD_TIME_MS = 30_000
const MAX_EMPTY_YIELD_TIME_MS = 300_000
const DEFAULT_OUTPUT_TOKENS = 10_000
const APPROX_BYTES_PER_TOKEN = 4
const INTERACTIVE_PROMPT_RE = /(?:\[(?:y\/n|yes\/no)\]|\((?:y\/n|yes\/no)\)|(?:password|passphrase|overwrite|continue)\s*[?:]\s*$)/i

export function positiveFinite(name: string, value: number | undefined): void {
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

export function outputLimit(maxOutputBytes: number, maxOutputTokens: number | undefined): number {
  const tokens = maxOutputTokens ?? DEFAULT_OUTPUT_TOKENS
  if (maxOutputTokens !== undefined) positiveFinite('max_output_tokens', maxOutputTokens)
  return Math.max(1, Math.min(maxOutputBytes, Math.trunc(tokens * APPROX_BYTES_PER_TOKEN)))
}

/** O(N) symmetric head+tail UTF-8 truncation that never splits a code point. */
export function truncateOutput(text: string, maxBytes: number): { text: string; originalTokenCount?: number } {
  const totalBytes = Buffer.byteLength(text, 'utf8')
  if (totalBytes <= maxBytes) return { text }
  const buf = Buffer.from(text, 'utf8')
  const headBudget = Math.ceil(maxBytes / 2)
  const tailBudget = Math.floor(maxBytes / 2)
  let headEnd = Math.min(headBudget, buf.length)
  // Walk back past UTF-8 continuation bytes (10xxxxxx) to land on a code point boundary.
  while (headEnd > 0 && headEnd < buf.length && (buf[headEnd]! & 0xc0) === 0x80) headEnd--
  let tailStart = Math.max(headEnd, buf.length - tailBudget)
  // Walk forward past continuation bytes so tail starts cleanly at a code point boundary.
  while (tailStart < buf.length && (buf[tailStart]! & 0xc0) === 0x80) tailStart++
  const omittedBytes = tailStart - headEnd
  if (omittedBytes <= 0) return { text }
  const marker = `…${Math.ceil(omittedBytes / APPROX_BYTES_PER_TOKEN)} tokens truncated…`
  const head = headEnd > 0 ? buf.subarray(0, headEnd).toString('utf8') : ''
  const tail = tailStart < buf.length ? buf.subarray(tailStart).toString('utf8') : ''
  const formatted = head.length > 0 && tail.length > 0
    ? `${head}\n${marker}\n${tail}`
    : head.length > 0
      ? `${head}\n${marker}`
      : tail.length > 0
        ? `${marker}\n${tail}`
        : marker
  return {
    text: formatted,
    originalTokenCount: Math.ceil(totalBytes / APPROX_BYTES_PER_TOKEN),
  }
}

/** Strip NULs and collapse bare `\r` progress overwrites on pipe output while preserving `\r\n`. */
export function sanitizePipeOutput(delta: string): string {
  if (!delta.includes('\x00') && !delta.includes('\r')) return delta
  const withoutNulls = delta.includes('\x00') ? delta.replaceAll('\x00', '') : delta
  if (!/\r(?!\n)/.test(withoutNulls)) return withoutNulls
  const lines = withoutNulls.split('\n')
  return lines.map((line, index) => {
    const hasCrlf = index < lines.length - 1 && line.endsWith('\r')
    const body = hasCrlf ? line.slice(0, -1) : line
    if (!body.includes('\r')) return hasCrlf ? `${body}\r` : body
    const segments = body.split('\r')
    const collapsed = segments.findLast(segment => segment.length > 0) ?? ''
    return hasCrlf ? `${collapsed}\r` : collapsed
  }).join('\n')
}

export function hasInteractivePrompt(output: string): boolean {
  const lines = output.split(/\r?\n/)
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i]!.trimEnd()
    if (line.length === 0) continue
    return INTERACTIVE_PROMPT_RE.test(line)
  }
  return false
}

export function withChunkId(result: Omit<ExecResult, 'chunk_id'>): ExecResult {
  return { chunk_id: randomBytes(3).toString('hex'), ...result }
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

/** Preserve policy/runner facts after bounding command output; never truncate these markers. */
export function sandboxNotes(sandbox: ShellProcess['sandbox'], escalationAvailable: boolean): string[] {
  if (sandbox?.runnerFailed) return [`[sandbox: the sandbox runner itself failed under ${sandbox.mode} mode — the command did not run; this is a sandbox problem, not a command failure]`]
  if (!sandbox?.denied) return []
  return [sandboxDenialMarker(sandbox.mode), ...escalationAvailable ? [escalationHintMarker('command')] : []]
}

/** Surface infrastructure failures from the execution handle without reclassifying nonzero exits. */
export async function assertShellCompleted(process: ShellProcess, escalationAvailable = false): Promise<ShellRunResult | undefined> {
  const result = (process as Partial<ShellExecution>).result
  if (typeof result !== 'function') return undefined
  try {
    return await result.call(process)
  } catch (error) {
    const notes = sandboxNotes(process.sandbox, escalationAvailable)
    if (notes.length === 0) throw error
    const message = [error instanceof Error ? error.message : String(error), ...notes].join('\n')
    const failure = error instanceof HarnessError
      ? new HarnessError(message, error.code, { cause: error })
      : new Error(message, { cause: error })
    if (error instanceof Error) failure.name = error.name
    throw failure
  }
}

export function readShellOutput(
  read: ShellProcessRead,
  maxBytes: number,
  sandbox?: ShellProcess['sandbox'],
  escalationAvailable = false,
): { output: string; originalTokenCount?: number } {
  const truncated = truncateOutput(sanitizePipeOutput(read.delta), maxBytes)
  const notes = sandboxNotes(sandbox, escalationAvailable)
  const output = notes.length === 0
    ? truncated.text
    : `${truncated.text}${truncated.text.length > 0 && !truncated.text.endsWith('\n') ? '\n' : ''}${notes.join('\n')}`
  return truncated.originalTokenCount === undefined
    ? { output }
    : { output, originalTokenCount: truncated.originalTokenCount }
}

export function terminalResult(result: TerminalSendResult, maxBytes: number, startedAt: number): ExecResult {
  const truncated = truncateOutput(result.viewport, maxBytes)
  return withChunkId({
    wall_time_seconds: (performance.now() - startedAt) / 1000,
    output: truncated.text,
    ...truncated.originalTokenCount === undefined ? {} : { original_token_count: truncated.originalTokenCount },
    ...result.sessionStatus.kind === 'exited' ? {
      ...result.sessionStatus.exitCode === null ? {} : { exit_code: result.sessionStatus.exitCode },
    } : {},
  })
}

/** Map a detached shell process onto the generic DSH job outcome contract. */
export function backgroundOutcome(process: ShellProcess, escalationAvailable: boolean, sandbox = process.sandbox): JobOutcome {
  const base: JobOutcome = process.status === 'killed'
    ? { status: 'killed', detail: process.signal !== null ? `signal: ${process.signal}` : 'killed before exit' }
    : { status: 'completed', detail: `exit code: ${process.exitCode ?? 0}` }
  const notes = sandboxNotes(sandbox, escalationAvailable)
  return notes.length === 0 ? base : { ...base, detail: `${base.detail}; ${notes.join(' ')}` }
}
