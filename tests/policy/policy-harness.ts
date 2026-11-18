import { afterEach, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import type { Agent } from '@deepseek-ai/dsh-agent'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import SessionProjections from '@deepseek-ai/dsh-session-projection'
import { createAssistantMessage, createDeveloperMessage, createUserMessage, HarnessError, projectToolUpdates, ToolCallId } from '@deepseek-ai/dsh-llm'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolsService, { defineTool } from '@deepseek-ai/dsh-tools'
import type { ToolDefinition, ResolvedToolSet } from '@deepseek-ai/dsh-tools'
import * as NativeExecutor from '@deepseek-ai/dsh-tool-executor-native'
import { bindScopeParent, createScope, scopeOf, scopeParentOf } from '@deepseek-ai/dsh-scope'
import { registerHybridDefaultDeferredTools } from '../../src/policy/deferred-tools.ts'
import ToolPolicy, { apply, Config } from '../../src/entries/tool-policy.ts'
import type { Config as PolicyConfig, ToolAction, ToolActionRule, ToolPolicyRule } from '../../src/entries/tool-policy.ts'
import { effectiveToolAction } from '../../src/contracts/tool-policy-contract.ts'
import { apply as applyCodex } from '../../src/entries/index.ts'
import type { Config as CoreConfig } from '../../src/entries/index.ts'
import type { CodexSettings } from '../../src/contracts/settings.ts'
import { codexToolMetadata } from '../../src/policy/tool-capabilities.ts'
import { readPresetToolCatalog } from '../../src/presets/preset-tool-catalog.ts'

const contexts: Context[] = []
afterEach(async () => {
  for (const ctx of contexts.splice(0).reverse()) await ctx.fiber.dispose()
  vi.restoreAllMocks()
})

export function capability(name: string): ToolDefinition {
  return defineTool({
    name,
    description: `Original ${name}`,
    parameters: {},
    output: {
      schema: { type: 'object', additionalProperties: false, properties: {} },
      render: () => [{ type: 'text', text: 'original result' }],
    },
    execute: async () => ({}),
  })
}

/** Real scoped registry, admission, Native pipeline and Agent publication; no OS processes. */
export async function harness() {
  const ctx = new Context()
  contexts.push(ctx)
  await ctx.plugin(SessionStore)
  await ctx.plugin(SessionProjections)
  await ctx.plugin(AgentRegistry)
  await ctx.plugin(SystemPrompt, {})
  await ctx.plugin(ToolsService)
  await ctx.plugin(NativeExecutor)
  let nextId = 0
  const presets = new Map<string, { key: object; ctx: Context; definitions: Record<string, ToolDefinition> }>()
  const presetNames = new Map<object, string>()
  const selected = new Map<string, string>()
  ctx.provide('agentPresets', {
    composedPreset: (agentCtx: Context) => {
      const key = scopeOf(agentCtx)
      const parent = key === undefined ? undefined : scopeParentOf(key)
      return parent === undefined ? undefined : presetNames.get(parent)
    },
    presetForSession: (session: Agent['session']) => selected.get(session.id) ?? session.header.agentPreset ?? null,
    acquireScope: async (id: string) => ({ key: presets.get(id)!.key, [Symbol.asyncDispose]: async () => {} }),
  } as never)
  let legacySettings: Partial<CodexSettings> = {}
  ctx.provide('codexPreferences', { current: () => legacySettings } as never)
  const patchWrites = vi.fn(async () => ({ operation: 'create', version: 'test-version' }))
  ctx.provide('fs', {
    resolve: async (path: string) => ({ targetKey: path, displayPath: path }),
    stat: async () => undefined,
    writeText: patchWrites,
  } as never)
  const executeShell = vi.fn(async (spec: { command: string }) => {
    const failure = spec.command === 'infrastructure-failure'
    return {
      status: 'completed', exitCode: spec.command === 'nonzero' ? 7 : 0, signal: null,
      done: Promise.resolve(), kill: vi.fn(() => false),
      readOutput: () => ({ delta: 'completed\n', lossy: false }),
      async result() {
        if (failure) throw new HarnessError('test shell failed', 'TEST_SHELL_FAILED')
        return {}
      },
    }
  })
  ctx.provide('shell', { resolve: (value: unknown) => value, execute: executeShell } as never)
  ctx.systemPrompt.section({ name: 'test:persona', order: 1, text: 'Keep this Persona.' })
  ctx.systemPrompt.section({ name: 'tool:pwsh', order: 1010, text: 'Original shell guidance stays unchanged.' })
  ctx.systemPrompt.context({ name: 'test:context', order: 1, text: 'Keep this runtime context.' })
  ctx.systemPrompt.variable('test_value', () => 'Keep this variable.')

  function preset(
    id: string,
    names = ['pwsh', 'todo_write', 'read', 'read_image', 'glob', 'grep', 'edit', 'write', 'apply_patch', 'other_tool'],
    conditions: Record<string, () => boolean | Promise<boolean>> = {},
  ) {
    const key = {}
    const scoped = createScope(ctx, key)
    const definitions: Record<string, ToolDefinition> = {}
    for (const name of names) {
      const definition = capability(name)
      definitions[name] = definition
      scoped.ctx.get('tools')!.register(definition, conditions[name] === undefined ? {} : { when: conditions[name] })
    }
    const value = { key, ctx: scoped.ctx, definitions }
    presets.set(id, value)
    presetNames.set(key, id)
    return value
  }

  function prepare(presetId: string, own: ToolDefinition[] = []) {
    const parent = presets.get(presetId)!
    const id = SessionId(`tool-policy-${++nextId}`)
    const session = ctx.sessions.create(id, { meta: { agentPreset: presetId } })
    const agent = { id, session, status: 'idle', options: { provider: 'test', model: 'test' } } as Agent
    const scoped = createScope(ctx, agent)
    const binding = bindScopeParent(agent, parent.key)
    Object.assign(agent, { ctx: scoped.ctx })
    for (const definition of own) scoped.ctx.get('tools')!.register(definition)
    return {
      agent,
      scoped,
      publish: async () => { await scoped.ctx.get('agents')!.register(agent) },
      switchPreset(next: string) {
        binding.rebind(presets.get(next)!.key)
        selected.set(id, next)
        // The real preset service emits this notification after rebind and commit.
        session.append('agent-preset/selected', { agentPreset: next })
        ctx.emit('agent-preset/selected', id, next)
      },
      setStatus(status: 'idle' | 'running') { Object.assign(agent, { status }) },
    }
  }

  async function corePreset(id: string, config: CoreConfig = {}) {
    const source = preset(id, ['read'])
    await source.ctx.plugin({
      inject: ['tools', 'systemPrompt', 'shell', 'fs'],
      apply(coreCtx: Context) { applyCodex(coreCtx, { globalEnhancements: false, ...config }) },
    })
    for (const definition of ctx.tools.definitions(source.key)) source.definitions[definition.name] = definition
    return source
  }
  const names = (agent: Agent) => ctx.tools.definitions(agent).map(tool => tool.name)
  const admit = (agent: Agent) => ctx.tools.resolve({ agent, signal: new AbortController().signal,
    modelSelection: { provider: 'test', model: 'test' } })
  async function visible(agent: Agent) {
    const admitted = await admit(agent)
    try { return ctx.tools.schemas(agent, admitted).map(tool => tool.name) }
    finally { admitted.dispose() }
  }
  let calls = 0
  async function dispatch(agent: Agent, name: string, args: unknown, admitted?: ResolvedToolSet) {
    const call = { type: 'tool-call' as const, id: ToolCallId(`call-policy-${++calls}`), name, arguments: JSON.stringify(args) }
    const signal = new AbortController().signal
    const toolSet = admitted ?? await ctx.tools.resolve({ agent, signal, modelSelection: { provider: 'test', model: 'test' } })
    const turn = ctx.agents.turnBoundaryOf(agent.session).lastTurn + 1
    agent.session.append('turn/start', { turn })
    agent.session.append('step/start', { turn, step: 1 })
    agent.session.append('user/message', createUserMessage({ content: [{ type: 'text', text: 'Test tool policy.' }], source: { kind: 'user' } }), { surfaceOp: 'append' })
    agent.session.append('assistant/message', { turn, step: 1, message: createAssistantMessage({ content: [call], source: { provider: 'test', model: 'test' } }), stream: [] }, { surfaceOp: 'append' })
    try {
      return await ctx.tools.execute({ agent, calls: [call], signal, toolSet, log: { turn, step: 1 } })
    } finally {
      toolSet.dispose()
      agent.session.append('step/end', { turn, step: 1 })
      agent.session.append('turn/end', { turn, reason: { kind: 'completed' } })
    }
  }
  return {
    ctx, preset, corePreset, prepare, names, dispatch, executeShell, visible, admit, patchWrites,
    setLegacy(value: Partial<CodexSettings>) { legacySettings = value },
    mount: (config: PolicyConfig = {}) => ctx.plugin(ToolPolicy, config),
    async mountWithLoader(config: PolicyConfig = {}) {
      // Loader (not bare Fiber.update) commits root-volatile config references.
      // The base Loader's commit is a no-op; this integration writes no config files.
      await ctx.plugin(Loader)
      ctx.loader.builtins['test-tool-policy'] = ToolPolicy
      const id = await ctx.loader.create({ name: 'cordis:test-tool-policy', config })
      await ctx.loader.await()
      const entry = ctx.loader.resolve(id)
      if (entry.fiber === undefined) throw new Error('test policy entry did not mount')
      await entry.fiber.await()
      return {
        fiber: entry.fiber,
        update: (next: PolicyConfig) => ctx.loader.update(id, { config: next }),
      }
    },
  }
}

export const fsNames = ['read', 'read_image', 'glob', 'grep', 'edit', 'write', 'apply_patch'] as const

export function individualRule(preset: string, tools: readonly ToolActionRule[]): ToolPolicyRule {
  return { preset, replaceShell: false, replacePlan: false, tools }
}

