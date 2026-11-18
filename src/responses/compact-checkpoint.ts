/** Trusted remote-compaction checkpoints (V1 & V2), retained-user budgeting, and SSE parsing. */

import { isCompactCheckpointSource } from '@deepseek-ai/dsh-compaction'
import type { GenerateOptions } from '@deepseek-ai/dsh-llm'

export interface JsonObject {
  [key: string]: unknown
}

export const REMOTE_COMPACTION_OPEN = '<codex-remote-compaction>'
export const REMOTE_COMPACTION_CLOSE = '</codex-remote-compaction>'
export const CODEX_CONNECT_COMPACTION_OPEN = '<dsh-codex-connect-native-compaction-v1>'
export const MAX_RETAINED_USER_BYTES = 64_000

const V2_PREFIX = 'v2:'
const MAX_CHECKPOINT_PAYLOAD_BYTES = 2 * 1024 * 1024
const MAX_COMPACT_STREAM_BYTES = 8 * 1024 * 1024

function isJsonObject(value: unknown): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function asCompactionItem(item: unknown): JsonObject | undefined {
  if (!isJsonObject(item) || item.type !== 'compaction') return undefined
  if (typeof item.encrypted_content !== 'string') return undefined
  const encrypted = item.encrypted_content.trim()
  if (encrypted.length === 0) return undefined
  if (item.id !== undefined && (typeof item.id !== 'string' || item.id.length === 0)) {
    return undefined
  }
  return {
    type: 'compaction',
    encrypted_content: encrypted,
    ...typeof item.id === 'string' && item.id.length > 0 ? { id: item.id } : {},
  }
}

function validateCheckpointItems(items: readonly unknown[]): JsonObject[] {
  if (items.length === 0 || items.length > 1024) {
    throw new Error('Invalid Codex v2 compaction checkpoint')
  }
  let compactionCount = 0
  const validated: JsonObject[] = []
  for (const raw of items) {
    const compaction = asCompactionItem(raw)
    if (compaction !== undefined) {
      compactionCount += 1
      validated.push(compaction)
      continue
    }
    if (!isJsonObject(raw)
      || raw.role !== 'user'
      || (raw.type !== undefined && raw.type !== 'message')
      || !Array.isArray(raw.content)) {
      throw new Error('Invalid Codex v2 compaction checkpoint')
    }
    validated.push(raw)
  }
  if (compactionCount === 0 || validated.at(-1)?.type !== 'compaction') {
    throw new Error('Invalid Codex v2 compaction checkpoint')
  }
  return validated
}

/** Recognize either harness-owned or `dsh-codex-connect`-owned remote compaction text. */
export function isAnyRemoteCompactionText(text: string): boolean {
  return text.includes(REMOTE_COMPACTION_OPEN) || text.includes(CODEX_CONNECT_COMPACTION_OPEN)
}

/** Extract inner checkpoint payload bounded by `<codex-remote-compaction>...</codex-remote-compaction>`. */
export function extractMarkerBody(text: string): string | undefined {
  const startOffset = text.indexOf(REMOTE_COMPACTION_OPEN)
  if (startOffset < 0) return undefined
  const start = startOffset + REMOTE_COMPACTION_OPEN.length
  const end = text.indexOf(REMOTE_COMPACTION_CLOSE, start)
  return end > start ? text.slice(start, end) : undefined
}

/** Read-only scan of request messages returning trusted checkpoint marker bodies. */
export function collectTrustedCompactionMarkers(messages: GenerateOptions['messages']): ReadonlySet<string> {
  const trusted = new Set<string>()
  for (const message of messages) {
    const source = 'source' in message ? message.source : undefined
    const isTrustedSource = source === undefined
      || (typeof source === 'object' && source !== null
        && isCompactCheckpointSource(source as Parameters<typeof isCompactCheckpointSource>[0]))
    if (!isTrustedSource) continue
    for (const block of message.content) {
      if (block.type !== 'text' || typeof block.text !== 'string') continue
      const inner = extractMarkerBody(block.text)
      if (inner !== undefined) trusted.add(inner)
    }
  }
  return trusted
}

/** Retain newest user-role input items within an adaptive byte budget below compacted source size. */
export function retainedUserMessagesFromInput(
  input: readonly JsonObject[],
  sourceBytes: number,
  encryptedBytes: number,
): JsonObject[] {
  const adaptiveBudget = Math.floor(sourceBytes * 0.45) - Math.ceil(encryptedBytes * 1.4)
  const budget = Math.max(0, Math.min(MAX_RETAINED_USER_BYTES, adaptiveBudget))
  if (budget <= 2) return []

  const retained: JsonObject[] = []
  let used = 0
  for (let index = input.length - 1; index >= 0; index -= 1) {
    const item = input[index]!
    if (item.role !== 'user'
      || (item.type !== undefined && item.type !== 'message')
      || !Array.isArray(item.content)) {
      continue
    }
    const size = Buffer.byteLength(JSON.stringify(item), 'utf8') + (retained.length === 0 ? 0 : 1)
    if (!Number.isFinite(size) || size <= 0 || size > budget - used) continue
    retained.push(item)
    used += size
  }
  return retained.reverse()
}

/** Encode encrypted compaction items plus retained user turns into a replay marker string. */
export function encodeRemoteCompactionCheckpoint(
  retained: readonly JsonObject[],
  compactions: readonly JsonObject[],
): string {
  if (compactions.length === 0) {
    throw new Error('Codex remote compaction requires at least one compaction item')
  }
  const validatedCompactions = compactions.map(item => {
    const valid = asCompactionItem(item)
    if (valid === undefined) {
      throw new Error('Codex remote compaction returned an invalid compaction item')
    }
    return valid
  })
  if (retained.length === 0 && validatedCompactions.length === 1 && validatedCompactions[0]!.id === undefined) {
    return `${REMOTE_COMPACTION_OPEN}${String(validatedCompactions[0]!.encrypted_content)}${REMOTE_COMPACTION_CLOSE}`
  }
  const items = validateCheckpointItems([...retained, ...validatedCompactions])
  const payload = JSON.stringify({ version: 2, items })
  if (Buffer.byteLength(payload, 'utf8') > MAX_CHECKPOINT_PAYLOAD_BYTES) {
    throw new Error('Codex remote compaction checkpoint exceeds 2 MiB')
  }
  return `${REMOTE_COMPACTION_OPEN}${V2_PREFIX}${Buffer.from(payload, 'utf8').toString('base64url')}${REMOTE_COMPACTION_CLOSE}`
}

/** Decode a V1 or V2 inner checkpoint string back into Responses input items. */
export function decodeRemoteCompactionMarker(inner: string): JsonObject[] | undefined {
  if (inner.length === 0) return undefined
  if (!inner.startsWith(V2_PREFIX)) {
    return [{ type: 'compaction', encrypted_content: inner }]
  }
  const encoded = inner.slice(V2_PREFIX.length)
  if (encoded.length === 0 || Buffer.byteLength(encoded, 'utf8') > Math.ceil(MAX_CHECKPOINT_PAYLOAD_BYTES / 3) * 4 + 32) {
    throw new Error('Invalid Codex v2 compaction checkpoint')
  }
  let decoded: unknown
  try {
    const raw = Buffer.from(encoded, 'base64url')
    if (raw.byteLength > MAX_CHECKPOINT_PAYLOAD_BYTES) throw new Error('oversized')
    decoded = JSON.parse(raw.toString('utf8'))
  } catch (error) {
    throw new Error('Invalid Codex v2 compaction checkpoint', { cause: error })
  }
  if (!isJsonObject(decoded) || decoded.version !== 2 || !Array.isArray(decoded.items)) {
    throw new Error('Invalid Codex v2 compaction checkpoint')
  }
  return validateCheckpointItems(decoded.items)
}

/** Parse either a JSON `/responses/compact` body or a V2 Responses SSE compaction stream. */
export async function parseCompactResponsePayload(
  response: Response,
): Promise<{ compactions: JsonObject[]; usage?: JsonObject }> {
  const contentType = response.headers.get('content-type')?.toLowerCase() ?? ''
  if (!contentType.includes('text/event-stream')) {
    const body = await response.json() as JsonObject
    const output = Array.isArray(body.output) ? body.output : []
    const compactions: JsonObject[] = []
    for (const item of output) {
      if (!isJsonObject(item) || typeof item.encrypted_content !== 'string') continue
      const encrypted = item.encrypted_content.trim()
      if (encrypted.length === 0) continue
      compactions.push({
        type: 'compaction',
        encrypted_content: encrypted,
        ...typeof item.id === 'string' && item.id.length > 0 ? { id: item.id } : {},
      })
    }
    return {
      compactions,
      ...isJsonObject(body.usage) ? { usage: body.usage } : {},
    }
  }

  if (response.body === null) throw new Error('Codex remote compaction stream had no body')
  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  const compactions: JsonObject[] = []
  let buffer = ''
  let receivedBytes = 0
  let completed = false
  let usage: JsonObject | undefined

  const consumeFrame = (frame: string): void => {
    const data = frame
      .split(/\r?\n/u)
      .filter(line => line.startsWith('data:'))
      .map(line => line.slice(5).trimStart())
      .join('\n')
      .trim()
    if (data.length === 0 || data === '[DONE]') return
    const event = JSON.parse(data) as unknown
    if (!isJsonObject(event)) return
    if (event.type === 'response.output_item.done') {
      const item = asCompactionItem(event.item)
      if (item !== undefined) compactions.push(item)
      return
    }
    if (event.type === 'response.failed' || event.type === 'error') {
      throw new Error('Codex remote compaction stream reported failure')
    }
    if (event.type !== 'response.completed' && event.type !== 'response.done') return
    const terminal = event.response
    if (completed || !isJsonObject(terminal) || terminal.status !== 'completed') {
      throw new Error('Codex remote compaction stream ended without completed status')
    }
    if (isJsonObject(terminal.usage)) usage = terminal.usage
    completed = true
  }

  try {
    for (;;) {
      const { done, value } = await reader.read()
      receivedBytes += value?.byteLength ?? 0
      if (receivedBytes > MAX_COMPACT_STREAM_BYTES) {
        throw new Error('Codex remote compaction stream exceeded 8 MiB limit')
      }
      buffer += decoder.decode(value, { stream: !done })
      for (;;) {
        const match = /\r?\n\r?\n/u.exec(buffer)
        if (match === null) break
        consumeFrame(buffer.slice(0, match.index))
        buffer = buffer.slice(match.index + match[0].length)
      }
      if (done) break
    }
    if (buffer.trim().length > 0) consumeFrame(buffer)
  } finally {
    await reader.cancel().catch(() => undefined)
    reader.releaseLock()
  }

  if (!completed || compactions.length === 0) {
    throw new Error('Codex remote compaction stream ended without a valid compaction item')
  }
  return {
    compactions,
    ...usage === undefined ? {} : { usage },
  }
}
