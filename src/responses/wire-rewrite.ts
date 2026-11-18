/** Pure Responses wire transformations for hosted search, custom `apply_patch`, and compaction items. */

import type { GenerateOptions } from '@deepseek-ai/dsh-llm'
import { isGptModel } from '../contracts/settings.ts'
import { APPLY_PATCH_DESCRIPTION, APPLY_PATCH_GRAMMAR } from '../tools/patch.ts'
import {
  REMOTE_COMPACTION_OPEN,
  REMOTE_COMPACTION_CLOSE,
  decodeRemoteCompactionMarker,
  extractMarkerBody,
  type JsonObject,
} from './compact-checkpoint.ts'

export { REMOTE_COMPACTION_OPEN, REMOTE_COMPACTION_CLOSE, decodeRemoteCompactionMarker, extractMarkerBody }
export type { JsonObject }

export interface CodexRequestWireOptions {
  /** Provider-facing request option preserved by older DSH LLM adapters. */
  serviceTier?: string
  /** Whether local web_search should become the hosted Responses tool. */
  hostedWebSearch?: boolean
  /** Whether apply_patch should use the Responses custom grammar tool. */
  customApplyPatch?: boolean
  /** Marker bodies verified to come from persisted compaction checkpoint sources. */
  trustedCheckpoints?: ReadonlySet<string>
}

export function serviceTierOf(options: GenerateOptions): string | undefined {
  const value = (options as GenerateOptions & { serviceTier?: unknown }).serviceTier
  return typeof value === 'string' ? value : undefined
}

export function isWebSearchTool(tool: unknown): boolean {
  if (typeof tool !== 'object' || tool === null) return false
  const value = tool as JsonObject
  if (value.defer_loading === true) return false
  if (value.name === 'web_search') return true
  const fn = value.function
  return typeof fn === 'object'
    && fn !== null
    && (fn as JsonObject).defer_loading !== true
    && (fn as JsonObject).name === 'web_search'
}

export function hasWebSearchTool(body: JsonObject): boolean {
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

export function hasFunctionApplyPatchTool(body: JsonObject): boolean {
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

export function canRewriteApplyPatchHistory(body: JsonObject): boolean {
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
      if (typeof value.id === 'string' && !value.id.startsWith('fc_')) next.id = value.id
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

/** Detect provider-native compaction triggers owned by adapters such as `dsh-codex-connect`. */
export function isNativeCompactionTriggerBody(body: JsonObject): boolean {
  return Array.isArray(body.input) && body.input.some(
    item => typeof item === 'object' && item !== null && (item as JsonObject).type === 'compaction_trigger',
  )
}

/** Compose the plugin-only Responses rewrites without changing DSH's tool API. */
export function rewriteCodexResponsesBody(
  body: JsonObject,
  options: Pick<CodexRequestWireOptions, 'hostedWebSearch' | 'customApplyPatch' | 'trustedCheckpoints'> = {},
): JsonObject {
  let next = body
  if (options.hostedWebSearch !== false && hasWebSearchTool(next)) {
    next = addHostedWebSearch(next, options.trustedCheckpoints)
  } else if (hasRemoteCompaction(next, options.trustedCheckpoints)) {
    next = replaceRemoteCompactions(next, options.trustedCheckpoints)
  }
  if (options.customApplyPatch !== false
    && hasFunctionApplyPatchTool(next)
    && canRewriteApplyPatchHistory(next)) {
    next = addCodexApplyPatch(next)
    next = rewriteCodexApplyPatchHistory(next)
  }
  return next
}

/** Convert a generic DSH Responses tool list to the hosted Codex variant. */
export function addHostedWebSearch(
  body: JsonObject,
  trustedCheckpoints?: ReadonlySet<string>,
): JsonObject {
  const tools = Array.isArray(body.tools) ? body.tools.filter(tool => !isWebSearchTool(tool)) : []
  tools.push({ type: 'web_search', external_web_access: true })
  return { ...replaceRemoteCompactions(body, trustedCheckpoints), tools }
}

function trustedMarkerInInputItem(
  item: unknown,
  trustedCheckpoints?: ReadonlySet<string>,
): string | undefined {
  if (typeof item !== 'object' || item === null) return undefined
  const content = (item as JsonObject).content
  if (!Array.isArray(content)) return undefined
  for (const part of content) {
    if (typeof part !== 'object' || part === null) continue
    const text = (part as { text?: unknown }).text
    if (typeof text !== 'string') continue
    const inner = extractMarkerBody(text)
    if (inner === undefined) continue
    if (trustedCheckpoints === undefined || trustedCheckpoints.has(inner)) return inner
  }
  return undefined
}

/** Replace trusted checkpoint placeholders written by compaction with native wire items. */
export function replaceRemoteCompactions(
  body: JsonObject,
  trustedCheckpoints?: ReadonlySet<string>,
): JsonObject {
  if (!Array.isArray(body.input)) return body
  const input = body.input.flatMap(item => {
    const inner = trustedMarkerInInputItem(item, trustedCheckpoints)
    if (inner === undefined) return [item]
    return decodeRemoteCompactionMarker(inner) ?? [item]
  })
  return { ...body, input }
}

export function hasRemoteCompaction(
  body: JsonObject,
  trustedCheckpoints?: ReadonlySet<string>,
): boolean {
  if (!Array.isArray(body.input)) return false
  return body.input.some(item => trustedMarkerInInputItem(item, trustedCheckpoints) !== undefined)
}

export function applyRequestWireOptions(body: JsonObject, options: CodexRequestWireOptions): JsonObject {
  if (options.serviceTier === undefined || !isGptModel(body.model) || body.service_tier !== undefined) return body
  return { ...body, service_tier: options.serviceTier }
}
