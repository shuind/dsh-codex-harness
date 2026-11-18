/** Host-side activity projection for the Codex status line. */

import type { Context } from '@deepseek-ai/cordis'
import type { StreamChunk } from '@deepseek-ai/dsh-llm/types'
import { z, type ZodType } from 'zod'
import type { CodexActivity } from '../contracts/ui-contracts.ts'

export type { CodexActivity } from '../contracts/ui-contracts.ts'

/** Long-running Codex activities currently surfaced to the client. */
export type CodexActivityState = CodexActivity | null

/** Minimal event shape needed by this projection; no compaction package import is required. */
export interface CodexActivityEvent {
  type: string
  time: number
  data?: unknown
}

/**
 * Whether a stream chunk carries visible model output.
 *
 * DSH 0.1.2 removed the runtime `isTokenDelta` helper from `dsh-llm/message`
 * while keeping the StreamChunk vocabulary unchanged. Keep this small
 * predicate local so the harness works with both the old and new DSH bundles.
 */
function isTokenDelta(chunk: StreamChunk): boolean {
  switch (chunk.type) {
    case 'text-delta':
    case 'reasoning-delta':
      return chunk.text !== ''
    case 'tool-call-delta':
      return chunk.argumentsDelta !== '' || chunk.name !== undefined
    default:
      return false
  }
}

/** Read packed v2 streams without importing a helper absent from older DSH packages. */
function streamReplyTime(stream: readonly unknown[]): number | undefined {
  for (const value of stream) {
    if (typeof value !== 'object' || value === null) continue
    const record = value as {
      type?: string; time?: number; chunk?: StreamChunk
      time0?: number; dt?: number[]; texts?: string[]; args?: string[]; name?: string
    }
    if (record.type === 'chunk') {
      if (record.chunk !== undefined && isTokenDelta(record.chunk)) return record.time
      continue
    }
    if (record.type !== 'text-chunks' && record.type !== 'reasoning-chunks' && record.type !== 'tool-call-chunks') continue
    const fragments = record.type === 'tool-call-chunks' ? record.args : record.texts
    if (fragments === undefined || record.time0 === undefined) continue
    let time = record.time0
    for (const [index, text] of fragments.entries()) {
      if (index > 0) time += record.dt?.[index - 1] ?? 0
      if (text !== '' || (record.type === 'tool-call-chunks' && record.name !== undefined)) return time
    }
  }
  return undefined
}

/** Only a non-empty delta starts the reply phase; preserve its original stream time. */
function modelReplyTime(event: CodexActivityEvent): number | undefined {
  const data = typeof event.data === 'object' && event.data !== null
    ? event.data as { chunk?: StreamChunk; stream?: unknown[] }
    : undefined
  if (event.type === 'assistant/chunk') {
    return data?.chunk !== undefined && isTokenDelta(data.chunk) ? event.time : undefined
  }
  if (event.type === 'assistant/message' || event.type === 'assistant/attempt') {
    if (data?.stream !== undefined) return streamReplyTime(data.stream)
    // Legacy/non-streaming adapters did not carry a packed stream on settlement.
    if (event.type === 'assistant/message') return event.time
  }
  return undefined
}

/** Persisted and wire shape of the Codex activity value. */
export const codexActivitySchema: ZodType<CodexActivityState> = z.union([
  z.object({
    activity: z.literal('compaction'),
    startedAt: z.number().int().nonnegative(),
  }),
  z.object({
    activity: z.literal('requesting-model'),
    startedAt: z.number().int().nonnegative(),
  }),
  z.object({
    activity: z.literal('model-reply'),
    startedAt: z.number().int().nonnegative(),
  }),
  z.null(),
])

/** Pure event fold, exported so its reset and reference-stability rules can be tested directly. */
export function applyCodexActivity(
  state: CodexActivityState,
  event: CodexActivityEvent,
): CodexActivityState {
  if (event.type === 'compaction/start') return { activity: 'compaction', startedAt: event.time }
  if (event.type === 'step/start' || event.type === 'llm/retry-started') {
    return { activity: 'requesting-model', startedAt: event.time }
  }
  if (state?.activity === 'requesting-model') {
    const startedAt = modelReplyTime(event)
    if (startedAt !== undefined) return { activity: 'model-reply', startedAt }
  }
  if (event.type === 'turn/start' || event.type === 'turn/end' || event.type === 'compaction/end') return null
  // Keep the line through reasoning and streamed output. It is the only
  // visible indication that the model is still progressing; tool cards have
  // their own status, so a tool dispatch retires this ambient line.
  if ((state?.activity === 'requesting-model' || state?.activity === 'model-reply')
    && (event.type === 'llm/retry'
      || event.type === 'tool/call'
      || event.type === 'step/end')) return null
  return state
}

export const codexActivityProjection = {
  key: 'codexActivity',
  stateSchema: codexActivitySchema,
  init: (): CodexActivityState => null,
  apply: applyCodexActivity,
  wire: {
    viewSchema: codexActivitySchema,
    view: (state: CodexActivityState): CodexActivityState => state,
  },
  stateVersion: 3,
} as const

type CodexActivityRegistry = {
  register(definition: typeof codexActivityProjection): unknown
}

type ProjectionContext = Context & {
  sessionProjections: CodexActivityRegistry
}

/** Register the optional activity unit without requiring the projection seam in every assembly. */
export function registerCodexActivityProjection(ctx: Context): void {
  ctx.inject(['sessionProjections'], async (projectionCtx) => {
    // Await readiness, but do not return the new ProjectionHandle as a Cordis effect.
    await (projectionCtx as ProjectionContext).sessionProjections.register(codexActivityProjection)
  })
}
