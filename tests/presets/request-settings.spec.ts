import { describe, expect, it } from 'vitest'
import {
  apply,
  applyCodexPresentationSettings,
  applyCodexRequestSettings,
  buildCodexSystemPrompt,
  CODEX_SETTINGS_NAMESPACE,
  Config,
  normalizeCodexPromptAssembly,
  syncCodexContextWindow,
} from '../../src/entries/index.ts'
import { repairLegacyPiAiContextOverflow } from '../../src/responses/sse-diagnostics.ts'
import { CODEX_SETTINGS_ENTRY } from '../../src/contracts/settings.ts'
import { OPENAI_CODEX_SETTINGS_NAMESPACE } from '../../src/contracts/ui-contracts.ts'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import type { StreamChunk } from '@deepseek-ai/dsh-llm'

describe('Codex request settings', () => {
  it('accepts per-preset Codex capability overrides', () => {
    const preset = Config({ hostedWebSearchEnabled: false, remoteCompactionEnabled: false, planToolEnabled: false })
    expect(preset.hostedWebSearchEnabled).toBe(false)
    expect(preset.remoteCompactionEnabled).toBe(false)
    expect(preset.planToolEnabled).toBe(false)
  })

  it('uses the complete working-principles prompt by default and accepts a full replacement', () => {
    expect(Config().systemPrompt).toContain('## Working principles')
    const prompt = buildCodexSystemPrompt()
    expect(prompt).toMatch(/^## General/)
    expect(prompt).not.toContain('You are Codex')
    expect(prompt).toContain('## Working principles')
    expect(prompt).toContain(
      'For substantial work, explain what changed and why, then briefly note how the work was verified and what comes next.',
    )
    expect(Config({ systemPrompt: 'Custom prompt.' }).systemPrompt).toBe('Custom prompt.')
    expect(buildCodexSystemPrompt({ systemPrompt: 'Custom prompt.' })).toBe('Custom prompt.')
    expect(buildCodexSystemPrompt({ systemPrompt: '' })).toBe('')
  })

  it('reads the editable full prompt when each system prompt is assembled', () => {
    let settings = { fast: false, systemPrompt: 'First prompt.' }
    let sectionText: string | (() => string) | undefined
    const ctx = {
      fs: { sandboxMode: undefined },
      get: (name: string) => name === 'tools' ? ctx.tools
        : name === 'shell' ? {}
        : name === 'codexPreferences' ? { current: () => settings }
        : undefined,
      on: () => () => {},
      inject: () => {},
      systemPrompt: { section: (section: { text: string | (() => string) }) => { sectionText = section.text } },
      tools: { register: () => {} },
    } as never

    apply(ctx)
    expect(typeof sectionText).toBe('function')
    expect((sectionText as () => string)()).toBe('First prompt.')
    settings = { fast: false, systemPrompt: 'Second prompt.' }
    expect((sectionText as () => string)()).toBe('Second prompt.')
  })

  it('maps Fast to the priority service tier and carries a context override', () => {
    const result = applyCodexRequestSettings({
      provider: 'relay',
      model: 'gpt-5.4',
      reasoningEffort: 'high',
    }, {
      fast: true,
      contextWindow: 131_072,
    })

    expect(result).toMatchObject({
      provider: 'relay',
      model: 'gpt-5.4',
      reasoningEffort: 'high',
      contextWindow: 131_072,
      serviceTier: 'priority',
    })
  })

  it('puts the Codex persona first and removes the generic Harness identity', () => {
    const result = normalizeCodexPromptAssembly({
      sections: [
        { name: 'harness:identity', text: 'You are an AI agent powered by DeepSeek Harness.' },
        { name: 'harness:source', text: 'The Harness checkout is here.' },
        { name: 'deployment:persona', text: 'You are Codex.' },
        { name: 'codex:base', text: '## General' },
      ],
      contexts: [],
      variables: {},
    })

    expect(result.sections.map(section => section.name)).toEqual([
      'deployment:persona',
      'harness:source',
      'codex:base',
    ])
    expect(result.sections.map(section => section.text).join('\n')).not.toContain('You are an AI agent powered by DeepSeek Harness.')
  })

  it('applies editable Persona and DSH Core templates with runtime values', () => {
    const result = applyCodexPresentationSettings({
      sections: [
        { name: 'harness:identity', text: 'Harness' },
        {
          name: 'harness:source',
          text: 'The DeepSeek Harness implementation checkout is at C:\\repo. The checkout location and current working directory are separate values.',
        },
        {
          name: 'app:web-surface',
          text: 'You are interacting with the user through the DeepSeek Harness Web GUI at http://127.0.0.1:3080. When the user refers to this page.',
        },
        { name: 'deployment:persona', text: 'Default Persona' },
        { name: 'codex:base', text: 'Instructions' },
      ],
      contexts: [],
      variables: { model: 'gpt-5.6-luna', cwd: 'C:\\workspace' },
    }, {
      ...CODEX_SETTINGS_ENTRY,
      persona: 'You are {{model}} working in {{cwd}}.',
      harnessSourcePrompt: 'Source checkout: {{sourceRoot}}.',
      webSurfacePrompt: 'Use this GUI at {{webUrl}}.',
    })

    expect(result.sections.map(section => section.text)).toEqual([
      'You are gpt-5.6-luna working in C:\\workspace.',
      'Source checkout: C:\\repo.',
      'Use this GUI at http://127.0.0.1:3080.',
      'Instructions',
    ])
  })

  it('extracts {{cwd}}, {{sourceRoot}}, and {{webUrl}} from DSH 0.2.2 runtime contexts', () => {
    const result = applyCodexPresentationSettings({
      sections: [
        { name: 'deployment:persona-prefix', text: 'You are Codex, working in {{cwd}}.' },
        { name: 'harness:source', text: 'The runtime context names the DeepSeek Harness implementation checkout.' },
        { name: 'app:web-surface', text: 'You are interacting with the user through the DeepSeek Harness Web GUI.' },
      ],
      contexts: [
        { name: 'working-directory:current', text: 'Current working directory: "C:\\\\workspace".' },
        { name: 'harness:source', text: 'Current DeepSeek Harness implementation checkout: "C:\\\\dsh-repo".' },
        { name: 'app:web-surface', text: 'Current DeepSeek Harness Web GUI URL: "http://127.0.0.1:4123".' },
      ],
      variables: {},
    }, {
      ...CODEX_SETTINGS_ENTRY,
      harnessSourcePrompt: 'Root={{sourceRoot}}',
      webSurfacePrompt: 'Web={{webUrl}}',
    })

    expect(result.variables.cwd).toBe('C:\\workspace')
    expect(result.sections.map(section => section.text)).toEqual([
      'You are Codex, working in {{cwd}}.',
      'Root=C:\\dsh-repo',
      'Web=http://127.0.0.1:4123',
    ])
  })

  it('clears stale Codex controls when Fast is off or the route is not GPT', () => {
    expect(applyCodexRequestSettings({
      provider: 'relay',
      model: 'gpt-5.4',
      contextWindow: 64_000,
      serviceTier: 'priority',
    }, { fast: false })).not.toHaveProperty('serviceTier')

    expect(applyCodexRequestSettings({
      provider: 'relay',
      model: 'deepseek-chat',
      contextWindow: 64_000,
      serviceTier: 'priority',
    }, { fast: true, contextWindow: 32_000 })).toEqual({
      provider: 'relay',
      model: 'deepseek-chat',
    })

    expect(applyCodexRequestSettings({
      provider: 'openai-codex',
      model: 'gpt-6.1-sol',
      contextWindow: 64_000,
      serviceTier: 'priority',
    }, { ...CODEX_SETTINGS_ENTRY, fast: true, contextWindow: 400_000 })).toEqual({
      provider: 'openai-codex',
      model: 'gpt-6.1-sol',
    })
  })

  it('does not override Codex Connect model context windows via syncCodexContextWindow', () => {
    const session = Session.create(SessionId('codex-connect-context-preserve'))
    session.append('turn/start', { turn: 1 })
    session.append('request/header', {
      header: { config: { provider: 'openai-codex', model: 'gpt-6.1-sol' } },
      reason: 'initial',
    })
    session.append('request/context', { provider: 'openai-codex', model: 'gpt-6.1-sol', contextWindow: 500_000 })
    const countBefore = session.snapshotEvents().length
    syncCodexContextWindow(session, 272_000)
    expect(session.snapshotEvents()).toHaveLength(countBefore)
    expect(session.requestContext()?.contextWindow).toBe(500_000)
  })

  it('feeds the live context override into the official context projection', () => {
    const session = Session.create(SessionId('codex-context-projection'))
    session.append('turn/start', { turn: 1 })
    session.append('request/header', {
      header: { config: { provider: 'relay', model: 'gpt-5.4' } },
      reason: 'initial',
    })
    session.append('request/context', {
      provider: 'relay',
      model: 'gpt-5.4',
      contextWindow: 262_144,
    })

    syncCodexContextWindow(session, 400_000)
    expect(session.requestContext()).toEqual({
      provider: 'relay',
      model: 'gpt-5.4',
      contextWindow: 400_000,
    })
    const eventCount = session.snapshotEvents().length
    syncCodexContextWindow(session, 400_000)
    expect(session.snapshotEvents()).toHaveLength(eventCount)
  })

  it('waits for request context publication before appending the projection override', async () => {
    const session = Session.create(SessionId('codex-context-event'))
    session.append('turn/start', { turn: 1 })
    session.append('request/header', {
      header: { config: { provider: 'relay', model: 'gpt-5.4' } },
      reason: 'initial',
    })
    session.append('request/context', {
      provider: 'relay',
      model: 'gpt-5.4',
      contextWindow: 262_144,
    })

    const listeners = new Map<string, Array<(...args: any[]) => void>>()
    const ctx = {
      fs: { sandboxMode: undefined },
      get: (name: string) => name === 'tools' ? ctx.tools
        : name === 'shell' ? {}
        : name === 'codexPreferences' ? { current: () => ({ fast: false, contextWindow: 400_000 }) }
        : undefined,
      on: (name: string, listener: (...args: any[]) => void) => {
        const entries = listeners.get(name) ?? []
        entries.push(listener)
        listeners.set(name, entries)
        return () => {}
      },
      inject: () => {},
      systemPrompt: { section: () => {} },
      tools: { register: () => {} },
    } as never

    apply(ctx)
    session.append('request/context', {
      provider: 'relay',
      model: 'gpt-5.4',
      contextWindow: 262_144,
    })
    const adapterContext = session.requestContext()
    for (const listener of listeners.get('session/event') ?? []) {
      listener(session, session.snapshotEvents().at(-1))
    }
    for (const listener of listeners.get('session/created') ?? []) listener(session)

    expect(session.requestContext()).toBe(adapterContext)
    await new Promise<void>(resolve => { queueMicrotask(resolve) })
    expect(session.requestContext()).toEqual({
      provider: 'relay',
      model: 'gpt-5.4',
      contextWindow: 400_000,
    })
  })

  it('preserves in-history prompt capability when synchronizing only capacity', () => {
    const session = Session.create(SessionId('codex-context-capability'))
    session.append('turn/start', { turn: 1 })
    session.append('request/header', {
      header: { config: { provider: 'relay', model: 'gpt-5.4' } }, reason: 'initial',
    })
    session.append('request/context', {
      provider: 'relay', model: 'gpt-5.4', contextWindow: 262_144, systemPromptUpdate: 'in-history',
    })
    syncCodexContextWindow(session, 400_000)
    expect(session.requestContext()).toEqual({
      provider: 'relay', model: 'gpt-5.4', contextWindow: 400_000, systemPromptUpdate: 'in-history',
    })
  })

  it('refreshes an open session when the resolved Codex setting changes', () => {
    const session = Session.create(SessionId('codex-context-setting-update'))
    session.append('turn/start', { turn: 1 })
    session.append('request/header', {
      header: { config: { provider: 'relay', model: 'gpt-5.4' } },
      reason: 'initial',
    })
    session.append('request/context', {
      provider: 'relay',
      model: 'gpt-5.4',
      contextWindow: 262_144,
    })

    let contextWindow: number | undefined
    const listeners = new Map<string, Array<(...args: any[]) => void>>()
    const ctx = {
      fs: { sandboxMode: undefined },
      get: (name: string) => name === 'tools' ? ctx.tools
        : name === 'shell' ? {}
        : name === 'sessions' ? { list: () => [session] }
        : name === 'codexPreferences' ? { current: () => ({ fast: false, contextWindow }) }
        : undefined,
      on: (name: string, listener: (...args: any[]) => void) => {
        const entries = listeners.get(name) ?? []
        entries.push(listener)
        listeners.set(name, entries)
        return () => {}
      },
      inject: () => {},
      systemPrompt: { section: () => {} },
      tools: { register: () => {} },
    } as never

    apply(ctx)
    contextWindow = 400_000
    for (const listener of listeners.get('settings/document-updated') ?? []) {
      listener(CODEX_SETTINGS_NAMESPACE)
    }

    expect(session.requestContext()).toEqual({
      provider: 'relay',
      model: 'gpt-5.4',
      contextWindow: 400_000,
    })
  })

  it('repairs usage-only pi-ai overflow below Codex capacity while preserving genuine overflows', async () => {
    const overflow: Extract<StreamChunk, { type: 'finish' }> = {
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
    const collect = async (usage: { inputTokens: number; outputTokens: number; cacheReadTokens?: number }) => {
      const out: StreamChunk[] = []
      const src = async function* (): AsyncGenerator<StreamChunk> {
        yield { type: 'usage', usage }
        yield overflow
      }
      for await (const c of repairLegacyPiAiContextOverflow(src(), 'gpt-5.6-luna', 400_000)) out.push(c)
      return out.at(-1)
    }

    expect(await collect({ inputTokens: 867, outputTokens: 90, cacheReadTokens: 282_240 })).toEqual({
      ...overflow,
      reason: { kind: 'stop' },
    })
    expect(await collect({ inputTokens: 399_950, outputTokens: 100 })).toEqual(overflow)
    expect(await collect({ inputTokens: 867, outputTokens: 0, cacheReadTokens: 282_240 })).toEqual(overflow)

    const run = async (model: string, chunks: StreamChunk[], ceiling: number) => {
      const out: StreamChunk[] = []
      const src = async function* (): AsyncGenerator<StreamChunk> { for (const c of chunks) yield c }
      for await (const c of repairLegacyPiAiContextOverflow(src(), model, ceiling)) out.push(c)
      return out.at(-1)
    }
    const diagErr: Extract<StreamChunk, { type: 'finish' }> = {
      ...overflow,
      reason: { kind: 'error', failure: { code: 'CONTEXT_WINDOW_EXCEEDED', message: 'pi-ai detected context overflow for model "gpt-6.1-sol"\n[Codex diagnostics: {"clientRequestId":"req-1","httpStatus":200}]' } },
    }
    expect(await run('gpt-6.1-sol', [{ type: 'usage', usage: { inputTokens: 250_000, outputTokens: 120 } }, diagErr], 872_000)).toEqual({ ...diagErr, reason: { kind: 'stop' } })
    expect(await run('gpt-6.1-sol', [
      { type: 'text-delta', index: 0, text: '<dsh-codex-connect-native-compaction-v1>x' },
      { type: 'usage', usage: { inputTokens: 250_000, outputTokens: 0 } },
      diagErr,
    ], 872_000)).toEqual({ ...diagErr, reason: { kind: 'stop' } })

    const listeners = new Map<string, Array<(...args: any[]) => void>>()
    apply({
      fs: { sandboxMode: undefined },
      get: (name: string) => name === 'tools' ? { register: () => {} } : name === 'shell' ? {} : name === 'codexPreferences' ? { current: () => ({ fast: false }) } : undefined,
      on: (name: string, listener: (...args: any[]) => void) => { listeners.set(name, [...(listeners.get(name) ?? []), listener]); return () => {} },
      inject: () => {}, systemPrompt: { section: () => {} }, tools: { register: () => {} },
    } as never)
    const llmHook = listeners.get('llm/stream')!.at(-1)!
    for (const purpose of [undefined, 'compaction'] as const) {
      const out: StreamChunk[] = []
      const next = async function* (): AsyncGenerator<StreamChunk> {
        yield { type: 'usage', usage: { inputTokens: 250_000, outputTokens: 80 } }
        yield diagErr
      }
      for await (const c of llmHook({ provider: 'openai-codex', model: 'gpt-6.1-sol', purpose, messages: [] }, next)) out.push(c)
      expect(out.at(-1)).toEqual({ ...diagErr, reason: { kind: 'stop' } })
    }
  })

  it('syncs open openai-codex sessions from llm-openai-codex without leaking codex.contextWindow', () => {
    const session = Session.create(SessionId('codex-connect-context-sync'))
    session.append('turn/start', { turn: 1 })
    session.append('request/header', { header: { config: { provider: 'openai-codex', model: 'gpt-6.1-sol' } }, reason: 'initial' })
    session.append('request/context', { provider: 'openai-codex', model: 'gpt-6.1-sol', contextWindow: 500_000 })

    let overrides: Record<string, number | null> | undefined
    const listeners = new Map<string, Array<(...args: any[]) => void>>()
    const ctx = {
      fs: { sandboxMode: undefined },
      get: (name: string) => name === 'tools' ? ctx.tools
        : name === 'shell' ? {}
        : name === 'sessions' ? { list: () => [session] }
        : name === 'codexPreferences' ? { current: () => ({ fast: false, contextWindow: 128_000 }) }
        : name === 'settings' ? { describe: () => [{ ns: OPENAI_CODEX_SETTINGS_NAMESPACE, value: { contextWindowOverrides: overrides } }] }
        : undefined,
      on: (name: string, listener: (...args: any[]) => void) => {
        listeners.set(name, [...(listeners.get(name) ?? []), listener])
        return () => {}
      },
      inject: () => {},
      systemPrompt: { section: () => {} },
      tools: { register: () => {} },
    } as never

    apply(ctx)
    for (const listener of listeners.get('settings/document-updated') ?? []) listener(CODEX_SETTINGS_NAMESPACE)
    expect(session.requestContext()?.contextWindow).toBe(500_000)

    overrides = { 'gpt-6.1-sol': 872_000 }
    for (const listener of listeners.get('settings/document-updated') ?? []) listener(OPENAI_CODEX_SETTINGS_NAMESPACE)
    expect(session.requestContext()?.contextWindow).toBe(872_000)

    overrides = { 'gpt-6.1-sol': null }
    for (const listener of listeners.get('settings/document-updated') ?? []) listener(OPENAI_CODEX_SETTINGS_NAMESPACE)
    expect(session.requestContext()?.contextWindow).toBe(500_000)
  })
})
