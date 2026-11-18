import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import Preferences, { Config } from '../../src/entries/preferences.ts'
import { readHostSettings } from '../../src/contracts/settings.ts'
import { CODEX_SETTINGS_ENTRY } from '../../src/contracts/settings.ts'
import { apply, applyCodexPresentationSettings } from '../../src/entries/index.ts'

describe('desktop host preferences', () => {
  it('publishes validated preferences through a volatile Config', async () => {
    const ctx = new Context()
    const fiber = ctx.plugin(Preferences, { fast: true, contextWindow: 400_000 })
    await fiber
    expect(Config.meta.volatile).toBe(true)
    expect(readHostSettings(ctx, 'codex')).toMatchObject({ fast: true, contextWindow: 400_000 })
    await fiber.dispose()
    expect(ctx.get('codexPreferences')).toBeUndefined()
    expect(() => Config({ contextWindow: -1 })).toThrow()
  })

  it('prefers codexPreferences and reads settings.describe entries for other namespaces', () => {
    const ctx = new Context()
    const providers = { relay: { api: 'openai-responses', baseURL: 'https://example.test/v1' } }
    ctx.provide('settings', { describe: () => [
      { ns: 'codex', value: { fast: true } },
      { ns: 'llm-pi-ai', value: { providers } },
    ] })
    ctx.provide('codexPreferences', { current: () => ({ fast: false }) })
    expect(readHostSettings(ctx, 'codex')).toEqual({ fast: false })
    expect(readHostSettings(ctx, 'llm-pi-ai')).toEqual({ providers })
    expect(readHostSettings(ctx, 'missing')).toBeUndefined()
  })

  it('overrides and orders the desktop persona prefix without losing its suffix', () => {
    const result = applyCodexPresentationSettings({
      variables: { model: 'test-model', cwd: '/workspace' },
      sections: [
        { name: 'harness:identity', text: 'Harness' },
        { name: 'other', text: 'Other' },
        { name: 'deployment:persona-prefix', text: 'Default persona' },
        { name: 'deployment:persona-suffix', text: 'Keep this suffix' },
      ],
    } as never, { ...CODEX_SETTINGS_ENTRY, persona: 'Codex on {{model}}' })
    expect(result.sections.map(section => [section.name, section.text])).toEqual([
      ['deployment:persona-prefix', 'Codex on test-model'],
      ['other', 'Other'],
      ['deployment:persona-suffix', 'Keep this suffix'],
    ])
  })

  it('does not mount the host preset editor inside a native preset scope', () => {
    const injections: readonly string[][] = []
    const ctx = {
      fs: {}, get: (name: string) => name === 'tools' ? ctx.tools : name === 'shell' ? {} : undefined, on: () => () => {},
      inject: (deps: string[]) => (injections as string[][]).push(deps),
      systemPrompt: { section: () => () => {} },
      tools: { register: () => () => {} },
    }
    apply(ctx as never, { globalEnhancements: false })
    expect(injections).not.toContainEqual(['agentPresets'])
  })
})
