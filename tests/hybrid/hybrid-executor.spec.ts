import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { AttachmentId, ImageVariantId } from '@deepseek-ai/dsh-attachment'
import { createAssistantMessage, createUserMessage, ToolCallId } from '@deepseek-ai/dsh-llm'
import type { PtcRunRequest, PtcRunResult, PtcRunSpec } from '@deepseek-ai/dsh-ptc-runtime'
import { bindScopeParent, createScope } from '@deepseek-ai/dsh-scope'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import SessionProjections from '@deepseek-ai/dsh-session-projection'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolsService, { defineTool } from '@deepseek-ai/dsh-tools'
import CodexHybridExecutorPlugin from '../../src/entries/hybrid-executor.ts'

const contexts: Context[] = []
afterEach(async () => {
  for (const ctx of contexts.splice(0).reverse()) await ctx.fiber.dispose()
})

const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor as new (
  ...args: string[]
) => (...values: unknown[]) => Promise<unknown>

function stubImageRef() {
  return {
    id: AttachmentId('att-hybrid-1'),
    mediaType: 'image/png' as const,
    byteLength: 42,
    width: 16,
    height: 16,
    variants: {
      model: {
        id: ImageVariantId('var-hybrid-1'),
        mediaType: 'image/png' as const,
        byteLength: 42,
        width: 16,
        height: 16,
      },
    },
  }
}

async function setupHybrid(config: Parameters<typeof CodexHybridExecutorPlugin.apply>[1] = {}) {
  const ctx = new Context()
  contexts.push(ctx)
  await ctx.plugin(SessionStore)
  await ctx.plugin(SessionProjections)
  await ctx.plugin(AgentRegistry)
  await ctx.plugin(SystemPrompt, {})
  await ctx.plugin(ToolsService)

  ctx.provide('workingDirectory', {
    defaultDirectory: '/workspace',
    get: () => '/workspace',
    ensure: async () => '/workspace',
  } as never)

  ctx.provide('ptcRuntime', {
    language: 'typescript',
    isolation: 'in-memory',
    programFormat: 'function-body',
    retainsState: false,
    release: async () => {},
    resolve: (req: PtcRunRequest): PtcRunSpec => ({
      ...req,
      cwd: req.cwd ?? '/workspace',
      timeoutMs: req.timeoutMs === undefined ? 60_000 : req.timeoutMs,
    }),
    run: async (spec: PtcRunSpec): Promise<PtcRunResult> => {
      const logs: string[] = []
      const consoleStub = {
        log: (...parts: unknown[]) => {
          logs.push(parts.map(part => typeof part === 'string' ? part : JSON.stringify(part)).join(' '))
        },
      }
      try {
        const fn = new AsyncFunction('tools', 'console', spec.program)
        const value = await fn(spec.bindings[0]!.functions, consoleStub)
        return { logs, ...(value === undefined ? {} : { value: value as PtcRunResult['value'] }) }
      } catch (error: unknown) {
        return { logs, error: { kind: 'exception', message: error instanceof Error ? error.message : String(error) } }
      }
    },
  } as never)

  const presetKey = {}
  const preset = createScope(ctx, presetKey)
  await preset.ctx.plugin(CodexHybridExecutorPlugin, config)

  let callSeq = 0
  let agentSeq = 0

  async function spawnAgent() {
    const id = SessionId(`hybrid-test-${++agentSeq}`)
    const session = ctx.sessions.create(id)
    const agent = { id, session, status: 'idle', options: { provider: 'test', model: 'test' } } as Agent
    const scoped = createScope(ctx, agent)
    bindScopeParent(agent, presetKey)
    Object.assign(agent, { ctx: scoped.ctx })
    await scoped.ctx.get('agents')!.register(agent)
    return agent
  }

  async function runBatch(
    agent: Agent,
    requests: ReadonlyArray<{ name: string; args: unknown }>,
  ) {
    const signal = new AbortController().signal
    const toolSet = await ctx.tools.resolve({ agent, signal, modelSelection: { provider: 'test', model: 'test' } })
    const calls = requests.map(request => ({
      type: 'tool-call' as const,
      id: ToolCallId(`call-hybrid-${++callSeq}`),
      name: request.name,
      arguments: JSON.stringify(request.args),
    }))
    const turn = ctx.agents.turnBoundaryOf(agent.session).lastTurn + 1
    agent.session.append('turn/start', { turn })
    agent.session.append('step/start', { turn, step: 1 })
    agent.session.append('user/message', createUserMessage({ content: [{ type: 'text', text: 'Hybrid batch.' }], source: { kind: 'user' } }), { surfaceOp: 'append' })
    agent.session.append('assistant/message', {
      turn,
      step: 1,
      message: createAssistantMessage({ content: calls, source: { provider: 'test', model: 'test' } }),
      stream: [],
    }, { surfaceOp: 'append' })
    try {
      return await ctx.tools.execute({ agent, calls, signal, toolSet, log: { turn, step: 1 } })
    } finally {
      toolSet.dispose()
      agent.session.append('step/end', { turn, step: 1 })
      agent.session.append('turn/end', { turn, reason: { kind: 'completed' } })
    }
  }

  function registerStandardTools(target: Context) {
    const tools = target.get('tools')!
    const registerEcho = (
      name: string,
      opts: { description?: string; extra?: Record<string, unknown>; concurrencySafe?: boolean; deferLoading?: true } = {},
    ) => {
      tools.register(defineTool({
        name,
        description: opts.description ?? `Run ${name}`,
        parameters: {
          input: { type: 'string', description: 'Optional payload.' },
        },
        ...(opts.deferLoading ? { deferLoading: true as const } : {}),
        ...(opts.concurrencySafe ? { isConcurrencySafe: () => true } : {}),
        output: {
          schema: {
            type: 'object',
            additionalProperties: false,
            properties: {
              tool: { type: 'string', required: true },
              input: { type: 'string' },
            },
          },
          render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }],
        },
        execute: async args => ({
          tool: name,
          ...(args.input === undefined ? {} : { input: args.input }),
          ...opts.extra,
        }),
      }))
    }
    for (const direct of ['exec_command', 'apply_patch', 'update_plan']) registerEcho(direct)
    registerEcho('web_search', { deferLoading: true })
    for (const sdk of ['read', 'glob', 'grep', 'web_fetch']) registerEcho(sdk, { concurrencySafe: true })
  }

  return { ctx, preset, registerStandardTools, spawnAgent, runBatch }
}

describe('CodexHybridExecutor', () => {
  it('partitions direct wire tools and tools:sdk cleanly and preserves explicit deferLoading', async () => {
    const h = await setupHybrid()
    h.registerStandardTools(h.preset.ctx)
    const agent = await h.spawnAgent()
    const toolSet = await h.ctx.tools.resolve({
      agent,
      signal: new AbortController().signal,
      modelSelection: { provider: 'test', model: 'test' },
    })
    try {
      const assembled = await h.ctx.systemPrompt.assemble({ scope: agent, agent, toolSet })
      expect(assembled.tools.map(tool => tool.name)).toEqual([
        'apply_patch',
        'exec_command',
        'run_code',
        'update_plan',
        'web_search',
      ])
      expect(assembled.tools.find(tool => tool.name === 'web_search')?.deferLoading).toBe(true)

      expect(assembled.sections.some(section => section.name === 'tools:hybrid')).toBe(true)
      const sdkText = assembled.sections.find(section => section.name === 'tools:sdk')!.text
      expect(sdkText).toContain('interface ToolArgsMap')
      expect(sdkText).toContain('interface ToolOutputMap')
      for (const sdkTool of ['read', 'glob', 'grep', 'web_fetch']) expect(sdkText).toContain(sdkTool)
      for (const directTool of ['apply_patch', 'exec_command', 'update_plan', 'run_code']) {
        expect(sdkText).not.toContain(`  ${directTool}:`)
      }
    } finally {
      toolSet.dispose()
    }
  })

  it('enforces direct wire vs SDK-only execution boundaries', async () => {
    const h = await setupHybrid()
    h.registerStandardTools(h.preset.ctx)
    const agent = await h.spawnAgent()

    const directOk = await h.runBatch(agent, [{ name: 'update_plan', args: { input: 'step 1' } }])
    expect(directOk.results[0]!.result).toMatchObject({
      isError: false,
      value: { tool: 'update_plan', input: 'step 1' },
    })

    const directSdkRejected = await h.runBatch(agent, [{ name: 'read', args: { input: 'a.ts' } }])
    expect(directSdkRejected.results[0]!.result).toMatchObject({
      isError: true,
      error: { info: { code: 'UNKNOWN_TOOL' } },
    })
    expect(directSdkRejected.results[0]!.result.error?.message).toContain('run_code')

    const nestedDirectRejected = await h.runBatch(agent, [{
      name: 'run_code',
      args: { description: 'Attempt nested direct call', code: 'return await tools.apply_patch({ input: "x" })' },
    }])
    expect(nestedDirectRejected.results[0]!.result.isError).toBe(true)
  })

  it('batches SDK calls via Promise.all, logs ptc-dispatch events, and forwards images, context, and concludeTurn', async () => {
    const h = await setupHybrid()
    h.registerStandardTools(h.preset.ctx)
    h.preset.ctx.get('tools')!.register(defineTool({
      name: 'inspect_chart',
      description: 'Return image, extra context, and conclude turn.',
      parameters: {},
      output: {
        schema: { type: 'object', additionalProperties: false, properties: { ok: { type: 'boolean', required: true } } },
        render: () => [{ type: 'image', attachment: stubImageRef() }],
      },
      execute: async (_args, exec) => {
        exec.deferContext(createUserMessage({ content: [{ type: 'text', text: 'nested hint' }], source: { kind: 'user' } }))
        exec.concludeTurn()
        return { ok: true }
      },
    }))

    const agent = await h.spawnAgent()
    const batch = await h.runBatch(agent, [{
      name: 'run_code',
      args: {
        description: 'Batch read, grep, and inspect chart',
        code: [
          'const [a, b] = await Promise.all([tools.read({ input: "a.ts" }), tools.grep({ input: "foo" })]);',
          'const chart = await tools.inspect_chart({});',
          'console.log("batched");',
          'return { a, b, chart };',
        ].join('\n'),
      },
    }])

    expect(batch.results[0]!.result).toMatchObject({
      isError: false,
      value: {
        logs: ['batched'],
        result: {
          a: { tool: 'read', input: 'a.ts' },
          b: { tool: 'grep', input: 'foo' },
          chart: { ok: true },
        },
      },
    })
    expect(batch.concluded).toBe(true)
    expect(batch.additionalContexts).toHaveLength(2)
    expect(batch.additionalContexts[0]!.source).toEqual({ kind: 'ptc-mode' })
    expect(batch.additionalContexts[0]!.content[0]).toMatchObject({ type: 'image' })
    expect(batch.additionalContexts[1]!.content[0]).toEqual({ type: 'text', text: 'nested hint' })

    const events = agent.session.snapshotEvents()
    const starts = events.filter(event => event.type === 'tool/ptc-dispatch-start')
    const ends = events.filter(event => event.type === 'tool/ptc-dispatch')
    expect(starts).toHaveLength(3)
    expect(ends).toHaveLength(3)
    expect(ends.map(event => event.data.subCallId)).toEqual(starts.map(event => event.data.subCallId))
    for (const event of ends) {
      expect(event.data.parentCallId).toBe(batch.results[0]!.callId)
      expect(event.data.isError).toBe(false)
    }
  })

  it('settles mixed direct + run_code batch in exact call order with durable records', async () => {
    const h = await setupHybrid()
    h.registerStandardTools(h.preset.ctx)
    const agent = await h.spawnAgent()

    const batch = await h.runBatch(agent, [
      { name: 'update_plan', args: { input: 'plan' } },
      { name: 'run_code', args: { description: 'Read file via SDK', code: 'return await tools.read({ input: "index.ts" })' } },
      { name: 'apply_patch', args: { input: 'patch' } },
    ])

    expect(batch.results.map(entry => entry.result.isError)).toEqual([false, false, false])
    expect(batch.results.map(entry => entry.result.value)).toEqual([
      { tool: 'update_plan', input: 'plan' },
      { logs: [], result: { tool: 'read', input: 'index.ts' } },
      { tool: 'apply_patch', input: 'patch' },
    ])

    const events = agent.session.snapshotEvents()
    const calls = events.filter(event => event.type === 'tool/call')
    const results = events.filter(event => event.type === 'tool/result')
    expect(calls.map(event => event.data.name)).toEqual(['update_plan', 'run_code', 'apply_patch'])
    expect(results.map(event => event.data.message.toolCallId)).toEqual(calls.map(event => event.data.callId))
  })

  it('applies standalone deferredTools fallback via activate_tools when codex-tool-policy is absent', async () => {
    const h = await setupHybrid({ hiddenTools: ['todo_write'], deferredTools: ['workflow', 'goal'] })
    h.registerStandardTools(h.preset.ctx)
    for (const extra of ['todo_write', 'workflow', 'goal']) {
      h.preset.ctx.get('tools')!.register(defineTool({
        name: extra,
        description: `Run ${extra}.`,
        parameters: {},
        output: { schema: { type: 'object', additionalProperties: false, properties: {} }, render: () => [] },
        execute: async () => ({}),
      }))
    }

    const agent = await h.spawnAgent()
    const step1 = await h.ctx.tools.resolve({
      agent,
      signal: new AbortController().signal,
      modelSelection: { provider: 'test', model: 'test' },
    })
    try {
      const prompt1 = await h.ctx.systemPrompt.assemble({ scope: agent, agent, toolSet: step1 })
      const wireNames1 = prompt1.tools.map(tool => tool.name)
      expect(wireNames1).toContain('activate_tools')
      expect(wireNames1).not.toContain('todo_write')
      expect(wireNames1).not.toContain('workflow')
      expect(wireNames1).not.toContain('goal')
      expect(h.ctx.tools.definitions(agent).some(tool => tool.name === 'todo_write')).toBe(false)
      expect(prompt1.sections.find(section => section.name === 'codex:deferred-tools')?.text)
        .toContain('- `goal`:')
    } finally {
      step1.dispose()
    }

    const activation = await h.runBatch(agent, [{ name: 'activate_tools', args: { names: ['workflow'] } }])
    expect(activation.results[0]!.result).toMatchObject({
      isError: false,
      value: { activated: ['workflow'], alreadyActive: [], unknown: [] },
    })

    const step2 = await h.ctx.tools.resolve({
      agent,
      signal: new AbortController().signal,
      modelSelection: { provider: 'test', model: 'test' },
    })
    try {
      const wireNames2 = h.ctx.tools.schemas(agent, step2).map(tool => tool.name)
      expect(wireNames2).toContain('workflow')
      expect(wireNames2).not.toContain('goal')
    } finally {
      step2.dispose()
    }
  })
})
