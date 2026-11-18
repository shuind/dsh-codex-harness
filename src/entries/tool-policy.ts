/** Opt-in Host overlays for future Agents; source presets and Persona stay untouched. */

import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/dsh-agent-preset-registry'
import { scopeParentOf } from '@deepseek-ai/dsh-scope'
import type {} from '@deepseek-ai/dsh-tools'
import { effectiveToolAction } from '../contracts/tool-policy-contract.ts'
import type { LegacyCapabilities } from '../contracts/tool-policy-contract.ts'
import { readDefaultDeferredTools, readDefaultHiddenTools } from '../policy/deferred-tools.ts'
import { installOverlay } from '../policy/overlay-installer.ts'
import { Config, resolveRules } from '../policy/rule-resolver.ts'
import type { ResolvedRule, ToolPolicyConfigSource } from '../policy/rule-resolver.ts'
import { readLegacyCapabilities } from '../policy/tool-capabilities.ts'
import { preparePromptOverrides, probePresetPromptsCached } from '../presets/preset-prompt-catalog.ts'
import type { PreparedPromptOverride } from '../presets/preset-prompt-catalog.ts'

export type { ToolAction, ToolActionRule, ToolPolicyRule } from '../contracts/tool-policy-contract.ts'
export { Config } from '../policy/rule-resolver.ts'
export type { ToolPolicyConfigSource } from '../policy/rule-resolver.ts'

export const name = 'codex-tool-policy'
export const inject = ['tools', 'agents', 'agentPresets']

interface AgentToolSnapshot {
  readonly rules: ReadonlyMap<string, ResolvedRule>
  readonly legacyCapabilities: Readonly<LegacyCapabilities>
  activeRule?: ResolvedRule
  readonly promptPlans: Map<string, PreparedPromptOverride | Error>
  activePromptNames?: ReadonlySet<string>
}

interface Overlay {
  readonly preset: string
  readonly dispose: () => void
}

/**
 * Affect future Agent lifecycles only. No existing-agent scan, polling, prompt
 * rewrite, source-preset edit, or executor replacement is performed.
 */
export function apply(ctx: Context, config: ToolPolicyConfigSource = {}): void {
  const currentConfig = (): Config => 'get' in config ? config.get() ?? {} : config
  resolveRules(currentConfig())
  // A save changes only future Agents, including their later blank-preset switches.
  const snapshots = new WeakMap<Agent, AgentToolSnapshot>()
  const overlays = new Map<Agent, Overlay>()
  let active = true
  ctx.provide('codexToolPolicy', {
    enabled(agent, name, metadata) {
      const snapshot = snapshots.get(agent)
      if (snapshot === undefined) return undefined
      if (!metadata.presetEnabled) return false
      return effectiveToolAction(snapshot.activeRule, name, {
        legacyCapabilities: snapshot.legacyCapabilities, codexTool: metadata,
      }) !== 'hide'
    },
    hasPromptOverride(scope, name) { return snapshots.get(scope as Agent)?.activePromptNames?.has(name) === true },
  })

  const remove = (agent: Agent): void => {
    const snapshot = snapshots.get(agent)
    if (snapshot !== undefined) { delete snapshot.activeRule; delete snapshot.activePromptNames }
    const previous = overlays.get(agent)
    if (previous === undefined) return
    overlays.delete(agent)
    previous.dispose()
  }
  const reconcile = (agent: Agent): void => {
    const preset = ctx.agentPresets.composedPreset(agent.ctx)
      ?? ctx.agentPresets.presetForSession(agent.session)
      ?? undefined
    if (overlays.get(agent)?.preset === preset) return
    remove(agent)
    const snapshot = snapshots.get(agent)
    const defaultDeferred = readDefaultDeferredTools(agent.ctx, agent)
    const defaultHidden = readDefaultHiddenTools(agent.ctx, agent)
    const rule = preset === undefined
      ? undefined
      : snapshot?.rules.get(preset)
        ?? (((defaultDeferred !== undefined && defaultDeferred.size > 0) || (defaultHidden !== undefined && defaultHidden.size > 0))
          ? { preset, replaceShell: false, replacePlan: false, replacePatch: false }
          : undefined)
    if (rule === undefined || snapshot === undefined) return
    const prepared = snapshot.promptPlans.get(rule.preset)
    if (prepared instanceof Error) throw prepared
    if ((rule.promptOverrides?.length ?? 0) > 0 && prepared === undefined) throw new Error('preset-prompt-plan-unavailable')
    let installed: Overlay | undefined
    const dispose = installOverlay(agent, rule, snapshot.legacyCapabilities, prepared, () => {
      if (installed !== undefined && overlays.get(agent) === installed) {
        overlays.delete(agent)
        delete snapshot.activeRule
        delete snapshot.activePromptNames
      }
    })
    installed = { preset: rule.preset, dispose }
    overlays.set(agent, installed)
    snapshot.activeRule = rule
    if (prepared !== undefined) snapshot.activePromptNames = new Set(prepared.sections.map(section => section.name))
  }

  const isBlankSession = (agent: Agent): boolean => {
    const boundary = ctx.agents.turnBoundaryOf(agent.session)
    return boundary.openTurnStartSeq === null && boundary.lastTurn === 0
  }

  ctx.on('agent/created', ({ agent, signal }) => {
    if (!active) return
    signal?.throwIfAborted()
    const snapshot: AgentToolSnapshot = {
      rules: resolveRules(currentConfig()),
      legacyCapabilities: readLegacyCapabilities(ctx),
      promptPlans: new Map(),
    }
    snapshots.set(agent, snapshot)
    const targets = [...snapshot.rules.values()].filter(rule => (rule.promptOverrides?.length ?? 0) > 0)
    if (targets.length === 0) { reconcile(agent); return }
    const bound = ctx.agentPresets.composedPreset(agent.ctx) ?? ctx.agentPresets.presetForSession(agent.session)
    const activeTargets = isBlankSession(agent)
      ? targets
      : bound === undefined
        ? []
        : targets.filter(rule => rule.preset === bound)
    // Factory setup is finished; queued model work is held until this returns.
    if (activeTargets.length === 0) { reconcile(agent); return }
    return (async () => {
      for (const rule of activeTargets) {
        try {
          const probe = await probePresetPromptsCached(ctx, rule.preset, rule.preset === bound ? scopeParentOf(agent) : undefined)
          snapshot.promptPlans.set(rule.preset, preparePromptOverrides(probe, rule.promptOverrides!))
        } catch (error) {
          // A stale/unsupported sibling target cannot block the current preset.
          snapshot.promptPlans.set(rule.preset, error instanceof Error ? error : new Error(String(error)))
        }
      }
      signal?.throwIfAborted()
      if (active) reconcile(agent)
      return undefined
    })()
  })
  ctx.on('agent-preset/selected', sessionId => {
    if (!active) return
    const agent = ctx.agents.get(sessionId)
    if (agent === undefined || !snapshots.has(agent) || agent.status !== 'idle') return
    if (!isBlankSession(agent)) return
    // This event is emit, not serial: keep reconciliation entirely synchronous.
    // A rejected new overlay leaves the newly selected preset's baseline intact.
    try {
      reconcile(agent)
    } catch (error) {
      ctx.logger.warn(`codex-tool-policy: preset selection overlay refused for ${agent.id}: ${String(error)}`)
    }
  })
  ctx.on('agent/disposed', ({ agent }) => { remove(agent); snapshots.delete(agent) })
  // Registrations belong to agent.ctx, but must also unwind on Host-plugin unload.
  ctx.effect(() => () => {
    active = false
    for (const agent of [...overlays.keys()].reverse()) remove(agent)
  }, 'codex-tool-policy: Host overlay ownership')
}

export default { name, inject, Config, apply }
