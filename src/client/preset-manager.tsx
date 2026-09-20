import { useEffect, useRef, useState } from 'react'
import type { InjectFace, PropsLocale } from '@deepseek-ai/dsh-client-ui-slots'
import type { RemoteResult, TypertClientRemote } from '@deepseek-ai/dsh-typert-protocol'
import type { CodexPresetOptions, PresetCatalog, PresetCreateInput, PresetEditorDocument, PresetEditorInput } from '../preset-contract.ts'
import { DEFAULT_CODEX_SYSTEM_PROMPT } from '../prompt.ts'
import { isPresetConnectionError, readPresetWithRetry } from './preset-requests.ts'

export interface PresetClientRemote extends TypertClientRemote {
  codexPresetEditor: {
    catalog(): Promise<RemoteResult<PresetCatalog>>
    read(id: string): Promise<RemoteResult<PresetEditorDocument>>
    update(input: PresetEditorInput): Promise<RemoteResult<PresetEditorDocument>>
    create(input: PresetCreateInput): Promise<RemoteResult<PresetEditorDocument>>
  }
}
export interface PresetManagerActions { remote: PresetClientRemote; ready: Promise<void> }
type Props = InjectFace<{ presetManager: PresetManagerActions }> & PropsLocale<'codex'>

const catalogCache = new WeakMap<PresetManagerActions, PresetCatalog>()
const documentCache = new WeakMap<PresetManagerActions, Map<string, { value: PresetEditorDocument; time: number }>>()
const CODEX_DEFAULT_ID = 'codex-collaboration'
function unwrap<T>(result: RemoteResult<T>): T {
  if (result.ok) return result.value
  throw new Error((result.error as unknown as { message?: string }).message ?? 'remote-request-failed')
}
function equalEditorState(a: PresetEditorDocument | undefined, b: PresetEditorDocument | undefined): boolean {
  if (!a || !b) return a === b
  return a.name === b.name && a.description === b.description && a.systemPrompt === b.systemPrompt
    && a.inheritPrompt === b.inheritPrompt && a.codex === b.codex
    && JSON.stringify(a.codexOptions) === JSON.stringify(b.codexOptions)
    && JSON.stringify(a.promptSections) === JSON.stringify(b.promptSections)
}
const styles = `
.codex-preset-editor { display:grid; gap:12px; min-width:0; font-size:13px; }
.codex-preset-editor label { display:grid; gap:6px; }
.codex-preset-editor .pe-row { display:flex; align-items:center; gap:10px; flex-wrap:wrap; }
.codex-preset-editor input:not([type=checkbox]), .codex-preset-editor textarea, .codex-preset-editor select { box-sizing:border-box; width:100%; padding:8px; border:1px solid var(--dsw-alias-border-l2); border-radius:6px; background:var(--dsw-alias-bg-layer-3); color:inherit; font:inherit; }
.codex-preset-editor textarea { resize:vertical; line-height:1.5; }
.codex-preset-editor button { font:inherit; padding:6px 12px; border:1px solid var(--dsw-alias-border-l2); border-radius:6px; background:var(--dsw-alias-bg-layer-3); color:inherit; cursor:pointer; }
.codex-preset-editor button:disabled { opacity:.5; cursor:default; }
.codex-preset-editor .pe-primary { background:#425ce5; border-color:#425ce5; color:white; }
.codex-preset-editor .pe-block { display:grid; gap:9px; padding-top:12px; border-top:1px solid var(--dsw-alias-border-l2); }
.codex-preset-editor .pe-toggle { display:flex; align-items:flex-start; gap:9px; }
.codex-preset-editor .pe-toggle span { display:grid; gap:2px; }
.codex-preset-editor p { margin:0; font-size:12px; line-height:1.55; color:var(--dsw-alias-label-tertiary); }
`

function optionToggle(
  key: keyof CodexPresetOptions,
  label: string,
  hint: string,
  options: CodexPresetOptions,
  setOptions: (next: CodexPresetOptions) => void,
  disabled: boolean,
) {
  return <label className="pe-toggle" key={key}>
    <input type="checkbox" checked={options[key]} disabled={disabled} onChange={event => setOptions({ ...options, [key]: event.target.checked })} />
    <span><strong>{label}</strong><small>{hint}</small></span>
  </label>
}

/** Presets are peers: choose one to edit, or make an editable copy first. */
export function PresetManagerCard({ presetManager, t }: Props) {
  const [catalog, setCatalog] = useState(() => catalogCache.get(presetManager))
  const [selectedId, setSelectedId] = useState('')
  const [original, setOriginal] = useState<PresetEditorDocument>()
  const [draft, setDraft] = useState<PresetEditorDocument>()
  const [sourceId, setSourceId] = useState('')
  const [copyMode, setCopyMode] = useState(false)
  const [codexEnabled, setCodexEnabled] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [errorAction, setErrorAction] = useState<'read' | 'save'>('read')
  const [notice, setNotice] = useState('')
  const alive = useRef(true)
  const request = useRef(0)
  if (!documentCache.has(presetManager)) documentCache.set(presetManager, new Map())
  const cache = documentCache.get(presetManager)!
  const remote = presetManager.remote.codexPresetEditor
  const dirty = !!draft && (!original || !equalEditorState(draft, original) || codexEnabled !== draft.codex)

  async function run(work: () => Promise<void>) {
    setBusy(true); setError(''); setNotice('')
    try { await presetManager.ready; if (alive.current) await work() }
    catch (cause) { if (alive.current) setError(cause instanceof Error ? cause.message : String(cause)) }
    finally { if (alive.current) setBusy(false) }
  }
  async function load(id: string, confirmDirty = true): Promise<void> {
    if (!id) return
    if (confirmDirty && dirty && !window.confirm(t('pmDiscard'))) return
    const ticket = ++request.current
    setSelectedId(id); setError(''); setNotice(''); setErrorAction('read')
    const accept = (value: PresetEditorDocument) => {
      if (!alive.current || ticket !== request.current) return
      setSelectedId(id); setSourceId(id); setOriginal(value); setDraft(value)
      setCopyMode(false); setCodexEnabled(value.codex)
    }
    const cached = cache.get(id)
    if (cached && Date.now() - cached.time < 60_000) { accept(cached.value); return }
    setDraft(undefined); setOriginal(undefined); setBusy(true)
    try {
      await presetManager.ready
      const value = await readPresetWithRetry(() => remote.read(id).then(unwrap), () => alive.current && ticket === request.current)
      cache.set(id, { value, time: Date.now() }); accept(value)
    } catch (cause) { if (alive.current && ticket === request.current) setError(String(cause)) }
    finally { if (alive.current && ticket === request.current) setBusy(false) }
  }
  async function refresh(): Promise<void> {
    setErrorAction('read')
    const value = await readPresetWithRetry(() => remote.catalog().then(unwrap), () => alive.current)
    if (!alive.current) return
    catalogCache.set(presetManager, value); setCatalog(value)
    const current = selectedId || (value.presets.some(row => row.id === CODEX_DEFAULT_ID) ? CODEX_DEFAULT_ID : value.presets[0]?.id ?? '')
    if (current && current !== selectedId) await load(current, false)
  }
  useEffect(() => {
    alive.current = true
    if (!catalogCache.has(presetManager)) void run(refresh)
    else if (!selectedId) void load(catalogCache.get(presetManager)?.presets.some(row => row.id === CODEX_DEFAULT_ID) ? CODEX_DEFAULT_ID : catalogCache.get(presetManager)?.presets[0]?.id ?? '', false)
    return () => { alive.current = false }
  }, [presetManager])
  useEffect(() => {
    if (!dirty) return
    const guard = (event: BeforeUnloadEvent) => { event.preventDefault(); event.returnValue = '' }
    window.addEventListener('beforeunload', guard)
    return () => window.removeEventListener('beforeunload', guard)
  }, [dirty])
  function patch(value: Partial<PresetEditorDocument>) { if (draft) setDraft({ ...draft, ...value }) }
  function beginCopy(): void {
    if (!draft || !sourceId) return
    setCopyMode(true); setCodexEnabled(draft.codex)
    setOriginal({ ...draft })
    setDraft({ ...draft, id: '', revision: '', editable: true, name: `${draft.name} · ${t('pmCustom')}` })
  }
  function save(): void {
    if (!draft || busy || !draft.name.trim()) return
    setErrorAction('save')
    void run(async () => {
      const options = codexEnabled ? draft.codexOptions : undefined
      const payload = { name: draft.name, description: draft.description, systemPrompt: draft.systemPrompt,
        promptSections: draft.promptSections.filter(section => section.editable && (codexEnabled || section.id !== 'codex:base')),
        inheritPrompt: draft.inheritPrompt, enableCodex: codexEnabled, ...(options === undefined ? {} : { codexOptions: options }) }
      const value = unwrap(await (copyMode
        ? remote.create({ ...payload, sourceId })
        : remote.update({ ...payload, id: draft.id, revision: draft.revision })))
      if (!alive.current) return
      setSelectedId(value.id); setSourceId(value.id); setOriginal(value); setDraft(value)
      cache.set(value.id, { value, time: Date.now() })
      setCopyMode(false); setCodexEnabled(value.codex); setNotice(t('peSaved'))
      if (catalog) {
        const row = { id: value.id, name: value.name, description: value.description, editable: value.editable,
          isDefault: catalog.presets.find(item => item.id === value.id)?.isDefault ?? false }
        const presets = catalog.presets.some(item => item.id === value.id)
          ? catalog.presets.map(item => item.id === value.id ? row : item) : [...catalog.presets, row]
        catalogCache.set(presetManager, { ...catalog, presets }); setCatalog({ ...catalog, presets })
      }
    })
  }
  const selectedRow = catalog?.presets.find(row => row.id === selectedId)
  const readOnly = !!draft && !draft.editable && !copyMode
  const options = draft?.codexOptions
  return <section className="codex-preset-editor" aria-label={t('peTitle')} aria-busy={busy}>
    <style>{styles}</style>
    <div className="pe-row" style={{ justifyContent:'space-between' }}>
      <strong>{t('peTitle')}</strong>
      <button type="button" disabled={busy} onClick={() => { if (dirty && !window.confirm(t('pmDiscard'))) return; cache.clear(); void run(async () => { await refresh(); if (selectedId) await load(selectedId, false) }) }}>{t('pmRefresh')}</button>
    </div>
    <p>{t('peHierarchy')}</p>
    <label>{t('peSelect')}<select value={selectedId} disabled={busy || !catalog} onChange={event => { void load(event.target.value) }}>
      <option value="">{t('peSelectPlaceholder')}</option>
      {catalog?.presets.map(row => <option key={row.id} value={row.id}>{row.name}{row.editable ? '' : ` · ${t('pmBuiltIn')}`}</option>)}
    </select></label>
    {selectedRow && <p>{selectedRow.editable ? t('peEditable') : t('peBuiltinEdit')}</p>}
    {error && <div role="alert">
      <p>{errorAction === 'read'
        ? t(isPresetConnectionError(error) ? 'peConnectionError' : 'peReadError')
        : error.includes('preset-conflict') ? t('pmConflict') : error.includes('invalid-preset-yaml') ? t('pmYamlError') : t('pmSaveError')}</p>
      {errorAction === 'read' && <div className="pe-row">
        <button type="button" disabled={busy} onClick={() => { if (selectedId) { cache.delete(selectedId); void load(selectedId, false) } else void run(refresh) }}>{t('peRetryRead')}</button>
        {!draft && isPresetConnectionError(error) && <button type="button" onClick={() => window.location.reload()}>{t('peReconnect')}</button>}
      </div>}
      <details><summary>{t('pmErrorDetails')}</summary><pre style={{ whiteSpace:'pre-wrap' }}>{error}</pre></details>
    </div>}
    {notice && <p role="status">{notice}</p>}
    {busy && !draft && <p role="status">{t('peLoading')}</p>}
    {draft && <>
      <label>{t('pmName')}<input value={draft.name} maxLength={200} disabled={busy || readOnly} onChange={event => patch({ name:event.target.value })} /></label>
      <label>{t('pmDescription')}<input value={draft.description} maxLength={4000} disabled={busy || readOnly} onChange={event => patch({ description:event.target.value })} /></label>
      {!copyMode && <button type="button" disabled={busy || !catalog?.authorable} onClick={beginCopy}>{t('peCreateCopy')}</button>}
      <div className="pe-block">
        <strong>{t('peSystemPrompt')}</strong>
        <p>{t('peSectionsHint')}</p>
        {draft.promptSections.map(section => <details key={section.id}>
          <summary style={{ cursor: 'pointer', padding: '6px 0' }}>{section.label}{section.suppressed ? ` · ${t('peSuppressed')}` : ''}</summary>
          {section.id === 'harness:source' && <p>{t('peDshSourcePrompt')}</p>}
          {section.id === 'app:web-surface' && <p>{t('peDshWebPrompt')}</p>}
          <textarea aria-label={section.label} rows={section.id === 'codex:base' ? 12 : 5} value={section.text}
            disabled={busy || readOnly || !section.editable}
            onChange={event => patch({ promptSections: draft.promptSections.map(item => item.id === section.id ? { ...item, text: event.target.value } : item),
              ...(section.id === 'codex:base' ? { systemPrompt: event.target.value, inheritPrompt: false } : {}) })} />
          {section.suppressed ? <p>{t('peCompletePersona')}</p> : !section.editable && <p>{t('peDynamicPrompt')}</p>}
        </details>)}
      </div>
      {!readOnly && <>
        <div className="pe-block">
          <strong>{t('peCodexSection')}</strong>
          {!draft.codex && <label className="pe-toggle"><input type="checkbox" checked={codexEnabled} disabled={busy} onChange={event => {
            const enabled = event.target.checked
            setCodexEnabled(enabled)
            if (enabled) {
              const extras = [
                { id: 'codex:base', label: 'Codex 操作提示词', text: DEFAULT_CODEX_SYSTEM_PROMPT, editable: true },
              ]
              patch({ promptSections: [...draft.promptSections.map(s => s.suppressed ? { ...s, suppressed: undefined, editable: true } : s), ...extras.filter(item => !draft.promptSections.some(s => s.id === item.id))] })
            } else patch({ promptSections: draft.promptSections.filter(s => original?.promptSections.some(item => item.id === s.id)).map(s => {
              const source = original?.promptSections.find(item => item.id === s.id)
              return source?.suppressed ? { ...s, suppressed: true, editable: false } : s
            }) })
          }} /><span><strong>{t('peAddCodex')}</strong><small>{t('peAddCodexHint')}</small></span></label>}
          {codexEnabled && options && <>
            {optionToggle('hostedWebSearchEnabled', t('capabilityWebSearch'), t('capabilityWebSearchHint'), options, next => patch({ codexOptions: next }), busy)}
            {optionToggle('remoteCompactionEnabled', t('capabilityCompaction'), t('capabilityCompactionHint'), options, next => patch({ codexOptions: next }), busy)}
            {optionToggle('terminalToolsEnabled', t('capabilityTerminal'), t('capabilityTerminalHint'), options, next => patch({ codexOptions: next }), busy)}
            {optionToggle('patchToolEnabled', t('capabilityPatch'), t('capabilityPatchHint'), options, next => patch({ codexOptions: next }), busy)}
            {optionToggle('planToolEnabled', t('capabilityPlan'), t('capabilityPlanHint'), options, next => patch({ codexOptions: next }), busy)}
            {optionToggle('promptEnabled', t('capabilityPrompt'), t('capabilityPromptHint'), options, next => patch({ codexOptions: next }), busy)}
            <p>{t('peActivityGlobal')}</p>
          </>}
        </div>
        <div className="pe-row"><button type="button" className="pe-primary" disabled={busy || !catalog?.authorable || !draft.name.trim() || !dirty} onClick={save}>{copyMode ? t('peSaveCopy') : t('pmSave')}</button>
          {copyMode && <button type="button" disabled={busy} onClick={() => { void load(sourceId, false) }}>{t('pmCancel')}</button>}
          {!copyMode && <button type="button" disabled={busy} onClick={() => { void load(draft.id, false) }}>{t('pmCancel')}</button>}
        </div>
      </>}
    </>}
  </section>
}
export default PresetManagerCard
