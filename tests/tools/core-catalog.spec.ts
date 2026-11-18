import { describe, expect, it } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import type { ToolDefinition, ToolRunContext } from '@deepseek-ai/dsh-tools'
import { apply, enrichCodexModel } from '../../src/entries/index.ts'
import { CODEX_SETTINGS_ENTRY, CODEX_SETTINGS_NAMESPACE } from '../../src/contracts/settings.ts'

function mount(
  settings?: { describe?: () => Array<{ ns: string; value: unknown }>; update?(ns: string, patch: object): Promise<void> },
  config: Parameters<typeof apply>[1] = {},
): {
  definitions: ToolDefinition[]
  promptSections: string[]
  listeners: Map<string, Array<(...args: any[]) => unknown>>
} {
  const definitions: ToolDefinition[] = []
  const promptSections: string[] = []
  const listeners = new Map<string, Array<(...args: any[]) => unknown>>()
  const ctx = {
    tools: { register: (definition: ToolDefinition) => { definitions.push(definition) } },
    systemPrompt: { section: (section: { name: string }) => { promptSections.push(section.name) } },
    fs: { sandboxMode: undefined },
    get: (name: string) => name === 'tools' ? ctx.tools : name === 'shell' ? {} : name === 'settings' ? settings : undefined,
    on: (event: string, listener: (...args: any[]) => unknown) => {
      const entries = listeners.get(event) ?? []
      entries.push(listener)
      listeners.set(event, entries)
      return () => {}
    },
    inject: () => {},
    logger: { warn: () => {} },
  } as unknown as Context
  apply(ctx, config)
  return { definitions, promptSections, listeners }
}

describe('Codex tool catalog and model enrichment', () => {
  it('adds image and reasoning defaults only to GPT models', () => {
    expect(enrichCodexModel({ id: 'gpt-5.4' })).toMatchObject({
      input: ['text', 'image'],
      reasoningEfforts: {
        low: 'low',
        medium: 'medium',
        high: 'high',
        xhigh: 'xhigh',
        max: 'max',
      },
    })
    expect(enrichCodexModel({ id: 'qwen3' })).toEqual({ id: 'qwen3' })
    expect(enrichCodexModel({
      id: 'gpt-5.4',
      input: ['text'],
      reasoningEfforts: { off: null, minimal: 'minimal', low: 'low' },
    })).toEqual({ id: 'gpt-5.4', input: ['text'], reasoningEfforts: { low: 'low' } })
    expect(enrichCodexModel({ id: 'gpt-5.4', input: ['text'], reasoningEfforts: false }))
      .toEqual({ id: 'gpt-5.4', input: ['text'], reasoningEfforts: false })
  })

  it('writes missing GPT capabilities into the configured llm-pi-ai model profile', async () => {
    const updates: object[] = []
    const settings = {
      describe: () => [{ ns: 'llm-pi-ai', value: {
        providers: {
          relay: {
            models: [{ id: 'gpt-5.4', input: [], reasoningEfforts: {} }, { id: 'qwen3' }],
          },
        },
      } }],
      update: (_ns: unknown, patch: object) => { updates.push(patch); return Promise.resolve() },
    }
    mount(settings)
    await Promise.resolve()
    expect(updates).toHaveLength(1)
    expect(updates[0]).toMatchObject({
      providers: {
        relay: {
          models: [{ id: 'gpt-5.4', input: ['text', 'image'] }, { id: 'qwen3' }],
        },
      },
    })
  })

  it('keeps modelOverrides keyed by id without inserting an invalid id field', async () => {
    const updates: object[] = []
    const settings = {
      describe: () => [{ ns: 'llm-pi-ai', value: { providers: { relay: { modelOverrides: { 'gpt-5.4': {} } } } } }],
      update: (_ns: unknown, patch: object) => { updates.push(patch); return Promise.resolve() },
    }
    mount(settings)
    await Promise.resolve()
    expect(updates[0]).toMatchObject({
      providers: {
        relay: {
          modelOverrides: {
            'gpt-5.4': { input: ['text', 'image'], reasoningEfforts: { medium: 'medium' } },
          },
        },
      },
    })
    expect(JSON.stringify(updates[0])).not.toContain('"id":"gpt-5.4"')
  })

  it('registers only the four Codex core tools with exact descriptions', () => {
    const { definitions, promptSections } = mount()
    expect(definitions.map(definition => definition.name)).toEqual([
      'exec_command',
      'write_stdin',
      'apply_patch',
      'update_plan',
    ])
    expect(promptSections).toEqual(['codex:base'])
    expect(definitions.map(definition => definition.description)).toEqual([
      'Runs a command in the host-configured shell. By default it uses pipes: a running session can be polled for output but does not accept stdin. Set tty=true before starting a command that needs interactive input; background jobs use pipes.',
      'Polls output from an existing unified exec session. Non-empty chars can be sent to a session created with tty=true; pipe-backed sessions accept empty chars for polling or "\\u0003" to interrupt.',
      'Edits files using Codex patch syntax with Begin/End Patch markers and file update directives. In hunk lines, the first character is the operation marker; repeat a source-leading marker when the source line itself starts with one.',
      'Updates the task plan.\nProvide an optional explanation and a list of plan items, each with a step and status.\nAt most one step can be in_progress at a time.',
    ])
  })

  it('keeps Codex prompt and core tools out of the global enhancement layer', () => {
    const global = mount(undefined, { globalEnhancements: true, codexCore: false })
    expect(global.definitions).toEqual([])
    expect(global.promptSections).toEqual([])

    const codex = mount(undefined, { globalEnhancements: false, codexCore: true })
    expect(codex.definitions.map(tool => tool.name)).toEqual([
      'exec_command',
      'write_stdin',
      'apply_patch',
      'update_plan',
    ])
    expect(codex.promptSections).toEqual(['codex:base'])
  })

  it('rejects stale calls after a Codex tool capability is disabled', async () => {
    const settingsValue = {
      ...CODEX_SETTINGS_ENTRY,
      terminalToolsEnabled: false,
      patchToolEnabled: false,
      planToolEnabled: false,
    }
    const { definitions } = mount({
      describe: () => [{ ns: CODEX_SETTINGS_NAMESPACE, value: settingsValue }],
      update: async () => {},
    })
    const execution = {
      signal: new AbortController().signal,
      deferContext: () => {},
      concludeTurn: () => {},
    } as unknown as ToolRunContext

    await expect(definitions.find(tool => tool.name === 'exec_command')!.execute({
      cmd: 'echo no',
    }, execution)).rejects.toThrow('disabled in Codex Harness plugin settings')
    await expect(definitions.find(tool => tool.name === 'apply_patch')!.execute({
      input: '*** Begin Patch\n*** End Patch',
    }, execution)).rejects.toThrow('disabled in Codex Harness plugin settings')
    await expect(definitions.find(tool => tool.name === 'update_plan')!.execute({
      plan: [],
    }, execution)).rejects.toThrow('disabled in Codex Harness plugin settings')
  })

  it('keeps Codex parameter names and result schemas model-visible', () => {
    const { definitions } = mount()
    const exec = definitions.find(definition => definition.name === 'exec_command')
    const patch = definitions.find(definition => definition.name === 'apply_patch')
    expect(exec?.parameters).toEqual({
      type: 'object',
      properties: {
        cmd: { type: 'string', description: 'Shell command to execute.' },
        workdir: { type: 'string', description: 'Working directory for the command. Defaults to the turn cwd.' },
        tty: { type: 'boolean', description: 'True allocates a PTY for the command; false or omitted uses plain pipes.' },
        run_in_background: { type: 'boolean', description: 'Run as a DSH background job and return its job id immediately; collect output with job_output and stop it with job_kill. Only supported for pipe-backed commands.' },
        yield_time_ms: { type: 'number', description: 'Wait before yielding output. Defaults to 10000 ms; effective range is 250-30000 ms.' },
        max_output_tokens: { type: 'number', description: 'Output token budget. Defaults to 10000 tokens; larger requests may be capped by policy.' },
      },
      required: ['cmd'],
    })
    expect(exec?.output.schema).toEqual({
      type: 'object',
      additionalProperties: false,
      properties: {
        chunk_id: { type: 'string' },
        wall_time_seconds: { type: 'number' },
        exit_code: { type: 'number' },
        session_id: { type: 'number' },
        job_id: { type: 'string' },
        original_token_count: { type: 'number' },
        output: { type: 'string' },
      },
      required: ['wall_time_seconds', 'output'],
    })
    expect(patch?.parameters).toEqual({
      type: 'object',
      properties: {
        input: { type: 'string', description: 'The complete patch text.' },
      },
      required: ['input'],
    })
    const stdin = definitions.find(definition => definition.name === 'write_stdin')
    expect(stdin?.parameters).toMatchObject({
      properties: {
        session_id: {
          type: 'number',
          description: 'Identifier of the running unified exec session.',
        },
      },
    })
    const plan = definitions.find(definition => definition.name === 'update_plan')
    expect(plan?.parameters).toEqual({
      type: 'object',
      properties: {
        explanation: { type: 'string', description: 'Optional explanation for this plan update.' },
        plan: {
          type: 'array',
          description: 'The list of steps',
          items: {
              type: 'object',
              additionalProperties: false,
              properties: {
              step: { type: 'string', description: 'Task step text.' },
              status: { type: 'string', enum: ['pending', 'in_progress', 'completed'], description: 'Step status.' },
            },
            required: ['step', 'status'],
          },
        },
      },
      required: ['plan'],
    })
  })

  it('renders Codex-compatible apply_patch and plan results', () => {
    const { definitions } = mount()
    const patch = definitions.find(definition => definition.name === 'apply_patch')!
    const plan = definitions.find(definition => definition.name === 'update_plan')!
    expect(patch.output.render({}, { files: [{ path: 'a.ts', operation: 'updated' }] } as never))
      .toEqual([{ type: 'text', text: 'Success. Updated the following files:\nM a.ts\n' }])
    expect(plan.output.render({}, {} as never)).toEqual([{ type: 'text', text: 'Plan updated' }])
  })

  it('renders both unified exec results in Codex response text format', () => {
    const { definitions } = mount()
    const exec = definitions.find(definition => definition.name === 'exec_command')!
    const stdin = definitions.find(definition => definition.name === 'write_stdin')!
    const value = {
      chunk_id: 'abc123',
      wall_time_seconds: 1.25,
      exit_code: 0,
      output: 'done\n',
    }
    const expected = 'Chunk ID: abc123\nWall time: 1.2500 seconds\nProcess exited with code 0\nOutput:\ndone\n'
    expect(exec.output.render({}, value as never)).toEqual([{ type: 'text', text: expected }])
    expect(stdin.output.render({}, value as never)).toEqual([{ type: 'text', text: expected }])
  })

  it('renders a background job id in the unified exec result', () => {
    const { definitions } = mount()
    const exec = definitions.find(definition => definition.name === 'exec_command')!
    const value = {
      wall_time_seconds: 0.01,
      job_id: 'bash-1',
      output: 'Started background job bash-1.',
    }
    expect(exec.output.render({}, value as never)).toEqual([{
      type: 'text',
      text: 'Wall time: 0.0100 seconds\nBackground job ID: bash-1\nOutput:\nStarted background job bash-1.',
    }])
  })

  it('writes update_plan state to the session event stream', async () => {
    const { definitions } = mount()
    const plan = definitions.find(definition => definition.name === 'update_plan')!
    const events: unknown[] = []
    const execution = {
      agent: { session: { append: (type: string, data: unknown) => { events.push({ type, data }) } } },
      deferContext: () => {},
      concludeTurn: () => {},
    } as unknown as ToolRunContext
    await plan.execute({
      plan: [{ step: 'Inspect the repository', status: 'completed' }, { step: 'Implement the fix', status: 'in_progress' }],
    }, execution)
    expect(events).toEqual([{
      type: 'todo/write',
      data: { todos: [
        { content: 'Inspect the repository', status: 'completed' },
        { content: 'Implement the fix', status: 'in_progress' },
      ] },
    }])
  })
})
