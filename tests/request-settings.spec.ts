import { describe, expect, it } from 'vitest'
import {
  apply,
  applyCodexCapabilitySettings,
  applyCodexRequestSettings,
  buildCodexSystemPrompt,
  CODEX_SETTINGS_NAMESPACE,
  Config,
  normalizeCodexPromptAssembly,
  syncCodexContextWindow,
} from '../src/index.ts'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import { CODEX_SETTINGS_ENTRY } from '../src/settings.ts'

describe('Codex request settings', () => {
  it('uses the complete working-principles prompt by default and accepts a full replacement', () => {
    expect(Config().systemPrompt).toContain('## Working principles')
    const prompt = buildCodexSystemPrompt()
    expect(prompt).toMatch(/^## General/)
    expect(prompt).not.toContain('You are Codex')
    expect(prompt).toContain('## Working principles')
    expect(prompt).toContain(
      'For substantial work, explain what changed and why, then briefly note how the work was verified and what comes next.',
    )
    expect(prompt).not.toContain('Track every background job id you start.')
    expect(prompt).not.toContain('Before giving a final answer, collect every still-relevant job')
    for (const removedRule of [
      'do not wrap the patch in JSON',
      'Do not attempt to switch the preset',
      'do not invent a second harness',
      'bypass the filesystem service',
      'over new machinery',
      'Do not claim that a command',
      'do not invent replacement editing tools',
    ]) {
      expect(prompt).not.toContain(removedRule)
    }

    expect(prompt).toContain(
      "Actively establish the user's current context rather than relying on stale assumptions or prior context. Before committing to an approach that could materially shape the outcome or direction of the work, state the intended path and align it with the user; clarify any material uncertainty first. Then pursue the user's goal through the clearest, most effective path.",
    )
    expect(prompt).toContain(
      "Keep only the essential logic and core actions. Don't explain or test what was removed or why something wasn't done, especially when writing documentation or communicating. Convey enough valuable information with as few words as possible.",
    )
    expect(prompt).not.toContain('Gather more context from the user.')
    expect(prompt).not.toContain('Make things as effortless as possible for the user.')
    expect(Config({ systemPrompt: 'Custom prompt.' }).systemPrompt).toBe('Custom prompt.')
    expect(buildCodexSystemPrompt({ systemPrompt: 'Custom prompt.' })).toBe('Custom prompt.')
    expect(buildCodexSystemPrompt({ systemPrompt: '' })).toBe('')
  })

  it('reads the editable full prompt when each system prompt is assembled', () => {
    let settings = { fast: false, systemPrompt: 'First prompt.' }
    let sectionText: string | (() => string) | undefined
    const ctx = {
      fs: { sandboxMode: undefined },
      get: (name: string) => name === 'settings'
        ? { get: (ns: unknown) => ns === CODEX_SETTINGS_NAMESPACE ? settings : undefined }
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
      tools: [],
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
    const result = applyCodexCapabilitySettings({
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
      tools: [],
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

  it('filters disabled Codex capabilities from the next prompt assembly', () => {
    const assembly = {
      sections: [
        { name: 'harness:identity', text: 'Harness' },
        { name: 'deployment:persona', text: 'Codex' },
        { name: 'codex:base', text: 'Instructions' },
      ],
      contexts: [],
      tools: [
        { name: 'exec_command', description: 'exec', parameters: {} },
        { name: 'write_stdin', description: 'stdin', parameters: {} },
        { name: 'apply_patch', description: 'patch', parameters: {} },
        { name: 'update_plan', description: 'plan', parameters: {} },
        { name: 'web_search', description: 'search', parameters: {} },
      ],
      variables: {},
    }
    const result = applyCodexCapabilitySettings(assembly, {
      ...CODEX_SETTINGS_ENTRY,
      promptEnabled: false,
      terminalToolsEnabled: false,
      planToolEnabled: false,
    })

    expect(result.sections).toEqual(assembly.sections)
    expect(result.tools.map(tool => tool.name)).toEqual(['apply_patch', 'web_search'])
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
    const eventCount = session.events.length
    syncCodexContextWindow(session, 400_000)
    expect(session.events).toHaveLength(eventCount)
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
      get: () => undefined,
      on: (name: string, listener: (...args: any[]) => void) => {
        const entries = listeners.get(name) ?? []
        entries.push(listener)
        listeners.set(name, entries)
        return () => {}
      },
      inject: (services: string[], callback: (ctx: any) => void) => {
        if (!services.includes('settings')) return
        callback({
          settings: {
            installSection: (
              _owner: unknown,
              _namespace: unknown,
              _schema: unknown,
              _entry: unknown,
              hooks: { setSource: (source: () => unknown) => void },
            ) => hooks.setSource(() => ({ fast: false, contextWindow: 400_000 })),
          },
          effect: () => {},
        })
      },
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
      listener(session, session.events.at(-1))
    }

    expect(session.requestContext()).toBe(adapterContext)
    await new Promise<void>(resolve => { queueMicrotask(resolve) })
    expect(session.requestContext()).toEqual({
      provider: 'relay',
      model: 'gpt-5.4',
      contextWindow: 400_000,
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

    const listeners = new Map<string, Array<(...args: any[]) => void>>()
    const ctx = {
      fs: { sandboxMode: undefined },
      get: (name: string) => name === 'sessions' ? { list: () => [session] } : undefined,
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
    for (const listener of listeners.get('settings/updated') ?? []) {
      listener(CODEX_SETTINGS_NAMESPACE, { fast: false, contextWindow: 400_000 })
    }

    expect(session.requestContext()).toEqual({
      provider: 'relay',
      model: 'gpt-5.4',
      contextWindow: 400_000,
    })
  })
})
