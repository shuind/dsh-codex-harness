import type { ToolPolicyRule } from '../contracts/tool-policy-contract.ts'

/** Ephemeral UI drafts only; accepted ConfigForms values remain authoritative. */
export interface PresetDraft {
  readonly preset: string
  readonly revision: number | undefined
  readonly baseline: readonly ToolPolicyRule[]
  readonly rules: readonly ToolPolicyRule[]
}
export type PresetDrafts = ReadonlyMap<string, PresetDraft>
export interface PolicySnapshot { readonly revision: number | undefined; readonly rules: readonly ToolPolicyRule[] }
export interface PreparedPresetSave extends PolicySnapshot { readonly draft: PresetDraft; readonly before: PolicySnapshot }

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical)
  if (value !== null && typeof value === 'object') return Object.fromEntries(Object.entries(value)
    .filter(([, item]) => item !== undefined).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => [key, canonical(item)]))
  return value
}
export const sameRules = (a: readonly ToolPolicyRule[], b: readonly ToolPolicyRule[]): boolean => JSON.stringify(canonical(a)) === JSON.stringify(canonical(b))
export const presetRules = (rules: readonly ToolPolicyRule[], preset: string): readonly ToolPolicyRule[] => rules.filter(rule => rule.preset === preset)

export function editPresetDraft(drafts: PresetDrafts, preset: string, accepted: PolicySnapshot,
  change: (rules: readonly ToolPolicyRule[]) => readonly ToolPolicyRule[]): PresetDrafts {
  const previous = drafts.get(preset)
  const next = new Map(drafts)
  next.set(preset, { preset, revision: previous === undefined ? accepted.revision : previous.revision,
    baseline: previous?.baseline ?? accepted.rules, rules: change(previous?.rules ?? presetRules(accepted.rules, preset)) })
  return next
}

/** Replace just this source target, preserving all accepted other targets/order. */
export function mergePresetRules(accepted: readonly ToolPolicyRule[], preset: string, replacement: readonly ToolPolicyRule[]): readonly ToolPolicyRule[] {
  const first = accepted.findIndex(rule => rule.preset === preset)
  if (first < 0) return [...accepted, ...replacement]
  return [...accepted.slice(0, first), ...replacement, ...accepted.slice(first).filter(rule => rule.preset !== preset)]
}

export function preparePresetSave(draft: PresetDraft, accepted: PolicySnapshot): PreparedPresetSave {
  // Never silently rebase an external edit, even if only a different target changed.
  if (draft.revision !== accepted.revision || !sameRules(draft.baseline, accepted.rules)) throw new Error('policy-draft-conflict')
  return { draft, before: accepted, revision: draft.revision, rules: mergePresetRules(accepted.rules, draft.preset, draft.rules) }
}

export function acceptPresetSave(drafts: PresetDrafts, saved: PreparedPresetSave, accepted: PolicySnapshot): PresetDrafts {
  const next = new Map(drafts)
  if (next.get(saved.draft.preset) === saved.draft) next.delete(saved.draft.preset)
  // A true result is not enough: a later external view may already have arrived.
  if (!sameRules(accepted.rules, saved.rules)) return next
  for (const [preset, draft] of next) {
    if (draft.revision !== saved.before.revision || !sameRules(draft.baseline, saved.before.rules)) continue
    if (!sameRules(presetRules(saved.before.rules, preset), presetRules(accepted.rules, preset))) continue
    next.set(preset, { ...draft, revision: accepted.revision, baseline: accepted.rules })
  }
  return next
}
