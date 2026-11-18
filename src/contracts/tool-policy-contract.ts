/** Client-safe tool choices. The concrete adapters remain Host-owned. */
import type { PresetPromptOverride } from './ui-contracts.ts'
export { PRESET_PROMPT_NAMES } from './ui-contracts.ts'
export type { PresetPromptName, PresetPromptOverride, PresetPromptEntry, PresetPromptCatalog } from './ui-contracts.ts'

export type ToolAction = 'keep' | 'hide' | 'defer' | 'codex-exec' | 'codex-plan' | 'codex-patch'
export type ReplacementAction = Extract<ToolAction, 'codex-exec' | 'codex-plan' | 'codex-patch'>
export type CodexCapability = 'terminalToolsEnabled' | 'planToolEnabled' | 'patchToolEnabled'
export type LegacyCapabilities = Partial<Record<CodexCapability, boolean>>

/** Ownership metadata, not a promise that `keep` admits a locally disabled tool. */
export interface CodexToolMetadata {
  readonly capability: CodexCapability
  readonly presetEnabled: boolean
  /** An explicit old per-preset boolean already overrode the shared baseline. */
  readonly presetOverridesLegacy?: boolean
}

export interface ToolActionContext {
  readonly legacyCapabilities?: LegacyCapabilities
  readonly codexTool?: CodexToolMetadata
  readonly defaultDeferred?: boolean
}

export interface ToolActionRule {
  readonly name: string
  readonly action: ToolAction
}

export interface ToolPolicyRule {
  readonly preset: string
  readonly allow?: readonly string[]
  readonly deny?: readonly string[]
  /** Legacy category defaults; new UI rules explicitly set replaceShell/replacePlan to false. */
  readonly replaceShell?: boolean
  readonly replacePlan?: boolean
  readonly replacePatch?: boolean
  /** Explicit per-source choices override the legacy masks and category defaults. */
  readonly tools?: readonly ToolActionRule[]
  /** Exact reviewed section replacements, scoped to future Agents of this preset. */
  readonly promptOverrides?: readonly PresetPromptOverride[]
}

export interface PresetToolReplacement {
  readonly action: ReplacementAction
  readonly tools: readonly string[]
  readonly available: boolean
  readonly reason?: 'conditional' | 'target-exists'
}

export interface PresetToolEntry {
  readonly name: string
  readonly description: string
  readonly conditional: boolean
  readonly defaultDeferred?: boolean
  readonly replacements: readonly PresetToolReplacement[]
  readonly codexTool?: CodexToolMetadata
}

export interface PresetToolCatalog {
  readonly preset: string
  /** Registration snapshot, not admission for a particular Agent/model step. */
  readonly registeredOnly: true
  readonly tools: readonly PresetToolEntry[]
  readonly legacyCapabilities?: LegacyCapabilities
}

/** Legacy configuration remains a baseline, never a live second veto of an explicit choice. */
export function legacyToolAction(rule: ToolPolicyRule | undefined, name: string, context: ToolActionContext = {}): ToolAction {
  let action: ToolAction = 'keep'
  if (rule !== undefined) {
    if ((rule.allow !== undefined && !rule.allow.includes(name)) || rule.deny?.includes(name)) return 'hide'
    if ((name === 'bash' || name === 'pwsh') && rule.replaceShell !== false) action = 'codex-exec'
    if (name === 'todo_write' && rule.replacePlan !== false) action = 'codex-plan'
    if ((name === 'edit' || name === 'write') && rule.replacePatch === true) action = 'codex-patch'
  }
  if (action === 'keep' && context.defaultDeferred === true) action = 'defer'
  const capability = context.codexTool?.capability
    ?? (action === 'codex-exec' ? 'terminalToolsEnabled'
      : action === 'codex-plan' ? 'planToolEnabled'
      : action === 'codex-patch' ? 'patchToolEnabled'
      : undefined)
  // Only owned definitions and chosen Codex adapters consume the legacy baseline.
  // A third-party tool with the same name does not become a Codex capability.
  const presetOverride = context.codexTool?.presetOverridesLegacy === true && context.codexTool.presetEnabled
  if (!presetOverride && capability !== undefined && context.legacyCapabilities?.[capability] === false) return 'hide'
  return action
}

/** Policy action only: `keep` still respects the original preset's local enablement. */
export function effectiveToolAction(rule: ToolPolicyRule | undefined, name: string, context: ToolActionContext = {}): ToolAction {
  return rule?.tools?.find(tool => tool.name === name)?.action ?? legacyToolAction(rule, name, context)
}
