import type { StreamChunk, TokenUsage } from '@deepseek-ai/dsh-llm'
import { describe, expect, it } from 'vitest'
import { repairLegacyPiAiContextOverflow } from '../src/remote.ts'

const USAGE: Extract<StreamChunk, { type: 'usage' }> = {
  type: 'usage',
  usage: { inputTokens: 867, outputTokens: 90, cacheReadTokens: 282_240 },
}

const OVERFLOW: Extract<StreamChunk, { type: 'finish' }> = {
  type: 'finish',
  reason: {
    kind: 'error',
    failure: {
      message: 'pi-ai detected context overflow for model "gpt-5.6-luna"',
      code: 'CONTEXT_WINDOW_EXCEEDED',
    },
  },
  replayState: { response: { adapter: 'pi-ai' } },
}

async function* source(usage: TokenUsage = USAGE.usage): AsyncGenerator<StreamChunk> {
  yield { type: 'usage', usage }
  yield OVERFLOW
}

async function collect(stream: AsyncIterable<StreamChunk>): Promise<StreamChunk[]> {
  const chunks: StreamChunk[] = []
  for await (const chunk of stream) chunks.push(chunk)
  return chunks
}

describe('legacy pi-ai context capacity', () => {
  it('repairs a usage-only overflow below the Codex capacity', async () => {
    await expect(collect(repairLegacyPiAiContextOverflow(
      source(),
      'gpt-5.6-luna',
      400_000,
    ))).resolves.toEqual([
      USAGE,
      { ...OVERFLOW, reason: { kind: 'stop' } },
    ])
  })

  it.each([
    {
      name: 'combined usage exceeds the capacity',
      usage: { inputTokens: 399_950, outputTokens: 100 },
    },
    {
      name: 'the response has no output',
      usage: { inputTokens: 867, outputTokens: 0, cacheReadTokens: 282_240 },
    },
    {
      name: 'a cache-write bucket crosses the capacity',
      usage: { inputTokens: 867, outputTokens: 90, cacheReadTokens: 282_240, cacheWriteTokens: 117_000 },
    },
  ])('preserves the overflow when $name', async ({ usage }) => {
    const chunks = await collect(repairLegacyPiAiContextOverflow(
      source(usage),
      'gpt-5.6-luna',
      400_000,
    ))
    expect(chunks.at(-1)).toEqual(OVERFLOW)
  })
})
