import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import AgentPresetRegistry from '@deepseek-ai/dsh-agent-preset-registry'
import SessionStore from '@deepseek-ai/dsh-session'
import SessionProjections from '@deepseek-ai/dsh-session-projection'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import Tools, { defineTool } from '@deepseek-ai/dsh-tools'
import { readPresetToolCatalog } from '../../src/presets/preset-tool-catalog.ts'
import { presetToolCatalogSchema } from '../../src/contracts/preset-editor-schema.ts'
import { registerHybridDefaultDeferredTools } from '../../src/policy/deferred-tools.ts'
import clientContract from '../../src/contracts/preset-editor-schema.ts'
import { TYPERT } from '../../src/entries/typert.host.ts'

const contexts: Context[] = []
afterEach(async () => {
  for (const ctx of contexts.splice(0).reverse()) await ctx.fiber.dispose()
  vi.restoreAllMocks()
})

function tool(name: string, description = name) {
  return defineTool({ name, description, parameters: {},
    output: { schema: { type: 'object', properties: {}, additionalProperties: false }, render: () => [] },
    execute: vi.fn(async () => ({})),
  })
}

async function registryFixture() {
  const ctx = new Context()
  contexts.push(ctx)
  await ctx.plugin(Loader, { baseUrl: import.meta.url })
  await ctx.plugin(SessionStore)
  await ctx.plugin(SessionProjections)
  await ctx.plugin(AgentRegistry)
  await ctx.plugin(SystemPrompt, {})
  await ctx.plugin(Tools)
  await ctx.plugin(AgentPresetRegistry, { default: 'first' })
  const condition = { calls: 0 }
  ctx.provide('catalogTestCounter', condition)
  ctx.provide('catalogTestDefaults', (presetCtx: Context, names: string[]) =>
    registerHybridDefaultDeferredTools(presetCtx, new Set(names)))
  const module = new URL('../fixtures/preset-catalog-tools.mjs', import.meta.url).href
  const registry = ctx.get('agentPresets')!
  const first = await registry.register({ id: 'first', plugins: [{ name: module, config: { names: ['pwsh', 'todo_write', 'read', 'edit'], conditional: ['todo_write'] } }] })
  const second = await registry.register({ id: 'second', plugins: [{ name: module, config: { names: ['bash', 'exec_command', 'other'] } }] })
  return { ctx, registry, first, second, condition, module }
}

describe('read-only preset tool inventory', () => {
  it('reads the selected actual preset with no Agent, model call, body execution, or condition evaluation', async () => {
    const h = await registryFixture()
    const created = vi.fn()
    h.ctx.on('agent/created', created)
    const first = await readPresetToolCatalog(h.ctx, 'first')
    const second = await readPresetToolCatalog(h.ctx, 'second')
    expect(first.preset).toBe('first')
    expect(first.tools.map(row => row.name)).toEqual(['edit', 'pwsh', 'read', 'todo_write'])
    expect(second.tools.map(row => row.name)).toEqual(['bash', 'exec_command', 'other'])
    expect(first.tools.find(row => row.name === 'pwsh')?.replacements).toEqual([
      { action: 'codex-exec', tools: ['exec_command', 'write_stdin'], available: true },
    ])
    expect(first.tools.find(row => row.name === 'edit')?.replacements).toEqual([
      { action: 'codex-patch', tools: ['apply_patch'], available: true },
    ])
    expect(first.tools.find(row => row.name === 'todo_write')).toMatchObject({ conditional: true,
      replacements: [{ action: 'codex-plan', tools: ['update_plan'], available: false, reason: 'conditional' }] })
    expect(second.tools.find(row => row.name === 'bash')?.replacements).toEqual([
      { action: 'codex-exec', tools: ['exec_command', 'write_stdin'], available: false, reason: 'target-exists' },
    ])
    expect(first.tools.find(row => row.name === 'read')?.description).toHaveLength(300)
    expect(first.tools.find(row => row.name === 'read')?.replacements).toEqual([])
    expect(h.condition.calls).toBe(0)
    expect(created).not.toHaveBeenCalled()
    expect(h.ctx.get('agents')!.list()).toEqual([])
    expect(h.ctx.get('tools')!.definitions()).toEqual([])
    expect(presetToolCatalogSchema.safeParse(first).success).toBe(true)
  })

  it('releases every revision lease instead of retaining retired preset generations', async () => {
    const h = await registryFixture()
    await readPresetToolCatalog(h.ctx, 'first')
    await h.first()
    expect(h.registry.inspectCompositions().some(row => row.id === 'first')).toBe(false)
  })

  it('uses a child inheritance view rather than leaking a preset-local shadow through its own mask', async () => {
    const h = await registryFixture()
    h.ctx.get('tools')!.register(tool('masked'))
    // Construct the real inherited mask before the preset-local shadow.
    await h.registry.register({ id: 'shadow-view', plugins: [{ name: h.module,
      config: { names: ['masked'], deniedBeforeShadow: ['masked'] } }] })
    const result = await readPresetToolCatalog(h.ctx, 'shadow-view')
    expect(result.tools.some(row => row.name === 'masked')).toBe(false)
  })

  it('releases the lease on a registry projection error', async () => {
    const ctx = new Context()
    contexts.push(ctx)
    const dispose = vi.fn(async () => {})
    ctx.provide('agentPresets', { acquireScope: vi.fn(async () => ({ key: {}, [Symbol.asyncDispose]: dispose })) } as never)
    ctx.provide('tools', { definitions: () => { throw new Error('projection-failed') } } as never)
    await expect(readPresetToolCatalog(ctx, 'first')).rejects.toThrow('projection-failed')
    expect(dispose).toHaveBeenCalledTimes(1)
  })

  it('fails explicitly when the host cannot inspect preset scopes; never substitutes the current Agent tools', async () => {
    const ctx = new Context()
    contexts.push(ctx)
    ctx.provide('agentPresets', {} as never)
    ctx.provide('tools', { definitions: vi.fn() } as never)
    await expect(readPresetToolCatalog(ctx, 'first')).rejects.toThrow('preset-tool-catalog-unavailable')
    await expect(readPresetToolCatalog(ctx, '')).rejects.toThrow('invalid-preset-id')
    expect(ctx.get('tools')!.definitions).not.toHaveBeenCalled()
  })

  it('reports defaultDeferred on preset-declared deferred tools and passes schema validation', async () => {
    const h = await registryFixture()
    await h.registry.register({
      id: 'deferred-preset',
      plugins: [{ name: h.module, config: { names: ['pwsh', 'edit', 'read'], defaultDeferred: ['edit'] } }],
    })
    const result = await readPresetToolCatalog(h.ctx, 'deferred-preset')
    expect(result.tools.find(row => row.name === 'edit')?.defaultDeferred).toBe(true)
    expect(result.tools.find(row => row.name === 'read')?.defaultDeferred).toBeUndefined()
    expect(presetToolCatalogSchema.safeParse(result).success).toBe(true)
  })

  it('publishes the same strict tools endpoint in the Host and Client contracts', () => {
    const host = TYPERT.invocations.find(row => row.method === 'tools')!
    const client = clientContract.descriptors.find(row => row.method === 'tools')!
    expect(host.id).toBe(client.id)
    expect(host.parameters.map(row => row.name)).toEqual(['id'])
    expect(host.parameters[0]!.codec.create().safeParse('').success).toBe(false)
    const sample = { preset: 'x', registeredOnly: true, tools: [] }
    expect(host.result.create().parse(sample)).toEqual(client.result.create().parse(sample))
  })
})
