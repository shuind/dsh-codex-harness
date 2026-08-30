/** Browser controls for the Codex request settings mounted by the Host plugin. */

import { useEffect, useRef, useState } from 'react'
import type { HostObservable, InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type { Context } from '@deepseek-ai/cordis'
import type { SettingsScope } from '@deepseek-ai/dsh-client-runtime/client'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
import type {} from '@deepseek-ai/dsh-client-runtime/client'
import type {} from '@deepseek-ai/dsh-client-ui-slots'
import { CODEX_CONTEXT_MAX, CODEX_CONTEXT_UNIT, isCodexPresetId } from '../context.ts'
import type { CodexActivity } from '../activity-types.ts'
import { modelActivity, sameModelActivity } from './activity.ts'

const NS = 'codex' as const
const SETTINGS_NAMESPACE = 'codex'
const ACTIVITY_FALLBACK_SLOT = 'conversation.composer.dock' as const
const FAST_FALLBACK_SLOT = 'conversation.input.right' as const
const CONTEXT_FALLBACK_SLOT = 'conversation.input.right' as const
const DEFAULT_CONTEXT_WINDOW = 262_144

interface CodexSettings {
  fast: boolean
  contextWindow?: number
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
  activityCompacting: 'Compacting context...',
  activityRequestingModel: 'Requesting model...',
  activityModelReply: 'Model replying...',
} as const

const zh = {
  fast: 'Fast',
  fastOn: 'Fast mode on (priority tier)',
  fastOff: 'Fast mode off',
  fastStateOn: '开',
  fastStateOff: '关',
  contextSize: '上下文大小',
  contextSizeDescription: '设置下次请求的上下文容量，单位为 K tokens。',
  contextRestore: '恢复模型默认值',
  activityCompacting: '正在压缩上下文...',
  activityRequestingModel: '请求中...',
  activityModelReply: '回复中...',
} as const

type CodexKey = keyof typeof en

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    codex: CodexKey
  }
}

interface InputSettingsControlInjected {
  hooks: { settings: HostObservable<ReturnType<CodexScope['getSnapshot']>> }
  setSetting: (field: string, value: unknown) => Promise<void>
  unsetSetting: (field: string) => Promise<void>
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

type LegacyContextProps = PropsRuntime<'conversation.input.right'>
  & InjectFace<InputSettingsControlInjected>
  & PropsLocale<'codex'>

type ContextPressureReader = (key: 'contextPressure') => { contextWindow?: number } | undefined

function contextWindowFromProjection(useProjection: LegacyContextProps['useProjection']): number {
  const pressure = (useProjection as unknown as ContextPressureReader)('contextPressure')
  return pressure?.contextWindow !== undefined && pressure.contextWindow > 0
    ? pressure.contextWindow
    : DEFAULT_CONTEXT_WINDOW
}

type ContextSizeControlProps = {
  contextWindow: number
  useSettings: LegacyContextProps['useSettings']
  setSetting: InputSettingsControlInjected['setSetting']
  unsetSetting: InputSettingsControlInjected['unsetSetting']
  t: LegacyContextProps['t']
}

/** Settings form kept inside the official composer slot's popover. */
function ContextSizeControl({
  contextWindow, useSettings, setSetting, unsetSetting, t,
}: ContextSizeControlProps) {
  const snapshot = useSettings(state => state as { value?: CodexSettings; writable: boolean })
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
    <div style={{ marginTop: 0, display: 'grid', gap: 8 }}>
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

/** Compact trigger used when the host has no ContextMeter settings child slot. */
function LegacyContextSizeControl({ sessionId, useSessions, useProjection, useSettings, setSetting, unsetSetting, t }: LegacyContextProps) {
  const agentPreset = useSessions(state => state.byId[sessionId]?.agentPreset)
  const contextWindow = contextWindowFromProjection(useProjection)
  const snapshot = useSettings(state => state as { value?: CodexSettings; writable: boolean })
  const configured = snapshot.value?.contextWindow
  const valueK = Math.min(
    CODEX_CONTEXT_MAX / CODEX_CONTEXT_UNIT,
    Math.max(1, Math.round((configured ?? contextWindow) / CODEX_CONTEXT_UNIT)),
  )
  const [open, setOpen] = useState(false)
  const rootRef = useRef<HTMLSpanElement | null>(null)

  useEffect(() => {
    if (!open) return undefined
    const onPointerDown = (event: PointerEvent): void => {
      if (event.target instanceof Node && rootRef.current?.contains(event.target) === true) return
      setOpen(false)
    }
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') setOpen(false)
    }
    document.addEventListener('pointerdown', onPointerDown)
    document.addEventListener('keydown', onKeyDown)
    return () => {
      document.removeEventListener('pointerdown', onPointerDown)
      document.removeEventListener('keydown', onKeyDown)
    }
  }, [open])

  if (!isCodexPresetId(agentPreset)) return null
  return (
    <span ref={rootRef} style={{ position: 'relative', display: 'inline-flex', alignItems: 'center' }}>
      <button
        type="button"
        aria-label={`${t('contextSize')}: ${valueK}K`}
        aria-haspopup="dialog"
        aria-expanded={open}
        disabled={snapshot.writable === false}
        title={t('contextSize')}
        onMouseDown={event => { event.preventDefault() }}
        onClick={() => { setOpen(value => !value) }}
        style={{
          boxSizing: 'border-box',
          display: 'inline-flex',
          alignItems: 'center',
          gap: 3,
          height: 28,
          border: 0,
          borderRadius: 7,
          padding: '0 6px',
          color: configured === undefined
            ? 'var(--dsw-alias-label-secondary)'
            : 'var(--dsw-static-blue-500)',
          background: open ? 'var(--dsw-alias-interactive-bg-hover)' : 'transparent',
          cursor: snapshot.writable === false ? 'default' : 'pointer',
          font: 'inherit',
          fontSize: 12,
          lineHeight: '20px',
          fontWeight: configured === undefined ? 400 : 600,
          whiteSpace: 'nowrap',
        }}
      >
        <span>{valueK}K</span>
        <svg viewBox="0 0 12 12" width="12" height="12" aria-hidden>
          <path d="M3 4.5 6 7.5 9 4.5" fill="none" stroke="currentColor" strokeWidth="1.25" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      </button>
      {open && (
        <div
          role="dialog"
          aria-label={t('contextSize')}
          style={{
            position: 'absolute',
            right: 0,
            bottom: 'calc(100% + 8px)',
            zIndex: 20,
            boxSizing: 'border-box',
            width: 300,
            maxWidth: 'calc(100vw - 24px)',
            padding: '10px 12px 12px',
            border: '1px solid var(--dsw-alias-border-l2)',
            borderRadius: 10,
            color: 'var(--dsw-alias-label-primary)',
            background: 'var(--dsw-alias-bg-base)',
            boxShadow: 'var(--dsw-shadow-lv2)',
          }}
        >
          <ContextSizeControl
            contextWindow={contextWindow}
            useSettings={useSettings}
            setSetting={setSetting}
            unsetSetting={unsetSetting}
            t={t}
          />
        </div>
      )}
    </span>
  )
}

type ActivityDockProps = PropsRuntime<'conversation.composer.dock'>
  & PropsLocale<'codex'>

// The component reads only the common session/projection/locale face, so the
// erased optional-slot registration can also mount it on a future status seat.
type ActivityProps = ActivityDockProps

type CodexActivityReader = (key: 'codexActivity') => CodexActivity | null | undefined

function elapsedSeconds(startedAt: number, now: number): number {
  return Math.max(0, Math.floor((now - startedAt) / 1_000))
}

export function ActivityLine({ sessionId, useSession, useSessions, useProjection, t }: ActivityProps) {
  const agentPreset = useSessions(state => state.byId[sessionId]?.agentPreset)
  // Keep the projection seam optional: this package must still load when the
  // host has no session-projection registry or has not carried this key.
  const projectedActivity = (useProjection as unknown as CodexActivityReader)('codexActivity')
  // The projection is the authoritative phase and clock. The session snapshot
  // fallback only covers the short wire gap before the next projection frame;
  // tool calls intentionally remain silent because their cards own the status.
  const fallbackActivity = useSession(modelActivity, sameModelActivity)
  // `undefined` means the key has not arrived yet; `null` is an authoritative
  // clear and must not be resurrected by the local snapshot fallback.
  const normalizedProjectedActivity = projectedActivity?.activity === 'awaiting-model'
    ? {
        activity: fallbackActivity?.activity ?? 'requesting-model' as const,
        startedAt: fallbackActivity?.startedAt ?? projectedActivity.startedAt,
      }
    : projectedActivity
  const activity = projectedActivity !== undefined ? normalizedProjectedActivity : (
    isCodexPresetId(agentPreset) && fallbackActivity !== undefined
      ? fallbackActivity
      : null
  )
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
      id="codex-activity"
      role="status"
      aria-live="polite"
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: 7,
        minHeight: 26,
        color: 'var(--dsw-alias-label-secondary)',
        fontSize: 12,
        lineHeight: '20px',
        whiteSpace: 'nowrap',
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
        · {elapsedSeconds(activity.startedAt, now)}s
      </span>
    </span>
  )
}

/** Preserve the old composer-dock footprint for hosts without the chat status seat. */
function ActivityDock(props: ActivityDockProps) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', minHeight: 28, padding: '4px 10px' }}>
      <ActivityLine {...props} />
    </div>
  )
}

export const inject = ['slots', 'locale', 'settingsScope']

/** Mount all controls through the official composer seats shared by every DSH release. */
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
  ctx.slots.inject(CONTEXT_FALLBACK_SLOT, () => ctx.slots.register({
    name: CONTEXT_FALLBACK_SLOT,
    id: 'codex-context-size',
    order: 1,
    locale: NS,
    inject: injected,
  }, LegacyContextSizeControl))
  ctx.slots.inject(ACTIVITY_FALLBACK_SLOT, () => ctx.slots.register({
      name: ACTIVITY_FALLBACK_SLOT,
      id: 'codex-activity',
      order: 5,
      locale: NS,
    }, ActivityDock))
}

export default { inject, apply }
