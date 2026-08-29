import { describe, expect, it, vi } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import {
  applyCodexActivity,
  codexActivityProjection,
  codexActivitySchema,
  registerCodexActivityProjection,
} from '../src/activity.ts'

describe('Codex compaction activity projection', () => {
  it('starts on compaction/start with the event timestamp', () => {
    expect(applyCodexActivity(null, { type: 'compaction/start', time: 1_700_000_000_000 }))
      .toEqual({ activity: 'compaction', startedAt: 1_700_000_000_000 })
  })

  it('shows model waiting after a step starts and clears on the first output', () => {
    const waiting = applyCodexActivity(null, { type: 'step/start', time: 123 })
    expect(waiting).toEqual({ activity: 'awaiting-model', startedAt: 123 })
    expect(applyCodexActivity(waiting, { type: 'assistant/chunk', time: 456 })).toBeNull()
  })

  it('restarts the waiting clock after a retry begins', () => {
    const waiting = applyCodexActivity(null, { type: 'step/start', time: 123 })
    expect(applyCodexActivity(waiting, { type: 'llm/retry', time: 456 })).toBeNull()
    expect(applyCodexActivity(waiting, { type: 'llm/retry-started', time: 789 }))
      .toEqual({ activity: 'awaiting-model', startedAt: 789 })
  })

  it('preserves the state reference for unrelated events', () => {
    const state = { activity: 'compaction' as const, startedAt: 123 }
    expect(applyCodexActivity(state, { type: 'assistant/chunk', time: 456 })).toBe(state)
  })

  it('clears on compaction/end and turn/start', () => {
    const compacting = { activity: 'compaction' as const, startedAt: 123 }
    expect(applyCodexActivity(compacting, { type: 'compaction/end', time: 456 })).toBeNull()
    expect(applyCodexActivity(compacting, { type: 'turn/start', time: 789 })).toBeNull()

    const waiting = { activity: 'awaiting-model' as const, startedAt: 123 }
    expect(applyCodexActivity(waiting, { type: 'assistant/message', time: 789 })).toBeNull()
    expect(applyCodexActivity(waiting, { type: 'step/end', time: 789 })).toBeNull()
  })

  it('validates the nullable wire state', () => {
    expect(codexActivitySchema.parse(null)).toBeNull()
    expect(codexActivitySchema.parse({ activity: 'compaction', startedAt: 42 }))
      .toEqual({ activity: 'compaction', startedAt: 42 })
    expect(codexActivitySchema.parse({ activity: 'awaiting-model', startedAt: 42 }))
      .toEqual({ activity: 'awaiting-model', startedAt: 42 })
    expect(() => codexActivitySchema.parse({ activity: 'other', startedAt: 42 })).toThrow()
    expect(() => codexActivitySchema.parse({ activity: 'compaction', startedAt: -1 })).toThrow()
  })

  it('registers the expected client-visible projection definition', () => {
    let definition: typeof codexActivityProjection | undefined
    const inject = vi.fn((_names: string[], callback: (ctx: unknown) => void) => {
      callback({ sessionProjections: { register: (value: typeof codexActivityProjection) => { definition = value } } })
    })
    registerCodexActivityProjection({ inject } as unknown as Context)

    expect(inject).toHaveBeenCalledWith(['sessionProjections'], expect.any(Function))
    expect(definition).toBe(codexActivityProjection)
    expect(definition?.key).toBe('codexActivity')
    expect(definition?.stateVersion).toBe(1)
    expect(definition?.wire?.view(null)).toBeNull()
    expect(definition?.schema.parse(null)).toBeNull()
    expect(definition?.view(null)).toBeNull()
  })

  it('does not throw when the optional projection seam is unavailable', () => {
    expect(() => registerCodexActivityProjection({ inject: () => undefined } as unknown as Context))
      .not.toThrow()
  })
})

