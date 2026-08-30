import type { Context } from '@deepseek-ai/cordis'
import { credentialRef } from '@deepseek-ai/dsh-credentials'
import type { GenerateOptions, Message, StreamChunk, TokenUsage, ToolSchema } from '@deepseek-ai/dsh-llm'
import { AsyncLocalStorage } from 'node:async_hooks'
import { APPLY_PATCH_DESCRIPTION, APPLY_PATCH_GRAMMAR } from './patch.ts'

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

interface JsonObject {
  [key: string]: unknown
}

interface RemoteCompactResult {
  text: string
  usage?: TokenUsage
}

const SETTINGS_NAMESPACE = 'llm-pi-ai'
const REMOTE_COMPACTION_OPEN = '<codex-remote-compaction>'
const REMOTE_COMPACTION_CLOSE = '</codex-remote-compaction>'
interface CodexRequestWireOptions {
  /** Provider-facing request option preserved by older DSH LLM adapters. */
  serviceTier?: string
}

const HOSTED_REQUESTS = new AsyncLocalStorage<CodexRequestWireOptions>()
let hostedPatchUsers = 0
let hostedPatchRestore: (() => void) | undefined

function serviceTierOf(options: GenerateOptions): string | undefined {
  const value = (options as GenerateOptions & { serviceTier?: unknown }).serviceTier
  return typeof value === 'string' ? value : undefined
}

function isGptModel(model: unknown): model is string {
  return typeof model === 'string' && /(?:^|\/)(?:gpt|chatgpt)(?:[-_.]|\d|$)/i.test(model)
}

function settingsOf(ctx: Context): LlmSettings | undefined {
  const provider = ctx.get('settings') as { get?: (namespace: unknown) => unknown } | undefined
  return provider?.get?.(SETTINGS_NAMESPACE) as LlmSettings | undefined
}

function profileOf(ctx: Context, provider: string): ProviderProfile | undefined {
  return settingsOf(ctx)?.providers?.[provider]
}

function supportsResponses(profile: ProviderProfile | undefined, provider: string): boolean {
  return profile?.api === 'openai-responses'
    || profile?.api === 'openai-codex-responses'
    || (profile?.api === undefined && provider === 'openai')
}

function responsesEndpoint(baseURL: string, suffix: 'responses' | 'responses/compact'): string {
  return `${baseURL.replace(/\/+$/, '')}/${suffix}`
}

function hasHeader(headers: Record<string, string> | undefined, name: string): boolean {
  return Object.keys(headers ?? {}).some(key => key.toLowerCase() === name.toLowerCase())
}

async function apiHeaders(ctx: Context, profile: ProviderProfile): Promise<Record<string, string> | undefined> {
  const headers: Record<string, string> = { ...profile.headers, 'content-type': 'application/json' }
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

function isResponsesRequest(url: string): boolean {
  try {
    const path = new URL(url).pathname.replace(/\/+$/, '')
    return path.endsWith('/responses')
  } catch {
    return url.replace(/\/+$/, '').endsWith('/responses')
  }
}

function isWebSearchTool(tool: unknown): boolean {
  if (typeof tool !== 'object' || tool === null) return false
  const value = tool as JsonObject
  if (value.name === 'web_search') return true
  const fn = value.function
  return typeof fn === 'object' && fn !== null && (fn as JsonObject).name === 'web_search'
}

function hasWebSearchTool(body: JsonObject): boolean {
  return Array.isArray(body.tools) && body.tools.some(isWebSearchTool)
}

function toolName(tool: unknown): string | undefined {
  if (typeof tool !== 'object' || tool === null) return undefined
  const value = tool as JsonObject
  if (typeof value.name === 'string') return value.name
  const fn = value.function
  return typeof fn === 'object' && fn !== null && typeof (fn as JsonObject).name === 'string'
    ? (fn as JsonObject).name as string
    : undefined
}

function isApplyPatchTool(tool: unknown): boolean {
  return toolName(tool) === 'apply_patch'
}

function isFunctionApplyPatchTool(tool: unknown): boolean {
  if (!isApplyPatchTool(tool) || typeof tool !== 'object' || tool === null) return false
  return (tool as JsonObject).type !== 'custom'
}

function hasFunctionApplyPatchTool(body: JsonObject): boolean {
  return Array.isArray(body.tools) && body.tools.some(isFunctionApplyPatchTool)
}

function applyPatchTool(tool: unknown): JsonObject {
  const value = tool as JsonObject
  const fn = value.function
  const description = typeof value.description === 'string'
    ? value.description
    : typeof fn === 'object' && fn !== null && typeof (fn as JsonObject).description === 'string'
      ? (fn as JsonObject).description as string
      : APPLY_PATCH_DESCRIPTION
  const custom: JsonObject = {
    type: 'custom',
    name: 'apply_patch',
    description,
    format: {
      type: 'grammar',
      syntax: 'lark',
      definition: APPLY_PATCH_GRAMMAR,
    },
  }
  if (value.defer_loading !== undefined) custom.defer_loading = value.defer_loading
  return custom
}

/** Replace DSH's JSON function declaration with the Responses custom grammar tool. */
export function addCodexApplyPatch(body: JsonObject): JsonObject {
  if (!Array.isArray(body.tools)) return body
  let changed = false
  const tools = body.tools.map(tool => {
    if (!isApplyPatchTool(tool) || typeof tool !== 'object' || tool === null) return tool
    if ((tool as JsonObject).type === 'custom') return tool
    changed = true
    return applyPatchTool(tool)
  })
  return changed ? { ...body, tools } : body
}

function applyPatchInputOfCall(item: JsonObject): { callId: string; input: string } | undefined {
  if (item.type !== 'function_call' || item.name !== 'apply_patch') return undefined
  if (typeof item.call_id !== 'string' || item.call_id.length === 0) return undefined
  const raw = item.arguments
  const argumentsObject = typeof raw === 'string'
    ? (() => {
      try {
        return JSON.parse(raw) as unknown
      } catch {
        return undefined
      }
    })()
    : raw
  if (typeof argumentsObject !== 'object' || argumentsObject === null) return undefined
  const input = (argumentsObject as JsonObject).input
  return typeof input === 'string' ? { callId: item.call_id, input } : undefined
}

function canRewriteApplyPatchHistory(body: JsonObject): boolean {
  if (!Array.isArray(body.input)) return true
  return body.input.every(item => {
    if (typeof item !== 'object' || item === null) return true
    const value = item as JsonObject
    return value.type !== 'function_call' || value.name !== 'apply_patch'
      || applyPatchInputOfCall(value) !== undefined
  })
}

/** Replay apply_patch calls as custom tool items after pi-ai's generic conversion. */
export function rewriteCodexApplyPatchHistory(body: JsonObject): JsonObject {
  if (!Array.isArray(body.input) || !canRewriteApplyPatchHistory(body)) return body
  const applyCallIds = new Set<string>()
  for (const item of body.input) {
    if (typeof item !== 'object' || item === null) continue
    const value = item as JsonObject
    if (value.type === 'custom_tool_call' && value.name === 'apply_patch' && typeof value.call_id === 'string') {
      applyCallIds.add(value.call_id)
    }
    const call = applyPatchInputOfCall(value)
    if (call !== undefined) applyCallIds.add(call.callId)
  }
  if (applyCallIds.size === 0) return body

  let changed = false
  const input = body.input.map(item => {
    if (typeof item !== 'object' || item === null) return item
    const value = item as JsonObject
    const call = applyPatchInputOfCall(value)
    if (call !== undefined) {
      const next: JsonObject = {
        type: 'custom_tool_call',
        call_id: call.callId,
        name: 'apply_patch',
        input: call.input,
      }
      if (typeof value.id === 'string') next.id = value.id
      changed = true
      return next
    }
    if (value.type === 'function_call_output'
      && typeof value.call_id === 'string'
      && applyCallIds.has(value.call_id)) {
      changed = true
      return {
        type: 'custom_tool_call_output',
        call_id: value.call_id,
        output: value.output,
      }
    }
    return item
  })
  return changed ? { ...body, input } : body
}

/** Compose the plugin-only Responses rewrites without changing DSH's tool API. */
export function rewriteCodexResponsesBody(body: JsonObject): JsonObject {
  let next = body
  if (hasWebSearchTool(next)) {
    next = addHostedWebSearch(next)
  } else if (hasRemoteCompaction(next)) {
    next = replaceRemoteCompactions(next)
  }
  if (hasFunctionApplyPatchTool(next) && canRewriteApplyPatchHistory(next)) {
    next = addCodexApplyPatch(next)
    next = rewriteCodexApplyPatchHistory(next)
  }
  return next
}

/** Convert a generic DSH Responses tool list to the hosted Codex variant. */
export function addHostedWebSearch(body: JsonObject): JsonObject {
  const tools = Array.isArray(body.tools) ? body.tools.filter(tool => !isWebSearchTool(tool)) : []
  tools.push({ type: 'web_search', external_web_access: true })
  return { ...replaceRemoteCompactions(body), tools }
}

/** Replace the text placeholder written by dsh-compaction-basic with the native item. */
export function replaceRemoteCompactions(body: JsonObject): JsonObject {
  if (!Array.isArray(body.input)) return body
  const input = body.input.map(item => {
    if (typeof item !== 'object' || item === null) return item
    const value = item as JsonObject
    const content = Array.isArray(value.content) ? value.content : []
    const marker = content.find(part => (
      typeof part === 'object'
      && part !== null
      && typeof (part as { text?: unknown }).text === 'string'
      && String((part as { text: string }).text).includes(REMOTE_COMPACTION_OPEN)
    )) as JsonObject | undefined
    if (marker === undefined) return item
    const text = String(marker.text)
    const start = text.indexOf(REMOTE_COMPACTION_OPEN) + REMOTE_COMPACTION_OPEN.length
    const end = text.indexOf(REMOTE_COMPACTION_CLOSE, start)
    if (end < start) return item
    return {
      type: 'compaction',
      encrypted_content: text.slice(start, end),
    }
  })
  return { ...body, input }
}

function hasRemoteCompaction(body: JsonObject): boolean {
  if (!Array.isArray(body.input)) return false
  return body.input.some(item => {
    if (typeof item !== 'object' || item === null) return false
    const content = (item as JsonObject).content
    return Array.isArray(content) && content.some(part => (
      typeof part === 'object'
      && part !== null
      && typeof (part as { text?: unknown }).text === 'string'
      && String((part as { text: string }).text).includes(REMOTE_COMPACTION_OPEN)
    ))
  })
}

function canPatchBody(body: JsonObject): boolean {
  return isGptModel(body.model)
    && (hasWebSearchTool(body)
      || hasRemoteCompaction(body)
      || (hasFunctionApplyPatchTool(body) && canRewriteApplyPatchHistory(body)))
}

/** Add provider options that older pi-ai adapters do not copy themselves. */
function applyRequestWireOptions(body: JsonObject, options: CodexRequestWireOptions): JsonObject {
  if (options.serviceTier === undefined || !isGptModel(body.model)) return body
  return { ...body, service_tier: options.serviceTier }
}

/**
 * Install a scoped fetch shim for pi-ai's already-built Responses request.
 * The generic DSH adapter remains the owner of auth, streaming, replay, and
 * attachments; this shim changes only Codex's Responses tool and compaction
 * representation at the wire boundary.
 */
function installGlobalHostedWebSearchPatch(): () => void {
  const original = globalThis.fetch
  const patched: typeof fetch = async (input, init) => {
    const options = HOSTED_REQUESTS.getStore()
    if (options === undefined) return original(input, init)
    const request = new Request(input, init)
    if (!isResponsesRequest(request.url)) return original(input, init)

    let body: JsonObject
    try {
      body = JSON.parse(await request.clone().text()) as JsonObject
    } catch {
      return original(input, init)
    }
    const requestBody = applyRequestWireOptions(body, options)
    if (!canPatchBody(requestBody)) {
      if (requestBody === body) return original(input, init)
      const headers = new Headers(request.headers)
      headers.delete('content-length')
      return original(new Request(request, {
        body: JSON.stringify(requestBody),
        headers,
      }))
    }

    const fallbackHeaders = new Headers(request.headers)
    fallbackHeaders.delete('content-length')
    const fallbackRequest = requestBody === body
      ? request.clone()
      : new Request(request, {
        body: JSON.stringify(requestBody),
        headers: fallbackHeaders,
      })
    const headers = new Headers(request.headers)
    headers.delete('content-length')
    const hostedRequest = new Request(request, {
      body: JSON.stringify(rewriteCodexResponsesBody(requestBody)),
      headers,
    })
    try {
      const hostedResponse = await original(hostedRequest)
      // A rejected hosted-tool request is retried with the untouched request so
      // dsh-tool-web can still produce the normal local function-tool path.
      if (!hostedResponse.ok) return original(fallbackRequest)
      return hostedResponse
    } catch {
      // Network and transport failures must have the same fallback behavior as
      // an HTTP rejection; the local function-tool path remains available.
      return original(fallbackRequest)
    }
  }

  globalThis.fetch = patched
  return () => {
    if (globalThis.fetch === patched) globalThis.fetch = original
  }
}

/** Enable the transport patch for this Codex plugin scope only. */
export function installHostedWebSearch(): () => void {
  hostedPatchUsers += 1
  hostedPatchRestore ??= installGlobalHostedWebSearchPatch()
  return () => {
    hostedPatchUsers = Math.max(0, hostedPatchUsers - 1)
    if (hostedPatchUsers === 0) {
      hostedPatchRestore?.()
      hostedPatchRestore = undefined
    }
  }
}

/** Iterate an existing DSH stream with the hosted-request context installed. */
export function hostedWebSearchStream(
  next: () => AsyncIterable<StreamChunk>,
  options: CodexRequestWireOptions = {},
): AsyncIterable<StreamChunk> {
  return (async function* (): AsyncGenerator<StreamChunk> {
    const iterator = next()[Symbol.asyncIterator]()
    let completed = false
    try {
      while (true) {
        const item = await HOSTED_REQUESTS.run(options, () => iterator.next())
        if (item.done) {
          completed = true
          return
        }
        yield item.value
      }
    } finally {
      if (!completed) await iterator.return?.()
    }
  })()
}

function textOf(message: Message): string {
  return message.content
    .filter(block => block.type === 'text')
    .map(block => block.text)
    .join('')
}

function responsesInput(messages: readonly Message[]): JsonObject[] {
  const result: JsonObject[] = []
  for (const message of messages) {
    const text = textOf(message)
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
            call_id: block.id,
            name: block.name,
            arguments: block.arguments,
          })
        }
      }
      continue
    }
    const role = message.role === 'system' ? 'developer' : 'user'
    if (text.length > 0) result.push({
      type: 'message',
      role,
      content: [{ type: 'input_text', text }],
    })
    for (const block of message.content) {
      if (block.type !== 'tool-result') continue
      result.push({
        type: 'function_call_output',
        call_id: block.toolCallId,
        output: block.content.filter(item => item.type === 'text').map(item => item.text).join(''),
      })
    }
  }
  return result
}

function responsesTools(tools: readonly ToolSchema[] | undefined): JsonObject[] | undefined {
  if (tools === undefined) return undefined
  return tools.filter(tool => tool.name !== 'web_search').map(tool => ({
    type: 'function',
    name: tool.name,
    description: tool.description,
    parameters: tool.parameters,
  }))
}

function compactBody(options: GenerateOptions): JsonObject {
  const tools = responsesTools(options.tools)
  const body: JsonObject = {
    model: options.model,
    // dsh-compaction-basic appends an instruction for its local summarizer.
    // The hosted compact endpoint owns summarization and must not receive it.
    input: responsesInput(options.messages.slice(0, -1)),
    ...options.system === undefined ? {} : { instructions: options.system },
    ...tools === undefined ? {} : { tools },
    ...options.maxTokens === undefined ? {} : { max_output_tokens: options.maxTokens },
    ...options.reasoningEffort === undefined ? {} : { reasoning: { effort: options.reasoningEffort } },
  }
  const compacted = replaceRemoteCompactions(body)
  return options.tools?.some(tool => tool.name === 'web_search') ? addHostedWebSearch(compacted) : compacted
}

function compactText(body: JsonObject): string {
  const output = Array.isArray(body.output) ? body.output : []
  const text: string[] = []
  for (const item of output) {
    if (typeof item !== 'object' || item === null) continue
    const value = item as JsonObject
    if (typeof value.encrypted_content === 'string') text.push(value.encrypted_content)
  }
  const encrypted = text.join('\n\n').trim()
  return encrypted.length === 0 ? '' : `${REMOTE_COMPACTION_OPEN}${encrypted}${REMOTE_COMPACTION_CLOSE}`
}

function nonNegativeInteger(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : undefined
}

/** Map the Responses compact usage object without inventing missing counts. */
function compactUsage(body: JsonObject): TokenUsage | undefined {
  if (typeof body.usage !== 'object' || body.usage === null) return undefined
  const raw = body.usage as JsonObject
  const inputTokens = nonNegativeInteger(raw.input_tokens)
  const outputTokens = nonNegativeInteger(raw.output_tokens)
  if (inputTokens === undefined || outputTokens === undefined) return undefined

  const details = typeof raw.input_tokens_details === 'object' && raw.input_tokens_details !== null
    ? raw.input_tokens_details as JsonObject
    : undefined
  const cacheReadTokens = nonNegativeInteger(details?.cached_tokens)
  const cacheWriteTokens = nonNegativeInteger(details?.cache_write_tokens)
  const cached = cacheReadTokens ?? 0
  const writes = cacheWriteTokens ?? 0

  // Responses input_tokens includes the cache buckets. Reject an inconsistent
  // response instead of clamping it and reporting numbers that no longer sum.
  if (cached + writes > inputTokens) return undefined
  return {
    inputTokens: inputTokens - cached - writes,
    outputTokens,
    ...cacheReadTokens !== undefined && cacheReadTokens > 0 ? { cacheReadTokens } : {},
    ...cacheWriteTokens !== undefined && cacheWriteTokens > 0 ? { cacheWriteTokens } : {},
  }
}

async function remoteCompact(ctx: Context, options: GenerateOptions): Promise<RemoteCompactResult> {
  const profile = profileOf(ctx, options.provider)
  if (!supportsResponses(profile, options.provider) || profile?.baseURL === undefined) {
    throw new Error('Codex remote compaction requires an OpenAI Responses provider with baseURL')
  }
  const headers = await apiHeaders(ctx, profile)
  if (headers === undefined) throw new Error('Codex remote compaction has no configured API key')
  const response = await fetch(responsesEndpoint(profile.baseURL, 'responses/compact'), {
    method: 'POST',
    headers,
    body: JSON.stringify(compactBody(options)),
    ...options.signal === undefined ? {} : { signal: options.signal },
  })
  if (!response.ok) throw new Error(`remote compaction returned HTTP ${response.status}`)
  const body = await response.json() as JsonObject
  const text = compactText(body)
  if (text.length === 0) throw new Error('remote compaction returned no compaction text')
  const usage = compactUsage(body)
  return { text, ...usage === undefined ? {} : { usage } }
}

/** Remote-first compaction waterfall with the existing DSH path as fallback. */
export function remoteCompactStream(
  ctx: Context,
  options: GenerateOptions,
  next: () => AsyncIterable<StreamChunk>,
): AsyncIterable<StreamChunk> {
  return (async function* (): AsyncGenerator<StreamChunk> {
    try {
      const result = await remoteCompact(ctx, options)
      yield { type: 'block-start', index: 0, blockType: 'text' }
      yield { type: 'text-delta', index: 0, text: result.text }
      yield { type: 'block-end', index: 0, block: { type: 'text', text: result.text } }
      if (result.usage !== undefined) yield { type: 'usage', usage: result.usage }
      yield { type: 'finish', reason: { kind: 'stop' } }
    } catch (error) {
      if (options.signal?.aborted) throw error
      ctx.logger.warn('codex: remote compaction failed; using dsh-compaction-basic fallback')
      ctx.logger.warn(error)
      // The local fallback still replays the marker through a later GPT
      // Responses request, so it needs the same scoped wire context.
      const serviceTier = serviceTierOf(options)
      yield* hostedWebSearchStream(next, serviceTier === undefined ? {} : { serviceTier })
    }
  })()
}
