/** Experimental asymmetric hybrid executor: direct Codex wire tools + `run_code` SDK batching. */
import { symbols, type Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import type { PtcRuntime } from '@deepseek-ai/dsh-ptc-runtime'
import { ESCALATION_TARGETS } from '@deepseek-ai/dsh-sandbox'
import type {} from '@deepseek-ai/dsh-system-prompt'
import { defineTool, parameterSchemaSpecToJsonSchema, projectToolSchema, RUN_CODE_NAME, ToolNotFoundError } from '@deepseek-ai/dsh-tools'
import type { ToolBatchInput, ToolBatchResult, ToolDefinition, ToolExecutor, ToolModelInput, ToolPromptSection } from '@deepseek-ai/dsh-tools'
import { executeToolBatch, toolErrorMessage, ToolExecutionPipeline } from '@deepseek-ai/dsh-tools/pipeline'
import { renderHybridToolsSdk } from './hybrid-sdk.ts'
import { CodeResetFailedError, HybridProgramCalls, renderRunCodeValue } from './program-calls.ts'
import {
  escalationGuidance,
  executeHybridRunCode,
  requirePtcRuntime,
  resolveProgramFormat,
  resolveRunCodeDescription,
  resolveSandboxPolicy,
  type RunCodeArgs,
  type RunCodeOutput,
} from './subcall-scheduler.ts'

/** Direct wire tools called natively alongside `run_code` (omitted from `tools:sdk`). */
export const DEFAULT_HYBRID_DIRECT_TOOLS = [
  'exec_command',
  'write_stdin',
  'apply_patch',
  'update_plan',
  'activate_tools',
  'read_image',
  'web_search',
  'ask_user_question',
  'exit_plan_mode',
  'skill',
  'present',
  'ralph',
  'workflow',
  'create_goal',
  'get_goal',
  'update_goal',
  'goal',
] as const

export interface Config {
  /** Native wire tools kept directly callable (not placed in `tools:sdk`). */
  directTools: string[]
  /** Source tools hidden from the preset scope while keeping companion plugins (e.g. `todos` projection). */
  hiddenTools: string[]
  /** Unconditional tools deferred via `activate_tools` / `deferLoading: true` by default. */
  deferredTools: string[]
  /** Permit calling direct wire tools inside `run_code` as well (default false). */
  allowNestedDirectTools: boolean
  /** Maximum concurrent direct/outer calls in one model batch. */
  maxParallelToolCalls: number
  /** Maximum overlapping concurrency-safe subcalls inside `run_code`. */
  maxParallelSubCalls: number
  /** Nested tool-call attempts per minute of runtime timeout budget. */
  maxSubCallsPerMinute: number
}

export const Config: z<Partial<Config>, Config> = z.object({
  directTools: z.array(z.string()).default([...DEFAULT_HYBRID_DIRECT_TOOLS]),
  hiddenTools: z.array(z.string()).default([]),
  deferredTools: z.array(z.string()).default([]),
  allowNestedDirectTools: z.boolean().default(false),
  maxParallelToolCalls: z.natural().min(1).default(10),
  maxParallelSubCalls: z.natural().min(1).default(10),
  maxSubCallsPerMinute: z.natural().min(1).default(1024),
})

const HYBRID_INSTRUCTION = [
  'This session uses an asymmetric hybrid tool architecture:',
  `- Direct wire tools (such as \`apply_patch\`, \`exec_command\`, \`write_stdin\`, \`update_plan\`, \`activate_tools\`, etc.) are declared natively — call them directly as normal tool calls, NOT inside \`${RUN_CODE_NAME}\`.`,
  `- SDK-only tools (listed under \`tools:sdk\`, such as file reading/searching, \`web_fetch\`, and subagent helpers) are callable ONLY inside \`${RUN_CODE_NAME}\` via \`await tools.<name>(args)\` — direct tool calls to SDK-only names fail.`,
  `- Prefer batching multiple independent reads/searches in a single \`${RUN_CODE_NAME}\` program with \`Promise.all\`, filtering raw data in code, and returning concise findings before applying edits with \`apply_patch\`.`,
].join('\n')

const RUN_CODE_DESCRIPTION_PARAM_DESCRIPTION =
  'Clear, concise description of what this program does in active voice, 5-10 words (shown in the UI).'

const RUN_CODE_CONTROLS = {
  timeoutMs: { type: 'number', description: 'Positive elapsed-time budget in milliseconds, capped by the deployment maximum.' },
  sandbox_permissions: { type: 'string', enum: [...ESCALATION_TARGETS], description: 'Wider sandbox mode for this complete program execution; requires justification and approval.' },
  justification: { type: 'string', description: 'Reason this complete program needs wider access, shown to the user for approval. Use the language of the user\'s current request.' },
} as const

function unwrapRuntime(runtime: PtcRuntime): PtcRuntime {
  let provider = runtime
  for (;;) {
    const original = (provider as PtcRuntime & { [symbols.original]?: PtcRuntime })[symbols.original]
    if (original === undefined) return provider
    provider = original
  }
}

/** Asymmetric hybrid executor: direct Codex tools on the wire + SDK batching via `run_code`. */
export class CodexHybridExecutor implements ToolExecutor {
  readonly sections: readonly ToolPromptSection[]
  private readonly pipeline: ToolExecutionPipeline
  private readonly config: Config
  private readonly directTools: ReadonlySet<string>
  private readonly hiddenTools: ReadonlySet<string>
  private readonly calls: HybridProgramCalls
  private runCodeTool: ToolDefinition | undefined

  constructor(private readonly ctx: Context, config: Partial<Config> = {}) {
    this.config = Config(config)
    this.directTools = new Set(this.config.directTools.map(item => item.trim()).filter(Boolean))
    this.hiddenTools = new Set(this.config.hiddenTools.map(item => item.trim()).filter(Boolean))
    this.calls = new HybridProgramCalls(ctx)
    const tools = ctx.tools
    this.sections = [
      {
        name: 'tools:hybrid',
        order: ctx.systemPrompt.getSectionOrder('PTC_ONLY'),
        text: HYBRID_INSTRUCTION,
        interpolate: false,
      },
      {
        name: 'tools:sdk',
        order: ctx.systemPrompt.getSectionOrder('TOOLS_SDK'),
        text: visibleTools => this.renderSdk(visibleTools),
        interpolate: false,
      },
    ]
    this.pipeline = new ToolExecutionPipeline(ctx, {
      get: (name, scope, toolSet) => (
        this.hiddenTools.has(name)
          ? undefined
          : name === RUN_CODE_NAME
            ? this.requireRunCodeTool()
            : tools.executable(name, scope, toolSet)
      ),
      reject: (name, nested) => {
        if (this.hiddenTools.has(name)) {
          return new ToolNotFoundError(name, `\`${name}\` is hidden in this preset`)
        }
        if (!nested) {
          if (name === RUN_CODE_NAME || this.isDirectTool(name)) return undefined
          return new ToolNotFoundError(name, `only callable inside \`${RUN_CODE_NAME}\` via \`await tools.${name}(...)\` in hybrid mode`)
        }
        if (!this.config.allowNestedDirectTools && (name === RUN_CODE_NAME || this.isDirectTool(name))) {
          return new ToolNotFoundError(name, `call \`${name}\` directly as a tool call rather than inside \`${RUN_CODE_NAME}\``)
        }
        return undefined
      },
    })
  }

  isDirectTool(name: string): boolean {
    return this.directTools.has(name)
  }

  describe(tools: readonly ToolDefinition[]): ToolModelInput {
    const directSchemas = tools
      .filter(definition => !this.hiddenTools.has(definition.name) && this.isDirectTool(definition.name))
      .map(definition => projectToolSchema(definition, false))
    return {
      schemas: [...directSchemas, projectToolSchema(this.requireRunCodeTool(), false)],
    }
  }

  private renderSdk(tools: readonly ToolDefinition[]): string {
    const runtime = requirePtcRuntime(this.ctx)
    const sdkTools = tools.filter(definition =>
      !this.hiddenTools.has(definition.name)
      && (this.config.allowNestedDirectTools || !this.isDirectTool(definition.name)))
    return renderHybridToolsSdk(
      sdkTools.map(definition => ({
        ...projectToolSchema(definition, false),
        output: definition.output.schema,
      })),
      runtime.language,
      resolveProgramFormat(runtime),
    )
  }

  execute(input: ToolBatchInput): Promise<ToolBatchResult> {
    return executeToolBatch(input, this.pipeline, () => this.config.maxParallelToolCalls)
  }

  async reset(agent: Agent): Promise<void> {
    const runtime = requirePtcRuntime(this.ctx)
    if (!runtime.retainsState) {
      throw new CodeResetFailedError('The PTC runtime does not retain an environment')
    }
    try {
      await this.calls.reset(agent.session.id, () => runtime.release(agent), () => {
        agent.inject(createUserMessage({
          content: [{ type: 'text', text: 'Program environment reset; retained variables cleared. Completed tool effects remain.' }],
          source: { kind: 'ptc-mode' },
        }))
      })
    } catch (error) {
      throw new CodeResetFailedError(`Program environment reset failed: ${toolErrorMessage(error)}. State may not be cleared; retry the host reset before running more code.`)
    }
  }

  private requireRunCodeTool(): ToolDefinition {
    this.runCodeTool ??= this.createRunCodeTool()
    return this.runCodeTool
  }

  private createRunCodeTool(): ToolDefinition {
    const ctx = this.ctx
    const config = this.config
    const calls = this.calls
    const stateOwners = new WeakMap<object, WeakSet<PtcRuntime>>()
    const runHost = {
      ctx,
      pipeline: this.pipeline,
      allowNestedDirectTools: config.allowNestedDirectTools,
      maxParallelSubCalls: config.maxParallelSubCalls,
      maxSubCallsPerMinute: config.maxSubCallsPerMinute,
      stateOwners,
      isDirect: (toolName: string) => this.isDirectTool(toolName),
      unwrapRuntime,
    }

    const definition = defineTool({
      name: RUN_CODE_NAME,
      description: 'Execute a program against SDK tools declared in `tools:sdk`.',
      parameters: {
        code: { type: 'string', required: true, description: 'The program to execute.' },
        description: { type: 'string', required: true, description: RUN_CODE_DESCRIPTION_PARAM_DESCRIPTION },
        ...RUN_CODE_CONTROLS,
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            logs: { type: 'array', required: true, items: { type: 'string' } },
            result: { type: 'json' },
            sandbox: {
              type: 'object',
              additionalProperties: false,
              properties: {
                mode: { type: 'string', required: true, enum: ['read-only', 'workspace-write', 'danger-full-access'] },
                denied: { type: 'boolean', required: true },
                enforcement: { type: 'string', enum: ['full', 'partial'] },
              },
            },
          },
        },
        render: (_args, value) => {
          const rendered = value.result === undefined ? '' : renderRunCodeValue(value.result)
          const parts = [value.logs.join('\n'), rendered].filter(part => part.length > 0)
          if (value.sandbox?.enforcement === 'partial') parts.push('File sandbox enforcement is partial on this host.')
          if (value.sandbox?.denied) {
            parts.push(`The ${value.sandbox.mode} file sandbox denied an operation.${escalationGuidance(ctx.get('ptcRuntime')?.sandboxMode)}`)
          }
          return [{ type: 'text', text: parts.length > 0 ? parts.join('\n') : '(run_code completed with no output)' }]
        },
      },
      async execute(rawArgs: RunCodeArgs, exec): Promise<RunCodeOutput> {
        if (rawArgs.description.trim().length === 0) {
          throw new Error('invalid description: expected a non-empty string')
        }
        const runtime = requirePtcRuntime(ctx)
        const run = (callSignal: AbortSignal) => executeHybridRunCode(runHost, rawArgs, exec, callSignal)
        return exec.agent === undefined || (runtime.sandboxMode === undefined && !runtime.retainsState)
          ? run(exec.signal)
          : calls.run(
            exec.agent.session.id,
            exec.signal,
            () => runtime.sandboxMode === undefined ? undefined : resolveSandboxPolicy(ctx, exec).mode,
            run,
          )
      },
      presentCall: args => ({
        card: 'generic',
        title: args.description,
        kind: 'execute',
        rawInput: args.code,
      }),
    })

    Object.defineProperty(definition, 'description', {
      enumerable: true,
      get: () => resolveRunCodeDescription(requirePtcRuntime(ctx)),
    })
    Object.defineProperty(definition, 'parameters', {
      enumerable: true,
      get: () => {
        const runtime = requirePtcRuntime(ctx)
        const codeDescription = runtime.language === 'python'
          ? 'The Python program to execute against `tools`.'
          : 'The TypeScript program (function body supporting top-level `await` and `return`) to execute against `tools`.'
        return parameterSchemaSpecToJsonSchema({
          code: { type: 'string', required: true, description: codeDescription },
          description: { type: 'string', required: true, description: RUN_CODE_DESCRIPTION_PARAM_DESCRIPTION },
          ...(runtime.timeout === undefined ? {} : {
            timeoutMs: {
              ...RUN_CODE_CONTROLS.timeoutMs,
              description: `Positive elapsed-time budget in milliseconds, including nested waits. Default ${runtime.timeout.defaultMs}; capped at ${runtime.timeout.maxMs}.`,
            },
          }),
          ...(runtime.sandboxMode === undefined ? {} : {
            sandbox_permissions: RUN_CODE_CONTROLS.sandbox_permissions,
            justification: RUN_CODE_CONTROLS.justification,
          }),
        })
      },
    })
    return definition as ToolDefinition
  }
}
