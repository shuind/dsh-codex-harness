/** Host-only ownership marks and the optional Agent-snapshot availability seam. */
import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { ToolDefinition } from '@deepseek-ai/dsh-tools'
import type { ScopeKey } from '@deepseek-ai/dsh-scope'
import type { AssembleContext } from '@deepseek-ai/dsh-system-prompt'
import { CODEX_SETTINGS_ENTRY, CODEX_SETTINGS_NAMESPACE, readHostSettings } from '../contracts/settings.ts'
import type { CodexSettings } from '../contracts/settings.ts'
import type { CodexCapability, CodexToolMetadata, LegacyCapabilities } from '../contracts/tool-policy-contract.ts'

// Core and policy are bundled separately. A global symbol survives that boundary;
// matching an unmarked third-party tool by name would not establish ownership.
const OWNED_TOOL = Symbol.for('@shuind/dsh-codex-harness:tool-capability:v1')
const CAPABILITIES: readonly CodexCapability[] = ['terminalToolsEnabled', 'planToolEnabled', 'patchToolEnabled']

export interface CodexToolPolicyResolver {
  /** Undefined means an older, unsnapshotted Agent retains the compatibility path. */
  enabled(agent: Agent, name: string, metadata: CodexToolMetadata): boolean | undefined
  hasPromptOverride?(scope: ScopeKey, name: string): boolean
}

declare module '@deepseek-ai/dsh-system-prompt' {
  interface AssembleContext {
    /** Read-only own-plugin probe: do not reapply obsolete Codex prompt preferences. */
    codexPresetPromptProbe?: true
  }
}

/** Only our old presentation hooks consume this; registrations remain provider-owned. */
export function hasPresetPromptOverride(ctx: Context, context: AssembleContext, name: string): boolean {
  if (context.codexPresetPromptProbe === true) return ['deployment:persona-prefix', 'deployment:persona-suffix', 'codex:base'].includes(name)
  return context.scope !== undefined && ctx.get('codexToolPolicy')?.hasPromptOverride?.(context.scope, name) === true
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    codexToolPolicy: CodexToolPolicyResolver
  }
}

export function markCodexTool<T extends ToolDefinition>(definition: T, metadata: CodexToolMetadata): T {
  Object.defineProperty(definition, OWNED_TOOL, { value: Object.freeze({ ...metadata }) })
  return definition
}

export function codexToolMetadata(definition: ToolDefinition): CodexToolMetadata | undefined {
  const value = (definition as unknown as Record<symbol, unknown>)[OWNED_TOOL]
  if (value === null || typeof value !== 'object') return undefined
  const data = value as Partial<CodexToolMetadata>
  if (!CAPABILITIES.includes(data.capability as CodexCapability) || typeof data.presetEnabled !== 'boolean'
    || data.presetOverridesLegacy !== undefined && typeof data.presetOverridesLegacy !== 'boolean') return undefined
  return { capability: data.capability as CodexCapability, presetEnabled: data.presetEnabled,
    ...(data.presetOverridesLegacy === undefined ? {} : { presetOverridesLegacy: data.presetOverridesLegacy }) }
}

/** Read once for a new Agent or catalog. No caller keeps the live preference object. */
export function readLegacyCapabilities(ctx: Context): Readonly<Required<LegacyCapabilities>> {
  const current = readHostSettings<Partial<CodexSettings>>(ctx, CODEX_SETTINGS_NAMESPACE)
  return Object.freeze(Object.fromEntries(CAPABILITIES.map(key => [key, current?.[key] ?? CODEX_SETTINGS_ENTRY[key]]))) as Required<LegacyCapabilities>
}

export function codexToolEnabled(
  ctx: Context,
  agent: Agent | undefined,
  name: string,
  metadata: CodexToolMetadata,
  fallback: () => CodexSettings,
  authority?: boolean,
): boolean {
  if (!metadata.presetEnabled) return false
  // Only a successfully compiled adapter plan supplies this authority.
  if (authority !== undefined) return authority
  const decision = agent === undefined ? undefined : ctx.get('codexToolPolicy')?.enabled(agent, name, metadata)
  return decision ?? fallback()[metadata.capability] !== false
}

export function assertCapabilityEnabled(
  ctx: Context,
  current: () => CodexSettings,
  toolName: string,
  agent: Agent | undefined,
  metadata: CodexToolMetadata,
  authority?: boolean,
): void {
  if (!codexToolEnabled(ctx, agent, toolName, metadata, current, authority)) {
    throw new Error(`${toolName}: disabled in Codex Harness plugin settings`)
  }
}
