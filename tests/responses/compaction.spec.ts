import { Context } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import Include from '@deepseek-ai/cordis-plugin-include'
import LlmRuntime, { createMessage, createUserMessage, LlmAdapter } from '@deepseek-ai/dsh-llm'
import type { LlmResolvedModelInfo, StreamChunk } from '@deepseek-ai/dsh-llm'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import SessionStore from '@deepseek-ai/dsh-session'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import type { TokenMeasurement } from '@deepseek-ai/dsh-token-meter'
import TokenMeter from '@deepseek-ai/dsh-token-meter'
import { describe, expect, it, vi } from 'vitest'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import CodexCompactionEngine from '../../src/entries/compaction.ts'
import BasicCompactionEngine from '@deepseek-ai/dsh-compaction-basic'
import { CODEX_SETTINGS_ENTRY } from '../../src/contracts/settings.ts'
import { installSmallWindowCompaction } from '../../src/presets/small-window-compaction.ts'

const PROVIDER = 'relay'
const MODEL = 'gpt-5.4'

class ContextAdapter extends LlmAdapter {
  resolveCalls = 0

  override resolveModel(provider: string, model: string): Promise<LlmResolvedModelInfo> {
    this.resolveCalls += 1
    return Promise.resolve({
      provider,
      id: model,
      name: model,
      context: { contextWindow: 262_144 },
    })
  }

  override async * stream(): AsyncIterable<StreamChunk> {
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
}

function sessionWithDurableContext(
  contextWindow: number,
  body = '',
  headerContextWindow?: number,
): Session {
  const session = Session.create(SessionId('codex-compaction-context'))
  for (let turn = 1; turn <= 3; turn += 1) {
    session.append('turn/start', { turn })
    session.append('user/message', createUserMessage({
      content: [{ type: 'text', text: `${body}user ${turn}` }],
      source: { kind: 'user' },
    }), { surfaceOp: 'append' })
    session.append('step/start', { turn, step: 1 })
    if (turn === 1) {
      session.append('request/header', {
        header: {
          config: {
            provider: PROVIDER,
            model: MODEL,
            ...headerContextWindow === undefined ? {} : { contextWindow: headerContextWindow },
          },
        },
        reason: 'initial',
      })
      session.append('request/context', { provider: PROVIDER, model: MODEL, contextWindow })
    }
    session.append('assistant/message', {
      turn,
      step: 1,
      message: createMessage({
        role: 'assistant',
        content: [{ type: 'text', text: `${body}assistant ${turn}` }],
        source: { kind: 'model', provider: PROVIDER, model: MODEL },
      }),
      stream: [],
    }, { surfaceOp: 'append' })
    session.append('step/end', { turn, step: 1 })
    session.append('turn/end', { turn, reason: { kind: 'completed' } })
  }
  session.append('turn/start', { turn: 4 })
  return session
}

function pressureMeasurement(session: Session, totalTokens: number): TokenMeasurement {
  return {
    logRevision: session.seq,
    baseline: { kind: 'estimated', tokens: 10_000 },
    surfaceDeltaTokens: totalTokens - 10_000,
    totalTokens,
    surfaceTokens: 240_000,
    nodes: session.surface.nodes.map(seq => ({ seq, tokens: 40_000, heuristicTokens: 40_000 })),
  }
}

describe('Codex compaction context capacity', () => {
  it('does not use the adapter default when request/context records a 400K override', async () => {
    const ctx = new Context()
    const session = sessionWithDurableContext(400_000)
    const measurement = pressureMeasurement(session, 250_000)
    const resolveModelInfo = vi.fn(async (): Promise<LlmResolvedModelInfo> => ({
      provider: PROVIDER,
      id: MODEL,
      name: MODEL,
      context: { contextWindow: 262_144 },
    }))
    ctx.provide('llm', { resolveModelInfo } as never)
    ctx.provide('tokenMeter', { measure: () => measurement } as never)

    const compact = new CodexCompactionEngine(ctx, { auto: false })
    const compactRegion = vi.spyOn(compact, 'compactRegion')

    await expect(compact.compactIfNeeded({
      session,
      options: { provider: PROVIDER, model: MODEL },
    } as never, 'pressure', new AbortController().signal)).resolves.toBeNull()

    expect(resolveModelInfo).toHaveBeenCalledOnce()
    expect(compactRegion).not.toHaveBeenCalled()
  })

  it('uses the 400K override when evaluating routed pressure budgets', async () => {
    const ctx = new Context()
    const session = sessionWithDurableContext(400_000)
    let totalTokens = 381_000
    const resolveModelInfo = vi.fn(async (): Promise<LlmResolvedModelInfo> => ({
      provider: PROVIDER,
      id: MODEL,
      name: MODEL,
      context: { contextWindow: 262_144 },
    }))
    ctx.provide('llm', { resolveModelInfo } as never)
    ctx.provide('tokenMeter', { measure: () => pressureMeasurement(session, totalTokens) } as never)

    const compact = new CodexCompactionEngine(ctx, {
      auto: false,
      compactionRetries: 0,
      thresholdRatio: 0.95,
    })
    const compactRegion = vi.spyOn(compact, 'compactRegion').mockImplementation(async () => {
      totalTokens = 0
      return {} as never
    })

    await compact.compactIfNeeded({
      session,
      options: { provider: PROVIDER, model: MODEL },
    } as never, 'pressure', new AbortController().signal)

    expect(compactRegion).toHaveBeenCalledOnce()
  })

  it('uses the live Codex setting when official DSH reports only the model default', async () => {
    const ctx = new Context()
    const session = sessionWithDurableContext(262_144)
    let totalTokens = 321_000
    ctx.provide('codexPreferences', {
      current: () => ({ contextWindow: 400_000 }),
    } as never)
    const resolveModelInfo = vi.fn(async (): Promise<LlmResolvedModelInfo> => ({
      provider: PROVIDER,
      id: MODEL,
      name: MODEL,
      context: { contextWindow: 262_144 },
    }))
    ctx.provide('llm', { resolveModelInfo } as never)
    ctx.provide('tokenMeter', { measure: () => pressureMeasurement(session, totalTokens) } as never)

    const compact = new CodexCompactionEngine(ctx, { auto: false, compactionRetries: 0 })
    const compactRegion = vi.spyOn(compact, 'compactRegion').mockImplementation(async () => {
      totalTokens = 0
      return {} as never
    })

    await compact.compactIfNeeded({
      session,
      options: { provider: PROVIDER, model: MODEL },
    } as never, 'pressure', new AbortController().signal)

    expect(compactRegion).toHaveBeenCalledOnce()
  })

  it.each(['pressure', 'region'] as const)('passes the current capacity into auxiliary summaries via %s', async mode => {
    const ctx = new Context()
    const session = sessionWithDurableContext(mode === 'region' ? 400_000 : 262_144)
    let summaryOptions: Record<string, unknown> | undefined
    if (mode === 'pressure') ctx.provide('codexPreferences', {
      current: () => ({ contextWindow: 400_000 }),
    } as never)
    const resolveModelInfo = vi.fn(async (): Promise<LlmResolvedModelInfo> => ({
      provider: PROVIDER,
      id: MODEL,
      name: MODEL,
      context: { contextWindow: 262_144 },
    }))
    const stream = vi.fn((options: Record<string, unknown>) => {
      summaryOptions = options
      return (async function* () {
        const summary = '<codex-remote-compaction>opaque</codex-remote-compaction>'
        yield { type: 'block-start', index: 0, blockType: 'text' }
        yield { type: 'text-delta', index: 0, text: summary }
        yield { type: 'block-end', index: 0, block: { type: 'text', text: summary } }
        yield { type: 'finish', reason: { kind: 'stop' } }
      })()
    })
    ctx.provide('llm', { resolveModelInfo, stream } as never)
    ctx.provide('tokenMeter', {
      measure: () => pressureMeasurement(session, session.surface.replaceGeneration > 0 ? 0 : 381_000),
      estimateMessage: () => 0,
    } as never)

    const compact = new CodexCompactionEngine(ctx, { auto: false, compactionRetries: 0 })

    const agent = { session, options: { provider: PROVIDER, model: MODEL } }
    const signal = new AbortController().signal
    const operation = mode === 'region'
      ? compact.compactRegion(session.surface.nodes[0]!, session.surface.nodes[3]!, agent, signal)
      : compact.compactIfNeeded(agent, 'pressure', signal)
    await expect(operation).resolves.not.toBeNull()

    expect(stream).toHaveBeenCalledOnce()
    expect(summaryOptions).toMatchObject({
      provider: PROVIDER,
      model: MODEL,
      contextWindow: 400_000,
      purpose: 'compaction',
    })
    expect(session.surface.replaceGeneration).toBe(1)
    const checkpoint = session.snapshotEvents().findLast(event => (
      event.type === 'user/message'
      && event.data.source.kind === 'compact-checkpoint'
    ))
    expect(checkpoint).toMatchObject({
      surfaceOp: { op: 'replace' },
      data: { source: { kind: 'compact-checkpoint', compactionId: expect.any(String) } },
    })
    expect(JSON.stringify(checkpoint)).toContain('<codex-remote-compaction>opaque</codex-remote-compaction>')
  })

  it('uses the changed live setting instead of a stale request-header override', async () => {
    const ctx = new Context()
    const session = sessionWithDurableContext(400_000, '', 400_000)
    let totalTokens = 150_000
    ctx.provide('codexPreferences', {
      current: () => ({ contextWindow: 100_000 }),
    } as never)
    const resolveModelInfo = vi.fn(async (): Promise<LlmResolvedModelInfo> => ({
      provider: PROVIDER,
      id: MODEL,
      name: MODEL,
      context: { contextWindow: 262_144 },
    }))
    ctx.provide('llm', { resolveModelInfo } as never)
    ctx.provide('tokenMeter', { measure: () => pressureMeasurement(session, totalTokens) } as never)

    const compact = new CodexCompactionEngine(ctx, { auto: false, compactionRetries: 0 })
    const compactRegion = vi.spyOn(compact, 'compactRegion').mockImplementation(async () => {
      totalTokens = 0
      return {} as never
    })

    await compact.compactIfNeeded({
      session,
      options: { provider: PROVIDER, model: MODEL },
    } as never, 'pressure', new AbortController().signal)

    expect(compactRegion).toHaveBeenCalledOnce()
  })

  it('returns to the model default after the live override is removed', async () => {
    const ctx = new Context()
    const session = sessionWithDurableContext(400_000, '', 400_000)
    let totalTokens = 250_000
    ctx.provide('codexPreferences', {
      current: () => ({ fast: false }),
    } as never)
    const resolveModelInfo = vi.fn(async (): Promise<LlmResolvedModelInfo> => ({
      provider: PROVIDER,
      id: MODEL,
      name: MODEL,
      context: { contextWindow: 262_144 },
    }))
    ctx.provide('llm', { resolveModelInfo } as never)
    ctx.provide('tokenMeter', { measure: () => pressureMeasurement(session, totalTokens) } as never)

    const compact = new CodexCompactionEngine(ctx, { auto: false, compactionRetries: 0 })
    const compactRegion = vi.spyOn(compact, 'compactRegion').mockImplementation(async () => {
      totalTokens = 0
      return {} as never
    })

    await compact.compactIfNeeded({
      session,
      options: { provider: PROVIDER, model: MODEL },
    } as never, 'pressure', new AbortController().signal)

    expect(compactRegion).toHaveBeenCalledOnce()
  })

  it('uses an explicit override even when the adapter has no context metadata', async () => {
    const ctx = new Context()
    const session = sessionWithDurableContext(100_000)
    const measurement = pressureMeasurement(session, 150_000)
    ctx.provide('codexPreferences', {
      current: () => ({ contextWindow: 100_000 }),
    } as never)
    const resolveModelInfo = vi.fn(async (): Promise<LlmResolvedModelInfo> => ({
      provider: PROVIDER,
      id: MODEL,
      name: MODEL,
    }))
    ctx.provide('llm', { resolveModelInfo } as never)
    ctx.provide('tokenMeter', { measure: () => measurement } as never)

    const compact = new CodexCompactionEngine(ctx, { auto: false, compactionRetries: 0 })
    const compactRegion = vi.spyOn(compact, 'compactRegion').mockImplementation(async () => {
      measurement.totalTokens = 0
      return {} as never
    })

    await compact.compactIfNeeded({
      session,
      options: { provider: PROVIDER, model: MODEL },
    } as never, 'pressure', new AbortController().signal)

    expect(compactRegion).toHaveBeenCalledOnce()
  })

  it('loads through Cordis Loader and leaves a 250K session below pressure', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-codex-compaction-loader-'))
    const configPath = join(root, 'cordis.yml')
    await writeFile(configPath, [
      '- name: local-llm',
      '- name: local-sessions',
      '- name: local-projections',
      '- name: local-token-meter',
      '- name: local-codex-compaction',
      '  config:',
      '    auto: true',
      '',
    ].join('\n'))

    const ctx = new Context()
    try {
      await ctx.plugin(Loader)
      ctx.loader.builtins.include = Include
      const modules = new Map<string, unknown>([
        ['local-llm', LlmRuntime],
        ['local-sessions', SessionStore],
        ['local-projections', SessionProjectionRegistry],
        ['local-token-meter', TokenMeter],
        ['local-codex-compaction', CodexCompactionEngine],
      ])
      ctx.loader.internal = {
        version: 'v2',
        async import(specifier: string) {
          const module = modules.get(specifier)
          if (module === undefined) throw new Error(`unexpected Loader import: ${specifier}`)
          return module
        },
      } as unknown as NonNullable<typeof ctx.loader.internal>
      ctx.baseUrl = pathToFileURL(root).href + '/'
      await ctx.loader.create({
        name: 'cordis:include',
        config: { path: pathToFileURL(configPath).href },
      })
      await ctx.loader.await()

      const adapter = new ContextAdapter()
      ctx.llm.registerAdapter([PROVIDER], adapter)

      const session = sessionWithDurableContext(400_000, 'x'.repeat(160_000))
      const compact = ctx.get('compaction')
      if (compact === undefined) throw new Error('compaction service did not load')
      const eventCount = session.snapshotEvents().length

      expect(ctx.tokenMeter.measure(session).totalTokens).toBeGreaterThan(210_000)
      expect(ctx.tokenMeter.measure(session).totalTokens).toBeLessThan(320_000)
      await expect(ctx.waterfall('agent/pre-step', {
        agent: {
          session,
          options: { provider: PROVIDER, model: MODEL },
        },
        messages: [],
        turn: 4,
        step: 1,
        signal: new AbortController().signal,
      } as never, async () => undefined)).resolves.toBeUndefined()
      expect(adapter.resolveCalls).toBe(1)
      expect(session.snapshotEvents()).toHaveLength(eventCount)
    } finally {
      await ctx.fiber.dispose()
      await rm(root, { recursive: true, force: true })
    }
  })

  it('compacts a 64k context window natively in CodexCompactionEngine without headroom failure', async () => {
    const ctx = new Context()
    const session = sessionWithDurableContext(64_000)
    let totalTokens = 55_000
    ctx.provide('codexPreferences', { current: () => ({ contextWindow: 64_000 }) } as never)
    ctx.provide('llm', { resolveModelInfo: async () => ({ provider: PROVIDER, id: MODEL, name: MODEL, context: { contextWindow: 262_144 } }) } as never)
    ctx.provide('tokenMeter', { measure: () => pressureMeasurement(session, totalTokens) } as never)

    const compact = new CodexCompactionEngine(ctx, { auto: false, compactionRetries: 0 })
    const compactRegion = vi.spyOn(compact, 'compactRegion').mockImplementation(async () => { totalTokens = 0; return {} as never })
    await expect(compact.compactIfNeeded({ session, options: { provider: PROVIDER, model: MODEL } } as never, 'pressure', new AbortController().signal)).resolves.toEqual({})
    expect(compactRegion).toHaveBeenCalledOnce()
  })

  it('bridges pre-step compaction for 64k openai-codex sessions under upstream BasicCompactionEngine', async () => {
    const ctx = new Context()
    const session = sessionWithDurableContext(64_000)
    session.append('request/header', { header: { config: { provider: 'openai-codex', model: 'gpt-6.1-sol' } }, reason: 'initial' })
    let totalTokens = 200_000
    ctx.provide('llm', { resolveModelInfo: async () => ({ provider: 'openai-codex', id: 'gpt-6.1-sol', name: 'GPT-6.1-Sol', context: { contextWindow: 64_000 } }) } as never)
    ctx.provide('tokenMeter', { measure: () => pressureMeasurement(session, totalTokens) } as never)

    const upstream = new BasicCompactionEngine(ctx, { auto: true, compactionRetries: 0 })
    const compactRegion = vi.spyOn(upstream, 'compactRegion').mockImplementation(async () => { totalTokens = 10_000; return {} as never })
    installSmallWindowCompaction(ctx, () => ({ ...CODEX_SETTINGS_ENTRY }), new WeakMap())

    await ctx.waterfall('agent/pre-step', { agent: { ctx, session }, signal: new AbortController().signal } as never, async () => undefined)
    expect(compactRegion).toHaveBeenCalledOnce()
  })
})
