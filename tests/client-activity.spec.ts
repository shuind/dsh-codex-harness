import { describe, expect, it } from 'vitest'
import {
  awaitingModelStartedAt, modelActivity, modelReplyStartedAt, sameModelActivity,
} from '../src/client/activity.ts'
import { resolveActivity as resolveVisibleActivity } from '../src/client/index.tsx'

function snapshot(overrides: Partial<Parameters<typeof awaitingModelStartedAt>[0]> = {}) {
  return {
    running: true,
    partial: null,
    runningCalls: [],
    turnTimings: new Map([[3, { startTime: 123 }]]),
    ...overrides,
  }
}

describe('Codex client activity fallback', () => {
  it('uses the open turn start while the model has not produced output', () => {
    expect(awaitingModelStartedAt(snapshot())).toBe(123)
  })

  it('identifies the reply phase from streamed output but not a running tool', () => {
    expect(modelReplyStartedAt(snapshot())).toBeUndefined()
    expect(modelActivity(snapshot())).toEqual({ activity: 'requesting-model', startedAt: 123 })
    const partial = { turn: 3, step: 0, blocks: [], replyStartedAt: 456 }
    expect(modelReplyStartedAt(snapshot({ partial }))).toBe(456)
    expect(modelActivity(snapshot({ partial })))
      .toEqual({ activity: 'model-reply', startedAt: 456 })
    expect(awaitingModelStartedAt(snapshot({ partial }))).toBe(123)
    expect(modelReplyStartedAt(snapshot({ runningCalls: [{}], partial }))).toBeUndefined()
    expect(modelActivity(snapshot({ runningCalls: [{}] }))).toBeUndefined()
    expect(awaitingModelStartedAt(snapshot({ runningCalls: [{}] }))).toBeUndefined()
    expect(modelActivity(snapshot({ running: false, partial }))).toBeUndefined()
    expect(awaitingModelStartedAt(snapshot({ running: false }))).toBeUndefined()
  })

  it('does not invent a clock when no open turn is present', () => {
    expect(awaitingModelStartedAt(snapshot({ turnTimings: new Map([[3, { startTime: 123, endTime: 456 }]]) })))
      .toBeUndefined()
  })

  it('compares selector results by phase and timestamp rather than object identity', () => {
    expect(sameModelActivity(
      { activity: 'requesting-model', startedAt: 123 },
      { activity: 'requesting-model', startedAt: 123 },
    )).toBe(true)
    expect(sameModelActivity(
      { activity: 'requesting-model', startedAt: 123 },
      { activity: 'model-reply', startedAt: 123 },
    )).toBe(false)
  })

  it('does not treat a partial from another turn as the current reply', () => {
    const partial = { turn: 2, step: 0, blocks: [], replyStartedAt: 456 }
    expect(modelReplyStartedAt(snapshot({ partial }))).toBeUndefined()
    expect(modelActivity(snapshot({ partial })))
      .toEqual({ activity: 'requesting-model', startedAt: 123 })
  })

  it('uses the assembled Chat node for a non-streaming reply', () => {
    const chat = {
      timeline: {
        turns: new Map([[3, { steps: [{ step: 0, end: undefined }] }]]),
      },
      nodes: {
        values: () => [{
          kind: 'assistant-step',
          data: { turn: 3, step: 0, replyStartedAt: 456 },
        }],
      },
    }
    expect(modelReplyStartedAt(snapshot({ chat } as never))).toBe(456)
    expect(modelActivity(snapshot({ chat } as never)))
      .toEqual({ activity: 'model-reply', startedAt: 456 })
  })

  it('uses the legacy session fallback while the projection is null', () => {
    const fallback = { activity: 'requesting-model' as const, startedAt: 123 }
    expect(resolveVisibleActivity('codex', null, fallback)).toEqual(fallback)
    expect(resolveVisibleActivity('standard', null, fallback)).toBeNull()
  })

})
