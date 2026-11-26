/** OpenAI Responses `/responses/compact` and V2 `/responses` transport with local compaction fallback. */

import type { Context } from '@deepseek-ai/cordis'
import { credentialRef } from '@deepseek-ai/dsh-credentials'
import { offloadedImageText, resolveImageAttachmentAccess } from '@deepseek-ai/dsh-llm'
import type { GenerateOptions, ImageBlock, Message, StreamChunk, TokenUsage, ToolSchema } from '@deepseek-ai/dsh-llm'
import { isGptModel, readHostSettings } from '../contracts/settings.ts'
import {
  collectTrustedCompactionMarkers,
  encodeRemoteCompactionCheckpoint,
  parseCompactResponsePayload,
  retainedUserMessagesFromInput,
} from './compact-checkpoint.ts'
import {
  capabilityKey,
  CONTEXT_LIMIT_ERROR,
  hostedWebSearchStream,
  isCompactUnsupported,
  recordUnsupportedCapability,
} from './fetch-transport.ts'
import {
  applyRequestWireOptions,
  replaceRemoteCompactions,
  rewriteCodexResponsesBody,
  serviceTierOf,
} from './wire-rewrite.ts'
import type { CodexRequestWireOptions, JsonObject } from './wire-rewrite.ts'

export interface RemoteCodexConfig {
  hostedWebSearch: boolean
  remoteCompact: boolean
}

interface ProviderProfile {
  api?: string
  baseURL?: string
  apiKeyEnv?: string
  headers?: Record<string, string>
}

interface LlmSettings {
  providers?: Record<string, ProviderProfile>
}

interface RemoteCompactResult {
  text: string
  usage?: TokenUsage
}

type RequestMessage = GenerateOptions['messages'][number]

const SETTINGS_NAMESPACE = 'llm-pi-ai'
const MAX_COMPACT_RETRIES = 2
const RETRYABLE_COMPACT_STATUS = new Set([429, 502, 503, 504])

function profileOf(ctx: Context, provider: string): ProviderProfile | undefined {
  return readHostSettings<LlmSettings>(ctx, SETTINGS_NAMESPACE)?.providers?.[provider]
}

function supportsResponses(profile: ProviderProfile | undefined, provider: string): boolean {
  return profile?.api === 'openai-responses'
    || profile?.api === 'openai-codex-responses'
    || (profile?.api === undefined && provider === 'openai')
}

/** True only when `llm-pi-ai` configures an OpenAI Responses route directly (never `openai-codex`). */
export function hasDirectResponsesCompactRoute(ctx: Context, provider: string): boolean {
  if (provider === 'openai-codex') return false
  const profile = profileOf(ctx, provider)
  return supportsResponses(profile, provider) && typeof profile?.baseURL === 'string' && profile.baseURL.length > 0
}

function responsesEndpoint(baseURL: string, suffix: 'responses' | 'responses/compact'): string {
  return `${baseURL.replace(/\/+$/, '')}/${suffix}`
}

function hasHeader(headers: Record<string, string> | undefined, name: string): boolean {
  return Object.keys(headers ?? {}).some(key => key.toLowerCase() === name.toLowerCase())
}

async function apiHeaders(
  ctx: Context,
  profile: ProviderProfile,
  isV2Responses: boolean,
): Promise<Record<string, string> | undefined> {
  const headers: Record<string, string> = { ...profile.headers, 'content-type': 'application/json' }
  if (isV2Responses) {
    if (!hasHeader(headers, 'openai-beta')) headers['openai-beta'] = 'responses=experimental'
    if (!hasHeader(headers, 'accept')) headers['accept'] = 'text/event-stream, application/json'
  }
  if (profile.apiKeyEnv !== undefined && !hasHeader(headers, 'authorization')) {
    const credentials = ctx.get('credentials') as {
      resolve(ref: string): Promise<{ value: string } | undefined>
    } | undefined
    const resolved = await credentials?.resolve(credentialRef(profile.apiKeyEnv))
    if (resolved?.value === undefined) return undefined
    headers.authorization = `Bearer ${resolved.value}`
  }
  return headers
}

const VALID_IMAGE_MEDIA_TYPES = new Set(['image/png', 'image/jpeg', 'image/webp', 'image/gif'])

function hasValidImageRef(attachment: unknown): attachment is ImageBlock['attachment'] {
  if (typeof attachment !== 'object' || attachment === null) return false
  const record = attachment as Record<string, unknown>
  return typeof record.attachmentId === 'string' && record.attachmentId.length > 0
    && typeof record.mediaType === 'string' && VALID_IMAGE_MEDIA_TYPES.has(record.mediaType)
    && typeof record.width === 'number' && typeof record.height === 'number'
}

function formatOffloadedImage(ctx: Context, block: ImageBlock): string {
  const attachments = ctx.get('attachments' as never) as { imageHostPath?: (ref: ImageBlock['attachment']) => string | undefined } | undefined
  const fs = ctx.get('fs' as never) as { processPathFromHostPath?: (hostPath: string) => string | undefined } | undefined
  const access = typeof attachments?.imageHostPath === 'function' && typeof fs?.processPathFromHostPath === 'function'
    ? resolveImageAttachmentAccess(attachments as never, hostPath => fs.processPathFromHostPath!(hostPath), block.attachment)
    : undefined
  return offloadedImageText(block.attachment, access)
}

function textOf(ctx: Context, message: Pick<Message, 'content'>): string {
  return message.content
    .map(block => {
      if (block.type === 'text') return block.text
      if (block.type === 'image') {
        if (block.offloaded !== true || !hasValidImageRef(block.attachment)) {
          throw new Error('Codex remote compaction requires the DSH adapter for image attachments')
        }
        return formatOffloadedImage(ctx, block)
      }
      return ''
    })
    .join('')
}

function stripCompactionPrompt(messages: readonly RequestMessage[]): readonly RequestMessage[] {
  const last = messages.at(-1)
  if (last !== undefined && last.role === 'user' && !('id' in last && last.id !== undefined)) {
    return messages.slice(0, -1)
  }
  return messages
}

function extractInstructions(ctx: Context, options: GenerateOptions, messages: readonly RequestMessage[]): string | undefined {
  if (options.system !== undefined) return options.system
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index]!
    if (message.role !== 'system') continue
    const text = textOf(ctx, message)
    return text.length > 0 ? text : undefined
  }
  return undefined
}

function responsesInput(ctx: Context, messages: readonly RequestMessage[]): JsonObject[] {
  const result: JsonObject[] = []
  for (const message of messages) {
    // This compact transport cannot serialize attachment file references losslessly.
    if (message.content.some(block => block.type === 'file')) {
      throw new Error('Codex remote compaction requires the DSH adapter for attachments')
    }
    if (message.role === 'system') continue
    const text = textOf(ctx, message)
    if (message.role === 'tool') {
      result.push({ type: 'function_call_output', call_id: message.toolCallId.split('|')[0]!, output: text })
      continue
    }
    if (message.role === 'assistant') {
      if (text.length > 0) result.push({
        type: 'message',
        role: 'assistant',
        content: [{ type: 'output_text', text }],
      })
      for (const block of message.content) {
        if (block.type === 'tool-call') {
          result.push({
            type: 'function_call',
            call_id: block.id.split('|')[0]!,
            name: block.name,
            arguments: block.arguments,
          })
        }
      }
      continue
    }
    const role = message.role === 'developer' ? 'developer' : 'user'
    if (text.length > 0) result.push({
      type: 'message',
      role,
      content: [{ type: 'input_text', text }],
    })
  }
  return result
}

function responsesTools(tools: readonly ToolSchema[] | undefined): JsonObject[] | undefined {
  if (tools === undefined) return undefined
  return tools.map(tool => ({
    type: 'function',
    name: tool.name,
    description: tool.description,
    parameters: tool.parameters,
  }))
}

function compactBody(
  ctx: Context,
  options: GenerateOptions,
  wireOptions: CodexRequestWireOptions,
  isV2Responses: boolean,
): { body: JsonObject; preCompactInput: JsonObject[] } {
  const messages = stripCompactionPrompt(options.messages)
  const instructions = extractInstructions(ctx, options, messages)
  const tools = responsesTools(options.tools)
  const serviceTier = wireOptions.serviceTier ?? serviceTierOf(options)
  const body: JsonObject = {
    model: options.model,
    input: responsesInput(ctx, messages),
    ...instructions !== undefined ? { instructions } : isV2Responses ? { instructions: '' } : {},
    ...tools === undefined ? {} : { tools },
    ...typeof options.sessionId === 'string' && options.sessionId.length > 0
      ? { prompt_cache_key: options.sessionId.slice(0, 64) }
      : {},
    ...options.reasoningEffort === undefined
      ? {}
      : { reasoning: isV2Responses ? { effort: options.reasoningEffort, summary: 'auto' } : { effort: options.reasoningEffort } },
    ...isV2Responses ? {
      store: false,
      stream: true,
      tool_choice: 'auto',
      parallel_tool_calls: true,
      include: ['reasoning.encrypted_content'],
    } : {},
  }
  const withOptions = applyRequestWireOptions(body, {
    ...wireOptions,
    ...serviceTier === undefined ? {} : { serviceTier },
  })
  const expanded = replaceRemoteCompactions(withOptions, wireOptions.trustedCheckpoints)
  const rewritten = rewriteCodexResponsesBody(expanded, wireOptions)
  const preCompactInput = Array.isArray(rewritten.input)
    ? rewritten.input.filter((item): item is JsonObject => typeof item === 'object' && item !== null)
    : []
  if (!isV2Responses) return { body: rewritten, preCompactInput }
  return {
    body: { ...rewritten, input: [...preCompactInput, { type: 'compaction_trigger' }] },
    preCompactInput,
  }
}

function canRewriteCompactTools(
  options: GenerateOptions,
  wireOptions: CodexRequestWireOptions,
): boolean {
  if (!isGptModel(options.model) || options.tools === undefined) return false
  return (wireOptions.hostedWebSearch !== false && options.tools.some(tool => tool.name === 'web_search'))
    || (wireOptions.customApplyPatch !== false && options.tools.some(tool => tool.name === 'apply_patch'))
}

function nonNegativeInteger(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : undefined
}

/** Map the Responses compact usage object without inventing missing counts. */
function compactUsage(rawUsage: JsonObject | undefined): TokenUsage | undefined {
  if (rawUsage === undefined) return undefined
  const inputTokens = nonNegativeInteger(rawUsage.input_tokens)
  const outputTokens = nonNegativeInteger(rawUsage.output_tokens)
  if (inputTokens === undefined || outputTokens === undefined) return undefined

  const details = typeof rawUsage.input_tokens_details === 'object' && rawUsage.input_tokens_details !== null
    ? rawUsage.input_tokens_details as JsonObject
    : undefined
  const cacheReadTokens = nonNegativeInteger(details?.cached_tokens)
  const cacheWriteTokens = nonNegativeInteger(details?.cache_write_tokens)
  const cached = cacheReadTokens ?? 0
  const writes = cacheWriteTokens ?? 0

  if (cached + writes > inputTokens) return undefined
  return {
    inputTokens: inputTokens - cached - writes,
    outputTokens,
    ...cacheReadTokens !== undefined && cacheReadTokens > 0 ? { cacheReadTokens } : {},
    ...cacheWriteTokens !== undefined && cacheWriteTokens > 0 ? { cacheWriteTokens } : {},
  }
}

function retryDelayMs(response: Response, attempt: number): number {
  const retryAfter = response.headers.get('retry-after')?.trim()
  if (retryAfter !== undefined && /^\d+(?:\.\d+)?$/u.test(retryAfter)) {
    return Math.min(4_000, Math.max(0, Math.round(Number(retryAfter) * 1000)))
  }
  return 200 * 2 ** attempt
}

async function waitForRetry(delay: number, signal?: AbortSignal): Promise<void> {
  if (delay <= 0) {
    signal?.throwIfAborted()
    return
  }
  await new Promise<void>((resolve, reject) => {
    if (signal?.aborted) { reject(signal.reason); return }
    const onAbort = () => { clearTimeout(timer); reject(signal!.reason) }
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort)
      resolve()
    }, delay)
    signal?.addEventListener('abort', onAbort, { once: true })
  })
}

async function sendWithRetry(
  endpoint: string,
  headers: Record<string, string>,
  payload: JsonObject,
  signal?: AbortSignal,
): Promise<Response> {
  const serialized = JSON.stringify(payload)
  for (let attempt = 0; attempt <= MAX_COMPACT_RETRIES; attempt += 1) {
    const response = await fetch(endpoint, {
      method: 'POST',
      headers,
      body: serialized,
      ...signal === undefined ? {} : { signal },
    })
    if (!RETRYABLE_COMPACT_STATUS.has(response.status) || attempt === MAX_COMPACT_RETRIES) {
      return response
    }
    const delay = retryDelayMs(response, attempt)
    await response.body?.cancel().catch(() => undefined)
    await waitForRetry(delay, signal)
  }
  throw new Error('Codex remote compaction retries exhausted')
}

async function remoteCompact(
  ctx: Context,
  options: GenerateOptions,
  wireOptions: CodexRequestWireOptions = {},
): Promise<RemoteCompactResult> {
  if (!hasDirectResponsesCompactRoute(ctx, options.provider)) {
    throw new Error('Codex remote compaction requires an OpenAI Responses provider with baseURL')
  }
  const profile = profileOf(ctx, options.provider)!
  const isV2Responses = profile.api === 'openai-codex-responses'
  const headers = await apiHeaders(ctx, profile, isV2Responses)
  if (headers === undefined) throw new Error('Codex remote compaction has no configured API key')
  const endpoint = responsesEndpoint(profile.baseURL!, isV2Responses ? 'responses' : 'responses/compact')
  const key = capabilityKey(endpoint, options.model)
  if (isCompactUnsupported(key)) {
    throw new Error('remote compaction is cached as unsupported for this endpoint')
  }

  const compactWireOptions: CodexRequestWireOptions = {
    ...wireOptions,
    trustedCheckpoints: wireOptions.trustedCheckpoints ?? collectTrustedCompactionMarkers(options.messages),
  }
  const initial = compactBody(ctx, options, compactWireOptions, isV2Responses)
  let preCompactInput = initial.preCompactInput
  let response = await sendWithRetry(endpoint, headers, initial.body, options.signal)

  if (!response.ok
    && (response.status === 400 || response.status === 422)
    && canRewriteCompactTools(options, wireOptions)) {
    const errorText = await response.clone().text().catch(() => '')
    if (!CONTEXT_LIMIT_ERROR.test(errorText)) {
      const reduced = compactBody(ctx, options, {
        ...compactWireOptions,
        hostedWebSearch: false,
        customApplyPatch: false,
      }, isV2Responses)
      preCompactInput = reduced.preCompactInput
      response = await sendWithRetry(endpoint, headers, reduced.body, options.signal)
    }
  }
  if (!response.ok) {
    if (response.status === 404 || response.status === 405 || response.status === 501) {
      recordUnsupportedCapability(key, { remoteCompact: false })
    }
    throw new Error(`remote compaction returned HTTP ${response.status}`)
  }

  const parsed = await parseCompactResponsePayload(response)
  if (parsed.compactions.length === 0) throw new Error('remote compaction returned no compaction text')
  const sourceBytes = Buffer.byteLength(JSON.stringify(preCompactInput), 'utf8')
  const encryptedBytes = parsed.compactions.reduce(
    (sum, item) => sum + Buffer.byteLength(JSON.stringify(item), 'utf8'),
    0,
  )
  const retained = retainedUserMessagesFromInput(preCompactInput, sourceBytes, encryptedBytes)
  const text = encodeRemoteCompactionCheckpoint(retained, parsed.compactions)
  const usage = compactUsage(parsed.usage)
  return { text, ...usage === undefined ? {} : { usage } }
}

/** Remote-first compaction waterfall with clean delegation for `openai-codex` and DSH fallback. */
export function remoteCompactStream(
  ctx: Context,
  options: GenerateOptions,
  next: () => AsyncIterable<StreamChunk>,
  wireOptions: CodexRequestWireOptions = {},
): AsyncIterable<StreamChunk> {
  if (options.provider === 'openai-codex') return next()
  return (async function* (): AsyncGenerator<StreamChunk> {
    try {
      const result = await remoteCompact(ctx, options, wireOptions)
      yield { type: 'block-start', index: 0, blockType: 'text' }
      yield { type: 'text-delta', index: 0, text: result.text }
      yield { type: 'block-end', index: 0, block: { type: 'text', text: result.text } }
      if (result.usage !== undefined) yield { type: 'usage', usage: result.usage }
      yield { type: 'finish', reason: { kind: 'stop' } }
    } catch (error) {
      if (options.signal?.aborted) throw error
      ctx.logger.warn('codex: remote compaction failed; using dsh-compaction-basic fallback')
      ctx.logger.warn(error)
      const serviceTier = wireOptions.serviceTier ?? serviceTierOf(options)
      yield* hostedWebSearchStream(next, {
        ...wireOptions,
        ...serviceTier === undefined ? {} : { serviceTier },
      })
    }
  })()
}
