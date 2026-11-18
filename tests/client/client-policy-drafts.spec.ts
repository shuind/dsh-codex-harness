import { describe, expect, it } from 'vitest'
import { acceptPresetSave, editPresetDraft, preparePresetSave } from '../../src/client/policy-drafts.ts'
import type { PresetDrafts } from '../../src/client/policy-drafts.ts'
import type { ToolPolicyRule } from '../../src/contracts/tool-policy-contract.ts'
const a: ToolPolicyRule = { preset: 'A', replaceShell: false, replacePlan: false, tools: [{ name: 'read', action: 'hide' }] }
const b: ToolPolicyRule = { preset: 'B', replaceShell: false, replacePlan: false, tools: [{ name: 'write', action: 'hide' }] }

describe('per-preset draft concurrency', () => {
  it('merges only A into accepted server rules, then safely rebases untouched B', () => {
    const root = { revision: 1, rules: [{ preset: 'unknown', allow: [] }] }
    let drafts: PresetDrafts = editPresetDraft(new Map(), 'A', root, () => [a])
    drafts = editPresetDraft(drafts, 'B', root, () => [b])
    const prepared = preparePresetSave(drafts.get('A')!, root)
    expect(prepared.rules).toEqual([...root.rules, a])
    drafts = acceptPresetSave(drafts, prepared, { revision: 2, rules: prepared.rules })
    expect(drafts.has('A')).toBe(false); expect(drafts.get('B')?.revision).toBe(2)
    expect(preparePresetSave(drafts.get('B')!, { revision: 2, rules: prepared.rules }).rules).toEqual([...root.rules, a, b])
  })

  it('does not rebase on an accepted view that differs from its known successful payload', () => {
    const root = { revision: 1, rules: [] }
    let drafts: PresetDrafts = editPresetDraft(new Map(), 'A', root, () => [a]); drafts = editPresetDraft(drafts, 'B', root, () => [b])
    const prepared = preparePresetSave(drafts.get('A')!, root)
    const next = acceptPresetSave(drafts, prepared, { revision: 3, rules: [a, { preset: 'external' }] })
    expect(next.get('B')?.revision).toBe(1)
    expect(() => preparePresetSave(next.get('B')!, { revision: 3, rules: [a, { preset: 'external' }] })).toThrow('conflict')
  })

  it('rejects an external revision even if only another preset changed', () => {
    const root = { revision: 1, rules: [{ preset: 'unrelated' }] }
    const drafts = editPresetDraft(new Map(), 'A', root, () => [a])
    expect(() => preparePresetSave(drafts.get('A')!, { revision: 2, rules: [{ preset: 'unrelated', deny: ['read'] }] })).toThrow('conflict')
  })

  it('keeps unknown and duplicate accepted records when a new target returns to no changes', () => {
    const root = { revision: 1, rules: [{ preset: 'X' }, { preset: 'X', allow: [] }, b] }
    const drafts = editPresetDraft(new Map(), 'A', root, () => [])
    expect(preparePresetSave(drafts.get('A')!, root).rules).toEqual(root.rules)
  })
})
