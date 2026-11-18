/** Atomic per-Agent tool mask, Codex adapter replacement, prompt override, and defer overlay installer. */

import type { Agent } from '@deepseek-ai/dsh-agent'
import { scopeOf, scopeParentOf } from '@deepseek-ai/dsh-scope'
import type {} from '@deepseek-ai/dsh-tools'
import type { ToolDefinition } from '@deepseek-ai/dsh-tools'
import { effectiveToolAction, legacyToolAction } from '../contracts/tool-policy-contract.ts'
import type { LegacyCapabilities } from '../contracts/tool-policy-contract.ts'
import { matchesPromptRevision } from '../presets/preset-prompt-catalog.ts'
import type { PreparedPromptOverride } from '../presets/preset-prompt-catalog.ts'
import { registerCodexExecAndPlan } from '../tools/exec-plan-tools.ts'
import { ACTIVATE_TOOLS_NAME, readDefaultDeferredTools, readDefaultHiddenTools, yieldDeferredToolsOverlay } from './deferred-tools.ts'
import type { ResolvedRule } from './rule-resolver.ts'
import { codexToolMetadata } from './tool-capabilities.ts'

/**
 * Install only through an exact Agent scope. Replacement is deliberately limited
 * to builtin source names: arbitrary tools, argument adapters, and third-party
 * name-specific tools/pre-execute policy are not made equivalent by this overlay.
 */
export function installOverlay(
  agent: Agent,
  rule: ResolvedRule,
  legacyCapabilities: Readonly<LegacyCapabilities>,
  preparedPrompts: PreparedPromptOverride | undefined,
  onDispose: () => void,
): () => void {
  if (scopeOf(agent.ctx) !== agent) {
    throw new Error('codex-tool-policy: an exact Agent scope is required')
  }
  if (preparedPrompts !== undefined && (scopeParentOf(agent) !== preparedPrompts.scope
    || !matchesPromptRevision(agent.ctx, rule.preset, preparedPrompts))) throw new Error('preset-prompt-revision-mismatch')
  const tools = agent.ctx.get('tools')
  if (tools === undefined) throw new Error('codex-tool-policy: the Agent has no tools service')
  const upstream = scopeParentOf(agent)
  for (const choice of rule.tools ?? []) {
    if (tools.get(choice.name, agent) === undefined) {
      throw new Error(`codex-tool-policy: unknown or unavailable source tool ${JSON.stringify(choice.name)} in explicit choice`)
    }
  }
  for (const tool of [...rule.allow ?? [], ...rule.deny ?? [], ...rule.tools?.map(choice => choice.name) ?? []]) {
    const visible = tools.get(tool, agent)
    if (visible !== undefined && tools.get(tool, upstream) !== visible) {
      throw new Error(`codex-tool-policy: cannot restrict Agent-local tool ${JSON.stringify(tool)}`)
    }
  }

  // Explicit source choices override both legacy masks and category defaults.
  // They can widen this rule's own allowlist, never another owner's restriction.
  const allow = rule.allow === undefined ? undefined : new Set(rule.allow)
  const deny = new Set(rule.deny)
  let hasDeny = rule.deny !== undefined
  for (const choice of rule.tools ?? []) {
    if (choice.action === 'hide') {
      deny.add(choice.name)
      hasDeny = true
      allow?.delete(choice.name)
    } else {
      deny.delete(choice.name)
      allow?.add(choice.name)
    }
  }
  const defaultHiddenSet = readDefaultHiddenTools(agent.ctx, agent)
  for (const hiddenName of defaultHiddenSet ?? []) {
    const visible = tools.get(hiddenName, agent)
    if (visible !== undefined && tools.get(hiddenName, upstream) === visible
      && !rule.tools?.some(choice => choice.name === hiddenName)) {
      deny.add(hiddenName)
      hasDeny = true
      allow?.delete(hiddenName)
    }
  }
  const defaultDeferredSet = readDefaultDeferredTools(agent.ctx, agent)
  const actionFor = (name: string) => {
    const definition = tools.get(name, agent)
    const codexTool = definition === undefined ? undefined : codexToolMetadata(definition)
    return effectiveToolAction(rule, name, {
      legacyCapabilities,
      ...(codexTool === undefined ? {} : { codexTool }),
      ...(defaultDeferredSet?.has(name) ? { defaultDeferred: true } : {}),
    })
  }
  // Preserve an old replacement whose shared Codex capability was off: its
  // source stays hidden, but no unavailable adapter is installed. Explicit
  // per-source replacements bypass that compatibility baseline as one plan.
  for (const name of ['bash', 'pwsh', 'todo_write', 'edit', 'write']) {
    const oldAction = legacyToolAction(rule, name)
    if (tools.get(name, agent) !== undefined
      && (oldAction === 'codex-exec' || oldAction === 'codex-plan' || oldAction === 'codex-patch')
      && actionFor(name) === 'hide') {
      deny.add(name)
      hasDeny = true
      allow?.delete(name)
    }
  }
  const mask = {
    ...(allow === undefined ? {} : { allow: [...allow] }),
    ...(!hasDeny ? {} : { deny: [...deny] }),
  }
  const permitted = (tool: string): boolean => (allow === undefined || allow.has(tool)) && !deny.has(tool)
  const shells = ['bash', 'pwsh'].filter(tool => actionFor(tool) === 'codex-exec'
    && permitted(tool) && tools.get(tool, agent) !== undefined)
  const plan = actionFor('todo_write') === 'codex-plan'
    && permitted('todo_write') && tools.get('todo_write', agent) !== undefined
  const patches = ['edit', 'write'].filter(tool => actionFor(tool) === 'codex-patch'
    && permitted(tool) && tools.get(tool, agent) !== undefined)
  const sources = [...shells, ...(plan ? ['todo_write'] : []), ...patches]
  const deferredDefinitions: ToolDefinition[] = tools.definitions(upstream).filter(definition =>
    definition.name !== ACTIVATE_TOOLS_NAME
    && actionFor(definition.name) === 'defer'
    && permitted(definition.name)
    && !sources.includes(definition.name)
    && tools.get(definition.name, agent) !== undefined)

  for (const tool of sources) {
    const definition = tools.get(tool, agent)
    // `when` is registration-owned and cannot be copied from a ToolDefinition.
    // Without a step toolSet, executable() rejects every conditional registration.
    if (tools.executable(tool, agent) !== definition) {
      throw new Error(`codex-tool-policy: cannot replace conditional source tool ${JSON.stringify(tool)}; its activation condition must not be discarded`)
    }
    if (tools.get(tool, upstream) !== definition) {
      throw new Error(`codex-tool-policy: cannot replace Agent-local source tool ${JSON.stringify(tool)}`)
    }
  }
  for (const definition of deferredDefinitions) {
    if (tools.executable(definition.name, agent) !== definition) {
      throw new Error(`codex-tool-policy: cannot defer conditional source tool ${JSON.stringify(definition.name)}; its activation condition must not be discarded`)
    }
    if (tools.get(definition.name, upstream) !== definition) {
      throw new Error(`codex-tool-policy: cannot defer Agent-local source tool ${JSON.stringify(definition.name)}`)
    }
  }
  const additions = [
    ...(shells.length > 0 ? ['exec_command', 'write_stdin'] : []),
    ...(plan ? ['update_plan'] : []),
    ...(patches.length > 0 ? ['apply_patch'] : []),
    ...(deferredDefinitions.length > 0 ? [ACTIVATE_TOOLS_NAME] : []),
  ]
  for (const tool of additions) {
    if (tools.get(tool, agent) !== undefined) {
      throw new Error(`codex-tool-policy: replacement tool ${JSON.stringify(tool)} already exists; refusing to shadow another implementation`)
    }
  }
  if (shells.length > 0 && agent.ctx.get('shell') === undefined) {
    throw new Error('codex-tool-policy: builtin shell replacement requires the mounted shell capability')
  }
  if (patches.length > 0 && agent.ctx.get('fs') === undefined) {
    throw new Error('codex-tool-policy: builtin file-edit replacement requires the mounted fs capability')
  }
  const needsPrompt = sources.length > 0 || deferredDefinitions.length > 0 || (preparedPrompts?.sections.length ?? 0) > 0
  const systemPrompt = needsPrompt ? agent.ctx.get('systemPrompt') : undefined
  if (needsPrompt && systemPrompt === undefined) {
    throw new Error('codex-tool-policy: replacements require the mounted systemPrompt service')
  }
  const guidance = [
    ...(shells.length === 0 ? [] : [`For this Agent, ${shells.join('/')} is replaced by exec_command and write_stdin. Follow their current schemas; command status uses exit_code (rendered as Process exited with code N), not the old shell status markers.`]),
    ...(plan ? ['For this Agent, todo_write is replaced by update_plan. Follow its current schema; at most one plan item may be in_progress.'] : []),
    ...(patches.length === 0 ? [] : [`For this Agent, ${patches.join('/')} is replaced by apply_patch. Edit or create files with Codex Begin/End Patch hunks instead of calling ${patches.join('/')}.`]),
  ].join('\n')

  // These registrations and the helper have synchronous disposers. Yield exact
  // effects so a later refusal rolls back every earlier mask before it escapes.
  const dispose = agent.ctx.effect(function* () {
    yield onDispose
    for (const section of preparedPrompts?.sections ?? []) yield systemPrompt!.section(section)
    if (mask.allow !== undefined || mask.deny !== undefined) yield tools.restrict(mask)
    // Own registrations are exempt from restrict(). Never leave an unhidden
    // Agent-local source alongside a newly granted Codex capability.
    for (const tool of mask.deny ?? []) {
      if (tools.get(tool, agent) !== undefined) {
        throw new Error(`codex-tool-policy: cannot hide Agent-local tool ${JSON.stringify(tool)}`)
      }
    }
    if (sources.length > 0) {
      yield tools.restrict({ deny: sources })
      for (const tool of sources) {
        if (tools.get(tool, agent) !== undefined) {
          throw new Error(`codex-tool-policy: cannot hide Agent-local source tool ${JSON.stringify(tool)}`)
        }
      }
      yield registerCodexExecAndPlan(agent.ctx, { terminal: shells.length > 0, plan, patch: patches.length > 0,
        capabilityAuthority: { terminalToolsEnabled: shells.length > 0, planToolEnabled: plan, patchToolEnabled: patches.length > 0 } })
      yield systemPrompt!.section({ name: 'codex:tool-policy', order: 1015, text: guidance })
    }
    if (deferredDefinitions.length > 0) {
      yield* yieldDeferredToolsOverlay(tools, systemPrompt!, deferredDefinitions, agent)
    }
  }, `codex-tool-policy:${rule.preset}`)
  return () => { void dispose() }
}
