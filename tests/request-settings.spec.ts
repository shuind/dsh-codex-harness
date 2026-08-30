import { describe, expect, it } from 'vitest'
import {
  apply,
  applyCodexRequestSettings,
  buildCodexSystemPrompt,
  CODEX_SETTINGS_NAMESPACE,
  Config,
  normalizeCodexPromptAssembly,
  syncCodexContextWindow,
} from '../src/index.ts'
import { Session, SessionId } from '@deepseek-ai/dsh-session'

describe('Codex request settings', () => {
  it('keeps the collaboration prompt off by default and enables it explicitly', () => {
    expect(Config().collaborationPrompt).toBe(false)
    const prompt = buildCodexSystemPrompt()
    expect(prompt).toMatch(/^## General/)
    expect(prompt).not.toContain('You are Codex')
    expect(prompt).not.toContain('## Working principles')
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

    expect(Config({ collaborationPrompt: true }).collaborationPrompt).toBe(true)
    const collaborationPrompt = buildCodexSystemPrompt({ collaborationPrompt: true })
    expect(collaborationPrompt).toContain('## Working principles')
    expect(collaborationPrompt).toContain(
      "Ask, align, and clarify first. Gather enough context from the user, then align the approach to achieve the user's goal through the clearest, most effective path.",
    )
    expect(collaborationPrompt).toContain(
      "Keep only the essential logic and core actions. There's no need to explain or test what was removed or why something wasn't done, especially when writing documentation or communicating. Convey enough valuable information with as few words as possible.",
    )
    expect(collaborationPrompt).not.toContain('Gather more context from the user.')
    expect(collaborationPrompt).not.toContain('Make things as effortless as possible for the user.')
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
