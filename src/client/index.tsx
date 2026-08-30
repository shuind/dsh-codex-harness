/** Browser controls for Codex requests and the editable operating prompt. */

import { useEffect, useLayoutEffect, useState } from 'react'
import { createPortal } from 'react-dom'
import type { HostObservable, InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type { Context } from '@deepseek-ai/cordis'
import type { SettingsScope } from '@deepseek-ai/dsh-client-runtime/client'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
import type {} from '@deepseek-ai/dsh-client-runtime/client'
import type {} from '@deepseek-ai/dsh-client-ui-slots'
import { CODEX_CONTEXT_MAX, CODEX_CONTEXT_UNIT, isCodexPresetId } from '../context.ts'
import { DEFAULT_CODEX_SYSTEM_PROMPT } from '../prompt.ts'
import type { CodexActivity } from '../activity-types.ts'
import { modelActivity, sameModelActivity } from './activity.ts'

const NS = 'codex' as const
const SETTINGS_NAMESPACE = 'codex'
const FAST_FALLBACK_SLOT = 'conversation.input.right' as const
const LEGACY_OVERLAY_SLOT = 'conversation.input.overlay' as const
const PLUGIN_SETTINGS_SLOT = 'settings.plugin.item' as const
const DEFAULT_CONTEXT_WINDOW = 262_144

interface CodexSettings {
  fast: boolean
  contextWindow?: number
  systemPrompt?: string
}

type CodexScope = SettingsScope<CodexSettings>

const en = {
  fast: 'Fast mode',
  fastOn: 'Fast mode on (priority tier)',
  fastOff: 'Fast mode off',
  fastStateOn: 'On',
  fastStateOff: 'Off',
  contextSize: 'Context size',
  contextSizeDescription: 'Next request capacity in K tokens.',
  contextRestore: 'Restore model default',
  promptCardTitle: 'Codex Harness',
  promptCardDescription: 'View and customize the complete Codex operating prompt.',
  promptLabel: 'System prompt',
  promptHint: 'This is the full prompt owned by this plugin. Persona and DSH tool guidance stay dynamic.',
  promptOverridden: 'Overridden',
  promptReset: 'Restore default',
  promptUnsaved: 'Unsaved',
  promptDiscard: 'Discard',
  promptSave: 'Save',
  promptSaving: 'Saving...',
  promptSaveFailed: 'Could not save the prompt.',
  promptExpand: 'Expand settings',
  promptCollapse: 'Collapse settings',
  promptReadOnly: 'This settings document is read-only.',
  activityCompacting: 'Compacting context...',
  activityRequestingModel: 'Requesting model...',
  activityModelReply: 'Model replying...',
} as const

const zh = {
  fast: 'Fast',
  fastOn: 'Fast mode on (priority tier)',
  fastOff: 'Fast mode off',
  fastStateOn: '\u5f00',
  fastStateOff: '\u5173',
  contextSize: '\u4e0a\u4e0b\u6587\u5927\u5c0f',
  contextSizeDescription: '\u8bbe\u7f6e\u4e0b\u6b21\u8bf7\u6c42\u7684\u4e0a\u4e0b\u6587\u5bb9\u91cf\uff0c\u5355\u4f4d\u4e3a K tokens\u3002',
  contextRestore: '\u6062\u590d\u6a21\u578b\u9ed8\u8ba4\u503c',
  promptCardTitle: 'Codex Harness',
  promptCardDescription: '\u67e5\u770b\u548c\u81ea\u5b9a\u4e49\u5b8c\u6574\u7684 Codex \u7cfb\u7edf\u63d0\u793a\u8bcd\u3002',
  promptLabel: '\u7cfb\u7edf\u63d0\u793a\u8bcd',
  promptHint: '\u8fd9\u662f\u672c\u63d2\u4ef6\u8d1f\u8d23\u7684\u5168\u90e8\u63d0\u793a\u8bcd\uff1bPersona \u548c DSH \u5de5\u5177\u6307\u5bfc\u4ecd\u4f1a\u52a8\u6001\u6ce8\u5165\u3002',
  promptOverridden: '\u5df2\u8986\u76d6',
  promptReset: '\u6062\u590d\u9ed8\u8ba4',
  promptUnsaved: '\u672a\u4fdd\u5b58',
  promptDiscard: '\u653e\u5f03',
  promptSave: '\u4fdd\u5b58',
  promptSaving: '\u4fdd\u5b58\u4e2d...',
  promptSaveFailed: '\u63d0\u793a\u8bcd\u4fdd\u5b58\u5931\u8d25\u3002',
  promptExpand: '\u5c55\u5f00\u8bbe\u7f6e',
  promptCollapse: '\u6536\u8d77\u8bbe\u7f6e',
  promptReadOnly: '\u5f53\u524d\u8bbe\u7f6e\u6587\u4ef6\u4e3a\u53ea\u8bfb\u3002',
  activityCompacting: '\u6b63\u5728\u538b\u7f29\u4e0a\u4e0b\u6587...',
  activityRequestingModel: '\u8bf7\u6c42\u4e2d...',
  activityModelReply: '\u56de\u590d\u4e2d...',
} as const

type CodexKey = keyof typeof en

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    codex: CodexKey
  }
  interface SlotMap {
    'conversation.input.overlay': {
      kind: 'list'
      scope: 'session'
      owner: Record<never, never>
    }
    'settings.plugin.item': {
      kind: 'keyed'
      scope: 'root'
      owner: { children?: never }
    }
  }
}

interface InputSettingsControlInjected {
  hooks: { settings: HostObservable<ReturnType<CodexScope['getSnapshot']>> }
  setSetting: (field: string, value: unknown) => Promise<void>
  unsetSetting: (field: string) => Promise<void>
}

function promptFromLayer(layer: unknown): string | undefined {
  if (typeof layer !== 'object' || layer === null || Array.isArray(layer)) return undefined
  const value = (layer as Record<string, unknown>)['systemPrompt']
  return typeof value === 'string' ? value : undefined
}

function hasPromptOverride(layer: unknown): boolean {
  return typeof layer === 'object'
    && layer !== null
    && !Array.isArray(layer)
    && Object.hasOwn(layer, 'systemPrompt')
}

/** Full-prompt editor contributed to Settings > Plugins. */
export function PromptSettingsCard(
  props: PropsRuntime<'settings.plugin.item'>
    & InjectFace<InputSettingsControlInjected>
    & PropsLocale<'codex'>,
) {
  const { useSettings, setSetting, unsetSetting, t } = props
  const snapshot = useSettings(state => state as {
    status: 'loading' | 'ready' | 'unavailable'
    value?: CodexSettings
    base?: unknown
    user?: unknown
    writable: boolean
  })
  const current = snapshot.value?.systemPrompt ?? DEFAULT_CODEX_SYSTEM_PROMPT
  const inherited = promptFromLayer(snapshot.base) ?? DEFAULT_CODEX_SYSTEM_PROMPT
  const overridden = hasPromptOverride(snapshot.user)
  const [open, setOpen] = useState(false)
  const [draft, setDraft] = useState(current)
  const [saving, setSaving] = useState(false)
  const [failed, setFailed] = useState(false)

  useEffect(() => { setDraft(current) }, [current])
  if (snapshot.status === 'unavailable') return null

  const dirty = draft !== current
  const save = async (): Promise<void> => {
    setSaving(true)
    setFailed(false)
    try {
      await setSetting('systemPrompt', draft)
    } catch {
      setFailed(true)
    } finally {
      setSaving(false)
    }
  }
  const reset = async (): Promise<void> => {
    setSaving(true)
    setFailed(false)
    setDraft(inherited)
    try {
      await unsetSetting('systemPrompt')
    } catch {
      setFailed(true)
      setDraft(current)
    } finally {
      setSaving(false)
    }
  }

  return (
    <li style={{
      listStyle: 'none',
      border: '1px solid var(--dsw-alias-border-l2)',
      borderRadius: 12,
      background: open ? 'var(--dsw-alias-bg-layer-2)' : 'var(--dsw-alias-bg-layer-3)',
      overflow: 'hidden',
    }}>
      <button
        type="button"
        aria-expanded={open}
        aria-label={`${t(open ? 'promptCollapse' : 'promptExpand')}: ${t('promptCardTitle')}`}
        onClick={() => { setOpen(!open) }}
        style={{
          width: '100%',
          border: 0,
          background: 'none',
          color: 'inherit',
          padding: '14px 16px',
          display: 'flex',
          alignItems: 'center',
          gap: 12,
          textAlign: 'left',
          cursor: 'pointer',
          font: 'inherit',
        }}
      >
        <span style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', gap: 4 }}>
          <strong style={{ fontSize: 15, lineHeight: 1.4 }}>{t('promptCardTitle')}</strong>
          <span style={{ color: 'var(--dsw-alias-label-tertiary)', fontSize: 13, lineHeight: 1.5 }}>
            {t('promptCardDescription')}
          </span>
        </span>
        {dirty && (
          <span style={{
            borderRadius: 999,
            padding: '1px 8px',
            background: 'var(--dsw-alias-bg-module-platform)',
            color: 'var(--dsw-alias-label-secondary)',
            fontSize: 11,
          }}>
            {t('promptUnsaved')}
          </span>
        )}
        <span aria-hidden="true" style={{ color: 'var(--dsw-alias-label-tertiary)', fontSize: 16 }}>
          {open ? '-' : '+'}
        </span>
      </button>
      {open && (
        <div style={{ borderTop: '1px solid var(--dsw-alias-border-l2)', margin: '0 16px', padding: '12px 0' }}>
          {!snapshot.writable && (
            <p style={{ margin: '0 0 10px', color: 'var(--dsw-alias-label-tertiary)', fontSize: 12 }}>
              {t('promptReadOnly')}
            </p>
          )}
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 7 }}>
            <label htmlFor="codex-system-prompt" style={{ flex: 1, fontSize: 13, fontWeight: 500 }}>
              {t('promptLabel')}
            </label>
            {overridden && (
              <>
                <span style={{
                  borderRadius: 999,
                  padding: '1px 8px',
                  background: 'var(--dsw-alias-bg-module-platform)',
                  color: 'var(--dsw-alias-label-secondary)',
                  fontSize: 11,
                }}>
                  {t('promptOverridden')}
                </span>
                <button
                  type="button"
                  disabled={!snapshot.writable || saving}
                  onClick={() => { void reset() }}
                  style={{ border: 0, background: 'none', color: 'var(--dsw-alias-label-secondary)', font: 'inherit', fontSize: 12, cursor: 'pointer' }}
                >
                  {t('promptReset')}
                </button>
              </>
            )}
          </div>
          <textarea
            id="codex-system-prompt"
            value={draft}
            disabled={!snapshot.writable || saving}
            onChange={event => { setDraft(event.target.value) }}
            spellCheck={false}
            style={{
              boxSizing: 'border-box',
              width: '100%',
              minHeight: 320,
              resize: 'vertical',
              padding: 12,
              border: '1px solid var(--dsw-alias-border-l2)',
              borderRadius: 8,
              background: 'var(--dsw-alias-bg-layer-3)',
              color: 'var(--dsw-alias-label-primary)',
              fontFamily: 'ui-monospace, SFMono-Regular, Consolas, monospace',
              fontSize: 12,
              lineHeight: 1.55,
            }}
          />
          <p style={{ margin: '6px 0 12px', color: 'var(--dsw-alias-label-tertiary)', fontSize: 12, lineHeight: 1.5 }}>
            {t('promptHint')}
          </p>
          <div style={{
            display: 'flex',
            justifyContent: 'flex-end',
            alignItems: 'center',
            gap: 8,
            paddingTop: 12,
            borderTop: '1px solid var(--dsw-alias-border-l2)',
          }}>
            {failed && (
              <span role="status" style={{ flex: 1, color: 'var(--dsw-alias-label-error)', fontSize: 12 }}>
                {t('promptSaveFailed')}
              </span>
            )}
            <button
              type="button"
              disabled={!dirty || saving}
              onClick={() => { setDraft(current); setFailed(false) }}
              style={{ border: '1px solid var(--dsw-alias-border-l2)', borderRadius: 8, background: 'none', color: 'inherit', padding: '5px 14px', font: 'inherit', cursor: 'pointer' }}
            >
              {t('promptDiscard')}
            </button>
            <button
              type="button"
              disabled={!snapshot.writable || !dirty || saving}
              onClick={() => { void save() }}
              style={{ border: 0, borderRadius: 8, background: 'var(--dsw-alias-label-primary)', color: 'var(--dsw-alias-bg-layer-3)', padding: '6px 14px', font: 'inherit', cursor: 'pointer' }}
            >
              {saving ? t('promptSaving') : t('promptSave')}
            </button>
          </div>
        </div>
      )}
    </li>
  )
}

/** The legacy composer seat is a compact inline row, not a menu panel. */
function FastModeFallback(
  props: Pick<PropsRuntime<'conversation.input.right'>, 'sessionId' | 'useSessions'>
    & InjectFace<InputSettingsControlInjected>
    & PropsLocale<'codex'>,
) {
  const { sessionId, useSessions, useSettings, setSetting, t } = props
  const agentPreset = useSessions(state => state.byId[sessionId]?.agentPreset)
  const snapshot = useSettings(state => state as { value?: CodexSettings; writable: boolean })
  const fast = snapshot.value?.fast ?? false
  if (!isCodexPresetId(agentPreset)) return null
  return (
    <button
      type="button"
      role="switch"
      disabled={snapshot.writable === false}
      aria-checked={fast}
      aria-label={fast ? t('fastOn') : t('fastOff')}
      title={fast ? t('fastOn') : t('fastOff')}
      onClick={() => { void setSetting('fast', !fast) }}
      style={{
        boxSizing: 'border-box',
        display: 'inline-flex',
        alignItems: 'center',
        gap: 5,
        height: 28,
        border: 0,
        borderRadius: 7,
        padding: '0 6px',
        color: fast ? 'var(--dsw-static-blue-500)' : 'var(--dsw-alias-label-secondary)',
        background: fast ? 'var(--dsw-alias-interactive-bg-selected)' : 'transparent',
        cursor: snapshot.writable === false ? 'default' : 'pointer',
        font: 'inherit',
        fontSize: 12,
        lineHeight: '20px',
        fontWeight: fast ? 600 : 400,
        whiteSpace: 'nowrap',
      }}
    >
      <span>{t('fast')}</span>
      <span style={{ color: 'var(--dsw-alias-label-tertiary)', fontSize: 11 }}>
        {fast ? t('fastStateOn') : t('fastStateOff')}
      </span>
    </button>
  )
}

type LegacyOverlayProps = PropsRuntime<typeof LEGACY_OVERLAY_SLOT>
  & InjectFace<InputSettingsControlInjected>
  & PropsLocale<'codex'>

type ContextSizeControlProps = Pick<
  LegacyOverlayProps,
  'sessionId' | 'useSessions' | 'useSettings' | 't'
> & Pick<InputSettingsControlInjected, 'setSetting' | 'unsetSetting'> & {
  contextWindow: number
}

type ContextPressureReader = (key: 'contextPressure') => { contextWindow?: number } | undefined

function contextWindowFromProjection(useProjection: LegacyOverlayProps['useProjection']): number {
  const pressure = (useProjection as unknown as ContextPressureReader)('contextPressure')
  return pressure?.contextWindow !== undefined && pressure.contextWindow > 0
    ? pressure.contextWindow
    : DEFAULT_CONTEXT_WINDOW
}

/** Settings form appended to the old host's context meter panel. */
function ContextSizeControl({
  contextWindow, sessionId, useSessions, useSettings, setSetting, unsetSetting, t,
}: ContextSizeControlProps) {
  const agentPreset = useSessions(state => state.byId[sessionId]?.agentPreset)
  const snapshot = useSettings(state => state as { value?: CodexSettings; writable: boolean })
  if (!isCodexPresetId(agentPreset)) return null
  const configured = snapshot.value?.contextWindow
  const maxK = CODEX_CONTEXT_MAX / CODEX_CONTEXT_UNIT
  const valueK = Math.min(maxK, Math.max(1, Math.round((configured ?? contextWindow) / CODEX_CONTEXT_UNIT)))
  const setValueK = (nextK: number): void => {
    if (!Number.isFinite(nextK)) return
    const normalizedK = Math.min(maxK, Math.max(1, Math.trunc(nextK)))
    const normalized = normalizedK * CODEX_CONTEXT_UNIT
    if (normalized === contextWindow) void unsetSetting('contextWindow')
    else void setSetting('contextWindow', normalized)
  }

  return (
    <div style={{
      display: 'grid',
      gap: 8,
      marginTop: 10,
      paddingTop: 10,
      borderTop: '1px solid var(--dsw-alias-border-l2)',
    }}>
      <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', gap: 12 }}>
        <strong style={{ color: 'var(--dsw-alias-label-primary)', fontSize: 13 }}>{t('contextSize')}</strong>
        <span style={{ color: 'var(--dsw-alias-label-secondary)', fontSize: 12, fontVariantNumeric: 'tabular-nums' }}>
          {valueK}K
        </span>
      </div>
      <input
        type="range"
        min={1}
        max={maxK}
        step={1}
        value={valueK}
        disabled={snapshot.writable === false}
        aria-label={t('contextSize')}
        onChange={event => { setValueK(Number(event.target.value)) }}
        style={{
          display: 'block',
          width: '100%',
          accentColor: 'var(--dsw-static-blue-500)',
        }}
      />
      <div style={{ display: 'grid', gap: 4 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
          <input
            type="number"
            min={1}
            max={maxK}
            step={1}
            value={valueK}
            disabled={snapshot.writable === false}
            aria-label={t('contextSize')}
            onChange={event => { setValueK(Number(event.target.value)) }}
            style={{
              width: 68,
              border: '1px solid var(--dsw-alias-border-primary)',
              borderRadius: 6,
              padding: '4px 6px',
              color: 'var(--dsw-alias-label-primary)',
              background: 'var(--dsw-alias-fill-primary)',
              font: 'inherit',
              fontSize: 12,
              fontVariantNumeric: 'tabular-nums',
            }}
          />
          <span style={{ color: 'var(--dsw-alias-label-secondary)', fontSize: 11 }}>K</span>
        </div>
        <span style={{ color: 'var(--dsw-alias-label-tertiary)', fontSize: 11, lineHeight: '16px' }}>
          {t('contextSizeDescription')}
        </span>
      </div>
      {configured !== undefined && (
        <button
          type="button"
          onClick={() => { void unsetSetting('contextWindow') }}
          style={{
            justifySelf: 'start',
            border: 0,
            padding: 0,
            color: 'var(--dsw-static-blue-500)',
            background: 'transparent',
            cursor: 'pointer',
            font: 'inherit',
            fontSize: 11,
          }}
        >
          {t('contextRestore')}
        </button>
      )}
    </div>
  )
}

type ActivityProps = Pick<
  LegacyOverlayProps,
  'sessionId' | 'useSession' | 'useSessions' | 'useProjection' | 't'
>

type CodexActivityReader = (key: 'codexActivity') => CodexActivity | null | undefined
type ActivityFallback = ReturnType<typeof modelActivity>

function elapsedSeconds(startedAt: number, now: number): number {
  return Math.max(0, Math.floor((now - startedAt) / 1_000))
}

/** Prefer the session snapshot when an older projection host only exposes null. */
export function resolveActivity(
  agentPreset: string | undefined,
  projectedActivity: CodexActivity | null | undefined,
  fallbackActivity: ActivityFallback,
): CodexActivity | null {
  if (!isCodexPresetId(agentPreset)) return null
  if (projectedActivity?.activity === 'awaiting-model') {
    return {
      activity: fallbackActivity?.activity ?? 'requesting-model',
      startedAt: fallbackActivity?.startedAt ?? projectedActivity.startedAt,
    }
  }
  if (projectedActivity === null) return fallbackActivity ?? null
  return projectedActivity ?? fallbackActivity ?? null
}

export function ActivityLine({
  sessionId, useSession, useSessions, useProjection, t, position,
}: ActivityProps & { position?: { left: number; top: number } }) {
  const agentPreset = useSessions(state => state.byId[sessionId]?.agentPreset)
  // Keep the projection seam optional: this package must still load when the
  // host has no session-projection registry or has not carried this key.
  const projectedActivity = (useProjection as unknown as CodexActivityReader)('codexActivity')
  // The projection is the authoritative phase and clock. The session snapshot
  // fallback only covers the short wire gap before the next projection frame;
  // tool calls intentionally remain silent because their cards own the status.
  const fallbackActivity = useSession(modelActivity, sameModelActivity)
  const activity = resolveActivity(agentPreset, projectedActivity, fallbackActivity)
  const [now, setNow] = useState(() => Date.now())

  useEffect(() => {
    if (!isCodexPresetId(agentPreset) || activity === undefined || activity === null) return undefined
    setNow(Date.now())
    const timer = setInterval(() => { setNow(Date.now()) }, 1_000)
    return () => clearInterval(timer)
  }, [agentPreset, activity?.activity, activity?.startedAt])

  if (!isCodexPresetId(agentPreset) || activity === undefined || activity === null) return null
  const label = activity.activity === 'compaction'
    ? t('activityCompacting')
    : activity.activity === 'model-reply'
      ? t('activityModelReply')
      : t('activityRequestingModel')

  return (
    <span
      data-codex-activity
      aria-live="polite"
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: 7,
        minHeight: 26,
        marginLeft: position === undefined ? 10 : 0,
        color: 'var(--dsw-alias-label-secondary)',
        fontSize: 12,
        lineHeight: '20px',
        whiteSpace: 'nowrap',
        WebkitTextFillColor: 'currentColor',
        ...(position === undefined ? {} : {
          position: 'fixed' as const,
          left: position.left,
          top: position.top,
          zIndex: 100,
          pointerEvents: 'none' as const,
        }),
      }}
    >
      <span
        aria-hidden="true"
        style={{
          width: 5,
          height: 5,
          flex: '0 0 auto',
          borderRadius: '50%',
          background: 'var(--dsw-static-blue-500)',
          opacity: 0.55,
        }}
      />
      <span>{label}</span>
      <span style={{ color: 'var(--dsw-alias-label-tertiary)' }}>
        {'\u00b7'} {elapsedSeconds(activity.startedAt, now)}s
      </span>
    </span>
  )
}

function findContextMeterDialog(): HTMLElement | null {
  const buttons = document.querySelectorAll<HTMLButtonElement>(
    'button[aria-haspopup="dialog"][aria-expanded="true"]',
  )
  for (const button of buttons) {
    if (button.querySelectorAll('circle').length < 2) continue
    let ancestor: Element | null = button
    for (let depth = 0; ancestor !== null && depth < 5; depth += 1, ancestor = ancestor.parentElement) {
      const dialog = ancestor.querySelector<HTMLElement>('[role="dialog"]')
      if (dialog !== null) return dialog
    }
  }
  return null
}

function findTurnStatus(): HTMLElement | null {
  let fallback: HTMLElement | null = null
  for (const status of document.querySelectorAll<HTMLElement>('[role="status"]')) {
    if (status.closest('[data-chat-flow]') === null) continue
    fallback ??= status
    if (status.textContent?.includes('Deep diving...') === true
      || status.className.toString().includes('turnStatus')) return status
  }
  return fallback
}

function useTurnStatusPosition(target: HTMLElement | null): { left: number; top: number } | null {
  const [position, setPosition] = useState<{ left: number; top: number } | null>(null)

  useLayoutEffect(() => {
    if (target === null) {
      setPosition(null)
      return undefined
    }
    const update = (): void => {
      if (!target.isConnected) {
        setPosition(null)
        return
      }
      const rect = target.getBoundingClientRect()
      if (rect.width === 0 && rect.height === 0) {
        setPosition(null)
        return
      }
      setPosition({
        left: Math.round(rect.right + 10),
        top: Math.round(rect.top + (rect.height - 26) / 2),
      })
    }
    update()
    window.addEventListener('resize', update)
    window.addEventListener('scroll', update, true)
    const observer = typeof ResizeObserver === 'undefined' ? undefined : new ResizeObserver(update)
    observer?.observe(target)
    return () => {
      window.removeEventListener('resize', update)
      window.removeEventListener('scroll', update, true)
      observer?.disconnect()
    }
  }, [target])

  return position
}

function useLegacyHostTargets(): {
  contextDialog: HTMLElement | null
  turnStatus: HTMLElement | null
} {
  const [targets, setTargets] = useState<{
    contextDialog: HTMLElement | null
    turnStatus: HTMLElement | null
  }>({ contextDialog: null, turnStatus: null })

  useEffect(() => {
    if (typeof document === 'undefined' || document.body === null) return undefined
    const refresh = (): void => {
      const next = {
        contextDialog: findContextMeterDialog(),
        turnStatus: findTurnStatus(),
      }
      setTargets(current => current.contextDialog === next.contextDialog
        && current.turnStatus === next.turnStatus ? current : next)
    }
    refresh()
    const observer = new MutationObserver(refresh)
    observer.observe(document.body, {
      subtree: true,
      childList: true,
      attributes: true,
      attributeFilter: ['aria-expanded'],
    })
    return () => observer.disconnect()
  }, [])
  return targets
}

/** Bridges plugin UI into DOM sites rendered by the legacy conversation host. */
function LegacyOverlay(props: LegacyOverlayProps) {
  const {
    sessionId, useSession, useSessions, useProjection, useSettings, setSetting, unsetSetting, t,
  } = props
  const { contextDialog, turnStatus } = useLegacyHostTargets()
  const turnStatusPosition = useTurnStatusPosition(turnStatus)
  const contextWindow = contextWindowFromProjection(useProjection)
  const agentPreset = useSessions(state => state.byId[sessionId]?.agentPreset)
  if (!isCodexPresetId(agentPreset)) return null
  return (
    <>
      {contextDialog !== null && createPortal(
        <ContextSizeControl
          contextWindow={contextWindow}
          sessionId={sessionId}
          useSessions={useSessions}
          useSettings={useSettings}
          setSetting={setSetting}
          unsetSetting={unsetSetting}
          t={t}
        />,
        contextDialog,
        'codex-context-size',
      )}
      {turnStatusPosition !== null && typeof document !== 'undefined' && document.body !== null && createPortal(
        <ActivityLine
          sessionId={sessionId}
          useSession={useSession}
          useSessions={useSessions}
          useProjection={useProjection}
          t={t}
          position={turnStatusPosition}
        />,
        document.body,
        'codex-activity',
      )}
    </>
  )
}

export const inject = ['slots', 'locale', 'settingsScope']

/** Mount request controls and the plugin settings card through shared slots. */
export function apply(ctx: Context): void {
  ctx.effect(() => ctx.locale.register(NS, { en, zh }), 'codex client: dictionaries')
  const settings = ctx.settingsScope.bind<CodexSettings>({ namespace: SETTINGS_NAMESPACE })
  const injected = () => ({
    hooks: { settings },
    setSetting: (field: string, value: unknown) => settings.set(field, value),
    unsetSetting: (field: string) => settings.unset(field),
  })
  ctx.slots.inject(FAST_FALLBACK_SLOT, () => ctx.slots.register({
    name: FAST_FALLBACK_SLOT,
    id: 'codex-fast',
    order: 0,
    locale: NS,
    inject: injected,
  }, FastModeFallback))
  ctx.slots.inject(LEGACY_OVERLAY_SLOT, () => ctx.slots.register({
    name: LEGACY_OVERLAY_SLOT,
    id: 'codex-legacy-overlay',
    order: 0,
    locale: NS,
    inject: injected,
  }, LegacyOverlay))
  ctx.slots.inject(PLUGIN_SETTINGS_SLOT, () => ctx.slots.register({
    name: PLUGIN_SETTINGS_SLOT,
    key: SETTINGS_NAMESPACE,
    locale: NS,
    inject: injected,
  }, PromptSettingsCard))
}

export default { inject, apply }
