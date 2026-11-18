import { describe, expect, it } from 'vitest'
import { Context, Service } from '@deepseek-ai/cordis'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { ActivityLine, applyWithSettingsApi, FastModeFallback, resolveActivity } from '../../src/client/index.tsx'

describe('Codex client settings', () => {
  it('mounts only composer fast-mode and dock activity slots plus the protected Remote settings view', async () => {
    const ctx = new Context()
    const calls: string[] = []
    const dictionaries: Record<string, Record<string, string>> = {}
    const codexPresetEditor = {
      read: async () => { calls.push('codexPresetEditor/read'); return { ok: true as const, value: { id: 'codex', name: '', description: '', composition: '' } } },
    }
    class RemoteService extends Service {
      constructor(serviceCtx: Context) { super(serviceCtx, 'remote') }
      async $mount(): Promise<() => Promise<void>> { return async () => {} }
    }
    new RemoteService(ctx)
    ctx.provide('remote.codexPresetEditor', codexPresetEditor)
    ctx.provide('commandUi', { decorate: () => () => {} })
    ctx.provide('sessions', { binding: () => undefined })
    ctx.provide('locale', {
      register: (_ns: string, map: Record<string, Record<string, string>>) => { Object.assign(dictionaries, map) },
      bind: () => () => '',
    })
    const slots: string[] = []
    const registrations: Array<{ name?: string; id?: string; order?: number }> = []
    ctx.provide('slots', {
      inject: (key: string, callback: () => unknown) => { slots.push(key); return callback() },
      register: (options: { name?: string; id?: string; order?: number }) => {
        registrations.push(options)
        return () => {}
      },
    })

    let registeredManager: any
    applyWithSettingsApi(ctx, {
      bind: () => ({
        getSnapshot: () => ({ status: 'ready', writable: true }),
        subscribe: () => () => {},
        set: async () => {},
        unset: async () => {},
      }),
      register: (_host, _settings, manager) => {
        registeredManager = manager
        return () => {}
      },
    })
    for (let turn = 0; turn < 10; turn++) await Promise.resolve()

    expect(slots).toEqual(['conversation.input.right', 'conversation.input.dock'])
    expect(registrations).toEqual([
      expect.objectContaining({ name: 'conversation.input.right', id: 'codex-fast', order: 0 }),
      expect.objectContaining({ name: 'conversation.input.dock', id: 'codex-activity', order: -100 }),
    ])
    expect(registeredManager).toBeDefined()
    expect(await registeredManager.remote.codexPresetEditor.read('codex')).toMatchObject({ ok: true })
    expect(calls).toEqual(['codexPresetEditor/read'])
    expect(dictionaries.zh?.fastModeControl).not.toBe(dictionaries.en?.fastModeControl)
    expect(dictionaries.zh?.fastOn).not.toBe(dictionaries.en?.fastOn)
    expect(dictionaries.zh?.fastOff).not.toBe(dictionaries.en?.fastOff)
    await ctx.fiber.dispose()
  })

  it('prefers projection activity over snapshot fallback and never invents legacy states', () => {
    const fallback = { activity: 'requesting-model' as const, startedAt: 20 }
    expect(resolveActivity({ activity: 'compaction', startedAt: 10 }, fallback)).toEqual({ activity: 'compaction', startedAt: 10 })
    expect(resolveActivity(null, fallback)).toEqual(fallback)
    expect(resolveActivity(undefined, undefined)).toBeNull()
  })

  it('renders activity in the external dock without a viewport-positioned transcript overlay', () => {
    const props = {
      useSettings: (select: (value: unknown) => unknown) => select({ value: { activityIndicatorEnabled: true } }),
      useSession: (select: (value: unknown) => unknown) => select({ running: false }),
      useProjection: () => ({ activity: 'requesting-model', startedAt: Date.now() - 14_000 }),
      t: (key: string) => key,
    } as any
    const html = renderToStaticMarkup(createElement(ActivityLine, props))
    expect(html).toContain('data-codex-activity')
    expect(html).toContain('activityRequestingModel')
    expect(html).toContain('var(--dsh-composer-card-max-width, 952px)')
    expect(html).toContain('var(--dsh-composer-side-clearance, 16px)')
    expect(html).toContain('margin:0 auto')
    expect(html).toContain('padding:0 4px')
    expect(html).toContain('text-overflow:ellipsis')
    expect(html).toContain('font-variant-numeric:tabular-nums')
    expect(html).not.toMatch(/position:|left:|top:|z-index:/)
    expect(renderToStaticMarkup(createElement(ActivityLine, { ...props, useProjection: () => null }))).toBe('')
    expect(renderToStaticMarkup(createElement(ActivityLine, {
      ...props,
      useSettings: (select: (value: unknown) => unknown) => select({ value: { activityIndicatorEnabled: false } }),
    }))).toBe('')
  })

  it('shows FastModeFallback only for non-Codex-Connect GPT routes or legacy hosts without modelDirectories', () => {
    const baseProps = {
      useSettings: (select: (value: unknown) => unknown) => select({ writable: true, value: { fastModeControlEnabled: true, fast: false } }),
      setSetting: async () => {},
      t: (key: string) => key,
    } as any
    const storeFor = (snapshot: unknown) => ({ subscribe: () => () => {}, getSnapshot: () => snapshot })

    expect(renderToStaticMarkup(createElement(FastModeFallback, baseProps))).toContain('fast')
    expect(renderToStaticMarkup(createElement(FastModeFallback, {
      ...baseProps,
      modelDirectory: storeFor({ status: 'ready', current: { provider: 'relay', model: 'gpt-5.4' } }),
    }))).toContain('fast')
    expect(renderToStaticMarkup(createElement(FastModeFallback, {
      ...baseProps,
      modelDirectory: storeFor({ status: 'ready', current: { provider: 'openai-codex', model: 'gpt-6.1-sol' } }),
    }))).toBe('')
    expect(renderToStaticMarkup(createElement(FastModeFallback, {
      ...baseProps,
      modelDirectory: storeFor({ status: 'ready', current: { provider: 'deepseek', model: 'deepseek-chat' } }),
    }))).toBe('')
    expect(renderToStaticMarkup(createElement(FastModeFallback, {
      ...baseProps,
      modelDirectory: storeFor({ status: 'loading' }),
    }))).toBe('')
  })

  it('dispatches /compact synchronously and detached so popupSelect closes immediately', async () => {
    const ctx = new Context()
    let decoration: any
    const notifications: Array<{ level: string; text: string }> = []
    let resolveCommand: ((value: any) => void) | undefined
    let nextResult: Promise<any> = new Promise(resolve => { resolveCommand = resolve })
    const commands: string[] = []
    const sessionScope = {
      get: (name: string) => name === 'conversation'
        ? { input: { for: (actx: unknown) => actx === sessionScope ? { notify: (level: string, text: string) => { notifications.push({ level, text }) } } : {} } }
        : undefined,
    }

    ctx.provide('commandUi', { decorate: (entry: any) => { decoration = entry; return () => {} } })
    ctx.provide('sessions', {
      binding: (id: string) => id === 'sess-1' ? {
        session: {
          command: (line: string) => {
            commands.push(line)
            return nextResult
          },
        },
      } : undefined,
      scope: (id: string) => id === 'sess-1' ? sessionScope : undefined,
    })
    ctx.provide('locale', { register: () => () => {}, bind: () => (k: string) => k })
    ctx.provide('slots', { inject: () => () => {}, register: () => () => {} })

    applyWithSettingsApi(ctx, {
      bind: () => ({
        getSnapshot: () => ({ status: 'ready', writable: true }),
        subscribe: () => () => {},
        set: async () => {},
        unset: async () => {},
      }),
      register: () => () => {},
    })

    // onSelect must return synchronously (void) so popupSelect closes at 0ms even while live.command is pending.
    expect(decoration.ui.onSelect({ id: 'remote', label: 'Remote' }, { sessionId: 'sess-1' })).toBeUndefined()
    expect(commands).toEqual(['/compact remote'])
    expect(notifications).toEqual([])

    resolveCommand?.({ ok: true, value: { matched: false } })
    await Promise.resolve()
    await Promise.resolve()
    expect(notifications).toEqual([{ level: 'error', text: 'the host offers no /compact command' }])

    nextResult = Promise.resolve({ ok: false, error: { code: 'ERR', message: 'busy' } })
    expect(decoration.ui.onSelect({ id: 'local', label: 'Local' }, { sessionId: 'sess-1' })).toBeUndefined()
    await Promise.resolve()
    await Promise.resolve()
    expect(commands).toEqual(['/compact remote', '/compact local'])
    expect(notifications.at(-1)).toEqual({ level: 'error', text: 'compact failed: ERR: busy' })

    await ctx.fiber.dispose()
  })
})
