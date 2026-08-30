/** Browser controls for the Codex request settings mounted by the Host plugin. */

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
import type { CodexActivity } from '../activity-types.ts'
import { modelActivity, sameModelActivity } from './activity.ts'

const NS = 'codex' as const
const SETTINGS_NAMESPACE = 'codex'
const FAST_FALLBACK_SLOT = 'conversation.input.right' as const
const LEGACY_OVERLAY_SLOT = 'conversation.input.overlay' as const
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
  fastStateOn: '\u5f00',
  fastStateOff: '\u5173',
  contextSize: '\u4e0a\u4e0b\u6587\u5927\u5c0f',
  contextSizeDescription: '\u8bbe\u7f6e\u4e0b\u6b21\u8bf7\u6c42\u7684\u4e0a\u4e0b\u6587\u5bb9\u91cf\uff0c\u5355\u4f4d\u4e3a K tokens\u3002',
  contextRestore: '\u6062\u590d\u6a21\u578b\u9ed8\u8ba4\u503c',
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
  ctx.slots.inject(LEGACY_OVERLAY_SLOT, () => ctx.slots.register({
    name: LEGACY_OVERLAY_SLOT,
    id: 'codex-legacy-overlay',
    order: 0,
    locale: NS,
    inject: injected,
  }, LegacyOverlay))
}

export default { inject, apply }
