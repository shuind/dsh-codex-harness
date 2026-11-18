import { existsSync, readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { runInNewContext } from 'node:vm'
import { describe, expect, it, vi } from 'vitest'
import * as cordis from '@deepseek-ai/cordis'
import Schema from '@deepseek-ai/schemastery'
import { renderToStaticMarkup } from 'react-dom/server'
import { apply, inject } from '../../src/entries/client.tsx'
import { apply as applyConfigForms, adaptConfigForm, CodexSettingsTab, DesktopSettingsCard, saveDesktopSettings } from '../../src/client/desktop.tsx'
import { SlotCore } from '@deepseek-ai/dsh-client-ui-slots'
import { saveToolPolicy, TOOL_POLICY_NAMESPACE } from '../../src/client/tool-policy.tsx'
import { requestPresetCatalog, requestPresetPrompts, requestPresetTools } from '../../src/client/preset-requests.ts'

const currentRuntime = resolve('node_modules/@deepseek-ai')
const bundleFixtures = [
  { name: 'current Client 0.2.2-rc.1 bundles', runtime: currentRuntime, policyServed: true },
  { name: 'current Client 0.2.2-rc.1 bundles without policy namespace', runtime: currentRuntime, policyServed: false },
]

describe('desktop client contracts', () => {
  it('activates only on ConfigForms without legacy settingsScope dependencies', () => {
    expect(inject).not.toContain('settingsScope')
    expect(inject).not.toContain('configForms')
    expect(inject).not.toContain('remote.agentPresets')
    expect(inject).not.toContain('remote.settings')
    const children: string[][] = []
    apply({ inject: (deps: string[]) => children.push(deps) } as never)
    expect(children).toEqual([['configForms']])
  })

  it('reports rejected ConfigForms writes and skips empty batch mutations', async () => {
    const form = { getSnapshot: vi.fn(), subscribe: vi.fn(), set: vi.fn(async () => false), unset: vi.fn(async () => true) }
    const adapted = adaptConfigForm(form)
    await expect(adapted.set('fast', true)).rejects.toThrow('did not accept')
    await expect(adapted.unset('contextWindow')).resolves.toBeUndefined()
    const mutate = vi.fn(async () => true)
    await saveDesktopSettings({ mutate }, {}, 7)
    expect(mutate).not.toHaveBeenCalled()
  })

  it.each([true, null])('mounts the independent tab and the bundle page (%s)', async bundlePage => {
    const ctx = new cordis.Context()
    const core = new SlotCore()
    core.register({ name: 'root', children: {
      'settings.plugins.tab': { kind: 'list', scope: 'root' },
      ...(bundlePage ? { 'plugins.bundle.config': { kind: 'keyed' as const, scope: 'root' as const } } : {}),
      'conversation.input.right': { kind: 'list', scope: 'session' },
      'conversation.input.dock': { kind: 'list', scope: 'session' },
    } } as never, (() => null) as never)
    const registrations: any[] = []
    class Remote extends cordis.Service {
      constructor() { super(ctx, 'remote') }
      async $mount() { return async () => {} }
    }
    new Remote()
    ctx.provide('remote.codexPresetEditor', {})
    ctx.provide('slots', {
      spec: (key: any) => core.spec(key),
      inject: (key: string, register: () => () => void) => core.spec(key as never) === undefined ? () => {} : register(),
      register: (options: any, component: any) => {
        registrations.push(options)
        return core.register(options, component)
      },
    })
    ctx.provide('commandUi', { decorate: () => () => {} })
    ctx.provide('sessions', { binding: () => undefined })
    ctx.provide('locale', { register: () => () => {}, bind: () => (key: string) => key })
    const mutate = vi.fn(async () => true)
    const form = { getSnapshot: () => ({ status: 'ready', writable: true, revision: 12, value: {} }),
      subscribe: () => () => {}, set: async () => true, unset: async () => true, mutate }
    const withdraw = vi.fn()
    ctx.provide('configForms', {
      get: (id: string) => { expect(id).toBe('codex'); return form },
      whileServed: (namespaces: string[], register: () => () => void) => {
        if (namespaces.includes('codex-tool-policy')) return () => {}
        expect(namespaces).toEqual(['codex'])
        const off = register()
        return () => { withdraw(); off() }
      },
    })
    try {
      const fiber = ctx.plugin({ inject: [...inject, 'configForms'], apply: applyConfigForms })
      await fiber.await()
      // The settings contribution waits for its self-mounted Remote child.
      for (let turn = 0; turn < 15; turn++) await Promise.resolve()
      const tab = registrations.find(options => options.name === 'settings.plugins.tab')
      expect(tab).toMatchObject({ id: 'codex-harness', order: 30, locale: 'codex' })
      expect(tab.label()).toBe('settingsTabLabel')
      const page = registrations.find(options => options.name === 'plugins.bundle.config')
      if (bundlePage === null) expect(page).toBeUndefined()
      else {
        expect(page).toMatchObject({ key: '@shuind/dsh-codex-harness', locale: 'codex' })
        expect(tab.inject).toBe(page.inject)
        expect(tab.inject().hooks.settings).toBe(page.inject().hooks.settings)
        expect(tab.inject().toolPolicy).toBe(page.inject().toolPolicy)
      }
      await tab.inject().saveSettings({ persona: 'Staged' }, 12)
      expect(mutate).toHaveBeenLastCalledWith([{ op: 'set', path: ['persona'], value: 'Staged' }], 12)
      await fiber.dispose()
      expect(withdraw).toHaveBeenCalledOnce()
      expect(core.entries('settings.plugins.tab')).toHaveLength(0)
      if (bundlePage !== null) expect(core.entries('plugins.bundle.config')).toHaveLength(0)
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('makes the bundle summary-only and separates runtime preferences from tool plans', () => {
    const props = {
      useSettings: (select: (state: unknown) => unknown) => select({ status: 'ready', value: {}, writable: true }),
      t: (key: string) => key, setSetting: async () => {}, unsetSetting: async () => {},
      presetManager: { ready: Promise.resolve(), remote: { codexPresetEditor: {} } },
    } as any
    const summary = renderToStaticMarkup(<DesktopSettingsCard {...props} view="summary" />)
    expect(summary).toContain('settingsBundlePath')
    const bundle = renderToStaticMarkup(<DesktopSettingsCard {...props} view="page" />)
    expect(bundle).toBe(summary); expect(bundle).not.toContain('<form')
    const page = renderToStaticMarkup(<CodexSettingsTab {...props} initialPage="runtime" />)
    for (const label of ['contextWindowControl', 'fastModeControl', 'settingsRuntimeScope', 'settingsPreferHostedSearch', 'settingsPreferRemoteCompaction']) expect(page).toContain(label)
    expect(page).not.toContain('contextSize')
    expect(page).not.toContain('type="number"')
    for (const label of ['capabilityTerminal', 'capabilityPlan', 'capabilityPatch', 'capabilityPrompt', 'personaLabel', 'toolPolicyPresetChoice', 'toolPolicyAdvanced']) expect(page).not.toContain(label)
    expect(page.match(/role="switch"/g)).toHaveLength(6)
    expect(page).not.toContain('role="tab"')
  })
})

// Run the installed current SDK's actual controllers; only transport and renderer adapters are test doubles.
for (const { name, runtime, policyServed } of bundleFixtures) {
  const settingsBundle = resolve(runtime, 'dsh-client-ui-settings/lib/client.js')
  describe(name, () => {
  it('activates the universal entry against real ConfigForms and SlotCore, writes and disposes the Remote', async () => {
    const nativeImport = (url: string) => import(/* @vite-ignore */ url)
    // The read-only app extraction omits third-party packages. Supply those
    // dependencies from the test install, while executing its actual store.
    const require = createRequire(import.meta.url)
    const dependency = (name: string, subpath = '') => require(subpath === '' ? name : `${name}/${subpath}`)
    const storeSource = readFileSync(resolve(runtime, 'dsh-client-store/lib/index.js'), 'utf8')
      .replace(/^import .*;$/gm, '').replace(/^export \{.*\};$/m, '')
      .replaceAll('import.meta.env.MODE', '"production"')
    const store = runInNewContext(`${storeSource}\n;({ createSnapshotStore })`, {
      ...dependency('zustand', 'vanilla'), ...dependency('zustand', 'middleware'),
      ...dependency('zustand', 'shallow'), ...dependency('immer'), console, queueMicrotask,
    })
    const { SlotCore } = await nativeImport(pathToFileURL(resolve(runtime, 'dsh-client-ui-slots/lib/index.js')).href)
    let settingsPlugin: any
    runInNewContext(readFileSync(settingsBundle, 'utf8'), {
      window: { __ModuleLoader__: { load: ({ factory }: any) => {
        settingsPlugin = factory((id: string) => {
          if (id === '@deepseek-ai/cordis') return cordis
          if (id === '@deepseek-ai/dsh-client-store') return store
          throw new Error(`Unexpected desktop bundle dependency: ${id}`)
        })
      } } }, structuredClone, console,
    })
    const ctx = new cordis.Context()
    const core = new SlotCore()
    core.register({ name: 'root', children: {
      'settings.plugins.tab': { kind: 'list', scope: 'root' },
      'plugins.bundle.config': { kind: 'keyed', scope: 'root' },
      'conversation.input.right': { kind: 'list', scope: 'session' },
      'conversation.input.dock': { kind: 'list', scope: 'session' },
    } }, () => null)
    core.register({ name: 'settings.plugins.tab', id: 'all', order: 10 }, () => null)
    core.register({ name: 'settings.plugins.tab', id: 'connect', order: 40 }, () => null)
    const entries: any[] = []
    ctx.provide('slots', {
      spec: (key: any) => core.spec(key),
      inject: (_name: string, register: () => unknown) => register(),
      register: (options: any, component: any) => {
        const off = core.register(options, component)
        entries.push({ options, component })
        return off
      },
    })
    ctx.provide('commandUi', { decorate: () => () => {} })
    ctx.provide('sessions', { binding: () => undefined })
    ctx.provide('locale', { register: () => () => {}, bind: () => (key: string) => key })
    let row = { ns: 'codex', revision: 1, value: { fast: false } as Record<string, unknown>, base: {}, user: {},
      schema: { type: 'object', dict: { fast: { type: 'boolean' } } } }
    let policyRow = { ns: TOOL_POLICY_NAMESPACE, revision: 11, applies: 'live', autoGenerate: false, secrets: [],
      value: { rules: [] } as Record<string, unknown>, base: { rules: [] }, user: {},
      schema: Schema.object({ rules: Schema.array(Schema.object({
        preset: Schema.string().required(), allow: Schema.union([Schema.array(Schema.string())]), deny: Schema.union([Schema.array(Schema.string())]),
        replaceShell: Schema.boolean().default(true), replacePlan: Schema.boolean().default(true),
        tools: Schema.union([Schema.array(Schema.object({ name: Schema.string(), action: Schema.string() }))]),
        promptOverrides: Schema.union([Schema.array(Schema.object({ name: Schema.string(), text: Schema.string() }))]),
      })).default([]) }).toJSON() }
    const mutate = vi.fn(async (namespace, ops, expectedRevision) => {
      const previous = namespace === TOOL_POLICY_NAMESPACE ? policyRow : row
      if (expectedRevision !== previous.revision) return { ok: false, error: { message: 'settings conflict' } }
      const value: Record<string, unknown> = { ...previous.value }
      for (const op of ops) {
        if (op.op === 'unset') delete value[op.path[0]]
        else value[op.path[0]] = op.value
      }
      if (namespace === TOOL_POLICY_NAMESPACE) {
        policyRow = { ...policyRow, revision: policyRow.revision + 1, value }
        return { ok: true, value: policyRow }
      }
      row = { ...row, revision: row.revision + 1, value }
      return { ok: true, value: row }
    })
    const unmount = vi.fn(async () => {})
    const catalog = vi.fn(async () => ({ ok: true, value: { presets: [
      { id: 'sdk-preset-id', name: 'Readable SDK preset', description: '', isDefault: false },
    ], excludedCount: 0 } }))
    let gatewayPlugin: any
    runInNewContext(readFileSync(resolve(runtime, 'dsh-api-gateway/lib/client.browser.js'), 'utf8'), {
      window: { __ModuleLoader__: { load: ({ factory }: any) => { gatewayPlugin = factory(() => cordis) } } },
      console, crypto: globalThis.crypto, AbortController, AbortSignal, setTimeout, clearTimeout,
    })
    ctx.provide('typert', { remotes: { register: (contribution: any) => {
      expect(contribution.descriptors.map((d: any) => d.method)).toEqual(['catalog', 'tools', 'prompts', 'read'])
      return unmount
    } } })
    ctx.provide('connection', {
      isLoopback: true, interactions: 'answer', generation: { getSnapshot: () => undefined },
      registerGenerationSource: () => () => {}, start: () => ({ stop: () => {} }),
      rpc: { open: () => {}, call: (_base: string, endpoint: string, body: any) => {
        if (endpoint === 'codexPresetEditor/catalog') return catalog()
        if (endpoint === 'codexPresetEditor/prompts') {
          expect(body.args.id).toBe('sdk-preset-id')
          return { ok: true, value: { preset: body.args.id, sections: [{ name: 'deployment:persona-prefix', label: 'Native Persona', text: 'SDK native persona', editable: true, order: -10, complete: true, interpolate: true }] } }
        }
        expect(endpoint).toBe('codexPresetEditor/tools')
        expect(body.args.id).toBe('sdk-preset-id')
        return { ok: true, value: { preset: body.args.id, registeredOnly: true, tools: [
          { name: 'read', description: 'Read file', conditional: false, replacements: [] },
          { name: 'pwsh', description: 'Execute PowerShell', conditional: false,
            replacements: [{ action: 'codex-exec', tools: ['exec_command', 'write_stdin'], available: true }] },
        ] } }
      } }, 
    })
    await ctx.plugin(gatewayPlugin).await()
    let servesSettings = true
    ctx.provide('remote.settings', { describe: async () => ({ ok: true, value: { writable: true,
      namespaces: servesSettings ? [row, ...(policyServed ? [policyRow] : [])] : [] } }), mutate })
    try {
      await ctx.plugin(settingsPlugin).await()
      await (ctx as any).configForms.describe().ensure()
      await ctx.plugin({ inject, apply }).await()
      for (let turn = 0; turn < 30 && !entries.some(entry => entry.options.name === 'plugins.bundle.config'); turn++) await Promise.resolve()
      const card = entries.find(entry => entry.options.name === 'plugins.bundle.config')
      expect(card).toBeDefined()
      expect(card.options).toMatchObject({ key: '@shuind/dsh-codex-harness', locale: 'codex' })
      expect(entries.filter(entry => entry.options.name === 'conversation.input.right')).toHaveLength(1)
      expect(entries.find(entry => entry.options.id === 'codex-activity')?.options).toMatchObject({ name: 'conversation.input.dock', order: -100 })
      const tab = entries.find(entry => entry.options.name === 'settings.plugins.tab')
      expect(tab.options).toMatchObject({ id: 'codex-harness', order: 30, locale: 'codex' })
      expect(core.entries('settings.plugins.tab').map((entry: any) => entry.options.id)).toEqual(['all', 'codex-harness', 'connect'])
      expect(tab.component).toBe(CodexSettingsTab)
      expect(tab.options.inject).toBe(card.options.inject)
      const face = card.options.inject()
      const tabFace = tab.options.inject()
      expect(tabFace.hooks.settings).toBe(face.hooks.settings)
      expect(tabFace.toolPolicy).toBe(face.toolPolicy)
      expect(tabFace.presetManager).toBe(face.presetManager)
      await face.presetManager.ready
      expect(await face.presetManager.remote.codexPresetEditor.catalog()).toMatchObject({ ok: true })
      expect(face.hooks.settings.getSnapshot()).toMatchObject({ status: 'ready', writable: true, value: { fast: false } })
      const policyForm = face.toolPolicy.getSnapshot()
      if (policyServed) {
        const tabPolicyForm = tabFace.toolPolicy.getSnapshot()
        expect(tabPolicyForm).toBe(policyForm)
        expect(policyForm.getSnapshot()).toMatchObject({ status: 'ready', revision: 11, value: { rules: [] } })
        const actualCatalog = await requestPresetCatalog(face.presetManager)
        expect(actualCatalog.presets[0]?.id).toBe('sdk-preset-id')
        const actualTools = await requestPresetTools(face.presetManager, actualCatalog.presets[0]!.id)
        expect(actualTools.preset).toBe('sdk-preset-id')
        expect(actualTools.tools.map(tool => tool.name)).toEqual(['read', 'pwsh'])
        const actualPrompts = await requestPresetPrompts(face.presetManager, actualCatalog.presets[0]!.id)
        expect(actualPrompts.preset).toBe('sdk-preset-id')
        expect(actualPrompts.sections[0]?.text).toBe('SDK native persona')
        const policy = [{ preset: actualCatalog.presets[0]!.id, allow: [], replaceShell: false, replacePlan: false,
          tools: [{ name: 'read', action: 'keep' as const }, { name: 'pwsh', action: 'codex-exec' as const }],
          promptOverrides: [{ name: 'deployment:persona-prefix' as const, text: '' }] }]
        await expect(saveToolPolicy(tabPolicyForm, policy, 11)).resolves.toBe(true)
        expect(mutate).toHaveBeenLastCalledWith(TOOL_POLICY_NAMESPACE, [{ op: 'set', path: ['rules'], value: policy }], 11)
        expect(policyForm.getSnapshot().value.rules).toEqual(policy)
        await expect(saveToolPolicy(policyForm, [], 11)).resolves.toBe(false)
        expect(policyForm.getSnapshot().value.rules).toEqual(policy)
        const bundle = renderToStaticMarkup(<DesktopSettingsCard {...face}
          useSettings={(select: (state: unknown) => unknown) => select(face.hooks.settings.getSnapshot())} t={(key: string) => key} view="page" />)
        expect(bundle).toContain('settingsBundlePath'); expect(bundle).not.toContain('<form')
        const page = renderToStaticMarkup(<CodexSettingsTab {...face}
          useSettings={(select: (state: unknown) => unknown) => select(face.hooks.settings.getSnapshot())} t={(key: string) => key} />)
        expect(page).toContain('toolPolicyTitle')
        expect(page).not.toContain('toolPolicyEmptyAllow')
        expect(page).not.toContain('toolPolicyAdvanced')
        expect(page).toContain('data-tool-name="read"')
        expect(page).toContain('exec_command + write_stdin')
        expect(page).not.toContain('toolPolicyEnable')
        expect(page).toContain('Readable SDK preset')
        expect(page).toContain('data-preset-id="sdk-preset-id"')
        expect(page).not.toContain('pmGlobalSettings')
        expect(page).toContain('data-tool-group="command"')
        expect(page).toContain('toolLabelRead')
        expect(page).not.toContain('settingsRuntimeScope')
        expect(page).not.toContain('presetSourcesDetails')
        expect(page).not.toContain('codex-preset-editor')
        const tabPage = renderToStaticMarkup(<CodexSettingsTab {...tabFace}
          useSettings={(select: (state: unknown) => unknown) => select(tabFace.hooks.settings.getSnapshot())} t={(key: string) => key} />)
        expect(tabPage).toBe(page)
        expect(face.hooks.settings.getSnapshot().value).not.toHaveProperty('rules')
      } else {
        expect(policyForm).toBeUndefined()
      }
      await face.setSetting('fast', true)
      expect(mutate).toHaveBeenCalledWith('codex', [{ op: 'set', path: ['fast'], value: true }], 1)
      expect(face.hooks.settings.getSnapshot().value.fast).toBe(true)
      const revision = face.hooks.settings.getSnapshot().revision
      await face.saveSettings({ contextWindow: 64000, activityIndicatorEnabled: undefined }, revision)
      expect(mutate).toHaveBeenLastCalledWith('codex', [
        { op: 'set', path: ['contextWindow'], value: 64000 }, { op: 'unset', path: ['activityIndicatorEnabled'] },
      ], 2)
      // A fixed old fence must be refused even after the mirror advances.
      await expect(face.saveSettings({ contextWindow: 32000 }, revision)).rejects.toThrow('did not accept')
      expect(row.value.contextWindow).toBe(64000)
      expect(face.hooks.settings.getSnapshot().revision).toBe(3)
      servesSettings = false
      ctx.emit('connection/reset')
      for (let turn = 0; turn < 50; turn++) await Promise.resolve()
      expect(core.entries('settings.plugins.tab').map((entry: any) => entry.options.id)).toEqual(['all', 'connect'])
      expect(core.entries('plugins.bundle.config')).toHaveLength(0)
      servesSettings = true
      ctx.emit('connection/reset')
      for (let turn = 0; turn < 50; turn++) await Promise.resolve()
      expect(core.entries('settings.plugins.tab').map((entry: any) => entry.options.id)).toEqual(['all', 'codex-harness', 'connect'])
      expect(core.entries('plugins.bundle.config')).toHaveLength(1)
    } finally {
      await ctx.fiber.dispose()
    }
    expect(unmount).toHaveBeenCalledOnce()
    expect(core.entries('settings.plugins.tab').map((entry: any) => entry.options.id)).toEqual(['all', 'connect'])
  })
  })
}

