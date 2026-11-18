/** SSE error frame capture and legacy pi-ai context-overflow stream repair. */

import type { StreamChunk, TokenUsage } from '@deepseek-ai/dsh-llm'
import { randomUUID } from 'node:crypto'
import { mkdir, readdir, rename, unlink, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'

const CONTEXT_WINDOW_EXCEEDED_CODE = 'CONTEXT_WINDOW_EXCEEDED'
const CODEX_ERROR_DIRECTORY = ['diagnostics', 'openai-codex-errors'] as const
const MAX_DIAGNOSTIC_FILES = 50

function diagnosticsDirectory(): string {
  const configured = process.env['DSH_HOME']?.trim()
  const expanded = configured === undefined || configured.length === 0
    ? join(homedir(), '.dsh')
    : configured === '~'
      ? homedir()
      : configured.startsWith('~/') || configured.startsWith('~\\')
        ? join(homedir(), configured.slice(2))
        : configured
  return join(resolve(expanded), ...CODEX_ERROR_DIRECTORY)
}

async function saveCodexErrorPayload(payload: string): Promise<void> {
  const directory = diagnosticsDirectory()
  await mkdir(directory, { recursive: true, mode: 0o700 })
  const filename = `${Date.now()}-${randomUUID()}.json`
  const tempPath = join(directory, `.${filename}.tmp`)
  try {
    await writeFile(tempPath, `${payload}\n`, { flag: 'wx', mode: 0o600 })
    await rename(tempPath, join(directory, filename))
  } catch (error) {
    await unlink(tempPath).catch(() => {})
    throw error
  }
  const entries = (await readdir(directory)).filter(name => name.endsWith('.json') && !name.startsWith('.')).sort()
  for (const stale of entries.slice(0, Math.max(0, entries.length - MAX_DIAGNOSTIC_FILES))) {
    await unlink(join(directory, stale)).catch(() => {})
  }
}

function errorPayloadFromSseFrame(frame: string): string | undefined {
  const data = frame
    .split(/\r?\n/u)
    .filter(line => line.startsWith('data:'))
    .map(line => line.slice(5).trimStart())
    .join('\n')
    .trim()
  if (data.length === 0 || data === '[DONE]') return undefined
  try {
    const payload = JSON.parse(data) as { type?: unknown }
    return payload.type === 'error' || payload.type === 'response.failed' ? data : undefined
  } catch {
    return undefined
  }
}

async function captureCodexErrorPayloads(response: Response): Promise<void> {
  if (response.body === null) return
  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  try {
    while (true) {
      const { done, value } = await reader.read()
      buffer += decoder.decode(value, { stream: !done })
      while (true) {
        const delimiter = /\r?\n\r?\n/u.exec(buffer)
        if (delimiter?.index === undefined) break
        const frame = buffer.slice(0, delimiter.index)
        buffer = buffer.slice(delimiter.index + delimiter[0].length)
        const payload = errorPayloadFromSseFrame(frame)
        if (payload === undefined) continue
        try {
          await saveCodexErrorPayload(payload)
        } catch {
          // Diagnostics must never replace the provider response or failure.
        }
      }
      if (done) return
    }
  } finally {
    reader.releaseLock()
  }
}

export function captureCodexErrors(response: Response): Response {
  if (!response.headers.get('content-type')?.toLowerCase().includes('text/event-stream')) return response
  try {
    void captureCodexErrorPayloads(response.clone()).catch(() => {
      // Reading the diagnostic branch must not affect the provider stream.
    })
  } catch {
    // An already-consumed response remains usable by its original consumer.
  }
  return response
}

function contextTokens(usage: TokenUsage): number | undefined {
  const fields = [
    usage.inputTokens,
    usage.outputTokens,
    usage.cacheReadTokens ?? 0,
    usage.cacheWriteTokens ?? 0,
  ]
  if (fields.some(value => !Number.isSafeInteger(value) || value < 0)) return undefined
  const total = fields.reduce((sum, value) => sum + value, 0)
  return Number.isSafeInteger(total) ? total : undefined
}

function isSyntheticPiAiOverflow(message: string, model: string): boolean {
  const prefix = `pi-ai detected context overflow for model "${model}"`
  if (message === prefix) return true
  if (!message.startsWith(prefix)) return false
  return message.slice(prefix.length).trimStart().startsWith('[Codex diagnostics:')
}

/**
 * Correct the usage-only overflow verdict emitted by pi-ai adapters that do
 * not yet consume the request-scoped Codex capacity.
 */
export function repairLegacyPiAiContextOverflow(
  stream: AsyncIterable<StreamChunk>,
  model: string,
  contextWindow: unknown,
): AsyncIterable<StreamChunk> {
  return (async function* (): AsyncGenerator<StreamChunk> {
    let usage: TokenUsage | undefined
    let hasStreamedOutput = false
    for await (const chunk of stream) {
      if (chunk.type === 'usage') usage = chunk.usage
      else if (chunk.type === 'tool-call-delta'
        || (chunk.type === 'block-start' && chunk.blockType === 'tool-call')
        || ((chunk.type === 'text-delta' || chunk.type === 'reasoning-delta') && chunk.text.length > 0)) {
        hasStreamedOutput = true
      }
      const usedTokens = usage === undefined ? undefined : contextTokens(usage)
      if (chunk.type === 'finish'
        && chunk.reason.kind === 'error'
        && chunk.reason.failure.code === CONTEXT_WINDOW_EXCEEDED_CODE
        && isSyntheticPiAiOverflow(chunk.reason.failure.message, model)
        && typeof contextWindow === 'number'
        && Number.isSafeInteger(contextWindow)
        && contextWindow > 0
        && usage !== undefined
        && (usage.outputTokens > 0 || hasStreamedOutput)
        && usedTokens !== undefined
        && usedTokens <= contextWindow) {
        yield { ...chunk, reason: { kind: 'stop' } }
        continue
      }
      yield chunk
    }
  })()
}
