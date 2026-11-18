/** Unified preset plan editor: 1-click segmented tool actions, prompt overrides, and YAML inspector. */
import { useEffect, useRef, useState, useSyncExternalStore } from 'react'
import type { Context } from '@deepseek-ai/cordis'
import type { HostObservable, PropsLocale } from '@deepseek-ai/dsh-client-ui-slots'
import type { ConfigForm } from '@deepseek-ai/dsh-client-ui-settings/client'
import { PresetDefinitionCard } from './preset-manager.tsx'
import type { PresetManagerActions } from './preset-manager.tsx'
import {
  cachedPresetCatalog, cachedPresetPrompts, cachedPresetTools,
  requestPresetCatalog, requestPresetPrompts, requestPresetTools,
} from './preset-requests.ts'
import { effectiveToolAction, legacyToolAction } from '../contracts/tool-policy-contract.ts'
import type {
  PresetPromptCatalog, PresetPromptEntry, PresetPromptName, PresetToolCatalog,
  PresetToolEntry, ToolAction, ToolActionContext, ToolPolicyRule,
} from '../contracts/tool-policy-contract.ts'
import { PRESET_PROMPT_NAMES } from '../contracts/ui-contracts.ts'
import { acceptPresetSave, editPresetDraft, preparePresetSave, presetRules, sameRules } from './policy-drafts.ts'
import type { PresetDrafts } from './policy-drafts.ts'
import { groupOf, humanLabels, policyStyles, toolPolicyEn, toolPolicyZh } from './policy-locale.ts'
import type { ToolGroupId } from './policy-locale.ts'
export type { ToolPolicyRule } from '../contracts/tool-policy-contract.ts'
export { toolPolicyEn, toolPolicyZh }

export const TOOL_POLICY_NAMESPACE = 'codex-tool-policy'
export interface ToolPolicySettings { readonly rules: readonly ToolPolicyRule[] }
export type ObservableConfigForm<T> = Pick<ConfigForm<T>, 'getSnapshot' | 'subscribe' | 'mutate'>
export type ToolPolicyForm = ObservableConfigForm<ToolPolicySettings>
export type ToolPolicyBinding = HostObservable<ToolPolicyForm | undefined>
type PolicyForms = Pick<Context['configForms'], 'get' | 'whileServed'>

export function bindToolPolicy(ctx: Pick<Context, 'effect'>, forms: PolicyForms): ToolPolicyBinding {
  let form: ToolPolicyForm | undefined
  const listeners = new Set<() => void>()
  const publish = (next: ToolPolicyForm | undefined) => {
    form = next
    for (const listener of [...listeners]) listener()
  }
  ctx.effect(
    () => forms.whileServed([TOOL_POLICY_NAMESPACE], () => {
      publish(forms.get<ToolPolicySettings>(TOOL_POLICY_NAMESPACE))
      return () => publish(undefined)
    }),
    'codex client: tool-policy availability',
  )
  return {
    getSnapshot: () => form,
    subscribe: listener => { listeners.add(listener); return () => { listeners.delete(listener) } },
  }
}

type MutableRule = { -readonly [Key in keyof ToolPolicyRule]: ToolPolicyRule[Key] }

export function validateToolPolicyRules(rules: readonly ToolPolicyRule[]): 'toolPolicyInvalidPreset' | 'toolPolicyDuplicatePreset' | undefined {
  const ids = new Set<string>()
  for (const rule of rules) {
    const id = rule.preset.trim()
    if (!id) return 'toolPolicyInvalidPreset'
    if (ids.has(id)) return 'toolPolicyDuplicatePreset'
    ids.add(id)
  }
  return undefined
}

export function withToolAction(rule: ToolPolicyRule, name: string, action: ToolAction, context: ToolActionContext = {}): ToolPolicyRule {
  const next: MutableRule = { ...rule }
  const tools = [...(rule.tools ?? [])].filter(tool => tool.name !== name)
  if (action !== legacyToolAction(rule, name, context)) tools.push({ name, action })
  if (tools.length) next.tools = tools
  else delete next.tools
  return next
}

export function saveToolPolicy(form: ToolPolicyForm, rules: readonly ToolPolicyRule[], revision: number | undefined): Promise<boolean> {
  const value = rules.map(rule => {
    const row: Record<string, string | boolean | string[] | Array<{ name: string; action: string }> | Array<{ name: string; text: string }>> = { preset: rule.preset }
    if (rule.allow !== undefined) row.allow = [...rule.allow]
    if (rule.deny !== undefined) row.deny = [...rule.deny]
    if (rule.replaceShell !== undefined) row.replaceShell = rule.replaceShell
    if (rule.replacePlan !== undefined) row.replacePlan = rule.replacePlan
    if (rule.replacePatch !== undefined) row.replacePatch = rule.replacePatch
    if (rule.tools !== undefined) row.tools = rule.tools.map(tool => ({ ...tool }))
    if (rule.promptOverrides !== undefined) row.promptOverrides = rule.promptOverrides.map(override => ({ name: override.name, text: override.text }))
    return row
  })
  return form.mutate([{ op: 'set', path: ['rules'], value }], revision)
}

export type ToolPolicySubMode = 'tools' | 'prompts' | 'definition'
export type ToolPolicyMode = ToolPolicySubMode | 'inactive'
type PolicyProps = PropsLocale<'codex'> & { presetManager?: PresetManagerActions | undefined; mode?: ToolPolicyMode }
type ToolsView = { preset: string; status: 'loading' | 'ready' | 'error'; value?: PresetToolCatalog }
type PromptsView = { preset: string; status: 'loading' | 'ready' | 'error'; value?: PresetPromptCatalog }
const isPromptName = (name: string): name is PresetPromptName => (PRESET_PROMPT_NAMES as readonly string[]).includes(name)

const GROUP_META: readonly { id: ToolGroupId; labelKey: 'toolPolicyCommandGroup' | 'toolPolicyFileGroup' | 'toolPolicyPlanGroup' | 'toolPolicyCollabGroup' | 'toolPolicyOtherGroup' }[] = [
  { id: 'command', labelKey: 'toolPolicyCommandGroup' },
  { id: 'file', labelKey: 'toolPolicyFileGroup' },
  { id: 'plan', labelKey: 'toolPolicyPlanGroup' },
  { id: 'collab', labelKey: 'toolPolicyCollabGroup' },
  { id: 'other', labelKey: 'toolPolicyOtherGroup' },
]

export function ToolPolicySection({ binding, ...props }: { binding: ToolPolicyBinding } & PolicyProps) {
  const form = useSyncExternalStore(binding.subscribe, binding.getSnapshot, binding.getSnapshot)
  return form === undefined ? null : <ToolPolicySettingsCard form={form} {...props} />
}

export function ToolPolicySettingsCard({ form, presetManager, mode = 'tools', t }: { form: ToolPolicyForm } & PolicyProps) {
  const snapshot = useSyncExternalStore(listener => form.subscribe(listener), () => form.getSnapshot(), () => form.getSnapshot())
  const [subMode, setSubMode] = useState<ToolPolicySubMode>(mode === 'prompts' || mode === 'definition' ? mode : 'tools')
  const prevMode = useRef(mode)
  const modeChanged = prevMode.current !== mode
  prevMode.current = mode
  const activeSub: ToolPolicySubMode = modeChanged && (mode === 'tools' || mode === 'prompts' || mode === 'definition') ? mode : subMode
  const [drafts, setDrafts] = useState<PresetDrafts>(() => new Map())
  const [saving, setSaving] = useState(false); const [error, setError] = useState(''); const [notice, setNotice] = useState('')
  const [selection, setSelection] = useState<string>()
  const [query, setQuery] = useState(''); const [filter, setFilter] = useState<'all' | 'modified' | 'deferred' | 'replaceable'>('all')
  const [groupOpen, setGroupOpen] = useState<ReadonlyMap<string, boolean>>(() => new Map())
  const [toolsView, setToolsView] = useState<ToolsView>()
  const [promptsView, setPromptsView] = useState<PromptsView>()
  const alive = useRef(true); const catalogRequest = useRef(0); const toolsRequest = useRef(0); const promptsRequest = useRef(0)
  const [catalog, setCatalog] = useState(() => presetManager === undefined ? undefined : cachedPresetCatalog(presetManager))
  const [catalogState, setCatalogState] = useState<'loading' | 'ready' | 'error'>(() => catalog ? 'ready' : presetManager ? 'loading' : 'error')

  useEffect(() => {
    if (subMode !== activeSub) setSubMode(activeSub)
  }, [activeSub])

  function loadCatalog(refresh = false): void {
    const ticket = ++catalogRequest.current
    if (presetManager === undefined) { setCatalogState('error'); return }
    setCatalogState('loading')
    void requestPresetCatalog(presetManager, refresh).then(value => {
      if (alive.current && ticket === catalogRequest.current) { setCatalog(value); setCatalogState('ready') }
    }).catch(() => { if (alive.current && ticket === catalogRequest.current) setCatalogState('error') })
  }
  useEffect(() => { alive.current = true; loadCatalog(); return () => { alive.current = false; catalogRequest.current++; toolsRequest.current++; promptsRequest.current++ } }, [presetManager])

  const acceptedRules = snapshot.value?.rules ?? []
  const ids = [...new Set([...(catalog?.presets.map(preset => preset.id) ?? []), ...acceptedRules.map(rule => rule.preset), ...drafts.keys()])].filter(id => id.trim())
  const selectedId = selection ?? ids[0] ?? ''
  const currentDraft = drafts.get(selectedId)
  const currentRules = currentDraft?.rules ?? presetRules(acceptedRules, selectedId)
  const rule = currentRules[0]
  const duplicate = currentRules.length > 1
  const presetLabel = catalog?.presets.find(preset => preset.id === selectedId)?.name ?? selectedId

  function loadTools(refresh = false): void {
    const ticket = ++toolsRequest.current
    if (!selectedId || presetManager === undefined) { setToolsView({ preset: selectedId, status: 'error' }); return }
    setToolsView({ preset: selectedId, status: 'loading' })
    void requestPresetTools(presetManager, selectedId, refresh).then(value => {
      if (alive.current && ticket === toolsRequest.current) setToolsView({ preset: selectedId, status: 'ready', value })
    }).catch(() => { if (alive.current && ticket === toolsRequest.current) setToolsView({ preset: selectedId, status: 'error' }) })
  }
  useEffect(() => { loadTools(); return () => { toolsRequest.current++ } }, [presetManager, selectedId])

  const cached = presetManager && selectedId ? cachedPresetTools(presetManager, selectedId) : undefined
  const inventory = toolsView?.preset === selectedId && toolsView.status === 'error' ? undefined : toolsView?.preset === selectedId && toolsView.status === 'ready' ? toolsView.value : cached
  const toolsStatus = inventory ? 'ready' : toolsView?.preset === selectedId ? toolsView.status : selectedId ? 'loading' : 'error'

  function loadPrompts(refresh = false): void {
    const ticket = ++promptsRequest.current
    if (!selectedId || presetManager === undefined) { setPromptsView({ preset: selectedId, status: 'error' }); return }
    setPromptsView({ preset: selectedId, status: 'loading' })
    void requestPresetPrompts(presetManager, selectedId, refresh).then(value => {
      if (alive.current && ticket === promptsRequest.current) setPromptsView({ preset: selectedId, status: 'ready', value })
    }).catch(() => { if (alive.current && ticket === promptsRequest.current) setPromptsView({ preset: selectedId, status: 'error' }) })
  }
  useEffect(() => {
    if (activeSub === 'prompts') loadPrompts()
    return () => { promptsRequest.current++ }
  }, [presetManager, selectedId, activeSub === 'prompts'])

  const cachedPrompts = presetManager && selectedId ? cachedPresetPrompts(presetManager, selectedId) : undefined
  const promptCatalog = promptsView?.preset === selectedId && promptsView.status === 'error' ? undefined
    : promptsView?.preset === selectedId && promptsView.status === 'ready' ? promptsView.value : cachedPrompts
  const promptsStatus = promptCatalog ? 'ready' : promptsView?.preset === selectedId ? promptsView.status : selectedId ? 'loading' : 'error'

  const inventoryNames = new Set(inventory?.tools.map(tool => tool.name) ?? [])
  const contextFor = (tool: PresetToolEntry): ToolActionContext => ({
    ...(inventory?.legacyCapabilities === undefined ? {} : { legacyCapabilities: inventory.legacyCapabilities }),
    ...(tool.codexTool === undefined ? {} : { codexTool: tool.codexTool }),
    ...(tool.defaultDeferred === true ? { defaultDeferred: true } : {}),
  })
  const deferUnavailableReason = (tool: PresetToolEntry): 'conditional' | 'target-exists' | undefined =>
    tool.conditional ? 'conditional' : (tool.name === 'activate_tools' || inventoryNames.has('activate_tools')) ? 'target-exists' : undefined
  const chosen = (tool: PresetToolEntry) => effectiveToolAction(rule, tool.name, contextFor(tool))
  const customized = (tool: PresetToolEntry) => chosen(tool) !== effectiveToolAction(undefined, tool.name, contextFor(tool)) || !!rule?.tools?.some(choice => choice.name === tool.name)

  const stage = (change: (rules: readonly ToolPolicyRule[]) => readonly ToolPolicyRule[]): void => {
    if (snapshot.status !== 'ready' || !snapshot.writable || saving) return
    const latest = form.getSnapshot(); setError(''); setNotice('')
    setDrafts(previous => editPresetDraft(previous, selectedId, { revision: latest.revision, rules: latest.value?.rules ?? [] }, change))
  }
  const editRule = (change: (value: ToolPolicyRule) => ToolPolicyRule): void => stage(previous => {
    const base = previous[0] ?? { preset: selectedId, replaceShell: false, replacePlan: false }
    const next = change(base)
    const neutralNew = presetRules(currentDraft?.baseline ?? acceptedRules, selectedId).length === 0 && !next.tools?.length && !next.promptOverrides?.length && next.allow === undefined && !next.deny?.length && next.replaceShell === false && next.replacePlan === false && !next.replacePatch
    if (neutralNew) return []
    return previous.length === 0 ? [next] : previous.map((value, position) => position === 0 ? next : value)
  })
  const chooseAction = (tool: PresetToolEntry, action: string): void => {
    if (duplicate || !selectedId || (action !== 'keep' && action !== 'hide' && action !== 'defer' && action !== 'codex-exec' && action !== 'codex-plan' && action !== 'codex-patch')) return
    if (action === 'defer' && deferUnavailableReason(tool) !== undefined) return
    if (action !== 'keep' && action !== 'hide' && action !== 'defer' && !tool.replacements.some(replacement => replacement.action === action && replacement.available)) return
    const context = contextFor(tool)
    if (rule === undefined && action === legacyToolAction(undefined, tool.name, context)) return
    editRule(value => withToolAction(value, tool.name, action, context))
  }
  const removeChoice = (name: string): void => editRule(value => {
    const next: MutableRule = { ...value }; const tools = (value.tools ?? []).filter(choice => choice.name !== name)
    if (tools.length) next.tools = tools; else delete next.tools; return next
  })
  const changePrompt = (section: PresetPromptEntry, text: string): void => {
    if (duplicate || !section.editable || !isPromptName(section.name) || promptCatalog?.preset !== selectedId) return
    const name = section.name
    editRule(value => ({ ...value, promptOverrides: [...(value.promptOverrides ?? []).filter(entry => entry.name !== name), { name, text }] }))
  }
  const restorePrompt = (section: PresetPromptEntry): void => {
    if (duplicate || !section.editable || !isPromptName(section.name) || promptCatalog?.preset !== selectedId) return
    editRule(value => {
      const next: MutableRule = { ...value }; const remaining = (value.promptOverrides ?? []).filter(entry => entry.name !== section.name)
      if (remaining.length) next.promptOverrides = remaining; else delete next.promptOverrides; return next
    })
  }
  const saveCurrent = (): void => {
    if (!currentDraft || saving || !snapshot.writable || snapshot.status !== 'ready') return
    const latest = form.getSnapshot(); const target = selectedId
    const targetName = presetLabel && presetLabel !== target ? `${presetLabel} (${target})` : target || t('toolPolicyInvalidEntry')
    const message = (key: 'toolPolicyInvalidPreset' | 'toolPolicyDuplicatePreset' | 'toolPolicyRefused' | 'toolPolicyFailed' | 'toolPolicySaved') => `${targetName}: ${t(key)}`
    let prepared: ReturnType<typeof preparePresetSave>
    try {
      prepared = preparePresetSave(currentDraft, { revision: latest.revision, rules: latest.value?.rules ?? [] })
      const invalid = validateToolPolicyRules(currentDraft.rules)
      const otherIds = new Set((latest.value?.rules ?? []).filter(value => value.preset !== selectedId).map(value => value.preset.trim()))
      if (invalid || currentDraft.rules.some(value => otherIds.has(value.preset.trim()))) { setError(message(invalid ?? 'toolPolicyDuplicatePreset')); return }
    } catch { setError(message('toolPolicyRefused')); return }
    setSaving(true); setError(''); setNotice('')
    void saveToolPolicy(form, prepared.rules, prepared.revision).then(accepted => {
      if (!alive.current) return
      if (!accepted) { setError(message('toolPolicyRefused')); return }
      const after = form.getSnapshot()
      setDrafts(previous => acceptPresetSave(previous, prepared, { revision: after.revision, rules: after.value?.rules ?? [] }))
      setNotice(message('toolPolicySaved'))
    }).catch(() => { if (alive.current) setError(message('toolPolicyFailed')) }).finally(() => { if (alive.current) setSaving(false) })
  }

  const human = (tool: PresetToolEntry): string => {
    const key = humanLabels[tool.name as keyof typeof humanLabels]
    if (key !== undefined) return t(key)
    const mcp = /^mcp__([^_]+(?:_[^_]+)*)__(.+)$/.exec(tool.name)
    if (mcp !== null) return `${t('toolLabelMcpDynamic')} (${mcp[1]} · ${mcp[2]})`
    return tool.description.split(/[\n。.!]/u)[0]?.trim() || t('toolLabelOther')
  }
  const beforeTarget = currentDraft ? presetRules(currentDraft.baseline, selectedId) : []
  const beforeRule = beforeTarget[0]
  const choiceFor = (value: ToolPolicyRule | undefined, name: string) => value?.tools?.find(choice => choice.name === name)
  const changedNames = currentDraft ? [...new Set([
    ...(inventory?.tools.filter(tool => effectiveToolAction(beforeRule, tool.name, contextFor(tool)) !== chosen(tool)
      || JSON.stringify(choiceFor(beforeRule, tool.name)) !== JSON.stringify(choiceFor(rule, tool.name))).map(tool => tool.name) ?? []),
    ...[...(beforeRule?.tools ?? []), ...(rule?.tools ?? [])].filter(choice => !inventoryNames.has(choice.name)
      && JSON.stringify(choiceFor(beforeRule, choice.name)) !== JSON.stringify(choiceFor(rule, choice.name))).map(choice => choice.name),
  ])] : []
  const changedPrompts = currentDraft ? [...new Set([...(beforeRule?.promptOverrides ?? []), ...(rule?.promptOverrides ?? [])].map(entry => entry.name))]
    .filter(name => JSON.stringify(beforeRule?.promptOverrides?.find(entry => entry.name === name)) !== JSON.stringify(rule?.promptOverrides?.find(entry => entry.name === name))) : []
  const summaryParts = [
    ...(changedNames.length ? [`${t('presetSummaryTools')}: ${changedNames.slice(0, 4).join(', ')}${changedNames.length > 4 ? ` (+${changedNames.length - 4})` : ''}`] : []),
    ...(changedPrompts.length ? [`${t('presetSummaryPrompts')}: ${changedPrompts.map(name => promptCatalog?.sections.find(section => section.name === name)?.label || name).join(', ')}`] : []),
  ]
  const changeSummary = summaryParts.join(' · ') || t(currentDraft && !sameRules(beforeTarget, currentDraft.rules) ? 'toolPolicyRuleChanged' : 'toolPolicyNoToolDelta')
  const unavailable = (reason: 'conditional' | 'target-exists' | undefined) => t(reason === 'conditional' ? 'toolPolicyConditional' : reason === 'target-exists' ? 'toolPolicyTargetExists' : 'toolPolicyUnsupported')

  const renderRows = (tools: readonly PresetToolEntry[]) => <div className="codex-tool-policy-table" role="table" aria-label={t('toolPolicyTitle')}>
    {tools.map(tool => {
      const action = chosen(tool); const deferReason = deferUnavailableReason(tool)
      const supported = action === 'keep' || action === 'hide' || action === 'defer' || tool.replacements.some(option => option.action === action)
      const custom = customized(tool); const hasOverride = !!rule?.tools?.some(choice => choice.name === tool.name)
      return <div key={tool.name} role="row" className="codex-tool-policy-tool" data-tool-name={tool.name} data-tool-action={action}>
        <div role="cell" className="codex-tool-policy-name">
          <code className="codex-tool-policy-identifier">{tool.name}</code>
          <span className="codex-tool-policy-description" title={tool.description}>{human(tool)}</span>
          {tool.defaultDeferred && !custom && <span className="codex-badge" data-tone="blue">{t('toolPolicyDefaultDeferred')}</span>}
          {custom && <span className="codex-badge" data-tone="blue">{t('toolPolicyModified')}</span>}
          {tool.codexTool?.presetEnabled === false && <span className="codex-badge" data-tone="warn">{t('toolPolicyPresetDisabled')}</span>}
          {tool.conditional && tool.codexTool === undefined && <span className="codex-badge">{t('toolPolicyConditional')}</span>}
        </div>
        <div role="cell" className="codex-tool-policy-action">
          <div className="codex-seg" role="group" aria-label={`${t('toolPolicyAction')} ${tool.name}`}>
            <button type="button" data-action="keep" aria-pressed={action === 'keep'} disabled={duplicate} onClick={() => chooseAction(tool, 'keep')}>{t('toolPolicyKeep')}</button>
            {tool.replacements.map(option => <button type="button" key={option.action} data-action={option.action} aria-pressed={action === option.action}
              disabled={duplicate || !option.available} title={option.available ? option.tools.join(' + ') : `${option.tools.join(' + ')} · ${unavailable(option.reason)}`}
              onClick={() => chooseAction(tool, option.action)}>{t('toolPolicyReplaceShort')}</button>)}
            <button type="button" data-action="defer" aria-pressed={action === 'defer'} disabled={duplicate || deferReason !== undefined}
              title={deferReason !== undefined ? unavailable(deferReason) : t('toolPolicyDeferHint')} onClick={() => chooseAction(tool, 'defer')}>{t('toolPolicyDefer')}</button>
            <button type="button" data-action="hide" aria-pressed={action === 'hide'} disabled={duplicate} onClick={() => chooseAction(tool, 'hide')}>{t('toolPolicyHide')}</button>
          </div>
          {!supported && <span className="codex-tool-policy-warning">{t('toolPolicyUnsupported')} ({action})</span>}
          {hasOverride && <button type="button" className="codex-btn" aria-label={`${t('toolPolicyRestoreChoice')} ${tool.name}`}
            title={t('toolPolicyRestoreChoice')} onClick={() => removeChoice(tool.name)}>↶</button>}
        </div>
      </div>
    })}
    {tools.length === 0 && <p className="codex-tool-policy-note" style={{ padding: '12px 14px' }}>{t('toolPolicyNoMatches')}</p>}
  </div>

  if (snapshot.status !== 'ready' || snapshot.value === undefined || mode === 'inactive') return null
  const text = query.trim().toLowerCase()
  const isFiltering = text.length > 0 || filter !== 'all'
  const allTools = inventory?.tools ?? []
  const hasReplaceable = allTools.some(tool => tool.replacements.some(option => option.available))
  const shown = allTools.filter(tool => (!text || `${human(tool)} ${tool.name} ${tool.description}`.toLowerCase().includes(text))
    && (filter === 'all' || (filter === 'modified' ? customized(tool) : filter === 'deferred' ? chosen(tool) === 'defer' : tool.replacements.some(option => option.available))))

  return <section className="codex-tool-policy" aria-label={t(activeSub === 'prompts' ? 'settingsPresetPrompts' : 'toolPolicyTitle')}>
    <style>{policyStyles}</style>
    <div className="codex-card codex-preset-bar">
      <label className="codex-preset-select-wrap">
        <span className="codex-tool-policy-note">{t('toolPolicyPresetChoice')}</span>
        <select aria-label={t('toolPolicyPresetChoice')} value={selectedId} onChange={event => { setSelection(event.target.value); setError(''); setNotice('') }}>
          {!ids.length && <option value="">{t('toolPolicyEmpty')}</option>}
          {ids.map(id => <option key={id} value={id} data-preset-id={id}>{catalog?.presets.find(preset => preset.id === id)?.name ?? id}{drafts.has(id) ? ` · ${t('globalPending')}` : ''}</option>)}
        </select>
      </label>
      <div className="codex-tool-policy-action">
        <div className="codex-seg" role="group" aria-label={t('settingsTabLabel')}>
          {([['tools', 'settingsSubTools'], ['prompts', 'settingsPresetPrompts'], ['definition', 'settingsDefinition']] as const).map(([key, labelKey]) => (
            <button type="button" key={key} data-submode={key} aria-pressed={activeSub === key} onClick={() => setSubMode(key)}>{t(labelKey)}</button>
          ))}
        </div>
        {presetManager && <button type="button" className="codex-btn" disabled={catalogState === 'loading'} onClick={() => loadCatalog(true)}>{t('toolPolicyCatalogRetry')}</button>}
      </div>
    </div>
    {catalogState !== 'ready' && <p className="codex-tool-policy-note" role="status">{t(catalogState === 'loading' ? 'toolPolicyCatalogLoading' : 'toolPolicyCatalogFailed')}</p>}
    {catalogState === 'ready' && !ids.length && <p className="codex-tool-policy-note">{t('toolPolicyCatalogEmpty')}</p>}
    {duplicate && <p className="codex-tool-policy-warning">{t('toolPolicyDuplicatePreset')}</p>}
    {activeSub === 'definition' && (!selectedId || presetManager === undefined ? <p className="codex-tool-policy-note">{t('settingsDefinitionAbsent')}</p> : <PresetDefinitionCard presetManager={presetManager} id={selectedId} t={t} />)}
    {activeSub !== 'definition' && <form onSubmit={event => { event.preventDefault(); saveCurrent() }}><fieldset disabled={!snapshot.writable || saving}>
      {activeSub === 'tools' && <>
        {toolsStatus !== 'ready' && <p className="codex-tool-policy-note" role="status">{t(toolsStatus === 'loading' ? 'toolPolicyToolsLoading' : 'toolPolicyToolsFailed')}</p>}
        {inventory?.tools.length === 0 && <p className="codex-tool-policy-note" role="status">{t('toolPolicyToolsEmpty')}</p>}
        {inventory && !duplicate && inventory.tools.length > 0 && <div className="codex-toolbar">
          <input type="text" aria-label={t('toolPolicySearch')} placeholder={t('toolPolicySearch')} value={query} onChange={event => setQuery(event.target.value)} />
          <div className="codex-seg" role="group" aria-label={t('toolPolicyFilter')}>
            {(['all', 'deferred', 'modified', ...(hasReplaceable ? ['replaceable'] as const : [])] as const).map(item => (
              <button type="button" key={item} data-filter={item} aria-pressed={filter === item} onClick={() => setFilter(item)}>
                {t(item === 'all' ? 'toolPolicyAll' : item === 'modified' ? 'toolPolicyModified' : item === 'deferred' ? 'toolPolicyDeferredFilter' : 'toolPolicyReplaceable')}
              </button>
            ))}
          </div>
          {presetManager && selectedId && <button type="button" className="codex-btn" disabled={toolsStatus === 'loading'} onClick={() => loadTools(true)}>{t('toolPolicyToolsRefresh')}</button>}
        </div>}
        {inventory && !duplicate && (isFiltering && shown.length === 0
          ? <div className="codex-card">{renderRows(shown)}</div>
          : GROUP_META.map(group => {
            const tools = shown.filter(tool => groupOf(tool) === group.id); if (!tools.length) return null
            const changes = tools.filter(customized).length; const key = `${selectedId}/${group.id}`
            return <details key={group.id} className="codex-group" data-tool-group={group.id} open={isFiltering ? true : (groupOpen.get(key) ?? true)}
              onToggle={event => { const open = event.currentTarget.open; setGroupOpen(previous => new Map(previous).set(key, open)) }}>
              <summary><span>{t(group.labelKey)}</span><span className="codex-tool-policy-note">{tools.length}{changes ? ` · ${changes} ${t('toolPolicyCustomized')}` : ''}</span></summary>
              {renderRows(tools)}
            </details>
          }))}
      </>}
      {activeSub === 'prompts' && <>
        {presetManager && selectedId && <div className="codex-toolbar"><button type="button" className="codex-btn" disabled={promptsStatus === 'loading'} onClick={() => loadPrompts(true)}>{t('presetPromptsReload')}</button></div>}
        {promptsStatus !== 'ready' && <p className="codex-tool-policy-note" role="status">{t(promptsStatus === 'loading' ? 'presetPromptsLoading' : 'presetPromptsFailed')}</p>}
        {promptCatalog?.sections.length === 0 && <p className="codex-tool-policy-note">{t('presetPromptsEmpty')}</p>}
        {promptCatalog && <div className="codex-tool-policy-prompts">
          {promptCatalog.sections.map(section => {
            const editable = section.editable && isPromptName(section.name)
            const override = rule?.promptOverrides?.find(entry => entry.name === section.name)
            return <section key={section.name} className="codex-card codex-tool-policy-prompt" data-prompt-section={section.name}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 8 }}>
                <h4>{section.label || section.name}</h4><code>{section.name}</code>
              </div>
              {editable ? <>
                <textarea aria-label={`${t('settingsPresetPrompts')} ${section.name}`} rows={5} maxLength={1_000_000}
                  disabled={duplicate || !snapshot.writable || saving} value={override?.text ?? section.text} onChange={event => changePrompt(section, event.target.value)} />
                <button type="button" className="codex-btn" style={{ justifySelf: 'start' }} aria-label={`${t('presetPromptRestore')} ${section.name}`}
                  disabled={!override || duplicate || !snapshot.writable || saving} onClick={() => restorePrompt(section)}>{t('presetPromptRestore')}</button>
              </> : <><span className="codex-tool-policy-note" title={section.reason}>{t('presetPromptReadOnly')}</span><pre>{section.text}</pre></>}
            </section>
          })}
        </div>}
      </>}
      <div className="codex-save-bar" data-dirty={Boolean(currentDraft)}>
        {currentDraft ? <span className="codex-tool-policy-note" aria-label={t('toolPolicyDraftSummary')}>{t('toolPolicyDraftSummary')}: {changeSummary}</span>
          : <span className="codex-tool-policy-note">{t('toolPolicyTiming')}</span>}
        <div className="codex-save-buttons">
          <button type="button" className="codex-btn" disabled={!currentDraft} onClick={() => { setDrafts(previous => { const next = new Map(previous); next.delete(selectedId); return next }); setError(''); setNotice('') }}>{t('toolPolicyDiscard')}</button>
          <button className="codex-btn codex-btn-primary" type="submit" disabled={!currentDraft}>{t(saving ? 'toolPolicySaving' : 'toolPolicySave')}</button>
        </div>
      </div>
    </fieldset></form>}
    {!snapshot.writable && <p className="codex-tool-policy-note">{t('toolPolicyReadOnly')}</p>}
    {error && <p className="codex-tool-policy-error" role="alert">{error}</p>}
    {notice && <p className="codex-tool-policy-note" role="status">{notice}</p>}
  </section>
}
