/** A single Settings workspace; the bundle page is only a signpost. */
import { useState, useSyncExternalStore } from 'react'
import type { Context } from '@deepseek-ai/cordis'
import type { InjectFace, PropsLocale } from '@deepseek-ai/dsh-client-ui-slots'
import type {} from '@deepseek-ai/dsh-client-ui-plugin-manager/client'
import { applyWithSettingsApi } from './index.tsx'
import type {
  CodexConnectScope,
  CodexConnectSnapshot,
  CodexScope,
  CodexSettings,
  CodexSettingsSnapshot,
  InputSettingsControlInjected,
} from './index.tsx'
import {
  nextOpenAICodexOverrides,
  OPENAI_CODEX_SETTINGS_NAMESPACE,
} from '../contracts/ui-contracts.ts'
import type { PresetClientRemote } from './preset-manager.tsx'
import { bindToolPolicy, resolveGptCapabilities, ToolPolicySection } from './tool-policy.tsx'
import type { ToolPolicyBinding, ToolPolicyMode } from './tool-policy.tsx'

export interface DesktopConfigForm extends Pick<CodexScope, 'getSnapshot' | 'subscribe'> {
  set(field: string, value: unknown): Promise<boolean>
  unset(field: string): Promise<boolean>
  mutate(ops: Array<{ op: 'set'; path: string[]; value: unknown } | { op: 'unset'; path: string[] }>, expectedRevision?: number | string): Promise<boolean>
}
interface DesktopSettingsActions extends InputSettingsControlInjected {
  saveSettings(edits: Record<string, unknown>, expectedRevision?: number | string): Promise<void>
  toolPolicy?: ToolPolicyBinding
}
interface MirrorNamespaceRow {
  readonly ns: string
  readonly value?: unknown
  readonly base?: unknown
}
interface ConfigMirror {
  getSnapshot(): { readonly status?: string; readonly view?: { readonly writable?: boolean; readonly namespaces?: readonly MirrorNamespaceRow[] } }
  subscribe(listener: () => void): () => void
  ensure?(): unknown
}
interface DesktopSettingsContext {
  configForms: {
    get(entryId: string): DesktopConfigForm
    describe?(): ConfigMirror
    whileServed(namespaces: string[], register: () => () => void): () => void
  }
}
function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined
}
function asOverrides(value: unknown): Record<string, number | null> | undefined {
  const record = asRecord(value)
  if (record === undefined) return undefined
  const out: Record<string, number | null> = {}
  for (const [k, v] of Object.entries(record)) {
    if (v === null || (typeof v === 'number' && Number.isSafeInteger(v) && v > 0)) out[k] = v
  }
  return out
}
function projectCodexConnectRecord(
  record: Record<string, unknown>,
  baseRecord: Record<string, unknown> | undefined,
  writable: boolean,
): CodexConnectSnapshot {
  const searchModel = typeof record.searchModel === 'string' && record.searchModel.trim() ? record.searchModel.trim() : undefined
  const imageModelHint = typeof record.imageModelHint === 'string' ? record.imageModelHint.trim() : undefined
  return {
    status: 'ready',
    writable,
    overrides: asOverrides(record.contextWindowOverrides),
    baseOverrides: asOverrides(baseRecord?.contextWindowOverrides),
    ...(typeof record.enableNativeCompaction === 'boolean' ? { nativeCompaction: record.enableNativeCompaction } : {}),
    ...(typeof record.enableSearch === 'boolean' ? { searchEnabled: record.enableSearch } : {}),
    ...(searchModel !== undefined ? { searchModel } : {}),
    ...(typeof record.enableImageGeneration === 'boolean' ? { imageGenerationEnabled: record.enableImageGeneration } : {}),
    ...(imageModelHint !== undefined ? { imageModelHint } : {}),
  }
}

export function bindCodexConnectScope(configForms: DesktopSettingsContext['configForms']): CodexConnectScope {
  const form = configForms.get(OPENAI_CODEX_SETTINGS_NAMESPACE)
  const mirror = configForms.describe?.()
  void Promise.resolve(mirror?.ensure?.()).catch(() => {})
  let lastFormSnap: unknown
  let lastMirrorSnap: unknown
  let projected: CodexConnectSnapshot = { status: 'loading', writable: false }
  const getSnapshot = (): CodexConnectSnapshot => {
    const formSnap = form.getSnapshot() as CodexSettingsSnapshot & { readonly base?: Record<string, unknown> }
    const mirrorSnap = mirror?.getSnapshot()
    if (formSnap === lastFormSnap && mirrorSnap === lastMirrorSnap) return projected
    lastFormSnap = formSnap
    lastMirrorSnap = mirrorSnap
    const formRecord = formSnap.status === 'ready' ? asRecord(formSnap.value) : undefined
    if (formRecord !== undefined) {
      return projected = projectCodexConnectRecord(formRecord, asRecord(formSnap.base), formSnap.writable)
    }
    const view = mirrorSnap?.view
    if (view !== undefined) {
      const row = view.namespaces?.find(candidate => candidate.ns === OPENAI_CODEX_SETTINGS_NAMESPACE)
      const rowRecord = row === undefined ? undefined : asRecord(row.value)
      if (row === undefined || rowRecord === undefined) return projected = { status: 'unavailable', writable: false }
      return projected = projectCodexConnectRecord(rowRecord, asRecord(row.base), view.writable ?? formSnap.writable)
    }
    return projected = { status: formSnap.status, writable: formSnap.writable }
  }
  return {
    getSnapshot,
    subscribe: listener => {
      const stopForm = form.subscribe(listener)
      const stopMirror = mirror?.subscribe(listener)
      return () => { stopForm(); stopMirror?.() }
    },
    setModelOverride: async (modelId, tokens) => {
      const snap = getSnapshot()
      const next = nextOpenAICodexOverrides(snap.overrides, snap.baseOverrides, modelId, tokens)
      const accepted = next === undefined
        ? await form.unset('contextWindowOverrides')
        : await form.set('contextWindowOverrides', next)
      if (!accepted) throw new Error('The host did not accept the settings change.')
    },
    setNativeCompaction: async enabled => {
      const accepted = await form.set('enableNativeCompaction', enabled)
      if (!accepted) throw new Error('The host did not accept the settings change.')
    },
  }
}
export function adaptConfigForm(form: Pick<DesktopConfigForm, 'getSnapshot' | 'subscribe' | 'set' | 'unset'>): CodexScope {
  const accepted = async (result: Promise<boolean>) => { if (!await result) throw new Error('The host did not accept the settings change.') }
  return { getSnapshot: () => form.getSnapshot(), subscribe: listener => form.subscribe(listener),
    set: (field, value) => accepted(form.set(field, value)), unset: field => accepted(form.unset(field)) }
}
export async function saveDesktopSettings(form: Pick<DesktopConfigForm, 'mutate'>, edits: Record<string, unknown>, expectedRevision?: number | string): Promise<void> {
  const ops = Object.entries(edits).map(([field, value]) => value === undefined ? { op: 'unset' as const, path: [field] } : { op: 'set' as const, path: [field], value })
  if (!ops.length) return
  const accepted = expectedRevision === undefined ? await form.mutate(ops) : await form.mutate(ops, expectedRevision)
  if (!accepted) throw new Error('The host did not accept the settings change.')
}

type DesktopSettingsProps = InjectFace<DesktopSettingsActions> & PropsLocale<'codex'>
type SettingsPage = 'tools' | 'runtime'
const desktopStyles = `
.codex-harness-settings { max-width:760px; min-width:0; font-size:13px; color:var(--dsw-alias-label-primary); }
.codex-harness-settings h3 { font-size:14px; margin:0 0 10px; }
.codex-harness-settings .codex-harness-nav { display:flex; align-items:flex-end; gap:20px; margin-bottom:14px; border-bottom:0.5px solid var(--dsw-alias-border-l2); }
.codex-harness-settings .codex-harness-nav button { position:relative; border:0; padding:7px 1px 9px; background:transparent; color:var(--dsw-alias-label-tertiary, var(--dsw-alias-label-secondary)); font:inherit; font-size:13px; line-height:20px; cursor:pointer; }
.codex-harness-settings .codex-harness-nav button[aria-pressed=true] { color:var(--dsw-alias-label-primary); font-weight:500; }
.codex-harness-settings .codex-harness-nav button[aria-pressed=true]::after { position:absolute; right:0; bottom:-1px; left:0; height:2px; border-radius:2px 2px 0 0; background:var(--dsw-alias-label-primary); content:''; }
.codex-harness-settings button { box-sizing:border-box; min-width:0; max-width:100%; font:inherit; color:inherit; }
.codex-harness-settings .codex-harness-btn { background:var(--dsw-alias-bg-layer-2); border:0.5px solid var(--dsw-alias-border-l3, var(--dsw-alias-border-l2)); border-radius:var(--dsw-radius-md, 8px); padding:6px 12px; font-size:12px; cursor:pointer; }
.codex-harness-settings .codex-harness-btn:disabled { opacity:.48; cursor:default; }
.codex-harness-settings .codex-harness-primary { background:var(--dsw-alias-label-primary); color:var(--dsw-alias-bg-base); border-color:transparent; font-weight:500; }
.codex-harness-settings :is(input,button):focus-visible { outline:2px solid var(--dsw-focus-ring-color, var(--dsw-alias-brand-primary)); outline-offset:2px; }
.codex-harness-settings fieldset { min-width:0; border:0; padding:0; margin:0; display:flex; flex-direction:column; gap:12px; }
.codex-harness-settings .codex-harness-grid { display:grid; grid-template-columns:repeat(auto-fit,minmax(min(100%,260px),1fr)); gap:12px; }
.codex-harness-settings .codex-harness-card { border:0.5px solid var(--dsw-alias-settings-card-stroke, var(--dsw-alias-border-l2)); border-radius:var(--dsw-radius-xl, 12px); background:var(--dsw-alias-settings-card-fill, var(--dsw-alias-bg-layer-1)); padding:12px 16px; }
.codex-harness-settings .codex-harness-group h4 { margin:0 0 6px; font-size:12px; font-weight:600; color:var(--dsw-alias-label-secondary); }
.codex-harness-settings .codex-harness-setting-row { min-width:0; display:flex; gap:12px; justify-content:space-between; align-items:center; padding:8px 0; border-bottom:0.5px solid var(--dsw-alias-border-l1); }
.codex-harness-settings .codex-harness-setting-row:last-child { border-bottom:0; }
.codex-harness-settings .codex-harness-note { margin:0 0 12px; color:var(--dsw-alias-label-secondary); font-size:12px; line-height:1.5; }
.codex-harness-settings .codex-harness-actions { display:flex; gap:8px; flex-wrap:wrap; margin-top:4px; }
.codex-harness-settings input[role=switch] { appearance:none; width:34px; height:20px; border:0.5px solid var(--dsw-alias-border-l3, var(--dsw-alias-border-l2)); border-radius:16px; background:var(--dsw-alias-bg-layer-2); position:relative; cursor:pointer; flex-shrink:0; margin:0; transition:background .15s; }
.codex-harness-settings input[role=switch]:before { content:''; position:absolute; width:14px; height:14px; top:2.5px; left:2.5px; border-radius:50%; background:var(--dsw-alias-label-secondary); transition:left .15s, background .15s; }
.codex-harness-settings input[role=switch]:checked { background:var(--dsw-alias-label-primary); border-color:transparent; }
.codex-harness-settings input[role=switch]:checked:before { left:16.5px; background:var(--dsw-alias-bg-base); }
`

/** There is intentionally no second editable form on a bundle detail page. */
export function DesktopSettingsCard({ t }: DesktopSettingsProps & { view: 'summary' | 'page' }) {
  return <section><p>{t('settingsBundleSummary')}</p><p>{t('settingsBundlePath')}</p></section>
}

/** Kept mounted while inactive, so switching pages preserves runtime drafts. */
export function RuntimeSettingsEditor({ active, ...props }: DesktopSettingsProps & { active: boolean }) {
  const { useSettings, saveSettings, t } = props
  const snapshot = useSettings(state => state)
  const [draft, setDraft] = useState<{ edits: Record<string, unknown>; revision: number | string | undefined }>()
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')
  const edits = draft?.edits ?? {}
  const value = (field: keyof CodexSettings) => Object.hasOwn(edits, field) ? edits[field] === undefined ? snapshot.base?.[field] : edits[field] : snapshot.value?.[field]
  const edit = (field: string, next: unknown) => {
    setError(''); setDraft(current => ({ edits: { ...current?.edits, [field]: next }, revision: current === undefined ? snapshot.revision : current.revision }))
  }
  const groups = [
    { label: 'globalGroupRequest', fields: [['fast', 'fast'], ['hostedWebSearchEnabled', 'settingsPreferHostedSearch'], ['remoteCompactionEnabled', 'settingsPreferRemoteCompaction']] },
    { label: 'globalGroupDisplay', fields: [['contextWindowControlEnabled', 'contextWindowControl'], ['fastModeControlEnabled', 'fastModeControl'], ['activityIndicatorEnabled', 'capabilityActivity']] },
  ] as const
  if (!active) return null
  return <section aria-label={t('settingsRuntimePage')}>
    <h3>{t('settingsRuntimePage')}<span className="codex-harness-note"> · {t('settingsRuntimeScope')}</span></h3>
    <form onSubmit={event => {
      event.preventDefault(); if (saving || draft === undefined || !snapshot.writable || snapshot.status !== 'ready') return
      setSaving(true); setError(''); const submitted = draft
      void saveSettings(submitted.edits, submitted.revision).then(() => setDraft(current => current === submitted ? undefined : current))
        .catch(() => setError(t('settingsSharedFailed'))).finally(() => setSaving(false))
    }}>
      <fieldset disabled={!snapshot.writable || snapshot.status !== 'ready' || saving}>
        <div className="codex-harness-grid">{groups.map(group => <div key={group.label} className="codex-harness-card codex-harness-group">
          <h4>{t(group.label)}</h4>{group.fields.map(([field, label]) => <label key={field} className="codex-harness-setting-row">
            <span>{t(label)}</span><input type="checkbox" role="switch" aria-label={t(label)} aria-checked={Boolean(value(field) ?? (field !== 'fast'))}
              checked={Boolean(value(field) ?? (field !== 'fast'))} onChange={event => edit(field, event.target.checked)} />
          </label>)}
        </div>)}</div>
        <div className="codex-harness-actions">
          <button className="codex-harness-btn codex-harness-primary" type="submit" disabled={!Object.keys(edits).length}>{t(saving ? 'promptSaving' : 'settingsSaveRuntime')}</button>
          <button className="codex-harness-btn" type="button" disabled={draft === undefined} onClick={() => { setDraft(undefined); setError('') }}>{t('promptDiscard')}</button>
        </div>
      </fieldset>
    </form>
    {!snapshot.writable && <p className="codex-harness-note">{t('promptReadOnly')}</p>}{error && <p role="alert">{error}</p>}
  </section>
}

const EMPTY_CONNECT_SUBSCRIBE = () => () => {}
const EMPTY_CONNECT_SNAPSHOT = (): CodexConnectSnapshot | undefined => undefined

export function CodexSettingsTab(props: DesktopSettingsProps & { initialPage?: SettingsPage }) {
  const { toolPolicy, presetManager, getCodexConnectScope, t } = props
  const [page, setPage] = useState<SettingsPage>(props.initialPage ?? 'tools')
  const settingsSnapshot = typeof props.useSettings === 'function'
    ? props.useSettings(state => state as CodexSettingsSnapshot)
    : undefined
  const connectScope = getCodexConnectScope?.()
  const connectSnapshot = useSyncExternalStore(
    connectScope ? connectScope.subscribe : EMPTY_CONNECT_SUBSCRIBE,
    connectScope ? connectScope.getSnapshot : EMPTY_CONNECT_SNAPSHOT,
    connectScope ? connectScope.getSnapshot : EMPTY_CONNECT_SNAPSHOT,
  )
  const gptCapabilities = resolveGptCapabilities(settingsSnapshot?.value, connectSnapshot)
  const mode: ToolPolicyMode = page === 'tools' ? 'tools' : 'inactive'
  return <section className="codex-harness-settings">
    <style>{desktopStyles}</style>
    <nav className="codex-harness-nav" aria-label={t('settingsTabLabel')}>
      <button type="button" aria-pressed={page === 'tools'} onClick={() => setPage('tools')}>{t('settingsToolsPage')}</button>
      <button type="button" aria-pressed={page === 'runtime'} onClick={() => setPage('runtime')}>{t('settingsRuntimePage')}</button>
    </nav>
    {toolPolicy !== undefined && <ToolPolicySection binding={toolPolicy} presetManager={presetManager} mode={mode} gptCapabilities={gptCapabilities} t={t} />}
    <RuntimeSettingsEditor {...props} active={page === 'runtime'} />
  </section>
}

export const inject = ['commandUi', 'sessions', 'slots', 'locale', 'configForms', 'remote']
export function apply(ctx: Context): void {
  let form: DesktopConfigForm
  let connectScope: CodexConnectScope | undefined
  const getCodexConnectScope = (): CodexConnectScope | undefined => {
    try { return connectScope ??= bindCodexConnectScope((ctx as unknown as DesktopSettingsContext).configForms) }
    catch { return undefined }
  }
  applyWithSettingsApi(ctx, {
    bind: host => { form = (host as unknown as DesktopSettingsContext).configForms.get('codex'); return adaptConfigForm(form) },
    getCodexConnectScope,
    register: (host, settings, manager) => {
      const desktop = host as unknown as DesktopSettingsContext
      const presetManager = { ...manager, remote: (host as unknown as { remote: PresetClientRemote }).remote }
      const t = host.locale.bind('codex'); const toolPolicy = bindToolPolicy(host, host.configForms)
      const injected = (): DesktopSettingsActions => ({
        hooks: { settings },
        setSetting: (field, value) => settings.set(field, value),
        unsetSetting: field => settings.unset(field),
        presetManager,
        toolPolicy,
        saveSettings: async (edits, revision) => {
          await saveDesktopSettings(form, edits, revision)
          if (typeof edits.remoteCompactionEnabled === 'boolean') {
            const scope = getCodexConnectScope()
            if (scope?.setNativeCompaction !== undefined && scope.getSnapshot().writable) {
              await scope.setNativeCompaction(edits.remoteCompactionEnabled).catch(() => {})
            }
          }
        },
      })
      return desktop.configForms.whileServed(['codex'], () => {
        const disposers: Array<() => void> = []; const dispose = () => { for (const off of disposers.splice(0).reverse()) off() }
        try {
          disposers.push(host.slots.inject('settings.plugins.tab', () => host.slots.register({ name: 'settings.plugins.tab', id: 'codex-harness', order: 30,
            label: () => t('settingsTabLabel'), locale: 'codex', inject: injected }, CodexSettingsTab)))
          disposers.push(host.slots.inject('plugins.bundle.config', () => host.slots.register({
            name: 'plugins.bundle.config',
            key: '@shuind/dsh-codex-harness',
            locale: 'codex',
            inject: injected,
          }, DesktopSettingsCard)))
          return dispose
        } catch (error) { dispose(); throw error }
      })
    },
  })
}
export default { inject, apply }
