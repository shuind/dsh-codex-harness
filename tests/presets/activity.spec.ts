import { describe, expect, it, vi } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import { AssistantStreamAccumulator, assistantStreamFirstTokenTime, expandAssistantStream } from '@deepseek-ai/dsh-llm'
import {
  applyCodexActivity,
  codexActivityProjection,
  codexActivitySchema,
  registerCodexActivityProjection,
} from '../../src/presets/activity.ts'

describe('Codex activity projection', () => {
  it('starts on compaction/start with the event timestamp', () => {
    expect(applyCodexActivity(null, { type: 'compaction/start', time: 1_700_000_000_000 }))
      .toEqual({ activity: 'compaction', startedAt: 1_700_000_000_000 })
  })

  it('shows the model request and reply phases, then clears at step end', () => {
    const requesting = applyCodexActivity(null, { type: 'step/start', time: 123 })
    expect(requesting).toEqual({ activity: 'requesting-model', startedAt: 123 })
    const replying = applyCodexActivity(requesting, {
      type: 'assistant/chunk',
      time: 456,
      data: { chunk: { type: 'text-delta', index: 0, text: 'hello' } },
    })
    expect(replying).toEqual({ activity: 'model-reply', startedAt: 456 })
    expect(applyCodexActivity(replying, {
      type: 'assistant/chunk',
      time: 457,
      data: { chunk: { type: 'text-delta', index: 0, text: ' world' } },
    })).toBe(replying)
    expect(applyCodexActivity(replying, { type: 'assistant/message', time: 458 })).toBe(replying)
    expect(applyCodexActivity(replying, { type: 'tool/call', time: 459 })).toBeNull()
    expect(applyCodexActivity(replying, { type: 'step/end', time: 460 })).toBeNull()
  })

  it('uses assistant/message as the reply boundary for non-streaming adapters', () => {
    const requesting = applyCodexActivity(null, { type: 'step/start', time: 123 })
    expect(applyCodexActivity(requesting, { type: 'assistant/message', time: 456 }))
      .toEqual({ activity: 'model-reply', startedAt: 456 })
  })

  it('ignores empty, usage, and finish stream frames before the first delta', () => {
    const requesting = applyCodexActivity(null, { type: 'step/start', time: 123 })
    expect(applyCodexActivity(requesting, {
      type: 'assistant/chunk',
      time: 200,
      data: { chunk: { type: 'block-start', index: 0, blockType: 'text' } },
    })).toBe(requesting)
    expect(applyCodexActivity(requesting, {
      type: 'assistant/chunk',
      time: 300,
      data: { chunk: { type: 'text-delta', index: 0, text: '' } },
    })).toBe(requesting)
    expect(applyCodexActivity(requesting, {
      type: 'assistant/chunk',
      time: 400,
      data: { chunk: { type: 'usage', usage: { inputTokens: 1, outputTokens: 0 } } },
    })).toBe(requesting)
    expect(applyCodexActivity(requesting, {
      type: 'assistant/chunk',
      time: 500,
      data: { chunk: { type: 'finish', reason: { kind: 'completed' } } },
    })).toBe(requesting)
  })

  it('restarts the waiting clock after a retry begins', () => {
    const requesting = applyCodexActivity(null, { type: 'step/start', time: 123 })
    expect(applyCodexActivity(requesting, { type: 'llm/retry', time: 456 })).toBeNull()
    expect(applyCodexActivity(requesting, { type: 'llm/retry-started', time: 789 }))
      .toEqual({ activity: 'requesting-model', startedAt: 789 })
  })

  it('preserves the state reference for unrelated events', () => {
    const state = { activity: 'compaction' as const, startedAt: 123 }
    expect(applyCodexActivity(state, { type: 'assistant/chunk', time: 456 })).toBe(state)
  })

  it('clears on compaction/end and turn/start', () => {
    const compacting = { activity: 'compaction' as const, startedAt: 123 }
    expect(applyCodexActivity(compacting, { type: 'compaction/end', time: 456 })).toBeNull()
    expect(applyCodexActivity(compacting, { type: 'turn/start', time: 789 })).toBeNull()

    const requesting = { activity: 'requesting-model' as const, startedAt: 123 }
    expect(applyCodexActivity(requesting, { type: 'step/end', time: 789 })).toBeNull()
    const replying = { activity: 'model-reply' as const, startedAt: 456 }
    expect(applyCodexActivity(replying, { type: 'step/end', time: 789 })).toBeNull()
  })

  it('validates the nullable wire state', () => {
    expect(codexActivitySchema.parse(null)).toBeNull()
    expect(codexActivitySchema.parse({ activity: 'compaction', startedAt: 42 }))
      .toEqual({ activity: 'compaction', startedAt: 42 })
    expect(codexActivitySchema.parse({ activity: 'requesting-model', startedAt: 42 }))
      .toEqual({ activity: 'requesting-model', startedAt: 42 })
    expect(codexActivitySchema.parse({ activity: 'model-reply', startedAt: 42 }))
      .toEqual({ activity: 'model-reply', startedAt: 42 })
    expect(() => codexActivitySchema.parse({ activity: 'awaiting-model', startedAt: 42 })).toThrow()
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
    expect(definition?.stateVersion).toBe(3)
    expect(definition?.wire?.view(null)).toBeNull()
  })

  it('replays actual DSH packed settlements using the first non-empty delta time', () => {
    const requesting = { activity: 'requesting-model' as const, startedAt: 100 }
    const accumulator = new AssistantStreamAccumulator()
    accumulator.push({ time: 150, chunk: { type: 'usage', usage: { inputTokens: 1, outputTokens: 0 } } })
    accumulator.push({ time: 200, chunk: { type: 'reasoning-delta', index: 0, text: '' } })
    accumulator.push({ time: 210, chunk: { type: 'reasoning-delta', index: 0, text: '' } })
    accumulator.push({ time: 230, chunk: { type: 'reasoning-delta', index: 0, text: 'thinking' } })
    const stream = accumulator.snapshot()
    expect(stream[1]).toMatchObject({ time0: 200, dt: [10, 20], texts: ['', '', 'thinking'] })
    expect(expandAssistantStream(stream).map(value => value.time)).toEqual([150, 200, 210, 230])
    expect(assistantStreamFirstTokenTime(stream)).toBe(230)
    for (const type of ['assistant/message', 'assistant/attempt']) {
      expect(applyCodexActivity(requesting, {
        type,
        time: 900,
        data: { stream },
      })).toEqual({ activity: 'model-reply', startedAt: 230 })
    }
    expect(applyCodexActivity(requesting, {
      type: 'assistant/attempt', time: 900,
      data: { stream: [{ type: 'text-chunks', time0: 200, index: 0, dt: [], texts: [''] }] },
    })).toBe(requesting)
  })

  it('awaits projection readiness without returning its handle as an effect', async () => {
    let ready!: () => void
    const handle = { stateOf: () => null, dispose: async () => {} }
    let activation: Promise<unknown> | undefined
    registerCodexActivityProjection({
      inject: (_names: string[], callback: (ctx: unknown) => Promise<unknown>) => {
        activation = callback({ sessionProjections: {
          register: () => new Promise(resolve => { ready = () => resolve(handle) }),
        } })
      },
    } as unknown as Context)
    let settled = false
    void activation!.then(() => { settled = true })
    await Promise.resolve()
    expect(settled).toBe(false)
    ready()
    await expect(activation).resolves.toBeUndefined()
  })

  it('does not throw when the optional projection seam is unavailable', () => {
    expect(() => registerCodexActivityProjection({ inject: () => undefined } as unknown as Context))
      .not.toThrow()
  })
})

