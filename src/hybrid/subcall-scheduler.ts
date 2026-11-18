/** Concurrent/exclusive nested subcall queue and `run_code` execution runtime for hybrid mode. */
import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { createUserMessage, HarnessError, ToolCallId } from '@deepseek-ai/dsh-llm'
import type { ContentBlock, ToolSchema } from '@deepseek-ai/dsh-llm'
import type { PtcBindingFunction, PtcJsonValue, PtcProgramFormat, PtcRunResult, PtcRuntime } from '@deepseek-ai/dsh-ptc-runtime'
import { approveEscalation, validateEscalationArgs } from '@deepseek-ai/dsh-sandbox'
import type { SandboxExecutionPolicy, SandboxMode } from '@deepseek-ai/dsh-sandbox'
import { scopeTarget } from '@deepseek-ai/dsh-scope'
import type { Scoped } from '@deepseek-ai/dsh-scope'
import { RUN_CODE_NAME, TOOL_ABORTED } from '@deepseek-ai/dsh-tools'
import type { ToolExecution, ToolExecutionInput, ToolExecutionResult, ToolRunContext, ToolsService } from '@deepseek-ai/dsh-tools'
import { toolErrorMessage, ToolExecutionPipeline, type ScheduledToolDispatch } from '@deepseek-ai/dsh-tools/pipeline'
import { CodeRunFailedError, deepFreeze, jsonNormalizeArgs } from './program-calls.ts'

export interface PtcDispatchStartEventData {
  rootCallId: ToolCallId
  parentCallId: ToolCallId
  subCallId: ToolCallId
  name: string
  arguments: unknown
}

export interface PtcDispatchEventData extends PtcDispatchStartEventData {
  isError: boolean
  content: ContentBlock[]
  meta?: PtcJsonValue
  error?: { name: string; code: string; reason?: string }
}

export interface PtcDispatchLog {
  readonly exec: ToolExecution
  readonly agent?: Agent
  readonly subCallId: ToolCallId
  readonly name: string
  readonly isError: boolean
  readonly content: ContentBlock[]
}

declare module '@deepseek-ai/cordis' {
  interface Events {
    'tools/ptc-dispatch-log'(
      this: Scoped<ToolsService>,
      dispatch: PtcDispatchLog,
      next: () => Promise<ContentBlock[]>,
    ): Promise<ContentBlock[]>
  }
}

declare module '@deepseek-ai/dsh-session/types' {
  interface SessionEventMap {
    'tool/ptc-dispatch-start': PtcDispatchStartEventData
    'tool/ptc-dispatch': PtcDispatchEventData
  }
}

declare module '@deepseek-ai/dsh-llm' {
  interface MessageSourceMap {
    'ptc-mode': { kind: 'ptc-mode' }
  }
}

export type PtcSdkLanguage = 'typescript' | 'python'
export type SupportedPtcRuntime = PtcRuntime & { readonly language: PtcSdkLanguage }

export interface RunCodeOutput {
  logs: string[]
  result?: PtcJsonValue
  sandbox?: {
    mode: SandboxMode
    denied: boolean
    enforcement?: 'full' | 'partial'
  }
}

export interface RunCodeArgs {
  code: string
  description: string
  timeoutMs?: number
  sandbox_permissions?: string
  justification?: string
}

class ToolCallLimitExceededError extends Error {
  constructor(limit: number, windowMs: number) {
    super(`run_code exceeded its tool-call budget (${limit} calls in ${windowMs}ms)`)
    this.name = 'ToolCallLimitExceededError'
  }
}

export function requirePtcRuntime(ctx: Context): SupportedPtcRuntime {
  const runtime = ctx.get('ptcRuntime')
  if (runtime === undefined) {
    throw new Error('codex-hybrid-executor: requires a mounted ctx.ptcRuntime implementation')
  }
  if (runtime.language !== 'typescript' && runtime.language !== 'python') {
    throw new Error(`codex-hybrid-executor: unsupported PTC runtime language ${JSON.stringify(runtime.language)}`)
  }
  return runtime as SupportedPtcRuntime
}

export function resolveProgramFormat(runtime: PtcRuntime): PtcProgramFormat {
  return runtime.programFormat ?? 'function-body'
}

export function escalationGuidance(mode: PtcRuntime['sandboxMode']): string {
  return mode === undefined ? ''
    : ' A sandbox escalation approves this complete program for one execution only. Nested tools retain their own policies and approvals. Request wider access only after evidence of a denial. Earlier effects may already have completed: inspect them before explicitly retrying.'
}

export function resolveRunCodeDescription(runtime: SupportedPtcRuntime): string {
  const langLabel = runtime.language === 'python' ? 'Python' : 'TypeScript'
  const formatNote = runtime.language === 'typescript' && resolveProgramFormat(runtime) === 'function-body'
    ? 'the BODY of an async TypeScript function (erasable syntax only; top-level `await` and `return` work)'
    : `the ${langLabel} program to execute`
  const extra = runtime.executionInstructions ? ` ${runtime.executionInstructions}` : ''
  return `Execute a ${langLabel} program against the SDK tools declared in \`tools:sdk\`. Takes \`code\` (${formatNote}) and \`description\`. `
    + 'Call SDK tools via `await tools.name(args)`. Direct wire tools stay outside `run_code`. Image-bearing subtool results are attached after the run.'
    + extra
    + ' Each program starts in the Session current directory.'
    + escalationGuidance(runtime.sandboxMode)
}

async function resolveWorkingDirectory(ctx: Context, exec: ToolRunContext): Promise<string | undefined> {
  if (exec.agent === undefined) return undefined
  const directories = exec.agent.ctx.get('workingDirectory') ?? ctx.get('workingDirectory')
  if (directories === undefined) throw new Error('codex-hybrid: run_code with an Agent requires workingDirectory')
  return directories.ensure(exec.agent, exec.signal)
}

export function resolveSandboxPolicy(ctx: Context, exec: ToolRunContext): SandboxExecutionPolicy {
  const policy = exec.agent?.ctx.get('sandboxPolicy') ?? ctx.get('sandboxPolicy')
  if (policy === undefined) throw new Error('codex-hybrid: confined PTC runtime requires sandboxPolicy')
  return policy.resolve(exec.agent === undefined ? {} : { session: exec.agent.session })
}

export interface HybridRunHost {
  readonly ctx: Context
  readonly pipeline: ToolExecutionPipeline
  readonly allowNestedDirectTools: boolean
  readonly maxParallelSubCalls: number
  readonly maxSubCallsPerMinute: number
  readonly stateOwners: WeakMap<object, WeakSet<PtcRuntime>>
  readonly isDirect: (name: string) => boolean
  readonly unwrapRuntime: (runtime: PtcRuntime) => PtcRuntime
}

export async function executeHybridRunCode(
  host: HybridRunHost,
  rawArgs: RunCodeArgs,
  exec: ToolRunContext,
  callSignal: AbortSignal,
): Promise<RunCodeOutput> {
  const { ctx, pipeline } = host
  const tools = ctx.tools
  const runtime = requirePtcRuntime(ctx)
  validateEscalationArgs(rawArgs.sandbox_permissions, rawArgs.justification)
  if (rawArgs.timeoutMs !== undefined && runtime.timeout === undefined) {
    throw new Error('timeoutMs is not available for this PTC runtime')
  }
  if (rawArgs.timeoutMs !== undefined && (!Number.isFinite(rawArgs.timeoutMs) || rawArgs.timeoutMs <= 0)) {
    throw new Error('invalid timeoutMs: expected a positive finite number')
  }
  const standingPolicy = runtime.sandboxMode === undefined ? undefined : resolveSandboxPolicy(ctx, exec)
  let policy = standingPolicy
  if (rawArgs.sandbox_permissions !== undefined && rawArgs.justification !== undefined) {
    if (standingPolicy === undefined) throw new Error('sandbox_permissions is not available for this PTC runtime')
    const approver = exec.agent?.ctx.get('approval') ?? ctx.get('approval')
    const approvedMode = await approveEscalation({
      requestedMode: rawArgs.sandbox_permissions,
      justification: rawArgs.justification,
      effectiveMode: standingPolicy.mode,
      subject: 'program',
    }, { approver, agent: exec.agent, callId: exec.callId, toolName: RUN_CODE_NAME, signal: callSignal })
    policy = { ...standingPolicy, mode: approvedMode }
  }
  const cwd = await resolveWorkingDirectory(ctx, { ...exec, signal: callSignal })
  callSignal.throwIfAborted()

  const runController = new AbortController()
  const onOuterAbort = (): void => { runController.abort(callSignal.reason) }
  callSignal.addEventListener('abort', onOuterAbort, { once: true })

  let dispatches = 0
  let maxSubCalls = Infinity
  let subCallWindowMs = 60_000
  let subSeq = 1
  let closed = false

  interface PendingDispatch {
    start(): Promise<void>
    classify(): 'parallel' | 'exclusive'
    abandon(): void
    commit(): Promise<void>
    flight: Promise<void>
    settled: boolean
    mode?: 'parallel' | 'exclusive'
  }

  const pendingQueue: PendingDispatch[] = []
  const commitQueue: PendingDispatch[] = []
  const inFlight = new Set<Promise<void>>()
  const logWork = new Set<Promise<void>>()
  let exclusiveActive = false
  let driving = false
  let driverRun: Promise<void> = Promise.resolve()
  let wake: (() => void) | undefined
  const wakeup = (): void => {
    const release = wake
    wake = undefined
    release?.()
  }

  const shapeDispatchLog = async (dispatch: PtcDispatchLog): Promise<ContentBlock[]> => {
    try {
      return await ctx.waterfall(
        scopeTarget(tools, dispatch.agent),
        'tools/ptc-dispatch-log',
        dispatch,
        () => Promise.resolve(dispatch.content),
      )
    } catch (error: unknown) {
      ctx.logger.warn(`codex-hybrid: ptc-dispatch-log listener failed for ${dispatch.name}: ${toolErrorMessage(error)}`)
      return dispatch.content
    }
  }

  const drive = (): Promise<void> => {
    if (driving) return driverRun
    driving = true
    driverRun = (async () => {
      try {
        for (;;) {
          const waitSignal = new Promise<void>((resolve) => { wake = resolve })
          const commitHead = commitQueue[0]
          if (commitHead !== undefined && commitHead.settled) {
            commitQueue.shift()
            await commitHead.commit()
            if (commitHead.mode === 'exclusive') exclusiveActive = false
            continue
          }
          const head = pendingQueue[0]
          if (head !== undefined && !closed && !runController.signal.aborted && !exclusiveActive) {
            const mode = head.classify()
            const canStart = mode === 'parallel'
              ? inFlight.size < host.maxParallelSubCalls && commitQueue.every(entry => entry.mode !== 'exclusive')
              : inFlight.size === 0 && commitQueue.length === 0
            if (canStart) {
              pendingQueue.shift()
              head.mode = mode
              if (mode === 'exclusive') exclusiveActive = true
              await head.start()
              commitQueue.push(head)
              if (!head.settled) {
                const wrapped = head.flight.finally(() => {
                  inFlight.delete(wrapped)
                  wakeup()
                })
                inFlight.add(wrapped)
              }
              continue
            }
          }
          if (pendingQueue.length === 0 && commitQueue.length === 0 && inFlight.size === 0) break
          if ((closed || runController.signal.aborted) && commitQueue.length === 0 && inFlight.size === 0) break
          await waitSignal
        }
      } finally {
        driving = false
      }
    })()
    return driverRun
  }

  const drainDispatches = async (): Promise<void> => {
    closed = true
    while (pendingQueue.length > 0) pendingQueue.shift()!.abandon()
    wakeup()
    await drive()
    await Promise.allSettled(inFlight)
    while (commitQueue.length > 0) {
      const entry = commitQueue.shift()!
      if (entry.settled) await entry.commit()
    }
    await Promise.allSettled(logWork)
  }

  const runOver = (): boolean => closed || runController.signal.aborted || callSignal.aborted

  const binding = (schema: Readonly<ToolSchema>): PtcBindingFunction => async (rawBindingArgs: unknown): Promise<PtcJsonValue> => {
    if (runOver()) {
      throw new Error(`run_code run is over (${String(runController.signal.reason)}); cannot start ${schema.name}`)
    }
    dispatches++
    if (dispatches > maxSubCalls) {
      const limitError = new ToolCallLimitExceededError(maxSubCalls, subCallWindowMs)
      runController.abort(limitError)
      throw limitError
    }
    const normalized = jsonNormalizeArgs(rawBindingArgs)
    const subCallId = ToolCallId(`${exec.callId}:ptc:${subSeq++}`)
    const input: ToolExecutionInput = {
      callId: subCallId,
      rootCallId: exec.rootCallId,
      name: schema.name,
      arguments: normalized.dispatched,
      ...(exec.agent === undefined ? {} : { agent: exec.agent }),
      ...(exec.toolSet === undefined ? {} : { toolSet: exec.toolSet }),
      schema,
      signal: runController.signal,
      parent: exec.token,
    }
    const outcome = await new Promise<{ isError: false; value: PtcJsonValue } | { isError: true; message: string }>((resolve, reject) => {
      let parked: (ScheduledToolDispatch & { exec: ToolRunContext }) | undefined
      const settle = (result: ToolExecutionResult): void => {
        resolve(result.isError
          ? { isError: true, message: result.error.message }
          : { isError: false, value: result.value as PtcJsonValue })
        if (exec.agent === undefined) return
        const agent = exec.agent
        const task = (async () => {
          const logged = await shapeDispatchLog({
            exec, agent, subCallId, name: schema.name, isError: result.isError, content: result.content,
          })
          agent.session.append('tool/ptc-dispatch', {
            rootCallId: exec.rootCallId,
            parentCallId: exec.callId,
            subCallId,
            name: schema.name,
            arguments: normalized.logged,
            isError: result.isError,
            ...(result.error?.info === undefined ? {} : { error: result.error.info }),
            content: logged,
            ...(result.meta === undefined ? {} : { meta: result.meta as PtcJsonValue }),
          })
        })().finally(() => { logWork.delete(task) })
        logWork.add(task)
      }
      pendingQueue.push({
        flight: Promise.resolve(),
        settled: false,
        classify: () => pipeline.executionMode(input).kind,
        abandon: () => {
          reject(new Error(`run_code run is over (${String(runController.signal.reason)}); ${schema.name} tool call abandoned`))
        },
        async start(): Promise<void> {
          exec.agent?.session.append('tool/ptc-dispatch-start', {
            rootCallId: exec.rootCallId, parentCallId: exec.callId, subCallId, name: schema.name, arguments: normalized.logged,
          })
          const prepared = await pipeline.prepare(input)
          if (prepared.kind === 'dispatch') {
            this.flight = pipeline.dispatch(prepared.exec).then((dispatchOutcome) => {
              parked = { ...dispatchOutcome, exec: prepared.exec }
              this.settled = true
            })
            return
          }
          parked = { kind: prepared.kind, exec: prepared.exec, result: prepared.result }
          this.settled = true
        },
        async commit(): Promise<void> {
          if (parked === undefined) return
          const result = await pipeline.complete(parked.exec, parked)
          if (!result.isError && result.content.some(block => block.type === 'image')) {
            exec.deferContext(createUserMessage({ content: result.content, source: { kind: 'ptc-mode' } }))
          }
          for (const context of result.additionalContexts ?? []) exec.deferContext(context)
          if (result.concludesTurn) exec.concludeTurn()
          settle(result)
          while (logWork.size > host.maxParallelSubCalls) await Promise.race(logWork)
        },
      })
      wakeup()
      void drive()
    })
    if (runOver()) {
      throw new Error(`run_code run is over (${String(runController.signal.reason)}); ${schema.name} result discarded`)
    }
    if (outcome.isError) throw new Error(outcome.message)
    return outcome.value
  }

  const functions: Record<string, PtcBindingFunction> = Object.create(null) as Record<string, PtcBindingFunction>
  for (const schema of tools.schemas(exec.agent, exec.toolSet)) {
    if (!host.allowNestedDirectTools && host.isDirect(schema.name)) continue
    Object.defineProperty(functions, schema.name, { enumerable: true, value: binding(deepFreeze(schema)) })
  }

  try {
    let result: PtcRunResult
    try {
      if (exec.agent !== undefined && typeof runtime.release === 'function') {
        const agent = exec.agent
        let runtimes = host.stateOwners.get(agent)
        if (runtimes === undefined) {
          runtimes = new WeakSet()
          host.stateOwners.set(agent, runtimes)
        }
        const provider = host.unwrapRuntime(runtime)
        if (!runtimes.has(provider)) {
          agent.ctx.effect(() => () => runtime.release(agent), 'Codex hybrid PTC retained environment')
          runtimes.add(provider)
        }
      }
      const spec = runtime.resolve({
        program: rawArgs.code,
        ...(exec.agent === undefined || policy?.mode !== standingPolicy?.mode ? {} : { stateOwner: exec.agent }),
        bindings: [{ global: 'tools', functions, errorClass: { name: 'ToolCallError', memberNameProperty: 'toolName' } }],
        signal: runController.signal,
        ...(cwd === undefined ? {} : { cwd }),
        ...(policy === undefined ? {} : { sandboxPolicy: policy }),
        ...(rawArgs.timeoutMs === undefined ? {} : { timeoutMs: rawArgs.timeoutMs }),
      })
      subCallWindowMs = spec.timeoutMs ?? 60_000
      maxSubCalls = spec.timeoutMs === null ? Infinity : Math.max(1, Math.floor(spec.timeoutMs / 60_000 * host.maxSubCallsPerMinute))
      result = await runtime.run(spec)
    } finally {
      runController.abort('run_code settled')
      await drainDispatches()
    }

    if (result.error) {
      const limitError = runController.signal.reason instanceof ToolCallLimitExceededError ? runController.signal.reason : undefined
      if (result.error.kind === 'abort' && exec.signal.aborted && limitError === undefined) {
        const message = runtime.retainsState ? `tool call aborted: ${result.error.message}` : 'tool call aborted'
        const error = new HarnessError(message, TOOL_ABORTED)
        error.name = 'AbortError'
        throw error
      }
      const logsText = result.logs.length > 0 ? `\nCaptured output:\n${result.logs.join('\n')}` : ''
      const sandboxText = result.sandbox === undefined ? ''
        : `\nFile sandbox: ${result.sandbox.mode}${result.sandbox.enforcement === undefined ? '' : `; enforcement: ${result.sandbox.enforcement}`}${result.sandbox.denied ? '; operation denied' : ''}.`
      const failureText = limitError === undefined || limitError.message === result.error.message
        ? result.error.message
        : `${limitError.message}\n${result.error.message}`
      throw new CodeRunFailedError(`code run failed (${result.error.kind}): ${failureText}${logsText}${sandboxText}${result.sandbox?.denied ? escalationGuidance(runtime.sandboxMode) : ''}`)
    }
    return {
      logs: result.logs,
      ...(result.sandbox === undefined ? {} : { sandbox: result.sandbox }),
      ...(result.value === undefined ? {} : { result: result.value }),
    }
  } finally {
    callSignal.removeEventListener('abort', onOuterAbort)
  }
}
