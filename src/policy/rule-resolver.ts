/** Schema, choice validation, and rule detaching for `codex-tool-policy`. */

import z from '@deepseek-ai/schemastery'
import { PRESET_PROMPT_NAMES } from '../contracts/ui-contracts.ts'
import type { PresetPromptOverride } from '../contracts/ui-contracts.ts'
import type { ToolActionRule, ToolPolicyRule } from '../contracts/tool-policy-contract.ts'
import { ACTIVATE_TOOLS_NAME } from './deferred-tools.ts'

export interface Config {
  /** Empty by default: no preset or existing Agent is changed implicitly. */
  rules?: readonly ToolPolicyRule[]
}

// Root volatility keeps saving future-Agent rules from unloading live overlays.
export const Config = z.object({
  rules: z.array(z.object({
    preset: z.string().required().description('Exact preset id; only Agents created after this plugin loads are affected.'),
    // Bare Schemastery arrays default to []; a union preserves omitted masks.
    allow: z.union([z.array(z.string())]).description('Inherited source names to keep. Omit for no allowlist; [] removes all inherited tools, including file tools.'),
    deny: z.union([z.array(z.string())]).description('Inherited source names to remove; unknown and Agent-local names are rejected.'),
    replaceShell: z.boolean().default(true).description('Legacy default: replace permitted builtin bash/pwsh with exec_command/write_stdin. Explicit source choices override it; third-party name-specific policy is not transferred.'),
    replacePlan: z.boolean().default(true).description('Legacy default: replace permitted builtin todo_write with update_plan; explicit source choices override it.'),
    replacePatch: z.boolean().default(false).description('Legacy default: replace permitted builtin edit/write with apply_patch; explicit source choices override it.'),
    tools: z.union([z.array(z.object({
      name: z.string().required().description('Exact inherited source tool name.'),
      action: z.union([z.const('keep'), z.const('hide'), z.const('defer'), z.const('codex-exec'), z.const('codex-plan'), z.const('codex-patch')]).required()
        .description('Per-tool override: keep/hide/defer any inherited tool; codex-exec only for bash/pwsh, codex-plan only for todo_write, and codex-patch only for edit/write.'),
    }))]).description('Individual source choices, overriding allow/deny and legacy replacement defaults. Omission preserves legacy behavior.'),
    promptOverrides: z.union([z.array(z.object({
      name: z.union(PRESET_PROMPT_NAMES.map(name => z.const(name))).required(),
      text: z.string().max(1_000_000).required(),
    }))]).description('Exact current-preset prompt replacements. Order, interpolation and complete semantics remain Host-owned.'),
  })).default([]),
}).volatile()

/** Loader activations receive a volatile reference; direct callers may pass plain rules. */
export type ToolPolicyConfigSource = Config | ReturnType<typeof Config>

export interface ResolvedRule extends ToolPolicyRule {
  readonly replaceShell: boolean
  readonly replacePlan: boolean
  readonly replacePatch: boolean
}

/** Reject ambiguous/unsupported overrides before any Agent registrations change. */
function resolveToolChoices(input: readonly ToolActionRule[] | undefined): readonly ToolActionRule[] | undefined {
  if (input === undefined) return undefined
  if (!Array.isArray(input)) throw new TypeError('codex-tool-policy: tools must be an array of source choices')
  const seen = new Set<string>()
  const choices: ToolActionRule[] = []
  for (const choice of input) {
    if (choice === null || typeof choice !== 'object'
      || typeof choice.name !== 'string' || choice.name.trim().length === 0) {
      throw new TypeError('codex-tool-policy: every tool choice requires a non-empty source name')
    }
    if (seen.has(choice.name)) {
      throw new Error(`codex-tool-policy: duplicate tool choice ${JSON.stringify(choice.name)}`)
    }
    seen.add(choice.name)
    if (!['keep', 'hide', 'defer', 'codex-exec', 'codex-plan', 'codex-patch'].includes(choice.action)) {
      throw new TypeError(`codex-tool-policy: invalid action for source tool ${JSON.stringify(choice.name)}`)
    }
    if (choice.action === 'defer' && choice.name === ACTIVATE_TOOLS_NAME) {
      throw new Error(`codex-tool-policy: cannot defer reserved tool ${JSON.stringify(ACTIVATE_TOOLS_NAME)}`)
    }
    if (choice.action === 'codex-exec' && choice.name !== 'bash' && choice.name !== 'pwsh'
      || choice.action === 'codex-plan' && choice.name !== 'todo_write'
      || choice.action === 'codex-patch' && choice.name !== 'edit' && choice.name !== 'write') {
      throw new Error(`codex-tool-policy: unsupported replacement ${JSON.stringify(choice.action)} for source tool ${JSON.stringify(choice.name)}`)
    }
    choices.push({ name: choice.name, action: choice.action })
  }
  return choices
}

function resolvePromptChoices(input: readonly PresetPromptOverride[] | undefined): readonly PresetPromptOverride[] | undefined {
  if (input === undefined) return undefined
  if (!Array.isArray(input) || input.length > PRESET_PROMPT_NAMES.length) throw new Error('invalid-preset-prompt-overrides')
  const seen = new Set<string>()
  return input.map(value => {
    if (value === null || typeof value !== 'object' || !PRESET_PROMPT_NAMES.includes(value.name)
      || typeof value.text !== 'string' || value.text.length > 1_000_000
      || Object.keys(value).some(key => key !== 'name' && key !== 'text') || seen.has(value.name)) {
      throw new Error('invalid-preset-prompt-override')
    }
    seen.add(value.name)
    return { name: value.name, text: value.text }
  })
}

/** Validate direct callers too, and detach configuration from later form mutations. */
export function resolveRules(config: Config): ReadonlyMap<string, ResolvedRule> {
  const input = config.rules ?? []
  if (!Array.isArray(input)) throw new TypeError('codex-tool-policy: rules must be an array')
  const rules = new Map<string, ResolvedRule>()
  for (const rule of input) {
    if (rule === null || typeof rule !== 'object'
      || typeof rule.preset !== 'string' || rule.preset.trim().length === 0) {
      throw new TypeError('codex-tool-policy: every rule requires a non-empty preset id')
    }
    if (rules.has(rule.preset)) throw new Error(`codex-tool-policy: duplicate preset rule ${JSON.stringify(rule.preset)}`)
    for (const key of ['allow', 'deny'] as const) {
      const names = rule[key]
      if (names !== undefined && (!Array.isArray(names)
        || names.some(tool => typeof tool !== 'string' || tool.trim().length === 0))) {
        throw new TypeError(`codex-tool-policy: ${key} must be an array of non-empty tool names`)
      }
    }
    for (const key of ['replaceShell', 'replacePlan', 'replacePatch'] as const) {
      if (rule[key] !== undefined && typeof rule[key] !== 'boolean') {
        throw new TypeError(`codex-tool-policy: ${key} must be a boolean`)
      }
    }
    const choices = resolveToolChoices(rule.tools)
    const prompts = resolvePromptChoices(rule.promptOverrides)
    rules.set(rule.preset, {
      preset: rule.preset,
      ...(rule.allow === undefined ? {} : { allow: [...rule.allow] }),
      ...(rule.deny === undefined ? {} : { deny: [...rule.deny] }),
      replaceShell: rule.replaceShell !== false,
      replacePlan: rule.replacePlan !== false,
      replacePatch: rule.replacePatch === true,
      ...(choices === undefined ? {} : { tools: choices }),
      ...(prompts === undefined ? {} : { promptOverrides: prompts }),
    })
  }
  return rules
}
