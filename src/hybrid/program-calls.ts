/** Lossless JSON helpers, hybrid PTC errors, and per-session run/reset coordination. */
import type { Context } from '@deepseek-ai/cordis'
import { HarnessError } from '@deepseek-ai/dsh-llm'
import type { PtcJsonValue } from '@deepseek-ai/dsh-ptc-runtime'
import type { SandboxMode } from '@deepseek-ai/dsh-sandbox'
import type { SessionId } from '@deepseek-ai/dsh-session'
import { toolErrorMessage } from '@deepseek-ai/dsh-tools/pipeline'

export class CodeRunFailedError extends HarnessError {
  constructor(message: string) {
    super(message, 'PTC_RUN_FAILED')
    this.name = 'CodeRunFailedError'
  }
}

export class CodeResetFailedError extends HarnessError {
  constructor(message: string) {
    super(message, 'PTC_RESET_FAILED')
    this.name = 'CodeResetFailedError'
  }
}

export function snapshotJsonValue(value: unknown, seen = new WeakSet<object>()): PtcJsonValue | undefined {
  if (value === undefined || typeof value === 'function' || typeof value === 'symbol' || typeof value === 'bigint') {
    return undefined
  }
  if (value === null || typeof value === 'boolean' || typeof value === 'string') return value
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new Error('non-finite number is not lossless JSON')
    return Object.is(value, -0) ? 0 : value
  }
  if (typeof value !== 'object') return undefined
  if (seen.has(value)) throw new Error('cyclic structure is not lossless JSON')
  seen.add(value)
  try {
    if (Array.isArray(value)) {
      const copy: PtcJsonValue[] = []
      for (let i = 0; i < value.length; i++) {
        if (!Object.hasOwn(value, i)) throw new Error('sparse array is not lossless JSON')
        const item = snapshotJsonValue(value[i], seen)
        if (item === undefined) throw new Error('array element is not lossless JSON')
        copy.push(item)
      }
      return copy
    }
    const proto = Object.getPrototypeOf(value) as object | null
    if (proto !== Object.prototype && proto !== null) {
      throw new Error('non-plain object is not lossless JSON')
    }
    const copy: { [key: string]: PtcJsonValue } = {}
    for (const key of Object.keys(value)) {
      const prop = (value as Record<string, unknown>)[key]
      if (prop === undefined) continue
      const snapped = snapshotJsonValue(prop, seen)
      if (snapped === undefined) throw new Error(`property ${JSON.stringify(key)} is not lossless JSON`)
      copy[key] = snapped
    }
    return copy
  } finally {
    seen.delete(value)
  }
}

export function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value)
    for (const child of Object.values(value as Record<string, unknown>)) {
      deepFreeze(child)
    }
  }
  return value
}

export function jsonNormalizeArgs(value: unknown): { dispatched: unknown; logged: unknown } {
  let snapshot: PtcJsonValue | undefined
  try {
    snapshot = snapshotJsonValue(value)
  } catch (error: unknown) {
    throw new Error(`tool arguments must be lossless JSON: ${error instanceof Error ? error.message : String(error)}`)
  }
  if (snapshot === undefined) {
    throw new Error('tool arguments must be lossless JSON (call the tool with an arguments object, e.g. `{}`)')
  }
  const logged = snapshotJsonValue(snapshot)
  if (logged === undefined) {
    throw new Error('tool arguments could not be detached for durable logging')
  }
  return { dispatched: snapshot, logged }
}

export function renderRunCodeValue(value: PtcJsonValue): string {
  if (typeof value === 'string') return value
  const encoded = JSON.stringify(value, null, 2)
  return encoded ?? String(value)
}

interface ActiveCall {
  mode: SandboxMode | undefined
  controller: AbortController
  signal: AbortSignal
  done: Promise<void>
}

interface ActiveReset {
  done: Promise<void>
  settled: boolean
}

export class HybridProgramCalls {
  private readonly calls = new Map<SessionId, Set<ActiveCall>>()
  private readonly resets = new Map<SessionId, ActiveReset>()
  private disposed = false

  constructor(ctx: Context) {
    if (typeof (ctx as Partial<Context>).on === 'function') {
      ctx.on('session/event', (session, event) => {
        if (event.type !== 'sandbox/mode') return
        for (const call of this.calls.get(session.id) ?? []) {
          if (call.mode !== undefined && call.mode !== event.data.mode) {
            call.controller.abort(new Error('sandbox mode changed'))
          }
        }
      }, { global: true })
    }
    if (typeof (ctx as Partial<Context>).effect === 'function') {
      ctx.effect(() => async () => {
        this.disposed = true
        const active = [...this.calls.values()].flatMap(set => [...set])
        for (const call of active) call.controller.abort(new Error('Hybrid tool executor disposed'))
        await Promise.allSettled([
          ...active.map(call => call.done),
          ...[...this.resets.values()].map(reset => reset.done),
        ])
      }, 'Codex hybrid PTC calls')
    }
  }

  async run<T>(
    sessionId: SessionId,
    signal: AbortSignal,
    mode: () => SandboxMode | undefined,
    fn: (callSignal: AbortSignal) => Promise<T>,
  ): Promise<T> {
    for (;;) {
      const reset = this.resets.get(sessionId)
      if (reset !== undefined) {
        try {
          await reset.done
        } catch (error) {
          throw new CodeRunFailedError(`Program environment unavailable: ${toolErrorMessage(error)}. Ask the host to reset it before running more code.`)
        }
        continue
      }
      const pending = [...this.calls.get(sessionId) ?? []].filter(call => call.signal.aborted)
      if (pending.length === 0) break
      await Promise.all(pending.map(call => call.done))
    }
    signal.throwIfAborted()
    if (this.disposed) throw new Error('Hybrid tool executor disposed')
    const controller = new AbortController()
    const done = Promise.withResolvers<undefined>()
    const callSignal = AbortSignal.any([signal, controller.signal])
    const call: ActiveCall = { mode: mode(), controller, signal: callSignal, done: done.promise }
    let sessionCalls = this.calls.get(sessionId)
    if (sessionCalls === undefined) {
      sessionCalls = new Set()
      this.calls.set(sessionId, sessionCalls)
    }
    sessionCalls.add(call)
    try {
      return await fn(callSignal)
    } finally {
      sessionCalls.delete(call)
      if (sessionCalls.size === 0) this.calls.delete(sessionId)
      done.resolve(undefined)
    }
  }

  reset(sessionId: SessionId, release: () => Promise<void>, notify?: () => void): Promise<void> {
    if (this.disposed) return Promise.reject(new Error('Hybrid tool executor disposed'))
    const previous = this.resets.get(sessionId)
    if (previous !== undefined && !previous.settled) return previous.done
    const done = Promise.withResolvers<undefined>()
    const reset: ActiveReset = { done: done.promise, settled: false }
    this.resets.set(sessionId, reset)
    const calls = [...this.calls.get(sessionId) ?? []]
    for (const call of calls) call.controller.abort(new Error('PTC environment reset'))
    void Promise.allSettled([Promise.resolve().then(release), ...calls.map(call => call.done)]).then((results) => {
      const failure = results.find(result => result.status === 'rejected')
      if (failure !== undefined) throw failure.reason
      notify?.()
    }).then(() => {
      reset.settled = true
      this.resets.delete(sessionId)
      done.resolve(undefined)
    }, (error: unknown) => {
      reset.settled = true
      done.reject(error)
    })
    return reset.done
  }
}
