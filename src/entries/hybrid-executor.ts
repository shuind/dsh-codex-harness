/** Asymmetric hybrid executor plugin entry and `codexHybridDefaults` wiring. */
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-ptc-runtime'
import { scopeOf, scopeParentOf } from '@deepseek-ai/dsh-scope'
import type {} from '@deepseek-ai/dsh-system-prompt'
import type {} from '@deepseek-ai/dsh-tools'
import {
  CodexHybridExecutor,
  Config,
  DEFAULT_HYBRID_DIRECT_TOOLS,
} from '../hybrid/codex-hybrid-executor.ts'
import { CodeResetFailedError, CodeRunFailedError } from '../hybrid/program-calls.ts'
import type { PtcDispatchEventData, PtcDispatchLog, PtcDispatchStartEventData } from '../hybrid/subcall-scheduler.ts'
import {
  ACTIVATE_TOOLS_NAME,
  registerHybridDefaultDeferredTools,
  registerHybridDefaultHiddenTools,
  yieldDeferredToolsOverlay,
} from '../policy/deferred-tools.ts'

export {
  CodexHybridExecutor,
  Config,
  DEFAULT_HYBRID_DIRECT_TOOLS,
  CodeResetFailedError,
  CodeRunFailedError,
}
export type { PtcDispatchEventData, PtcDispatchLog, PtcDispatchStartEventData }

export const name = 'codex-hybrid-executor'
export const inject = ['tools', 'systemPrompt', 'ptcRuntime']

/** Mount `CodexHybridExecutor` and publish default hidden/deferred tools for the owning scope. */
export function apply(ctx: Context, config: Partial<Config> = {}): void {
  const resolved = Config(config)
  const executor = new CodexHybridExecutor(ctx, resolved)
  ctx.tools.setExecutor(executor)
  const hiddenSet = new Set(resolved.hiddenTools.map(item => item.trim()).filter(Boolean))
  const deferredSet = new Set(resolved.deferredTools.map(item => item.trim()).filter(Boolean))
  if (hiddenSet.size > 0) {
    ctx.effect(() => registerHybridDefaultHiddenTools(ctx, hiddenSet), 'codex-hybrid: default hidden tools')
  }
  if (deferredSet.size > 0) {
    ctx.effect(() => registerHybridDefaultDeferredTools(ctx, deferredSet), 'codex-hybrid: default deferred tools')
  }
  if ((deferredSet.size > 0 || hiddenSet.size > 0) && typeof (ctx as Partial<Context>).on === 'function') {
    const parentScope = scopeOf(ctx)
    ctx.on('agent/created', ({ agent }) => {
      if (agent.ctx.get('codexToolPolicy') !== undefined) return
      if (parentScope !== undefined && scopeParentOf(agent) !== parentScope) return
      const agentTools = agent.ctx.get('tools')
      const agentPrompt = agent.ctx.get('systemPrompt')
      if (agentTools === undefined || agentPrompt === undefined) return
      if (agentTools.get(ACTIVATE_TOOLS_NAME, agent) !== undefined) return
      const upstream = scopeParentOf(agent)
      const hiddenUpstream = [...hiddenSet].filter(tool => {
        const visible = agentTools.get(tool, agent)
        return visible !== undefined && agentTools.get(tool, upstream) === visible
      })
      const deferredDefs = agentTools.definitions(upstream).filter(def =>
        def.name !== ACTIVATE_TOOLS_NAME
        && !hiddenSet.has(def.name)
        && deferredSet.has(def.name)
        && agentTools.get(def.name, agent) !== undefined
        && agentTools.executable(def.name, agent) === def
        && agentTools.get(def.name, upstream) === def)
      if (hiddenUpstream.length === 0 && deferredDefs.length === 0) return
      agent.ctx.effect(function* () {
        if (hiddenUpstream.length > 0) yield agentTools.restrict({ deny: hiddenUpstream })
        if (deferredDefs.length > 0) yield* yieldDeferredToolsOverlay(agentTools, agentPrompt, deferredDefs, agent)
      }, 'codex-hybrid: standalone baseline tools')
    })
  }
}

export default { name, inject, Config, apply }
