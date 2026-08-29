/** Host-side activity projection for the Codex compaction status line. */

import type { Context } from '@deepseek-ai/cordis'
import { z, type ZodType } from 'zod'
import type { CodexActivity } from './activity-types.ts'

export type { CodexActivity } from './activity-types.ts'

/** The only long-running Codex activity currently surfaced to the client. */
export type CodexActivityState = CodexActivity | null

/** Minimal event shape needed by this projection; no compaction package import is required. */
export interface CodexActivityEvent {
  type: string
  time: number
}

/** Persisted and wire shape of the Codex activity value. */
export const codexActivitySchema: ZodType<CodexActivityState> = z.union([
  z.object({
    activity: z.literal('compaction'),
    startedAt: z.number().int().nonnegative(),
  }),
  z.object({
    activity: z.literal('awaiting-model'),
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
    return { activity: 'awaiting-model', startedAt: event.time }
  }
  if (event.type === 'turn/start' || event.type === 'turn/end' || event.type === 'compaction/end') return null
  if (state?.activity === 'awaiting-model'
    && (event.type === 'llm/retry'
      || event.type === 'assistant/chunk'
      || event.type === 'assistant/message'
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
  // Keep the old projection contract working for DSH bundles that predate
  // the `stateSchema`/`wire` split.
  schema: codexActivitySchema,
  view: (state: CodexActivityState): CodexActivityState => state,
  stateVersion: 1,
} as const

type CodexActivityRegistry = {
  register(definition: typeof codexActivityProjection): void
}

type ProjectionContext = Context & {
  sessionProjections: CodexActivityRegistry
}

/** Register the optional activity unit without requiring the projection seam in every assembly. */
export function registerCodexActivityProjection(ctx: Context): void {
  ctx.inject(['sessionProjections'], (projectionCtx) => {
    (projectionCtx as ProjectionContext).sessionProjections.register(codexActivityProjection)
  })
}

