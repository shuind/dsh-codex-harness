/** Read-only preset definition viewer and composer context-window control for Harness 0.2.2+. */
import { useCallback, useEffect, useId, useRef, useState, useSyncExternalStore } from 'react'
import { createPortal } from 'react-dom'
import type { PropsLocale } from '@deepseek-ai/dsh-client-ui-slots'
import type { RemoteResult, TypertClientRemote } from '@deepseek-ai/dsh-typert-protocol'
import {
  contextPresetsForBounds,
  formatCompactTokens,
  OPENAI_CODEX_MODEL_CATALOG_PATH,
  OPENAI_CODEX_MODEL_LIMITS,
  OPENAI_CODEX_PROVIDER,
  parseCustomContextInput,
  resolveContextWindowBounds,
} from '../contracts/ui-contracts.ts'
import type {
  CodexConnectScope,
  ModelDirectorySnapshot,
  ModelDirectoryStore,
  PresetCatalog,
  PresetDefinitionDocument,
} from '../contracts/ui-contracts.ts'
import type { PresetPromptCatalog, PresetToolCatalog } from '../contracts/tool-policy-contract.ts'
import { readPresetWithRetry } from './preset-requests.ts'

export interface PresetClientRemote extends TypertClientRemote {
  codexPresetEditor: {
    catalog(): Promise<RemoteResult<PresetCatalog>>
    tools?(id: string): Promise<RemoteResult<PresetToolCatalog>>
    prompts?(id: string): Promise<RemoteResult<PresetPromptCatalog>>
    read(id: string): Promise<RemoteResult<PresetDefinitionDocument>>
  }
}

export interface PresetManagerActions {
  remote: PresetClientRemote
  ready: Promise<void>
}

const documentCache = new WeakMap<PresetManagerActions, Map<string, { value: PresetDefinitionDocument; time: number }>>()

function unwrap<T>(result: RemoteResult<T>): T {
  if (result.ok) return result.value
  throw new Error((result.error as unknown as { message?: string }).message ?? 'remote-request-failed')
}

const styles = `
.codex-preset-editor { display:grid; gap:10px; min-width:0; font-size:13px; border:0.5px solid var(--dsw-alias-settings-card-stroke, var(--dsw-alias-border-l2)); border-radius:var(--dsw-radius-xl, 12px); background:var(--dsw-alias-settings-card-fill, var(--dsw-alias-bg-layer-1)); padding:12px 14px; }
.codex-preset-editor .codex-preset-editor-head { display:flex; align-items:center; justify-content:space-between; gap:8px; }
.codex-preset-editor button { font:inherit; font-size:12px; height:30px; padding:0 11px; border:0.5px solid var(--dsw-alias-border-l3, var(--dsw-alias-border-l2)); border-radius:var(--dsw-radius-md, 8px); background:var(--dsw-alias-bg-layer-2); color:inherit; cursor:pointer; }
.codex-preset-editor button:disabled { opacity:.5; cursor:default; }
.codex-preset-editor p { margin:0; font-size:12px; line-height:1.55; color:var(--dsw-alias-label-secondary); }
.codex-preset-editor pre { white-space:pre-wrap; overflow-wrap:anywhere; margin:0; padding:10px 12px; border-radius:var(--dsw-radius-md, 8px); background:var(--dsw-alias-bg-layer-2); font-size:12px; line-height:1.5; max-height:480px; overflow:auto; }
`

/** A fixed-ID declaration viewer: no second picker and no write/copy actions. */
export function PresetDefinitionCard({
  presetManager,
  id,
  t,
}: { presetManager: PresetManagerActions; id: string } & PropsLocale<'codex'>) {
  const [value, setValue] = useState<PresetDefinitionDocument>()
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const request = useRef(0)
  const alive = useRef(true)

  async function load(refresh = false): Promise<void> {
    const ticket = ++request.current
    setLoading(true)
    setError('')
    try {
      await presetManager.ready
      const cache = documentCache.get(presetManager) ?? new Map<string, { value: PresetDefinitionDocument; time: number }>()
      documentCache.set(presetManager, cache)
      const cached = cache.get(id)
      const document = !refresh && cached && Date.now() - cached.time < 60_000
        ? cached.value
        : await readPresetWithRetry(
          () => presetManager.remote.codexPresetEditor.read(id).then(unwrap),
          () => alive.current && ticket === request.current,
        )
      if (document.id !== id) throw new Error('preset-document-mismatch')
      cache.set(id, { value: document, time: Date.now() })
      if (alive.current && ticket === request.current) setValue(document)
    } catch (cause) {
      if (alive.current && ticket === request.current) {
        setError(cause instanceof Error ? cause.message : String(cause))
      }
    } finally {
      if (alive.current && ticket === request.current) setLoading(false)
    }
  }

  useEffect(() => {
    alive.current = true
    void load()
    return () => {
      alive.current = false
      request.current++
    }
  }, [presetManager, id])

  const shown = value?.id === id ? value : undefined
  return <section className="codex-preset-editor" aria-label={t('settingsDefinition')} aria-busy={loading}>
    <style>{styles}</style>
    <h3>{t('settingsDefinition')}</h3><code>{id}</code>
    <button type="button" disabled={loading} onClick={() => { void load(true) }}>{t('pmRefresh')}</button>
    {loading && !shown && <p role="status">{t('peLoading')}</p>}
    {error && <p role="alert">{t('peReadError')}</p>}
    {shown && <>
      <strong>{shown.name}</strong>
      <p>{shown.description}</p>
      <pre style={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere', margin: 0 }}>{shown.composition}</pre>
    </>}
  </section>
}

const NOOP_SUBSCRIBE = () => () => {}

export const isGptModelName = (model: unknown): model is string =>
  typeof model === 'string' && /(?:^|\/)(?:gpt|chatgpt)(?:[-_.]|\d|$)/i.test(model)

export function useModelDirectory(modelDirectory: ModelDirectoryStore | undefined): ModelDirectorySnapshot | undefined {
  const subscribe = useCallback(
    (listener: () => void) => modelDirectory !== undefined ? modelDirectory.subscribe(listener) : NOOP_SUBSCRIBE(),
    [modelDirectory],
  )
  const getSnapshot = useCallback(() => modelDirectory?.getSnapshot(), [modelDirectory])
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot)
}

export function pillStyle(active: boolean, writable: boolean) {
  return {
    boxSizing: 'border-box' as const,
    display: 'inline-flex',
    alignItems: 'center',
    gap: 5,
    height: 28,
    border: 0,
    borderRadius: 7,
    padding: '0 6px',
    font: 'inherit',
    fontSize: 12,
    lineHeight: '20px',
    whiteSpace: 'nowrap' as const,
    color: active ? 'var(--dsw-static-blue-500)' : 'var(--dsw-alias-label-secondary)',
    background: active ? 'var(--dsw-alias-interactive-bg-selected)' : 'transparent',
    cursor: writable ? 'pointer' : 'default',
    fontWeight: active ? 600 : 400,
  }
}

type DynamicCatalogMap = Readonly<Record<string, { readonly defaultTokens: number; readonly maxTokens: number }>>
let cachedConnectCatalog: DynamicCatalogMap | undefined
let catalogFetchPromise: Promise<DynamicCatalogMap | undefined> | undefined

async function loadConnectCatalog(): Promise<DynamicCatalogMap | undefined> {
  if (cachedConnectCatalog !== undefined) return cachedConnectCatalog
  if (typeof fetch !== 'function') return undefined
  return catalogFetchPromise ??= fetch(OPENAI_CODEX_MODEL_CATALOG_PATH, {
    headers: { accept: 'application/json' },
    credentials: 'same-origin',
  }).then(async res => {
    if (!res.ok) return undefined
    const rows = await res.json() as unknown
    if (!Array.isArray(rows)) return undefined
    const map: Record<string, { defaultTokens: number; maxTokens: number }> = {}
    for (const row of rows) {
      const rec = typeof row === 'object' && row !== null ? row as Record<string, unknown> : undefined
      if (rec !== undefined && typeof rec.id === 'string' && typeof rec.contextWindow === 'number' && typeof rec.maxContextWindow === 'number') {
        map[rec.id] = { defaultTokens: rec.contextWindow, maxTokens: rec.maxContextWindow }
      }
    }
    return cachedConnectCatalog = map
  }).catch(() => undefined).finally(() => { catalogFetchPromise = undefined })
}

const contextMenuCss = `
.codex-ctx-menu { position:fixed; z-index:1200; width:196px; padding:6px; border-radius:10px; font-size:12px; color:var(--dsw-alias-label-primary); background:var(--dsw-alias-bg-layer-1, #1f2329); border:0.5px solid var(--dsw-alias-border-l2); box-shadow:var(--dsw-shadow-lv2, 0 6px 20px rgb(0 0 0 / 16%)); box-sizing:border-box; }
.codex-ctx-head { padding:4px 8px 6px; font-size:11px; color:var(--dsw-alias-label-secondary); border-bottom:0.5px solid var(--dsw-alias-border-l2); margin-bottom:4px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
.codex-ctx-item { display:flex; align-items:center; gap:6px; width:100%; border:0; border-radius:6px; padding:5px 8px; background:transparent; color:inherit; font:inherit; text-align:left; cursor:pointer; }
.codex-ctx-item:hover:not(:disabled) { background:var(--dsw-alias-interactive-bg-hover, rgb(128 128 128 / 12%)); }
.codex-ctx-item[aria-checked=true] { color:var(--dsw-static-blue-500); font-weight:600; }
.codex-ctx-item:disabled { opacity:.5; cursor:default; }
.codex-ctx-form { display:flex; gap:4px; margin-top:4px; padding-top:6px; border-top:0.5px solid var(--dsw-alias-border-l2); }
.codex-ctx-form input { flex:1; min-width:0; height:26px; padding:0 7px; border-radius:6px; border:0.5px solid var(--dsw-alias-border-l3, var(--dsw-alias-border-l2)); background:var(--dsw-alias-bg-layer-2); color:inherit; font:inherit; font-variant-numeric:tabular-nums; }
.codex-ctx-form input[aria-invalid=true] { border-color:var(--dsw-alias-state-error-primary, #e5484d); }
.codex-ctx-form button { height:26px; padding:0 9px; border-radius:6px; border:0.5px solid var(--dsw-alias-border-l3, var(--dsw-alias-border-l2)); background:var(--dsw-alias-bg-layer-2); color:inherit; font:inherit; cursor:pointer; }
`

export interface ContextControlProps extends PropsLocale<'codex'> {
  useSettings: (select: (state: unknown) => unknown) => unknown
  setSetting: (field: string, value: unknown) => Promise<void>
  unsetSetting: (field: string) => Promise<void>
  modelDirectory?: ModelDirectoryStore | undefined
  getCodexConnectScope?: (() => CodexConnectScope | undefined) | undefined
}

export function ContextWindowControl(props: ContextControlProps) {
  const { useSettings, setSetting, unsetSetting, modelDirectory, getCodexConnectScope, t } = props
  const dirSnapshot = useModelDirectory(modelDirectory)
  const settings = useSettings(state => state) as {
    value?: { contextWindow?: number; contextWindowControlEnabled?: boolean }
    writable: boolean
  }
  const hasDirectory = modelDirectory !== undefined
  const provider = dirSnapshot?.current?.provider
  const currentModel = dirSnapshot?.current?.model
  const eligible = hasDirectory ? dirSnapshot?.status === 'ready' && isGptModelName(currentModel) : true
  const isCodexConnect = hasDirectory && eligible && provider === OPENAI_CODEX_PROVIDER
  const connectScope = isCodexConnect ? getCodexConnectScope?.() : undefined
  const subscribeConnect = useCallback(
    (listener: () => void) => connectScope !== undefined ? connectScope.subscribe(listener) : NOOP_SUBSCRIBE(),
    [connectScope],
  )
  const getConnectSnapshot = useCallback(() => connectScope?.getSnapshot(), [connectScope])
  const connectSnap = useSyncExternalStore(subscribeConnect, getConnectSnapshot, getConnectSnapshot)

  const [open, setOpen] = useState(false)
  const [customInput, setCustomInput] = useState('')
  const [customInvalid, setCustomInvalid] = useState(false)
  const [anchorRect, setAnchorRect] = useState<{ bottom: number; right: number }>()
  const [dynamicCatalog, setDynamicCatalog] = useState<DynamicCatalogMap | undefined>(() => cachedConnectCatalog)
  const fetchedModelsRef = useRef<Set<string>>(new Set())
  const buttonRef = useRef<HTMLButtonElement>(null)
  const menuRef = useRef<HTMLDivElement>(null)
  const menuId = useId()

  useEffect(() => {
    if (!isCodexConnect || currentModel === undefined) return
    if (OPENAI_CODEX_MODEL_LIMITS[currentModel] !== undefined || dynamicCatalog?.[currentModel] !== undefined) return
    if (fetchedModelsRef.current.has(currentModel)) return
    fetchedModelsRef.current.add(currentModel)
    let cancelled = false
    void loadConnectCatalog().then(catalog => {
      if (!cancelled && catalog !== undefined) setDynamicCatalog(catalog)
    })
    return () => { cancelled = true }
  }, [isCodexConnect, currentModel, dynamicCatalog])

  useEffect(() => { setOpen(false); setCustomInvalid(false); setCustomInput('') }, [provider, currentModel])

  useEffect(() => {
    if (!open) return undefined
    const updateAnchor = () => {
      const rect = buttonRef.current?.getBoundingClientRect()
      if (rect === undefined) return
      setAnchorRect({
        bottom: Math.max(8, window.innerHeight - rect.top + 6),
        right: Math.max(8, window.innerWidth - rect.right),
      })
    }
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return
      setOpen(false); setCustomInvalid(false); buttonRef.current?.focus()
    }
    const onPointerDown = (event: PointerEvent) => {
      const target = event.target as Node | null
      if (target !== null && (buttonRef.current?.contains(target) || menuRef.current?.contains(target))) return
      setOpen(false); setCustomInvalid(false)
    }
    updateAnchor()
    window.addEventListener('resize', updateAnchor)
    window.addEventListener('scroll', updateAnchor, true)
    window.addEventListener('keydown', onKeyDown)
    document.addEventListener('pointerdown', onPointerDown)
    return () => {
      window.removeEventListener('resize', updateAnchor)
      window.removeEventListener('scroll', updateAnchor, true)
      window.removeEventListener('keydown', onKeyDown)
      document.removeEventListener('pointerdown', onPointerDown)
    }
  }, [open])

  if (!(settings.value?.contextWindowControlEnabled ?? true) || !eligible) return null
  if (isCodexConnect && connectSnap?.status === 'unavailable') return null

  const bounds = resolveContextWindowBounds(provider, currentModel, dynamicCatalog)
  const rawConnectOverride = isCodexConnect && typeof currentModel === 'string'
    ? connectSnap?.overrides?.[currentModel]
    : undefined
  const overrideTokens = isCodexConnect
    ? (typeof rawConnectOverride === 'number' && rawConnectOverride > 0 ? rawConnectOverride : undefined)
    : settings.value?.contextWindow
  const effectiveTokens = overrideTokens ?? bounds.defaultTokens
  const writable = isCodexConnect ? connectSnap?.writable !== false : settings.writable !== false
  const label = effectiveTokens !== undefined ? formatCompactTokens(effectiveTokens) : t('contextShortDefault')
  const fullLabel = `${t('contextSize')}: ${effectiveTokens !== undefined ? `${effectiveTokens.toLocaleString()} tokens` : t('contextDefaultOption')}`

  const applyBudget = (tokens: number | undefined): void => {
    if (!writable) return
    if (isCodexConnect) {
      if (connectScope !== undefined && typeof currentModel === 'string') {
        void connectScope.setModelOverride(currentModel, tokens).catch(() => {})
      }
    } else if (tokens === undefined) {
      void unsetSetting('contextWindow').catch(() => {})
    } else {
      void setSetting('contextWindow', tokens).catch(() => {})
    }
    setOpen(false); setCustomInvalid(false); setCustomInput(''); buttonRef.current?.focus()
  }

  return <>
    <button
      ref={buttonRef}
      type="button"
      data-codex-context-control={overrideTokens !== undefined ? 'override' : 'default'}
      aria-haspopup="menu"
      aria-expanded={open}
      aria-controls={open ? menuId : undefined}
      aria-label={fullLabel}
      title={fullLabel}
      disabled={!writable}
      onClick={() => {
        if (!writable) return
        if (!open && typeof window !== 'undefined') {
          const rect = buttonRef.current?.getBoundingClientRect()
          if (rect !== undefined) {
            setAnchorRect({
              bottom: Math.max(8, window.innerHeight - rect.top + 6),
              right: Math.max(8, window.innerWidth - rect.right),
            })
          }
        }
        setOpen(current => !current); setCustomInvalid(false)
      }}
      style={{ ...pillStyle(overrideTokens !== undefined, writable), fontVariantNumeric: 'tabular-nums' }}
    >{label}</button>
    {open && typeof document !== 'undefined' ? createPortal(
      <div
        id={menuId}
        ref={menuRef}
        role="menu"
        aria-label={t('contextSize')}
        data-codex-context-menu
        className="codex-ctx-menu"
        style={{ bottom: anchorRect?.bottom ?? 48, right: anchorRect?.right ?? 16 }}
      >
        <style>{contextMenuCss}</style>
        <div className="codex-ctx-head">{`${currentModel ?? 'GPT'} · ≤${formatCompactTokens(bounds.maxTokens)}`}</div>
        <button
          type="button" role="menuitemradio" className="codex-ctx-item"
          aria-checked={overrideTokens === undefined} disabled={!writable} onClick={() => applyBudget(undefined)}
        >
          <span aria-hidden="true" style={{ width: 14, textAlign: 'center' }}>{overrideTokens === undefined ? '✓' : ''}</span>
          <span>{bounds.defaultTokens !== undefined ? `${t('contextDefaultOption')} (${formatCompactTokens(bounds.defaultTokens)})` : t('contextDefaultOption')}</span>
        </button>
        {contextPresetsForBounds(bounds).map(tier => <button
          key={tier}
          type="button" role="menuitemradio" className="codex-ctx-item"
          aria-checked={overrideTokens === tier} disabled={!writable} onClick={() => applyBudget(tier)}
          style={{ fontVariantNumeric: 'tabular-nums' }}
        >
          <span aria-hidden="true" style={{ width: 14, textAlign: 'center' }}>{overrideTokens === tier ? '✓' : ''}</span>
          <span>{formatCompactTokens(tier)}</span>
        </button>)}
        <form className="codex-ctx-form" onSubmit={event => {
          event.preventDefault()
          const parsed = parseCustomContextInput(customInput, bounds.maxTokens)
          if (parsed === undefined) { setCustomInvalid(true); return }
          applyBudget(parsed)
        }}>
          <input
            type="text" inputMode="numeric"
            placeholder={t('contextCustomPlaceholder')} aria-label={t('contextCustomPlaceholder')}
            aria-invalid={customInvalid} value={customInput}
            onChange={event => { setCustomInput(event.currentTarget.value); if (customInvalid) setCustomInvalid(false) }}
          />
          <button type="submit" disabled={!writable}>{t('contextApply')}</button>
        </form>
      </div>,
      document.body,
    ) : null}
  </>
}
