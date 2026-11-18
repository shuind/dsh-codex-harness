/** Shared Codex execution and plan tool registration (decoupled from Host preset editor). */

import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { ESCALATION_TARGETS, sandboxPermissionsDescription } from '@deepseek-ai/dsh-sandbox'
import type {} from '@deepseek-ai/dsh-sandbox-policy'
import type {} from '@deepseek-ai/dsh-shell'
import type { TodoItem } from '@deepseek-ai/dsh-tool-todo'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { TerminalResultView, ToolResult } from '@deepseek-ai/dsh-tools'
import { disposeAgentExecSessions, renderExecResult, runExecCommand, runWriteStdin } from './exec-runner.ts'
import type { ExecCommandArgs, ExecResult, WriteStdinArgs } from './exec-output.ts'
import { registerPatchTool } from './patch-tool.ts'
import { CODEX_SETTINGS_ENTRY, CODEX_SETTINGS_NAMESPACE, readHostSettings } from '../contracts/settings.ts'
import type { CodexSettings } from '../contracts/settings.ts'
import { assertCapabilityEnabled, codexToolEnabled, markCodexTool } from '../policy/tool-capabilities.ts'
import type { CodexCapability } from '../contracts/tool-policy-contract.ts'

export const DEFAULT_MAX_OUTPUT_BYTES = 1024 * 1024

const EXEC_COMMAND_DESCRIPTION =
  'Runs a command in the host-configured shell. By default it uses pipes: a running session can be polled for output but does not accept stdin. Set tty=true before starting a command that needs interactive input; background jobs use pipes.'
const WRITE_STDIN_DESCRIPTION =
  'Polls output from an existing unified exec session. Non-empty chars can be sent to a session created with tty=true; pipe-backed sessions accept empty chars for polling or "\\u0003" to interrupt.'
const UPDATE_PLAN_DESCRIPTION =
  'Updates the task plan.\nProvide an optional explanation and a list of plan items, each with a step and status.\nAt most one step can be in_progress at a time.'

const PLAN_STATUSES = ['pending', 'in_progress', 'completed'] as const
type PlanStatus = typeof PLAN_STATUSES[number]

interface PlanArgumentItem {
  step: string
  status: PlanStatus
}

interface UpdatePlanArgs {
  explanation?: string
  plan: PlanArgumentItem[]
}

export interface ExecToolConfig {
  defaultYieldTimeMs: number
  pollYieldTimeMs: number
  writeYieldTimeMs: number
  maxOutputBytes: number
  currentSettings: () => CodexSettings
  presetEnabled?: boolean
  authority?: boolean
  presetOverridesLegacy?: boolean
}

function planTodos(args: UpdatePlanArgs): TodoItem[] {
  const seen = new Set<string>()
  let active = 0
  const todos: TodoItem[] = []
  for (const item of args.plan) {
    const content = item.step.trim()
    if (content.length === 0) throw new Error('update_plan: every step must be non-empty')
    if (seen.has(content)) throw new Error(`update_plan: duplicate step ${JSON.stringify(content)}`)
    seen.add(content)
    if (item.status === 'in_progress') active++
    todos.push({ content, status: item.status })
  }
  if (active > 1) throw new Error('update_plan: at most one step may be in_progress')
  return todos
}

/** Release every registration once, even when one release fails. */
export function composeToolDisposers(disposers: Array<() => void>): () => void {
  return () => {
    const errors: unknown[] = []
    for (const dispose of disposers.splice(0).reverse()) {
      try { dispose() } catch (error) { errors.push(error) }
    }
    if (errors.length > 0) throw new AggregateError(errors, 'Could not unregister Codex tools')
  }
}

function terminalResultView(result: ToolResult): TerminalResultView | undefined {
  if (result.isError) return undefined
  const meta = typeof result.meta === 'object' && result.meta !== null && !Array.isArray(result.meta)
    ? result.meta as { output?: unknown; exitCode?: unknown }
    : undefined
  if (typeof meta?.output !== 'string') return undefined
  return {
    card: 'terminal',
    output: meta.output,
    ...typeof meta.exitCode === 'number' ? { exitCode: meta.exitCode } : {},
  }
}

export function registerExecTools(ctx: Context, config: ExecToolConfig): () => void {
  const tools = ctx.get('tools')
  if (tools === undefined) throw new Error('Codex execution tools require ctx.tools')
  const shell = ctx.get('shell')
  if (shell === undefined) throw new Error('Codex execution tools require ctx.shell')
  const confines = shell.sandboxMode !== undefined
  if (confines && ctx.get('sandboxPolicy') === undefined) throw new Error('Codex execution tools: a sandboxing shell requires ctx.sandboxPolicy')
  const metadata = {
    capability: 'terminalToolsEnabled' as const,
    presetEnabled: config.presetEnabled !== false,
    ...(config.presetOverridesLegacy ? { presetOverridesLegacy: true } : {}),
  }
  const ownedAgents = new Set<Agent>()
  const offDisposed = typeof (ctx as Partial<Context>).on === 'function'
    ? ctx.on('agent/disposed', ({ agent }) => {
      ownedAgents.delete(agent)
      disposeAgentExecSessions(agent)
    })
    : () => {}
  const cleanupOwned = (): void => {
    offDisposed()
    for (const agent of [...ownedAgents]) {
      ownedAgents.delete(agent)
      disposeAgentExecSessions(agent)
    }
  }

  let unregisterExec: (() => void) | undefined
  try {
    unregisterExec = tools.register(markCodexTool(defineTool({
      name: 'exec_command',
      description: EXEC_COMMAND_DESCRIPTION,
      parameters: {
        cmd: { type: 'string', required: true, description: 'Shell command to execute.' },
        workdir: { type: 'string', description: 'Working directory for the command. Defaults to the turn cwd.' },
        tty: { type: 'boolean', description: confines ? 'This host cannot carry sandbox policy into a PTY; omit tty or use false.' : 'True allocates a PTY for the command; false or omitted uses plain pipes.' },
        run_in_background: { type: 'boolean', description: 'Run as a DSH background job and return its job id immediately; collect output with job_output and stop it with job_kill. Only supported for pipe-backed commands.' },
        yield_time_ms: { type: 'number', description: 'Wait before yielding output. Defaults to 10000 ms; effective range is 250-30000 ms.' },
        max_output_tokens: { type: 'number', description: 'Output token budget. Defaults to 10000 tokens; larger requests may be capped by policy.' },
        ...confines ? {
          sandbox_permissions: { type: 'string' as const, enum: [...ESCALATION_TARGETS], description: sandboxPermissionsDescription('command') },
          justification: { type: 'string' as const, description: 'Required with sandbox_permissions: one sentence for the user explaining why this exact command needs the wider access. Use the language of the user’s current request.' },
        } : {},
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            chunk_id: { type: 'string' },
            wall_time_seconds: { type: 'number', required: true },
            exit_code: { type: 'number' },
            session_id: { type: 'number' },
            job_id: { type: 'string' },
            original_token_count: { type: 'number' },
            output: { type: 'string', required: true },
          },
        },
        render: (_args, value) => [{ type: 'text', text: renderExecResult(value) }],
        presentationMeta: (_args, value) => ({
          output: value.output,
          ...value.exit_code === undefined ? {} : { exitCode: value.exit_code },
          ...value.job_id === undefined ? {} : { jobId: value.job_id },
        }),
      },
      async execute(args: ExecCommandArgs, exec): Promise<ExecResult> {
        assertCapabilityEnabled(ctx, config.currentSettings, 'exec_command', exec.agent, metadata, config.authority)
        const result = await runExecCommand(ctx, args, exec, config)
        if (result.session_id !== undefined && exec.agent !== undefined) ownedAgents.add(exec.agent)
        return result
      },
      presentCall: args => args.run_in_background === true
        ? { card: 'generic', title: args.cmd, kind: 'execute', rawInput: args.cmd }
        : { card: 'terminal', title: args.cmd, ...args.workdir === undefined ? {} : { cwd: args.workdir } },
      presentResult: (args, result) => args.run_in_background === true ? undefined : terminalResultView(result),
    }), metadata), { when: context => codexToolEnabled(ctx, context?.agent, 'exec_command', metadata, config.currentSettings, config.authority) })

    const unregisterStdin = tools.register(markCodexTool(defineTool({
      name: 'write_stdin',
      description: WRITE_STDIN_DESCRIPTION,
      parameters: {
        session_id: { type: 'number', required: true, description: 'Identifier of the running unified exec session.' },
        chars: { type: 'string', description: 'Characters to send to a PTY session created with tty=true. Leave empty to poll output without writing; pipe-backed sessions accept empty chars to poll or "\\u0003" to interrupt.' },
        yield_time_ms: { type: 'number', description: 'Wait before yielding output. Non-empty writes default to 250 ms and cap at 30000 ms; empty polls wait 5000-300000 ms by default.' },
        max_output_tokens: { type: 'number', description: 'Output token budget. Defaults to 10000 tokens; larger requests may be capped by policy.' },
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            chunk_id: { type: 'string' },
            wall_time_seconds: { type: 'number', required: true },
            exit_code: { type: 'number' },
            session_id: { type: 'number' },
            original_token_count: { type: 'number' },
            output: { type: 'string', required: true },
          },
        },
        render: (_args, value) => [{ type: 'text', text: renderExecResult(value) }],
        presentationMeta: (_args, value) => ({
          output: value.output,
          ...value.exit_code === undefined ? {} : { exitCode: value.exit_code },
        }),
      },
      async execute(args: WriteStdinArgs, exec): Promise<ExecResult> {
        assertCapabilityEnabled(ctx, config.currentSettings, 'write_stdin', exec.agent, metadata, config.authority)
        return runWriteStdin(ctx, args, exec, config)
      },
      presentCall: args => ({ card: 'terminal', title: `write_stdin #${args.session_id}` }),
      presentResult: (_args, result) => terminalResultView(result),
    }), metadata), { when: context => codexToolEnabled(ctx, context?.agent, 'write_stdin', metadata, config.currentSettings, config.authority) })

    return composeToolDisposers([cleanupOwned, unregisterExec, unregisterStdin])
  } catch (error) {
    cleanupOwned()
    unregisterExec?.()
    throw error
  }
}

export function registerPlanTool(
  ctx: Context,
  currentSettings: () => CodexSettings,
  presetEnabled = true,
  authority?: boolean,
  presetOverridesLegacy = false,
): () => void {
  const tools = ctx.get('tools')
  if (tools === undefined) throw new Error('Codex plan tools require ctx.tools')
  const metadata = {
    capability: 'planToolEnabled' as const,
    presetEnabled,
    ...(presetOverridesLegacy ? { presetOverridesLegacy: true } : {}),
  }
  return tools.register(markCodexTool(defineTool({
    name: 'update_plan',
    description: UPDATE_PLAN_DESCRIPTION,
    parameters: {
      explanation: { type: 'string', description: 'Optional explanation for this plan update.' },
      plan: {
        type: 'array',
        required: true,
        description: 'The list of steps',
        items: {
          type: 'object',
          additionalProperties: false,
          properties: {
            step: { type: 'string', required: true, description: 'Task step text.' },
            status: { type: 'string', required: true, enum: [...PLAN_STATUSES], description: 'Step status.' },
          },
        },
      },
    },
    output: {
      schema: { type: 'object', additionalProperties: false, properties: {} },
      render: () => [{ type: 'text', text: 'Plan updated' }],
    },
    execute(args: UpdatePlanArgs, exec): Promise<Record<string, never>> {
      assertCapabilityEnabled(ctx, currentSettings, 'update_plan', exec.agent, metadata, authority)
      const agent = exec.agent
      if (agent === undefined) throw new Error('update_plan requires an owning agent session')
      const events = typeof agent.session.snapshotEvents === 'function'
        ? agent.session.snapshotEvents() as ReadonlyArray<{ type: string; data?: unknown }>
        : undefined
      const planEvent = events?.findLast(event => event.type === 'plan/mode')
      if ((planEvent?.data as { active?: unknown } | undefined)?.active === true) {
        throw new Error('update_plan is a task-execution checklist tool and is not allowed in plan mode; submit your plan via exit_plan_mode')
      }
      agent.session.append('todo/write', { todos: planTodos(args) })
      return Promise.resolve({})
    },
  }), metadata), { when: context => codexToolEnabled(ctx, context?.agent, 'update_plan', metadata, currentSettings, authority) })
}

/** Select only the execution/plan/patch contributions; omitted execution/plan flags mean enabled, patch defaults false. */
export interface CodexExecAndPlanOptions {
  terminal?: boolean
  plan?: boolean
  patch?: boolean
  defaultYieldTimeMs?: number
  pollYieldTimeMs?: number
  writeYieldTimeMs?: number
  maxOutputBytes?: number
  /** Internal compiled-plan authority; omitted preserves the unsnapshotted compatibility path. */
  capabilityAuthority?: Partial<Record<CodexCapability, boolean>>
}

/**
 * Register selected Codex tools through the existing pipeline, without prompt hooks.
 * Compiled adapters receive authority once; the disposer supports an additional owner.
 */
export function registerCodexExecAndPlan(ctx: Context, options: CodexExecAndPlanOptions = {}): () => void {
  const currentSettings = (): CodexSettings => ({
    ...CODEX_SETTINGS_ENTRY,
    ...readHostSettings<CodexSettings>(ctx, CODEX_SETTINGS_NAMESPACE),
  })
  const disposers: Array<() => void> = []
  const dispose = composeToolDisposers(disposers)
  try {
    if (options.terminal !== false) disposers.push(registerExecTools(ctx, {
      defaultYieldTimeMs: options.defaultYieldTimeMs ?? 10_000,
      pollYieldTimeMs: options.pollYieldTimeMs ?? 5_000,
      writeYieldTimeMs: options.writeYieldTimeMs ?? 250,
      maxOutputBytes: options.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES,
      currentSettings,
      ...(options.capabilityAuthority?.terminalToolsEnabled === undefined ? {} : { authority: options.capabilityAuthority.terminalToolsEnabled }),
    }))
    if (options.plan !== false) disposers.push(registerPlanTool(ctx, currentSettings, true, options.capabilityAuthority?.planToolEnabled))
    if (options.patch === true) disposers.push(registerPatchTool(ctx, currentSettings, true, options.capabilityAuthority?.patchToolEnabled))
    return dispose
  } catch (error) {
    dispose()
    throw error
  }
}
