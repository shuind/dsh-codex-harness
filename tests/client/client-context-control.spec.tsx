import { describe, expect, it, vi } from 'vitest'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import {
  contextPresetsForBounds,
  formatCompactTokens,
  nextOpenAICodexOverrides,
  OPENAI_CODEX_PROVIDER,
  OPENAI_CODEX_SETTINGS_NAMESPACE,
  parseCustomContextInput,
  resolveContextWindowBounds,
} from '../../src/contracts/ui-contracts.ts'
import { bindCodexConnectScope } from '../../src/client/desktop.tsx'
import { ComposerControls, ContextWindowControl } from '../../src/client/index.tsx'

describe('context window contracts and composer quick-adjust control', () => {
  it('resolves catalog defaults, ceilings, formatting, presets, and custom inputs', () => {
    expect(resolveContextWindowBounds(OPENAI_CODEX_PROVIDER, 'gpt-6.1-sol')).toEqual({
      defaultTokens: 500_000,
      maxTokens: 872_000,
    })
    expect(resolveContextWindowBounds(OPENAI_CODEX_PROVIDER, 'gpt-6-astra')).toEqual({
      defaultTokens: 272_000,
      maxTokens: 872_000,
    })
    expect(resolveContextWindowBounds(OPENAI_CODEX_PROVIDER, 'gpt-5.4')).toEqual({
      defaultTokens: 272_000,
      maxTokens: 1_000_000,
    })
    expect(resolveContextWindowBounds(OPENAI_CODEX_PROVIDER, 'gpt-5.5')).toEqual({
      defaultTokens: 272_000,
      maxTokens: 272_000,
    })
    expect(resolveContextWindowBounds(OPENAI_CODEX_PROVIDER, 'gpt-9-future')).toEqual({
      defaultTokens: 272_000,
      maxTokens: 272_000,
    })
    expect(resolveContextWindowBounds(OPENAI_CODEX_PROVIDER, 'gpt-9-future', {
      'gpt-9-future': { defaultTokens: 400_000, maxTokens: 950_000 },
    })).toEqual({
      defaultTokens: 400_000,
      maxTokens: 950_000,
    })
    expect(resolveContextWindowBounds('relay', 'gpt-5.4')).toEqual({ maxTokens: 1_000_000 })

    expect(formatCompactTokens(1_000_000)).toBe('1000k')
    expect(formatCompactTokens(872_000)).toBe('872k')
    expect(formatCompactTokens(500_000)).toBe('500k')
    expect(formatCompactTokens(272_000)).toBe('272k')

    expect(contextPresetsForBounds({ defaultTokens: 500_000, maxTokens: 872_000 })).toEqual([
      64_000, 128_000, 200_000, 272_000, 400_000, 872_000,
    ])
    expect(contextPresetsForBounds({ defaultTokens: 272_000, maxTokens: 272_000 })).toEqual([
      64_000, 128_000, 200_000,
    ])

    expect(parseCustomContextInput('64', 872_000)).toBe(64_000)
    expect(parseCustomContextInput('16k', 872_000)).toBe(16_000)
    expect(parseCustomContextInput('8k', 872_000)).toBeUndefined()
    expect(parseCustomContextInput('320', 872_000)).toBe(320_000)
    expect(parseCustomContextInput('320k', 872_000)).toBe(320_000)
    expect(parseCustomContextInput('1000', 1_000_000)).toBe(1_000_000)
    expect(parseCustomContextInput('1000k', 1_000_000)).toBe(1_000_000)
    expect(parseCustomContextInput('1000k', 872_000)).toBeUndefined()
    expect(parseCustomContextInput('1001k', 1_000_000)).toBeUndefined()
    expect(parseCustomContextInput('1M', 1_000_000)).toBeUndefined()
    expect(parseCustomContextInput('500000', 872_000)).toBe(500_000)
    expect(parseCustomContextInput('0', 872_000)).toBeUndefined()
    expect(parseCustomContextInput('abc', 872_000)).toBeUndefined()
    expect(parseCustomContextInput('900k', 872_000)).toBeUndefined()
  })

  it('computes sparse per-model contextWindowOverrides and base masks cleanly', () => {
    expect(nextOpenAICodexOverrides({ 'gpt-6-astra': 400_000 }, undefined, 'gpt-6.1-sol', 872_000)).toEqual({
      'gpt-6-astra': 400_000,
      'gpt-6.1-sol': 872_000,
    })
    expect(nextOpenAICodexOverrides({ 'gpt-6.1-sol': 872_000 }, undefined, 'gpt-6.1-sol', undefined)).toBeUndefined()
    expect(nextOpenAICodexOverrides({ 'gpt-6.1-sol': 872_000 }, { 'gpt-6.1-sol': 600_000 }, 'gpt-6.1-sol', undefined)).toEqual({
      'gpt-6.1-sol': null,
    })
  })

  it('binds llm-openai-codex mirror state with stable snapshots and per-model writes', async () => {
    const formSnap = { status: 'loading', writable: true, revision: 3 }
    let mirrorSnap: any = {
      status: 'ready',
      view: {
        writable: true,
        namespaces: [{ ns: OPENAI_CODEX_SETTINGS_NAMESPACE, value: { contextWindowOverrides: { 'gpt-6.1-sol': 872_000 } } }],
      },
    }
    const form = {
      getSnapshot: () => formSnap,
      subscribe: () => () => {},
      set: vi.fn(async () => true),
      unset: vi.fn(async () => true),
      mutate: vi.fn(async () => true),
    }
    const mirror = { getSnapshot: () => mirrorSnap, subscribe: () => () => {}, ensure: vi.fn() }
    const scope = bindCodexConnectScope({
      get: (id: string) => { expect(id).toBe(OPENAI_CODEX_SETTINGS_NAMESPACE); return form },
      describe: () => mirror,
      whileServed: () => () => {},
    })

    const snap1 = scope.getSnapshot()
    expect(snap1).toEqual({
      status: 'ready',
      writable: true,
      overrides: { 'gpt-6.1-sol': 872_000 },
      baseOverrides: undefined,
    })
    expect(scope.getSnapshot()).toBe(snap1)

    await scope.setModelOverride('gpt-6.1-sol', 400_000)
    expect(form.set).toHaveBeenCalledWith('contextWindowOverrides', { 'gpt-6.1-sol': 400_000 })

    mirrorSnap = {
      status: 'ready',
      view: {
        writable: true,
        namespaces: [{
          ns: OPENAI_CODEX_SETTINGS_NAMESPACE,
          value: {
            enableNativeCompaction: false,
            enableSearch: true,
            searchModel: 'gpt-6.2-sol',
            enableImageGeneration: true,
            imageModelHint: 'gpt-image-2.6-sunburst',
          },
        }],
      },
    }
    const snap2 = scope.getSnapshot()
    expect(snap2.nativeCompaction).toBe(false)
    expect(snap2.searchEnabled).toBe(true)
    expect(snap2.searchModel).toBe('gpt-6.2-sol')
    expect(snap2.imageGenerationEnabled).toBe(true)
    expect(snap2.imageModelHint).toBe('gpt-image-2.6-sunburst')
    await scope.setNativeCompaction?.(true)
    expect(form.set).toHaveBeenCalledWith('enableNativeCompaction', true)

    await scope.setModelOverride('gpt-6.1-sol', undefined)
    expect(form.unset).toHaveBeenCalledWith('contextWindowOverrides')
  })

  it('renders route-appropriate composer controls without eagerly reading llm-openai-codex', () => {
    const storeFor = (snapshot: unknown) => ({ subscribe: () => () => {}, getSnapshot: () => snapshot })
    const makeProps = (settingsValue: Record<string, unknown>, dirSnapshot: unknown, connectOverrides?: Record<string, number | null>, connectSpy?: () => void) => ({
      useSettings: (select: (state: unknown) => unknown) => select({ writable: true, value: settingsValue }),
      setSetting: async () => {},
      unsetSetting: async () => {},
      modelDirectory: storeFor(dirSnapshot),
      getCodexConnectScope: () => {
        connectSpy?.()
        return {
          getSnapshot: () => ({ status: 'ready', writable: true, overrides: connectOverrides }),
          subscribe: () => () => {},
          setModelOverride: async () => {},
        }
      },
      t: (key: string) => key,
    }) as any

    const solDefault = renderToStaticMarkup(createElement(ComposerControls, makeProps(
      { fastModeControlEnabled: true, contextWindowControlEnabled: true },
      { status: 'ready', current: { provider: OPENAI_CODEX_PROVIDER, model: 'gpt-6.1-sol' } },
      {},
    )))
    expect(solDefault).toContain('data-codex-context-control="default"')
    expect(solDefault).toContain('>500k<')
    expect(solDefault).not.toContain('>fast<')

    const solOverride = renderToStaticMarkup(createElement(ContextWindowControl, makeProps(
      { contextWindowControlEnabled: true },
      { status: 'ready', current: { provider: OPENAI_CODEX_PROVIDER, model: 'gpt-6.1-sol' } },
      { 'gpt-6.1-sol': 872_000 },
    )))
    expect(solOverride).toContain('data-codex-context-control="override"')
    expect(solOverride).toContain('>872k<')

    const astraDefault = renderToStaticMarkup(createElement(ContextWindowControl, makeProps(
      { contextWindowControlEnabled: true },
      { status: 'ready', current: { provider: OPENAI_CODEX_PROVIDER, model: 'gpt-6-astra' } },
      {},
    )))
    expect(astraDefault).toContain('>272k<')

    const relayDefault = renderToStaticMarkup(createElement(ComposerControls, makeProps(
      { fastModeControlEnabled: true, contextWindowControlEnabled: true },
      { status: 'ready', current: { provider: 'relay', model: 'gpt-5.4' } },
    )))
    expect(relayDefault).toContain('>contextShortDefault<')
    expect(relayDefault).toContain('>fast<')

    const relayOverride = renderToStaticMarkup(createElement(ContextWindowControl, makeProps(
      { contextWindowControlEnabled: true, contextWindow: 400_000 },
      { status: 'ready', current: { provider: 'relay', model: 'gpt-5.4' } },
    )))
    expect(relayOverride).toContain('data-codex-context-control="override"')
    expect(relayOverride).toContain('>400k<')

    const connectSpy = vi.fn()
    const deepseekHtml = renderToStaticMarkup(createElement(ComposerControls, makeProps(
      { fastModeControlEnabled: true, contextWindowControlEnabled: true },
      { status: 'ready', current: { provider: 'deepseek', model: 'deepseek-chat' } },
      undefined,
      connectSpy,
    )))
    expect(deepseekHtml).toBe('')
    expect(connectSpy).not.toHaveBeenCalled()

    const hiddenHtml = renderToStaticMarkup(createElement(ContextWindowControl, makeProps(
      { contextWindowControlEnabled: false },
      { status: 'ready', current: { provider: OPENAI_CODEX_PROVIDER, model: 'gpt-6.1-sol' } },
    )))
    expect(hiddenHtml).toBe('')
  })
})
