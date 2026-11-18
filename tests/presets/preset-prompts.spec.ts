import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import Loader, { EntryTree } from '@deepseek-ai/cordis-plugin-loader'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import type { Agent } from '@deepseek-ai/dsh-agent'
import AgentPresetRegistry from '@deepseek-ai/dsh-agent-preset-registry'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import SessionProjections from '@deepseek-ai/dsh-session-projection'
import SystemPrompt, { renderPrompt } from '@deepseek-ai/dsh-system-prompt'
import Tools, { defineTool } from '@deepseek-ai/dsh-tools'
import * as NativeExecutor from '@deepseek-ai/dsh-tool-executor-native'
import { createScope } from '@deepseek-ai/dsh-scope'
import Core from '../../src/entries/index.ts'
import ToolPolicy, { Config, apply as applyPolicy } from '../../src/entries/tool-policy.ts'
import type { Config as PolicyConfig } from '../../src/entries/tool-policy.ts'
import { CODEX_SETTINGS_ENTRY } from '../../src/contracts/settings.ts'
import { readPresetPromptCatalog, probePresetPrompts, probePresetPromptsCached } from '../../src/presets/preset-prompt-catalog.ts'
import { presetPromptCatalogSchema } from '../../src/contracts/preset-editor-schema.ts'
import { CodexPresetEditor } from '../../src/presets/preset-editor.ts'
import { TYPERT } from '../../src/entries/typert.host.ts'
import remote from '../../src/contracts/preset-editor-schema.ts'

const contexts: Context[] = []
afterEach(async () => {
  for (const ctx of contexts.splice(0).reverse()) await ctx.fiber.dispose()
  vi.restoreAllMocks()
})
class FixtureLoader extends Loader {
  override import(name: string, stack?: () => string[]) {
    return name === '@shuind/dsh-codex-harness' ? Core : super.import(name, stack)
  }
}
const PREFIX = 'deployment:persona-prefix' as const
const SUFFIX = 'deployment:persona-suffix' as const
function rule(preset: string, text: string) {
  return { preset, replaceShell: false, replacePlan: false, promptOverrides: [{ name: PREFIX, text }] }
}
async function fixture() {
  // Preset revisions have their own EntryTree; route only this package to the
  // current source plugin rather than an older built package in the workspace.
  const originalImport = EntryTree.prototype.import
  vi.spyOn(EntryTree.prototype, 'import').mockImplementation(function(name, stack) {
    return name === '@shuind/dsh-codex-harness' ? Core : originalImport.call(this, name, stack)
  })
  const ctx = new Context()
  contexts.push(ctx)
  await ctx.plugin(FixtureLoader, { baseUrl: import.meta.url })
  await ctx.plugin(SessionStore)
  await ctx.plugin(SessionProjections)
  await ctx.plugin(AgentRegistry)
  await ctx.plugin(SystemPrompt, {})
  await ctx.plugin(Tools)
  await ctx.plugin(NativeExecutor)
  await ctx.plugin(AgentPresetRegistry, { default: 'a' })
  const shared = { ...CODEX_SETTINGS_ENTRY, persona: 'Shared custom Persona' }
  const updates = vi.fn()
  ctx.provide('codexPreferences', { current: () => shared } as never)
  ctx.provide('settings', { describe: () => [{ ns: 'codex', value: shared }], update: updates } as never)
  ctx.provide('fs', { sandboxMode: undefined } as never)
  ctx.provide('shell', { resolve: (input: unknown) => input, execute: vi.fn() } as never)
  ctx.provide('llm', { stream: vi.fn() } as never)
  ctx.provide('credentials', {} as never)
  const counter = { calls: 0 }
  ctx.provide('promptTestCounter', counter)
  const readBody = vi.fn(async () => 'read')
  const read = defineTool({ name: 'read', description: 'read', parameters: {},
    output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value }] },
    execute: readBody,
  })
  ctx.tools.register(read)
  ctx.systemPrompt.context({ name: 'required:runtime', order: 1, required: true, text: 'Required host facts.' })
  ctx.systemPrompt.context({ name: 'optional:runtime', order: 2, text: 'Optional host facts.' })
  ctx.systemPrompt.variable('model', () => 'fixture-model')
  ctx.systemPrompt.section({ name: 'host:policy', order: 500, text: 'Do not replace host policy.' })
  ctx.loader.builtins['unknown-prompt'] = { inject: ['systemPrompt'], apply(scope: Context, config: { text: string; complete?: boolean }) {
    scope.systemPrompt.section({ name: 'unknown:instructions', order: 20, text: config.text, complete: config.complete === true })
  } }
  const registry = ctx.agentPresets
  async function register(id: string, prefix: string | { __jsExpr: string }, options: { complete?: boolean; suffix?: string; core?: boolean; localPersona?: string; unknownComplete?: boolean } = {}) {
    return registry.register({ id, plugins: [
      { name: '@deepseek-ai/dsh-persona', config: { prefix, suffix: options.suffix ?? '', complete: options.complete ?? false } },
      ...(options.core ? [{ name: '@shuind/dsh-codex-harness', config: { globalEnhancements: false,
        presetPrompt: 'Original Codex operating instructions.' } }] : []),
      ...(options.unknownComplete ? [{ name: 'cordis:unknown-prompt', config: { text: 'Unknown complete instructions.', complete: true } }] : []),
    ] })
  }
  await register('a', 'Original A {{model}}', { suffix: 'Original A suffix.' })
  await register('b', 'Original B')
  await register('complete', 'Complete original.', { complete: true })
  // Loader evaluates this once while mounting the standing fixture, never in RPC/probes.
  await register('codex', { __jsExpr: "(get('promptTestCounter').calls++, 'Resolved Codex native Persona')" }, { core: true })
  await ctx.plugin(CodexPresetEditor)
  let next = 0
  async function prepare(id: string) {
    const session = ctx.sessions.create(SessionId(`prompt-${++next}`), { meta: { agentPreset: id } })
    const agent = { id: session.id, session, status: 'idle', options: { provider: 'fixture', model: 'fixture' } } as Agent
    const scope = createScope(ctx, agent)
    Object.assign(agent, { ctx: scope.ctx })
    await registry.mount(scope.ctx, id)
    return { agent, scope,
      publish: async () => { await scope.ctx.get('agents')!.register(agent) },
      select: (target: string) => registry.select(agent, target),
    }
  }
  const assemble = (agent: Agent) => ctx.systemPrompt.assemble({ scope: agent, agent })
  const prefix = async (agent: Agent) => (await assemble(agent)).sections.find(section => section.name === PREFIX)?.text
  async function mount(config: PolicyConfig) {
    ctx.loader.builtins['prompt-policy'] = ToolPolicy
    const id = await ctx.loader.create({ name: 'cordis:prompt-policy', config })
    await ctx.loader.await()
    const fiber = ctx.loader.resolve(id).fiber!
    await fiber.await()
    return { fiber, update: (next: PolicyConfig) => ctx.loader.update(id, { config: next }) }
  }
  return { ctx, registry, shared, updates, counter, register, prepare, assemble, prefix, mount, read, readBody }
}

describe('actual selected-preset prompt catalog', () => {
  it('reads real Persona and Codex sections, not a global Codex template for every preset', async () => {
    const h = await fixture()
    const created = vi.fn()
    h.ctx.on('agent/created', created)
    const before = (await h.registry.readDocument('a')).content
    const a = await h.ctx.get('codexPresetEditor')!.prompts('a')
    expect(a.sections.find(section => section.name === PREFIX)).toMatchObject({ text: 'Original A {{model}}', editable: true, complete: false, interpolate: true })
    expect(a.sections.find(section => section.name === SUFFIX)).toMatchObject({ text: 'Original A suffix.', editable: true })
    expect(a.sections.some(section => section.name === 'codex:base')).toBe(false)
    expect(a.sections.find(section => section.name === 'host:policy')).toMatchObject({ editable: false })
    const codex = await readPresetPromptCatalog(h.ctx, 'codex')
    expect(codex.sections.find(section => section.name === PREFIX)?.reason).toBeUndefined()
    expect(codex.sections.find(section => section.name === PREFIX)).toMatchObject({ editable: true, text: 'Shared custom Persona' })
    expect(codex.sections.find(section => section.name === 'codex:base')).toMatchObject({ editable: true, text: 'Original Codex operating instructions.' })
    expect(h.counter.calls).toBe(1)
    expect(created).not.toHaveBeenCalled()
    expect(h.ctx.agents.list()).toEqual([])
    expect(h.ctx.get('llm')!.stream).not.toHaveBeenCalled()
    expect(h.readBody).not.toHaveBeenCalled()
    expect(h.updates).not.toHaveBeenCalled()
    expect((await h.registry.readDocument('a')).content).toBe(before)
    expect(presetPromptCatalogSchema.parse(codex)).toEqual(codex)
  })

  it('reports unknown complete/static contracts as read-only and releases failed probes', async () => {
    const h = await fixture()
    await h.register('unknown', 'Native prefix.', { unknownComplete: true })
    const catalog = await readPresetPromptCatalog(h.ctx, 'unknown')
    expect(catalog.sections.find(section => section.name === 'unknown:instructions')).toMatchObject({ text: 'Unknown complete instructions.', editable: false })
    expect(catalog.sections.find(section => section.name === PREFIX)).toMatchObject({ editable: false, reason: 'not-effective-or-complete-suppressed' })
    const acquired = h.registry.acquireScope.bind(h.registry)
    const released = vi.fn()
    vi.spyOn(h.registry, 'acquireScope').mockImplementation(async id => {
      const lease = await acquired(id)
      return { key: lease.key, [Symbol.asyncDispose]: async () => { released(); await lease[Symbol.asyncDispose]() } }
    })
    const assembly = vi.spyOn(h.ctx.systemPrompt, 'assemble').mockRejectedValueOnce(new Error('dynamic section needs a live Agent'))
    const failed = await readPresetPromptCatalog(h.ctx, 'a')
    expect(failed.sections.every(section => !section.editable)).toBe(true)
    expect(failed.sections.some(section => section.reason === 'assembly-unavailable')).toBe(true)
    expect(released).toHaveBeenCalledOnce()
    assembly.mockRestore()
  })

  it('keeps current and legacy strict RPC codecs identical, with an exact prompts endpoint', () => {
    const host = TYPERT.invocations.find(row => row.method === 'prompts')!
    const client = remote.descriptors.find(row => row.method === 'prompts')!
    expect(host.id).toBe(client.id)
    expect(host.parameters.map(parameter => parameter.name)).toEqual(['id'])
    expect(host.parameters[0]!.codec.create().safeParse('').success).toBe(false)
    const sample = { preset: 'a', sections: [{ name: PREFIX, label: 'Persona', text: 'A', editable: true, order: 0, complete: true, interpolate: true }] }
    expect(host.result.create().parse(sample)).toEqual(client.result.create().parse(sample))
  })
})

describe('per-Agent current-preset prompt shadows', () => {
  it('isolates A/B, old snapshots, blank switches and restores exact originals on either owner disposal', async () => {
    const h = await fixture()
    const source = (await h.registry.readDocument('a')).content
    const old = await h.prepare('a'); await old.publish()
    const original = await h.assemble(old.agent)
    const sharedBefore = JSON.stringify(h.shared)
    const policy = await h.mount({ rules: [rule('a', 'A override {{model}}')] })
    const a = await h.prepare('a'); const b = await h.prepare('b')
    await a.publish(); await b.publish()
    const bBefore = await h.assemble(b.agent)
    expect(await h.prefix(a.agent)).toBe('A override {{model}}')
    expect(await h.prefix(old.agent)).toBe('Original A {{model}}')
    expect(await h.prefix(b.agent)).toBe('Original B')
    const changed = await h.assemble(a.agent)
    expect(changed.contexts).toEqual(original.contexts)
    expect(changed.tools).toEqual(original.tools)
    expect(changed.variables).toEqual(original.variables)
    expect(changed.sections.filter(section => section.name !== PREFIX)).toEqual(original.sections.filter(section => section.name !== PREFIX))
    await policy.update({ rules: [rule('a', 'Second A')] })
    const second = await h.prepare('a'); await second.publish()
    expect(await h.prefix(second.agent)).toBe('Second A')
    expect(await h.prefix(a.agent)).toBe('A override {{model}}')
    await a.select('b')
    expect(await h.assemble(a.agent)).toEqual(bBefore)
    await a.select('a')
    expect(await h.prefix(a.agent)).toBe('A override {{model}}')
    expect(await h.assemble(b.agent)).toEqual(bBefore)
    expect((await h.registry.readDocument('a')).content).toBe(source)
    expect(JSON.stringify(h.shared)).toBe(sharedBefore)
    await second.scope.dispose()
    expect(h.ctx.tools.get('read', second.agent)).toBe(h.read)
    await policy.fiber.dispose()
    expect(await h.assemble(a.agent)).toEqual(original)
    expect(h.updates).not.toHaveBeenCalled()
  })

  it('preserves native Persona complete, placement and interpolation rather than appending a second prompt', async () => {
    const h = await fixture()
    const original = await h.prepare('complete'); await original.publish()
    const before = await h.assemble(original.agent)
    await h.mount({ rules: [rule('complete', 'Complete replacement {{model}}')] })
    const changed = await h.prepare('complete'); await changed.publish()
    const result = await h.assemble(changed.agent)
    expect(result.sections).toHaveLength(1)
    expect(result.sections[0]).toMatchObject({ name: PREFIX, text: 'Complete replacement {{model}}', interpolate: true })
    expect(renderPrompt(result)).toBe('Complete replacement fixture-model')
    expect(result.tools).toEqual(before.tools)
    expect(result.contexts).toEqual(before.contexts)
  })

  it('replaces Codex Persona and operating text per preset and isolates it from later shared preference edits', async () => {
    const h = await fixture()
    const baseline = await h.prepare('codex'); await baseline.publish()
    const original = await h.assemble(baseline.agent)
    expect(await h.prefix(baseline.agent)).toBe('Shared custom Persona')
    const policy = await h.mount({ rules: [{ ...rule('codex', 'Current preset Persona'), promptOverrides: [
      { name: PREFIX, text: 'Current preset Persona' }, { name: 'codex:base', text: 'Current preset operating text.' },
    ] }] })
    const changed = await h.prepare('codex'); await changed.publish()
    const result = await h.assemble(changed.agent)
    expect(result.sections.find(section => section.name === PREFIX)?.text).toBe('Current preset Persona')
    expect(result.sections.filter(section => section.name === 'codex:base')).toEqual([{ name: 'codex:base', text: 'Current preset operating text.', interpolate: true }])
    expect(result.sections.some(section => section.text.includes('Original Codex operating instructions.'))).toBe(false)
    h.shared.persona = 'Changed shared preference later'
    h.shared.systemPrompt = 'Changed shared operating later'
    expect((await h.assemble(changed.agent)).sections).toEqual(result.sections)
    expect((await h.assemble(changed.agent)).tools).toEqual(original.tools)
    expect(h.counter.calls).toBe(1)
    await policy.fiber.dispose()
    expect((await h.assemble(changed.agent)).sections.find(section => section.name === PREFIX)?.text).toBe('Changed shared preference later')
    expect((await h.assemble(changed.agent)).sections.find(section => section.name === 'codex:base')?.text).toBe('Original Codex operating instructions.')
  })

  it('does not probe or inject when a rule has no prompt overrides', async () => {
    const h = await fixture()
    const old = await h.prepare('codex'); await old.publish()
    const before = await h.assemble(old.agent)
    const probe = vi.spyOn(h.registry, 'acquireScope')
    await h.mount({ rules: [{ preset: 'codex', replaceShell: false, replacePlan: false, tools: [] }] })
    const candidate = await h.prepare('codex'); await candidate.publish()
    expect(await h.assemble(candidate.agent)).toEqual(before)
    expect(probe).not.toHaveBeenCalled()
  })

  it('does not let an unsupported or missing sibling target block A, and rejects only that target on switch', async () => {
    const h = await fixture()
    await h.register('unknown', 'Native prefix.', { unknownComplete: true })
    await h.mount({ rules: [rule('a', 'A succeeds'), rule('unknown', 'Must reject'), rule('missing-preset', 'Must not block A')] })
    const a = await h.prepare('a'); await a.publish()
    expect(await h.prefix(a.agent)).toBe('A succeeds')
    const warning = vi.spyOn(h.ctx.logger, 'warn').mockImplementation(() => {})
    await a.select('unknown')
    expect((await h.assemble(a.agent)).sections).toEqual([{ name: 'unknown:instructions', text: 'Unknown complete instructions.' }])
    expect(warning).toHaveBeenCalledWith(expect.stringContaining('unsupported-preset-prompt-override'))
    await a.select('a')
    expect(await h.prefix(a.agent)).toBe('A succeeds')
  })

  it('refuses stale declarations for an Agent retained on an older revision and releases every lease', async () => {
    const h = await fixture()
    const previous = await h.register('revision', 'Old revision')
    const old = await h.prepare('revision')
    await previous()
    await h.register('revision', 'New revision', { complete: true })
    await h.mount({ rules: [rule('revision', 'Do not apply new metadata to old revision')] })
    await expect(old.publish()).rejects.toThrow('preset-prompt-revision-mismatch')
    expect((await h.assemble(old.agent)).sections.find(section => section.name === PREFIX)?.text).toBe('Old revision')
    const lease = await h.registry.acquireScope('revision')
    const valid = await probePresetPrompts(h.ctx, 'revision', lease.key)
    await lease[Symbol.asyncDispose]()
    expect(valid.catalog.sections.find(section => section.name === PREFIX)?.complete).toBe(true)
  })

  it('rolls back prompt/tool contributions on an Agent-owned section collision', async () => {
    const h = await fixture()
    await h.mount({ rules: [{ ...rule('a', 'Must roll back'), deny: ['read'] }] })
    const candidate = await h.prepare('a')
    candidate.agent.ctx.get('systemPrompt')!.section({ name: PREFIX, order: 0, text: 'Agent-owned identity' })
    await expect(candidate.publish()).rejects.toThrow(/already registered/)
    expect(h.ctx.tools.get('read', candidate.agent)).toBe(h.read)
    expect(await h.prefix(candidate.agent)).toBe('Agent-owned identity')
    expect(h.ctx.tools.get('exec_command', candidate.agent)).toBeUndefined()
  })

  it('rejects client-supplied flags, unknown names, duplicate overrides and dynamic complete metadata', async () => {
    const h = await fixture()
    expect(Config({ rules: [{ preset: 'a' }] }).get()!.rules[0]!.promptOverrides).toBeUndefined()
    for (const promptOverrides of [
      [{ name: PREFIX, text: 'a', complete: true }],
      [{ name: 'host:policy', text: 'not allowed' }],
      [{ name: PREFIX, text: 'a' }, { name: PREFIX, text: 'b' }],
    ]) expect(() => applyPolicy(h.ctx, { rules: [{ preset: 'a', promptOverrides: promptOverrides as never }] })).toThrow('invalid-preset-prompt-override')
    const acquired = h.registry.readDocument.bind(h.registry)
    vi.spyOn(h.registry, 'readDocument').mockImplementation(async id => {
      const doc = await acquired(id)
      return id === 'complete' ? { ...doc, content: doc.content.replace('complete: true', 'complete: !!js true') } : doc
    })
    const catalog = await readPresetPromptCatalog(h.ctx, 'complete')
    expect(catalog.sections.find(section => section.name === PREFIX)).toMatchObject({ editable: false, reason: 'dynamic-declaration' })
  })

  it('caches prompt probes per scope, module signature, and document content while invalidating on changes', async () => {
    const h = await fixture()
    await h.prepare('a')
    const assemble = vi.spyOn(h.ctx.systemPrompt, 'assemble')
    const first = await probePresetPromptsCached(h.ctx, 'a')
    const callsAfterFirst = assemble.mock.calls.length
    expect(callsAfterFirst).toBeGreaterThan(0)

    const second = await probePresetPromptsCached(h.ctx, 'a')
    expect(second).toBe(first)
    expect(assemble).toHaveBeenCalledTimes(callsAfterFirst)

    // Explicit catalog reloads stay uncached.
    await readPresetPromptCatalog(h.ctx, 'a')
    expect(assemble.mock.calls.length).toBeGreaterThan(callsAfterFirst)

    // Document content changes invalidate cached probes even within the same scope key.
    const callsBeforeDocChange = assemble.mock.calls.length
    const originalRead = h.registry.readDocument.bind(h.registry)
    vi.spyOn(h.registry, 'readDocument').mockImplementation(async id => {
      const doc = await originalRead(id)
      return id === 'a' ? { ...doc, content: `${doc.content}\n# modified` } : doc
    })
    const third = await probePresetPromptsCached(h.ctx, 'a')
    expect(third).not.toBe(first)
    expect(assemble.mock.calls.length).toBeGreaterThan(callsBeforeDocChange)
  })

  it('skips probing sibling presets on restored non-blank sessions', async () => {
    const h = await fixture()
    await h.mount({ rules: [rule('a', 'A override'), rule('b', 'Sibling override')] })
    const acquireScope = vi.spyOn(h.registry, 'acquireScope')
    const restored = await h.prepare('a')
    restored.agent.session.append('turn/start', { turn: 1 })
    restored.agent.session.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
    await restored.publish()
    expect(acquireScope.mock.calls.map(call => call[0])).toEqual(['a'])

    acquireScope.mockClear()
    const blank = await h.prepare('a')
    await blank.publish()
    expect(acquireScope.mock.calls.map(call => call[0])).toEqual(['a', 'b'])
  })
})
