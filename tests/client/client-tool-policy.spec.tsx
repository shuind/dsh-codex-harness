import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { ReactElement } from 'react'
const hooks = vi.hoisted(() => ({ values: [] as any[], cursor: 0, effects: [] as Array<() => unknown>, cleanups: [] as Array<() => unknown> }))
vi.mock('react', async importOriginal => ({
  ...await importOriginal<typeof import('react')>(),
  useState(initial: any) { const index = hooks.cursor++; if (!(index in hooks.values)) hooks.values[index] = typeof initial === 'function' ? initial() : initial
    return [hooks.values[index], (next: any) => { hooks.values[index] = typeof next === 'function' ? next(hooks.values[index]) : next }] },
  useRef(initial: any) { const index = hooks.cursor++; return hooks.values[index] ??= { current: initial } },
  useEffect(effect: () => unknown, deps: any[]) { const index = hooks.cursor++; const previous = hooks.values[index]
    if (!previous || deps.some((value, i) => value !== previous[i])) hooks.effects.push(effect); hooks.values[index] = deps },
  useSyncExternalStore(_subscribe: unknown, read: () => unknown) { return read() },
}))
import { bindToolPolicy, resolveGptCapabilities, validateToolPolicyRules, saveToolPolicy, ToolPolicySection, ToolPolicySettingsCard, toolPolicyEn, toolPolicyZh, withToolAction } from '../../src/client/tool-policy.tsx'
import type { GptCapabilitiesState, ToolPolicyMode } from '../../src/client/tool-policy.tsx'
import { PresetDefinitionCard } from '../../src/client/preset-manager.tsx'
import { CodexSettingsTab, RuntimeSettingsEditor, saveDesktopSettings } from '../../src/client/desktop.tsx'
import type { PresetPromptCatalog, PresetPromptName, ToolPolicyRule, PresetToolCatalog, PresetToolEntry } from '../../src/contracts/tool-policy-contract.ts'
import { effectiveToolAction } from '../../src/contracts/tool-policy-contract.ts'
import { cachePresetCatalog } from '../../src/client/preset-requests.ts'
beforeEach(() => { hooks.values = []; hooks.cursor = 0; hooks.effects = []; hooks.cleanups = [] })
function elements(tree: any, match: (node: ReactElement<any>) => boolean): ReactElement<any>[] {
  if (!tree || typeof tree !== 'object') return []
  return [...(match(tree) ? [tree] : []), ...[tree.props?.children].flat(Infinity).flatMap(child => elements(child, match))]
}
const element = (tree: any, match: (node: ReactElement<any>) => boolean) => elements(tree, match)[0]!
const labelled = (tree: any, label: string) => element(tree, node => node.props?.['aria-label'] === label)
const button = (tree: any, label: string) => element(tree, node => node.type === 'button' && node.props.children === label)
const actionGroup = (tree: any, name: string) => labelled(tree, `toolPolicyAction ${name}`)
const actionButton = (tree: any, name: string, value: string) =>
  actionGroup(tree, name) === undefined ? undefined : element(actionGroup(tree, name), node => node.type === 'button' && node.props?.['data-action'] === value)
const chosenAction = (tree: any, name: string) =>
  actionGroup(tree, name) === undefined ? undefined : elements(actionGroup(tree, name), node => node.type === 'button' && node.props?.['aria-pressed'] === true)[0]?.props['data-action']
const pickAction = (tree: any, name: string, value: string) => {
  actionButton(tree, name, value)?.props.onClick()
}
const subModeButton = (tree: any, mode: string) => element(tree, node => node.type === 'button' && node.props?.['data-submode'] === mode)
const filterButton = (tree: any, filter: string) => element(tree, node => node.type === 'button' && node.props?.['data-filter'] === filter)
const submit = (tree: any) => element(tree, node => node.type === 'form').props.onSubmit({ preventDefault() {} })
const settle = async () => { for (let i = 0; i < 30; i++) await Promise.resolve() }
const registered: PresetToolEntry[] = [
  { name: 'read', description: 'Read file contents', conditional: false, replacements: [] },
  { name: 'write', description: 'Write a file', conditional: false, replacements: [{ action: 'codex-patch', tools: ['apply_patch'], available: true }] },
  { name: 'pwsh', description: 'Execute PowerShell', conditional: false, replacements: [{ action: 'codex-exec', tools: ['exec_command', 'write_stdin'], available: true }] },
  { name: 'todo_write', description: 'Write a plan', conditional: false, replacements: [{ action: 'codex-plan', tools: ['update_plan'], available: true }] },
  { name: 'bash', description: 'Conditional shell', conditional: true, replacements: [{ action: 'codex-exec', tools: ['exec_command', 'write_stdin'], available: false, reason: 'conditional' }] },
  { name: 'custom_tool', description: 'A real custom action', conditional: false, replacements: [] },
]
const inventory = (preset: string, tools = registered): PresetToolCatalog => ({ preset, registeredOnly: true, tools })
function managerFor(
  tools = vi.fn(async (id: string) => ({ ok: true, value: inventory(id) })),
  catalog?: any,
  prompts?: any,
) {
  const manager = { ready: Promise.resolve(), remote: { codexPresetEditor: { tools, catalog: catalog ?? vi.fn(), ...(prompts ? { prompts } : {}) } } }
  if (catalog === undefined) cachePresetCatalog(manager as never, { presets: ['standard', 'minimal'].map(id => ({ id, name: id, description: '', isDefault: false })), excludedCount: 0 })
  return manager
}
function editor(rules: readonly ToolPolicyRule[] = [], manager = managerFor(), gptCapabilities?: GptCapabilitiesState) {
  let snapshot = { status: 'ready', value: { rules }, base: {}, user: {}, revision: 7, writable: true }
  const mutate = vi.fn(async (ops: any[], revision?: number) => { if (revision !== snapshot.revision) return false
    snapshot = { ...snapshot, revision: snapshot.revision + 1, value: { rules: ops[0].value } }; return true })
  const form = { getSnapshot: () => snapshot, subscribe: () => () => {}, mutate }
  const props = { form, presetManager: manager, mode: 'tools', gptCapabilities, t: (key: string) => key } as any
  const render = () => { hooks.cursor = 0; const tree = ToolPolicySettingsCard(props)
    hooks.effects.splice(0).forEach(effect => { const cleanup = effect(); if (typeof cleanup === 'function') hooks.cleanups.push(cleanup as () => unknown) }); return tree }
  return { form, mutate, manager, render, mode: (mode: ToolPolicyMode) => { props.mode = mode; return render() }, snapshot: (patch: Partial<typeof snapshot>) => { snapshot = { ...snapshot, ...patch } },
    ready: async () => { render(); await settle(); return render() }, dispose: () => hooks.cleanups.splice(0).reverse().forEach(cleanup => cleanup()) }
}
async function navigate(ui: ReturnType<typeof editor>, id: string) {
  const tree = ui.render(); labelled(tree, 'toolPolicyPresetChoice').props.onChange({ target: { value: id } }); ui.render(); await settle(); return ui.render()
}
const saved = (ui: ReturnType<typeof editor>, call = 0) => ui.mutate.mock.calls[call]![0]![0].value as ToolPolicyRule[]

describe('target-scoped tool plans', () => {
  it('uses unified segmented actions, inline search/filters, and open DSH groups', async () => {
    const ui = editor(); const tree = await ui.ready()
    expect(element(tree, node => node.props?.['data-tool-group'] === 'command').props.open).toBe(true)
    expect(element(tree, node => node.props?.['data-tool-group'] === 'file').props.open).toBe(true)
    expect(element(tree, node => node.props?.['data-tool-group'] === 'other').props.open).toBe(true)
    expect(element(tree, node => node.type === 'span' && node.props.children === 'toolLabelRead')).toBeDefined()
    expect(element(tree, node => node.type === 'code' && node.props.children === 'read')).toBeDefined()
    expect(labelled(tree, 'toolPolicySearch')).toBeDefined(); expect(labelled(tree, 'toolPolicyAllow 0')).toBeUndefined()
    expect(button(tree, 'toolPolicySave').props.disabled).toBe(true); expect(ui.mutate).not.toHaveBeenCalled()
  })

  it('changes only one tool via 1-click pills, keeps exec targets together, and removes a redundant new rule', async () => {
    const ui = editor(); let tree = await ui.ready()
    expect(actionButton(tree, 'pwsh', 'codex-exec')?.props.title).toBe('exec_command + write_stdin')
    pickAction(tree, 'pwsh', 'codex-exec'); tree = ui.render()
    expect(chosenAction(tree, 'todo_write')).toBe('keep'); expect(chosenAction(tree, 'read')).toBe('keep')
    submit(tree); await settle(); expect(saved(ui)).toEqual([{ preset: 'standard', replaceShell: false, replacePlan: false, tools: [{ name: 'pwsh', action: 'codex-exec' }] }])
    tree = await navigate(ui, 'minimal'); pickAction(tree, 'read', 'hide'); tree = ui.render()
    pickAction(tree, 'read', 'keep'); tree = ui.render(); submit(tree); await settle()
    expect(saved(ui, 1)).toEqual(saved(ui))
  })

  it('saves only the current preset and safely rebases the other unchanged target after its own save', async () => {
    const untouched: ToolPolicyRule = { preset: 'unknown', allow: [], deny: [' original '], tools: [{ name: 'future', action: 'keep' }] }
    const ui = editor([untouched]); let tree = await ui.ready(); pickAction(tree, 'read', 'hide')
    tree = await navigate(ui, 'minimal'); pickAction(tree, 'todo_write', 'codex-plan')
    tree = await navigate(ui, 'standard'); submit(tree); await settle()
    expect(saved(ui)).toEqual([untouched, { preset: 'standard', replaceShell: false, replacePlan: false, tools: [{ name: 'read', action: 'hide' }] }])
    expect(ui.mutate.mock.calls[0]![1]).toBe(7)
    tree = await navigate(ui, 'minimal'); expect(chosenAction(tree, 'todo_write')).toBe('codex-plan'); submit(tree); await settle()
    expect(saved(ui, 1)).toHaveLength(3); expect(saved(ui, 1)[0]).toEqual(untouched); expect(ui.mutate.mock.calls[1]![1]).toBe(8)
    pickAction(tree, 'write', 'codex-patch'); tree = ui.render(); submit(tree); await settle()
    expect(saved(ui, 2).find(r => r.preset === 'minimal')?.tools).toEqual([
      { name: 'todo_write', action: 'codex-plan' },
      { name: 'write', action: 'codex-patch' },
    ])
  })

  it.each([true, false])('keeps another selected preset during a pending tool save, with target-labelled status (%s)', async accepted => {
    const ui = editor([{ preset: 'standard', replaceShell: false, replacePlan: false, tools: [{ name: 'read', action: 'hide' }] }]); let tree = await ui.ready()
    pickAction(tree, 'write', 'hide'); tree = ui.render(); let finish!: () => void
    ui.mutate.mockImplementationOnce((ops: any[]) => new Promise<boolean>(resolve => { finish = () => {
      if (accepted) ui.snapshot({ revision: 8, value: { rules: ops[0].value } }); resolve(accepted)
    } }))
    submit(tree); tree = await navigate(ui, 'minimal'); finish(); await settle(); tree = ui.render()
    expect(labelled(tree, 'toolPolicyPresetChoice').props.value).toBe('minimal')
    const status = element(tree, node => node.props?.role === (accepted ? 'status' : 'alert'))
    expect(status.props.children).toContain('standard:')
  })

  it('summarizes only this draft’s tool changes and preserves preset context across YAML sub-view', async () => {
    const ui = editor([{ preset: 'standard', replaceShell: false, replacePlan: false, tools: [{ name: 'read', action: 'hide' }] }]); let tree = await ui.ready()
    pickAction(tree, 'write', 'hide'); tree = ui.render()
    const summary = JSON.stringify(labelled(tree, 'toolPolicyDraftSummary').props.children)
    expect(summary).toContain('write'); expect(summary).not.toContain('(read)')
    button(tree, 'toolPolicyDiscard').props.onClick(); tree = await navigate(ui, 'minimal')
    for (const tool of registered) { pickAction(tree, tool.name, 'hide'); tree = ui.render() }
    expect(JSON.stringify(labelled(tree, 'toolPolicyDraftSummary').props.children)).toContain('(+2)')
    const definition = ui.mode('definition')
    expect(labelled(definition, 'toolPolicyPresetChoice').props.value).toBe('minimal')
    expect(element(definition, node => node.type === PresetDefinitionCard).props.id).toBe('minimal')
  })

  it('discards only this target and keeps drafts through inactive/runtime and prompts sub-views', async () => {
    const ui = editor(); let tree = await ui.ready(); pickAction(tree, 'read', 'hide')
    tree = await navigate(ui, 'minimal'); pickAction(tree, 'write', 'hide')
    expect(ui.mode('inactive')).toBeNull(); tree = ui.mode('tools'); expect(chosenAction(tree, 'write')).toBe('hide')
    button(tree, 'toolPolicyDiscard').props.onClick(); tree = ui.render(); expect(chosenAction(tree, 'write')).toBe('keep')
    tree = await navigate(ui, 'standard'); expect(chosenAction(tree, 'read')).toBe('hide'); expect(ui.mutate).not.toHaveBeenCalled()
  })

  it('preserves legacy fields and unknown choices when editing and restoring an ordinary tool', async () => {
    const original: ToolPolicyRule = { preset: 'standard', allow: ['pwsh'], deny: ['read'], replaceShell: true, replacePlan: true, tools: [{ name: 'future', action: 'hide' }] }
    const ui = editor([original]); let tree = await ui.ready(); expect(chosenAction(tree, 'read')).toBe('hide')
    pickAction(tree, 'read', 'keep'); tree = ui.render(); submit(tree); await settle()
    expect(saved(ui)[0]).toEqual({ ...original, tools: [...original.tools!, { name: 'read', action: 'keep' }] })
    labelled(tree, 'toolPolicyRestoreChoice read').props.onClick()
    tree = ui.render(); submit(tree); await settle()
    expect(saved(ui, 1)[0]).toEqual(original)
  })

  it('suppresses noisy conditional pills on codexTool entries while keeping non-codex conditional labels', async () => {
    const tools: PresetToolEntry[] = [
      { name: 'apply_patch', description: 'Patch', conditional: false, replacements: [], codexTool: { capability: 'patchToolEnabled', presetEnabled: true } },
      { name: 'exec_command', description: 'Exec', conditional: true, replacements: [], codexTool: { capability: 'terminalToolsEnabled', presetEnabled: false } },
      { name: 'write_stdin', description: 'Stdin', conditional: false, replacements: [], codexTool: { capability: 'terminalToolsEnabled', presetEnabled: true, presetOverridesLegacy: true } },
      { name: 'bash', description: 'Conditional shell', conditional: true, replacements: [] },
    ]
    const manager = managerFor(vi.fn(async id => ({ ok: true, value: { ...inventory(id, tools), legacyCapabilities: { patchToolEnabled: false, terminalToolsEnabled: false } } })))
    const ui = editor([], manager); let tree = await ui.ready()
    expect(chosenAction(tree, 'apply_patch')).toBe('hide'); expect(chosenAction(tree, 'write_stdin')).toBe('keep')
    const execRow = element(tree, node => node.props?.['data-tool-name'] === 'exec_command')
    expect(elements(execRow, node => node.type === 'span' && node.props.children === 'toolPolicyPresetDisabled')).toHaveLength(1)
    expect(elements(execRow, node => node.type === 'span' && node.props.children === 'toolPolicyConditional')).toHaveLength(0)
    const bashRow = element(tree, node => node.props?.['data-tool-name'] === 'bash')
    expect(elements(bashRow, node => node.type === 'span' && node.props.children === 'toolPolicyConditional')).toHaveLength(1)
    pickAction(tree, 'apply_patch', 'keep'); tree = ui.render(); submit(tree); await settle()
    expect(saved(ui)[0]?.tools).toEqual([{ name: 'apply_patch', action: 'keep' }])
  })

  it('filters inline in unified tools view without inventing invalid replacements', async () => {
    const ui = editor(); let tree = await ui.ready()
    expect(actionButton(tree, 'write', 'codex-plan')).toBeUndefined()
    expect(actionButton(tree, 'bash', 'codex-exec')?.props.disabled).toBe(true)
    expect(button(tree, 'toolPolicySave').props.disabled).toBe(true)
    labelled(tree, 'toolPolicySearch').props.onChange({ target: { value: 'PowerShell' } }); tree = ui.render()
    expect(elements(tree, node => node.props?.['data-tool-name'] !== undefined).map(node => node.props['data-tool-name'])).toEqual(['pwsh'])
    filterButton(tree, 'modified').props.onClick(); tree = ui.render(); expect(actionGroup(tree, 'pwsh')).toBeUndefined()
    expect(ui.mutate).not.toHaveBeenCalled()
  })

  it('keeps stale choices and unrelated legacy targets intact across current-target changes', async () => {
    const original: ToolPolicyRule = { preset: 'standard', allow: [], deny: ['future_block'], tools: [{ name: 'old_tool', action: 'codex-plan' }] }
    const other: ToolPolicyRule = { preset: 'unknown-preset', replaceShell: false, replacePlan: true, tools: [{ name: 'another_future_tool', action: 'keep' }] }
    const ui = editor([original, other]); let tree = await ui.ready()
    pickAction(tree, 'read', 'keep'); tree = ui.render(); submit(tree); await settle()
    expect(saved(ui)).toEqual([{ ...original, tools: [...original.tools!, { name: 'read', action: 'keep' }] }, other])
    labelled(tree, 'toolPolicyRestoreChoice read').props.onClick(); tree = ui.render(); submit(tree); await settle()
    expect(saved(ui, 1)).toEqual([original, other])
  })

  it('keeps ordinary empty/duplicate ID validation without a configuration repair UI', async () => {
    expect(validateToolPolicyRules([{ preset: '' }])).toBe('toolPolicyInvalidPreset')
    expect(validateToolPolicyRules([{ preset: 'standard' }, { preset: ' standard ' }])).toBe('toolPolicyDuplicatePreset')
    const rules: ToolPolicyRule[] = [{ preset: 'standard', tools: [{ name: 'read', action: 'hide' }] }, { preset: 'standard', tools: [{ name: 'write', action: 'hide' }] }]
    const ui = editor(rules); const tree = await ui.ready()
    expect(actionGroup(tree, 'read')).toBeUndefined(); expect(button(tree, 'toolPolicySave').props.disabled).toBe(true)
    expect(element(tree, node => node.type === 'input')).toBeUndefined()
    submit(tree); await settle(); expect(ui.mutate).not.toHaveBeenCalled(); expect(ui.form.getSnapshot().value.rules).toEqual(rules)
  })

  it('retains drafts after refusal/transport and never rebases an external revision silently', async () => {
    const ui = editor(); let tree = await ui.ready(); pickAction(tree, 'read', 'hide')
    ui.mutate.mockResolvedValueOnce(false); tree = ui.render(); submit(tree); await settle(); expect(chosenAction(ui.render(), 'read')).toBe('hide')
    tree = await navigate(ui, 'minimal'); pickAction(tree, 'todo_write', 'codex-plan')
    ui.snapshot({ revision: 8, value: { rules: [{ preset: 'standard', deny: ['remote'] }] } }); tree = await navigate(ui, 'standard'); submit(tree); await settle()
    expect(ui.mutate).toHaveBeenCalledOnce(); expect(element(ui.render(), node => node.props?.role === 'alert').props.children).toContain('toolPolicyRefused')
    button(ui.render(), 'toolPolicyDiscard').props.onClick(); tree = ui.render(); pickAction(tree, 'read', 'hide')
    ui.mutate.mockRejectedValueOnce(new Error('offline')); tree = ui.render(); submit(tree); await settle()
    expect(ui.mutate.mock.calls[1]![1]).toBe(8); expect(chosenAction(ui.render(), 'read')).toBe('hide')
    tree = await navigate(ui, 'minimal'); expect(chosenAction(tree, 'todo_write')).toBe('codex-plan'); submit(tree); await settle(); expect(ui.mutate).toHaveBeenCalledTimes(2)
  })

  it('rejects late A responses after selecting B, and does not write after disposal', async () => {
    const pending = new Map<string, (value: any) => void>(); const tools = vi.fn((id: string) => new Promise<any>(resolve => pending.set(id, resolve)))
    const ui = editor([], managerFor(tools)); ui.render(); await settle(); await navigate(ui, 'minimal')
    pending.get('minimal')!({ ok: true, value: inventory('minimal', [{ name: 'B', description: 'B', conditional: false, replacements: [] }]) }); await settle()
    pending.get('standard')!({ ok: true, value: inventory('standard', [{ name: 'A', description: 'A', conditional: false, replacements: [] }]) }); await settle()
    let tree = ui.render(); expect(actionGroup(tree, 'B')).toBeDefined(); expect(actionGroup(tree, 'A')).toBeUndefined()
    button(tree, 'toolPolicyToolsRefresh').props.onClick(); ui.dispose(); pending.get('minimal')!({ ok: true, value: inventory('minimal', []) }); await settle(); expect(ui.mutate).not.toHaveBeenCalled()
  })

  it('preserves saved data on inventory failure and makes unsupported namespaces/readonly safe', async () => {
    const rules: ToolPolicyRule[] = [{ preset: 'standard', allow: [], tools: [{ name: 'saved', action: 'hide' }] }]
    const ui = editor(rules, managerFor(vi.fn(async () => { throw new Error('offline') })))
    let tree = await ui.ready(); expect(element(tree, node => node.props?.role === 'table')).toBeUndefined()
    expect(ui.form.getSnapshot().value.rules).toEqual(rules)
    expect(element(tree, node => node.props?.role === 'status' && node.props.children === 'toolPolicyToolsFailed')).toBeDefined()
    ui.snapshot({ writable: false }); tree = ui.render()
    expect(element(tree, node => node.type === 'fieldset').props.disabled).toBe(true); submit(tree); expect(ui.mutate).not.toHaveBeenCalled()
    ui.snapshot({ status: 'unavailable' }); expect(ui.render()).toBeNull()
  })

  it('still selects saved IDs and preserves their legacy/unknown data when the catalog fails', async () => {
    const catalog = vi.fn(async () => { throw new Error('offline') }); const tools = vi.fn(async id => ({ ok: true, value: inventory(id) }))
    const original: ToolPolicyRule = { preset: 'saved-custom-id', deny: ['future_tool'], replaceShell: false, tools: [{ name: 'unknown', action: 'hide' }] }
    const ui = editor([original], managerFor(tools, catalog)); let tree = await ui.ready()
    expect(labelled(tree, 'toolPolicyPresetChoice').props.value).toBe('saved-custom-id')
    expect(tools).toHaveBeenCalledWith('saved-custom-id'); pickAction(tree, 'read', 'hide'); tree = ui.render(); submit(tree); await settle()
    expect(saved(ui)[0]).toEqual({ ...original, tools: [...original.tools!, { name: 'read', action: 'hide' }] }); expect(catalog).toHaveBeenCalledOnce()
  })

  it('uses matching locales, exact baseline overrides, and localized annotations for official and MCP tools', async () => {
    expect(Object.keys(toolPolicyEn).sort()).toEqual(Object.keys(toolPolicyZh).sort())
    const context = { legacyCapabilities: { patchToolEnabled: false }, codexTool: { capability: 'patchToolEnabled' as const, presetEnabled: true } }
    const next = withToolAction({ preset: 'standard', replaceShell: false, replacePlan: false }, 'apply_patch', 'keep', context)
    expect(next.tools).toEqual([{ name: 'apply_patch', action: 'keep' }]); expect(effectiveToolAction(next, 'apply_patch', context)).toBe('keep')

    const tools: PresetToolEntry[] = [
      { name: 'job_list', description: 'List your background jobs (running and finished) with their ids, kinds, and statuses.', conditional: false, replacements: [] },
      { name: 'list_subagent_models', description: 'Inspect subagent models without changing the current Agent.', conditional: false, replacements: [] },
      { name: 'schedule_create', description: 'Create a recurring or one-shot schedule.', conditional: false, replacements: [] },
      { name: 'mcp__github__list_issues', description: 'List repository issues from GitHub', conditional: false, replacements: [] },
    ]
    const ui = editor([], managerFor(vi.fn(async id => ({ ok: true, value: inventory(id, tools) }))))
    const tree = await ui.ready()
    const labels = elements(tree, node => node.props?.className === 'codex-tool-policy-description').map(node => node.props.children)
    expect(labels).toEqual([
      'toolLabelJobList',
      'toolLabelSubagentModels',
      'toolLabelScheduleCreate',
      'toolLabelMcpDynamic (github · list_issues)',
    ])
  })

  it('supports deferring unconditional tools, respects defaultDeferred baselines, and guards conditional or activate_tools collisions', async () => {
    const tools: PresetToolEntry[] = [
      { name: 'read', description: 'Read files', conditional: false, replacements: [] },
      { name: 'bash', description: 'Conditional shell', conditional: true, replacements: [] },
      { name: 'workflow', description: 'Run workflow', conditional: false, defaultDeferred: true, replacements: [] },
    ]
    const ui = editor([], managerFor(vi.fn(async id => ({ ok: true, value: inventory(id, tools) }))))
    let tree = await ui.ready()

    expect(actionButton(tree, 'bash', 'defer')?.props.disabled).toBe(true)
    expect(actionButton(tree, 'read', 'defer')?.props.disabled).toBe(false)
    expect(chosenAction(tree, 'workflow')).toBe('defer')

    pickAction(tree, 'read', 'defer')
    pickAction(tree, 'workflow', 'keep')
    tree = ui.render(); submit(tree); await settle()
    expect(saved(ui)).toEqual([{
      preset: 'standard',
      replaceShell: false,
      replacePlan: false,
      tools: [{ name: 'read', action: 'defer' }, { name: 'workflow', action: 'keep' }],
    }])

    const colliding = editor([], managerFor(vi.fn(async id => ({
      ok: true,
      value: inventory(id, [...tools, { name: 'activate_tools', description: 'Collision', conditional: false, replacements: [] }]),
    }))))
    const collidingTree = await colliding.ready()
    expect(actionButton(collidingTree, 'read', 'defer')?.props.disabled).toBe(true)
  })
})

describe('policy form binding', () => {
  it('does not read unserved namespaces and disposes availability', () => {
    const ui = editor(); let register: (() => () => void) | undefined; let cleanup: (() => void) | undefined; const get = vi.fn(() => ui.form); const stop = vi.fn()
    const binding = bindToolPolicy({ effect: (setup: () => () => void) => { cleanup = setup(); return cleanup } } as never, {
      get, whileServed: (_ns: string[], setup: () => () => void) => { register = setup; return stop },
    } as never)
    expect(ToolPolicySection({ binding, t: (key: string) => key } as any)).toBeNull(); expect(get).not.toHaveBeenCalled(); const off = register!()
    expect(binding.getSnapshot()).toBe(ui.form); off(); expect(binding.getSnapshot()).toBeUndefined(); cleanup!(); expect(stop).toHaveBeenCalledOnce()
  })
  it('sends one rules array and the exact fence', async () => {
    const ui = editor(); const rules: ToolPolicyRule[] = [{ preset: 'standard', allow: [], tools: [{ name: 'read', action: 'keep' }] }]
    await saveToolPolicy(ui.form as never, rules, 7); expect(ui.mutate).toHaveBeenLastCalledWith([{ op: 'set', path: ['rules'], value: rules }], 7)
  })
})

describe('prompt overrides, runtime settings, and read-only preset definition viewer', () => {
  it('loads prompts lazily via sub-view pill, saves prompt and tool edits in one draft, and guards readonly', async () => {
    const prefix: PresetPromptName = 'deployment:persona-prefix'
    const promptCatalog = (preset: string): PresetPromptCatalog => ({
      preset,
      sections: [
        { name: prefix, label: 'Persona', text: `${preset} native persona`, editable: true, order: -10, complete: true, interpolate: true },
        { name: 'native:dynamic', label: 'Dynamic', text: 'Dynamic text', editable: false, reason: 'dynamic' },
      ],
    })
    const prompts = vi.fn(async (id: string) => ({ ok: true as const, value: promptCatalog(id) }))
    const ui = editor([], managerFor(undefined, undefined, prompts))
    let tree = ui.render(); await settle()
    expect(prompts).not.toHaveBeenCalled()

    subModeButton(tree, 'prompts').props.onClick(); tree = ui.render(); await settle(); tree = ui.render()
    expect(prompts).toHaveBeenCalledWith('standard')
    expect(labelled(tree, `settingsPresetPrompts ${prefix}`).props.value).toBe('standard native persona')
    expect(labelled(tree, 'settingsPresetPrompts native:dynamic')).toBeUndefined()

    labelled(tree, `settingsPresetPrompts ${prefix}`).props.onChange({ target: { value: '' } })
    subModeButton(tree, 'tools').props.onClick(); tree = ui.render()
    pickAction(tree, 'read', 'hide')
    tree = ui.render(); submit(tree); await settle()
    expect(saved(ui)).toEqual([{
      preset: 'standard', replaceShell: false, replacePlan: false,
      tools: [{ name: 'read', action: 'hide' }],
      promptOverrides: [{ name: prefix, text: '' }],
    }])

    tree = ui.mode('prompts'); await settle(); tree = ui.render()
    labelled(tree, `presetPromptRestore ${prefix}`).props.onClick()
    tree = ui.render(); submit(tree); await settle()
    expect(saved(ui, 1)[0]).toEqual({ preset: 'standard', replaceShell: false, replacePlan: false, tools: [{ name: 'read', action: 'hide' }] })

    ui.snapshot({ writable: false })
    tree = ui.render()
    expect(labelled(tree, `settingsPresetPrompts ${prefix}`).props.disabled).toBe(true)
  })

  it('reads one fixed read-only preset definition without write actions and navigates settings pages', async () => {
    const read = vi.fn(async (id: string) => ({ ok: true as const, value: { id, name: id, description: 'desc', composition: `definition:${id}` } }))
    const props = { presetManager: { ready: Promise.resolve(), remote: { codexPresetEditor: { read } } }, id: 'standard', t: (key: string) => key } as any
    const renderCard = () => { hooks.cursor = 0; const tree = PresetDefinitionCard(props); hooks.effects.splice(0).forEach(effect => effect()); return tree }
    renderCard(); await settle()
    let cardTree = renderCard()
    expect(element(cardTree, node => node.type === 'pre').props.children).toBe('definition:standard')
    expect(button(cardTree, 'pmSave')).toBeUndefined()
    props.id = 'minimal'; renderCard(); await settle()
    cardTree = renderCard()
    expect(element(cardTree, node => node.type === 'pre').props.children).toBe('definition:minimal')
    expect(read.mock.calls.map(call => call[0])).toEqual(['standard', 'minimal'])

    hooks.values = []; hooks.cursor = 0; hooks.effects = []
    const mutate = vi.fn(async () => true)
    const runtimeProps = { active: true, t: (key: string) => key,
      useSettings: (select: (v: unknown) => unknown) => select({ status: 'ready', writable: true, revision: 3, value: { contextWindow: 96000 }, base: {} }),
      saveSettings: (edits: Record<string, unknown>, revision?: number) => saveDesktopSettings({ mutate }, edits, revision),
    } as any
    hooks.cursor = 0
    let tabTree = CodexSettingsTab({ t: (key: string) => key, toolPolicy: {}, presetManager: {} } as any)
    expect(element(tabTree, node => node.type === ToolPolicySection).props.mode).toBe('tools')
    button(tabTree, 'settingsRuntimePage').props.onClick(); hooks.cursor = 0
    tabTree = CodexSettingsTab({ t: (key: string) => key, toolPolicy: {}, presetManager: {} } as any)
    expect(element(tabTree, node => node.type === RuntimeSettingsEditor).props.active).toBe(true)

    hooks.values = []; hooks.cursor = 0
    let rt = RuntimeSettingsEditor(runtimeProps)
    const walk = (node: any): any[] => node == null || typeof node !== 'object' ? []
      : Array.isArray(node) ? node.flatMap(walk)
        : [node, ...walk(node.props?.children)]
    expect(walk(rt).some(node => node.type === 'input' && node.props?.type === 'number')).toBe(false)
    element(rt, node => node.type === 'input' && node.props['aria-label'] === 'fast').props.onChange({ target: { checked: true } })
    hooks.cursor = 0; rt = RuntimeSettingsEditor(runtimeProps)
    element(rt, node => node.type === 'form').props.onSubmit({ preventDefault() {} }); await settle()
    expect(mutate).toHaveBeenLastCalledWith([{ op: 'set', path: ['fast'], value: true }], 3)
  })

  it('pins a top GPT capabilities group for GPT-sourced search, image generation, and read-only compaction', async () => {
    const gptTools: PresetToolEntry[] = [
      ...registered,
      { name: 'web_search', description: 'Search the web', conditional: false, replacements: [] },
      { name: 'codex_connect_image_generate', description: 'Generate or edit images', conditional: false, replacements: [] },
    ]
    const caps = resolveGptCapabilities(
      { hostedWebSearchEnabled: true, remoteCompactionEnabled: true },
      {
        status: 'ready',
        writable: true,
        searchEnabled: true,
        searchModel: 'gpt-6.2-sol',
        imageGenerationEnabled: true,
        imageModelHint: 'gpt-image-2.6-sunburst',
      },
    )
    const ui = editor([], managerFor(vi.fn(async (id: string) => ({ ok: true, value: inventory(id, gptTools) }))), caps)
    let tree = await ui.ready()
    const groups = elements(tree, node => typeof node.props?.['data-tool-group'] === 'string')
    expect(groups[0]?.props['data-tool-group']).toBe('gpt')
    const gptGroup = groups[0]!
    expect(element(gptGroup, node => node.props?.['data-tool-name'] === 'web_search')).toBeDefined()
    expect(element(gptGroup, node => node.props?.['data-tool-name'] === 'codex_connect_image_generate')).toBeDefined()
    expect(element(gptGroup, node => node.props?.['data-gpt-capability'] === 'compaction')).toBeDefined()
    expect(element(gptGroup, node => node.props?.['data-tone'] === 'gpt' && node.props.children === 'toolPolicyGptDualSearch')).toBeDefined()
    expect(element(gptGroup, node => node.props?.['data-tone'] === 'gpt' && node.props.children === 'GPT-Image-2.6 Sunburst')).toBeDefined()
    expect(element(gptGroup, node => node.props?.['data-tone'] === 'gpt' && node.props.children === 'toolPolicyGptCompactionBadge')).toBeDefined()
    expect(actionGroup(gptGroup, '/compact')).toBeUndefined()

    labelled(tree, 'toolPolicySearch').props.onChange({ target: { value: 'compact' } })
    tree = ui.render()
    expect(element(tree, node => node.props?.['data-gpt-capability'] === 'compaction')).toBeDefined()

    labelled(tree, 'toolPolicySearch').props.onChange({ target: { value: '' } })
    filterButton(tree, 'modified').props.onClick()
    tree = ui.render()
    expect(element(tree, node => node.props?.['data-gpt-capability'] === 'compaction')).toBeUndefined()

    hooks.values = []; hooks.cursor = 0; hooks.effects = []
    const nonGptTools: PresetToolEntry[] = [
      ...registered,
      { name: 'web_search', description: 'Search the web', conditional: false, replacements: [] },
    ]
    const offCaps = resolveGptCapabilities(
      { hostedWebSearchEnabled: false, remoteCompactionEnabled: false },
      { status: 'ready', writable: true, searchEnabled: false, nativeCompaction: false, imageGenerationEnabled: false },
    )
    const uiOff = editor([], managerFor(vi.fn(async (id: string) => ({ ok: true, value: inventory(id, nonGptTools) }))), offCaps)
    const treeOff = await uiOff.ready()
    expect(element(treeOff, node => node.props?.['data-tool-group'] === 'gpt')).toBeUndefined()
    const otherGroup = element(treeOff, node => node.props?.['data-tool-group'] === 'other')
    expect(element(otherGroup, node => node.props?.['data-tool-name'] === 'web_search')).toBeDefined()
  })
})
