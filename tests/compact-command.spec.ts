import { describe, expect, it } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import { codexCompactionMode } from '../src/compaction.ts'
import { apply } from '../src/compact-command.ts'

function mount() {
  let definition: {
    handler(invocation: { commandId: string; agent: never; rawInput: string; signal: AbortSignal }): Promise<unknown>
  } | undefined
  let mode: string | undefined
  const ctx = {
    commands: {
      register(next: typeof definition): () => void {
        definition = next
        return () => {}
      },
    },
    compaction: {
      compactNow: async () => {
        mode = codexCompactionMode()
        return { shadowedSeqs: [1, 2], shadowedTokenCount: 100, summarySeq: 3 }
      },
    },
    effect(factory: () => Generator<unknown, void, unknown>): void {
      const iterator = factory()
      iterator.next()
      iterator.next()
    },
  } as unknown as Context
  apply(ctx)
  if (definition === undefined) throw new Error('compact command was not registered')
  return { handler: definition.handler, getMode: () => mode }
}

const invocation = (rawInput: string) => ({
  commandId: 'cmd-test',
  agent: {} as never,
  rawInput,
  signal: new AbortController().signal,
})

describe('Codex compact command', () => {
  it('shares explicit mode across separately evaluated plugin entry modules', async () => {
    const duplicateEntry = await import('../src/compaction.ts?duplicate-entry')
    let observed: string | undefined
    await duplicateEntry.runCodexCompactionMode('remote', async () => {
      observed = codexCompactionMode()
    })
    expect(observed).toBe('remote')
  })

  it.each([
    ['remote', 'remote'],
    [' local ', 'local'],
  ])('passes %s as the compaction preference', async (input, expected) => {
    const command = mount()
    await expect(command.handler(invocation(input))).resolves.toMatchObject({
      kind: 'success',
      text: 'Compacted 2 history items (~100 tokens).',
    })
    expect(command.getMode()).toBe(expected)
  })

  it('keeps the setting-selected mode for an argument-free command', async () => {
    const command = mount()
    await expect(command.handler(invocation(''))).resolves.toMatchObject({ kind: 'success' })
    expect(command.getMode()).toBeUndefined()
  })

  it('rejects unsupported mode arguments without starting compaction', async () => {
    const command = mount()
    await expect(command.handler(invocation('automatic'))).resolves.toEqual({
      kind: 'error',
      text: 'Usage: /compact [remote|local]',
    })
    expect(command.getMode()).toBeUndefined()
  })
})
