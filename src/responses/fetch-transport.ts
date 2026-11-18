/** Scoped fetch interceptor, zstd body codec, and negative capability cache for Responses requests. */

import type { StreamChunk } from '@deepseek-ai/dsh-llm'
import { AsyncLocalStorage } from 'node:async_hooks'
import { zstdCompressSync, zstdDecompressSync } from 'node:zlib'
import { isGptModel } from '../contracts/settings.ts'
import { captureCodexErrors } from './sse-diagnostics.ts'
import {
  applyRequestWireOptions,
  canRewriteApplyPatchHistory,
  hasFunctionApplyPatchTool,
  hasRemoteCompaction,
  hasWebSearchTool,
  isNativeCompactionTriggerBody,
  replaceRemoteCompactions,
  rewriteCodexResponsesBody,
} from './wire-rewrite.ts'
import type { CodexRequestWireOptions, JsonObject } from './wire-rewrite.ts'

interface CapabilityEntry {
  hostedWebSearch?: boolean
  customApplyPatch?: boolean
  remoteCompact?: boolean
  expiresAt: number
}

const CAPABILITY_CACHE_TTL_MS = 10 * 60_000
const CAPABILITY_CACHE_MAX_ENTRIES = 64
export const CONTEXT_LIMIT_ERROR = /context_length_exceeded|maximum context length|context window|too many tokens/i
const WEB_SEARCH_ERROR = /web_search|external_web_access/i
const CUSTOM_PATCH_ERROR = /apply_patch|custom_tool|custom\s+tool|grammar|lark/i

const HOSTED_REQUESTS = new AsyncLocalStorage<CodexRequestWireOptions>()
const unsupportedCapabilities = new Map<string, CapabilityEntry>()
let hostedPatchUsers = 0
let hostedPatchRestore: (() => void) | undefined

function isResponsesRequest(url: string): boolean {
  try {
    const path = new URL(url).pathname.replace(/\/+$/, '')
    return path.endsWith('/responses')
  } catch {
    return url.replace(/\/+$/, '').endsWith('/responses')
  }
}

export function capabilityKey(url: string, model: unknown): string | undefined {
  if (typeof model !== 'string' || model.length === 0) return undefined
  try {
    const parsed = new URL(url)
    return `${parsed.origin}${parsed.pathname.replace(/\/+$/, '')}\0${model}`
  } catch {
    return `${url.replace(/\/+$/, '')}\0${model}`
  }
}

function effectiveWireOptions(key: string | undefined, options: CodexRequestWireOptions): CodexRequestWireOptions {
  if (key === undefined) return options
  const cached = unsupportedCapabilities.get(key)
  if (cached === undefined) return options
  if (cached.expiresAt <= Date.now()) {
    unsupportedCapabilities.delete(key)
    return options
  }
  return {
    ...options,
    ...cached.hostedWebSearch === false ? { hostedWebSearch: false } : {},
    ...cached.customApplyPatch === false ? { customApplyPatch: false } : {},
  }
}

export function recordUnsupportedCapability(
  key: string | undefined,
  flags: { hostedWebSearch?: boolean; customApplyPatch?: boolean; remoteCompact?: boolean },
): void {
  if (key === undefined) return
  const now = Date.now()
  const existing = unsupportedCapabilities.get(key)
  const valid = existing !== undefined && existing.expiresAt > now ? existing : undefined
  if (existing !== undefined) unsupportedCapabilities.delete(key)
  while (unsupportedCapabilities.size >= CAPABILITY_CACHE_MAX_ENTRIES) {
    const oldest = unsupportedCapabilities.keys().next().value
    if (oldest === undefined) break
    unsupportedCapabilities.delete(oldest)
  }
  unsupportedCapabilities.set(key, {
    ...valid,
    ...flags,
    expiresAt: now + CAPABILITY_CACHE_TTL_MS,
  })
}

export function isCompactUnsupported(key: string | undefined): boolean {
  if (key === undefined) return false
  const cached = unsupportedCapabilities.get(key)
  if (cached === undefined) return false
  if (cached.expiresAt <= Date.now()) {
    unsupportedCapabilities.delete(key)
    return false
  }
  return cached.remoteCompact === false
}

function shouldFallbackResponse(response: Response, errorText: string): boolean {
  if (response.status !== 400
    && response.status !== 404
    && response.status !== 415
    && response.status !== 422) {
    return false
  }
  return !CONTEXT_LIMIT_ERROR.test(errorText)
}

function isAbortError(error: unknown, signal: AbortSignal): boolean {
  if (signal.aborted) return true
  return typeof error === 'object' && error !== null && (error as { name?: unknown }).name === 'AbortError'
}

function isZstdEncoded(headers: Headers): boolean {
  return headers.get('content-encoding')?.split(',').some(value => value.trim().toLowerCase() === 'zstd') === true
}

async function parseResponsesBody(request: Request): Promise<JsonObject> {
  if (isZstdEncoded(request.headers) && typeof zstdDecompressSync === 'function') {
    const compressed = Buffer.from(await request.clone().arrayBuffer())
    return JSON.parse(zstdDecompressSync(compressed).toString('utf8')) as JsonObject
  }
  return JSON.parse(await request.clone().text()) as JsonObject
}

function jsonRequest(request: Request, body: JsonObject): Request {
  const headers = new Headers(request.headers)
  headers.delete('content-length')
  const serialized = JSON.stringify(body)
  if (isZstdEncoded(headers)) {
    if (typeof zstdCompressSync === 'function') {
      return new Request(request, {
        body: new Uint8Array(zstdCompressSync(Buffer.from(serialized, 'utf8'))),
        headers,
      })
    }
    headers.delete('content-encoding')
  }
  return new Request(request, {
    body: serialized,
    headers,
  })
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
    const requestAndCapture = async (target: RequestInfo | URL, requestInit?: RequestInit): Promise<Response> =>
      captureCodexErrors(await original(target, requestInit))

    let body: JsonObject
    try {
      body = await parseResponsesBody(request)
    } catch {
      return requestAndCapture(input, init)
    }

    if (isNativeCompactionTriggerBody(body)) return requestAndCapture(input, init)

    const requestBody = applyRequestWireOptions(body, options)
    const baseBody = isGptModel(requestBody.model) && hasRemoteCompaction(requestBody, options.trustedCheckpoints)
      ? replaceRemoteCompactions(requestBody, options.trustedCheckpoints)
      : requestBody
    const key = capabilityKey(request.url, baseBody.model)
    const activeOptions = effectiveWireOptions(key, options)

    const usesHostedWebSearch = isGptModel(baseBody.model)
      && activeOptions.hostedWebSearch !== false
      && hasWebSearchTool(baseBody)
    const usesCustomApplyPatch = isGptModel(baseBody.model)
      && activeOptions.customApplyPatch !== false
      && hasFunctionApplyPatchTool(baseBody)
      && canRewriteApplyPatchHistory(baseBody)

    if (!usesHostedWebSearch && !usesCustomApplyPatch) {
      return baseBody === body
        ? requestAndCapture(input, init)
        : requestAndCapture(jsonRequest(request, baseBody))
    }

    const hostedBody = rewriteCodexResponsesBody(baseBody, activeOptions)
    const hostedRequest = jsonRequest(request, hostedBody)
    const fallbackRequest = baseBody === body ? request.clone() : jsonRequest(request, baseBody)
    const sendPlainFallback = (): Promise<Response> => requestAndCapture(fallbackRequest)

    let response: Response
    try {
      response = await requestAndCapture(hostedRequest)
    } catch (error) {
      if (isAbortError(error, request.signal)) throw error
      // Transport failures fall back once without poisoning the capability cache.
      return sendPlainFallback()
    }

    if (response.ok) return response
    const errorText = await response.clone().text().catch(() => '')
    if (!shouldFallbackResponse(response, errorText)) return response

    const mentionsWebSearch = usesHostedWebSearch && WEB_SEARCH_ERROR.test(errorText)
    const mentionsCustomPatch = usesCustomApplyPatch && CUSTOM_PATCH_ERROR.test(errorText)
    if (usesHostedWebSearch && usesCustomApplyPatch && mentionsWebSearch !== mentionsCustomPatch) {
      const reducedOptions: CodexRequestWireOptions = mentionsWebSearch
        ? { ...activeOptions, hostedWebSearch: false }
        : { ...activeOptions, customApplyPatch: false }
      recordUnsupportedCapability(
        key,
        mentionsWebSearch ? { hostedWebSearch: false } : { customApplyPatch: false },
      )
      try {
        const reducedResponse = await requestAndCapture(
          jsonRequest(request, rewriteCodexResponsesBody(baseBody, reducedOptions)),
        )
        if (reducedResponse.ok) return reducedResponse
        const secondErrorText = await reducedResponse.clone().text().catch(() => '')
        if (!shouldFallbackResponse(reducedResponse, secondErrorText)) return reducedResponse
        recordUnsupportedCapability(
          key,
          mentionsWebSearch ? { customApplyPatch: false } : { hostedWebSearch: false },
        )
        return sendPlainFallback()
      } catch (error) {
        if (isAbortError(error, request.signal)) throw error
        return sendPlainFallback()
      }
    }

    recordUnsupportedCapability(key, {
      ...usesHostedWebSearch ? { hostedWebSearch: false } : {},
      ...usesCustomApplyPatch ? { customApplyPatch: false } : {},
    })
    return sendPlainFallback()
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
      unsupportedCapabilities.clear()
    }
  }
}

/** Iterate an existing DSH stream with the hosted-request context installed. */
export function hostedWebSearchStream(
  next: () => AsyncIterable<StreamChunk>,
  options: CodexRequestWireOptions = {},
): AsyncIterable<StreamChunk> {
  return (async function* (): AsyncGenerator<StreamChunk> {
    const iterator = HOSTED_REQUESTS.run(options, () => next()[Symbol.asyncIterator]())
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
      if (!completed) await HOSTED_REQUESTS.run(options, () => iterator.return?.())
    }
  })()
}
