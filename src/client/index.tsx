/** Browser controls for the Codex request settings mounted by the Host plugin. */

import { useEffect, useState } from 'react'
import type { HostObservable, InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type { Context } from '@deepseek-ai/cordis'
import type { SettingsScope } from '@deepseek-ai/dsh-client-runtime/client'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
import type {} from '@deepseek-ai/dsh-client-runtime/client'
import type {} from '@deepseek-ai/dsh-client-ui-slots'
import { CODEX_CONTEXT_MAX, CODEX_CONTEXT_UNIT, CODEX_PRESET_ID } from '../context.ts'
import type { CodexActivity } from '../activity-types.ts'

const NS = 'codex' as const
const SETTINGS_NAMESPACE = 'codex'

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
  contextSizeDescription: 'Next request capacity in K tokens. The meter above is current.',
  contextRestore: 'Restore model default',
  activityCompacting: 'Compacting context...',
  activityAwaitingModel: 'Waiting for model response...',
} as const

const zh = {
  fast: 'Fast',
  fastOn: 'Fast mode on (priority tier)',
  fastOff: 'Fast mode off',
  fastStateOn: '开',
  fastStateOff: '关',
  contextSize: '上下文大小',
  contextSizeDescription: '设置下次请求的上下文容量，单位为 K tokens；上方是当前请求。',
  contextRestore: '恢复模型默认值',
  activityCompacting: '正在压缩上下文...',
  activityAwaitingModel: '正在等待模型响应...',
} as const

type CodexKey = keyof typeof en

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    codex: CodexKey
  }
  interface SlotMap {
    'conversation.input.model.settings': {
      kind: 'list'
      scope: 'session'
    }
    'conversation.input.context.settings': {
      kind: 'list'
      scope: 'session'
      owner: { contextWindow: number }
    }
  }
}

interface InputSettingsControlInjected {
  hooks: { settings: HostObservable<ReturnType<CodexScope['getSnapshot']>> }
  setSetting: (field: string, value: unknown) => Promise<void>
  unsetSetting: (field: string) => Promise<void>
}

type FastProps = PropsRuntime<'conversation.input.model.settings'>
  & InjectFace<InputSettingsControlInjected>
  & PropsLocale<'codex'>

function FastModeButton({ sessionId, useSessions, useSettings, setSetting, t }: FastProps) {
  const agentPreset = useSessions(state => state.byId[sessionId]?.agentPreset)
  const snapshot = useSettings(state => state as { value?: CodexSettings; writable: boolean })
  const fast = snapshot.value?.fast ?? false
  if (agentPreset !== CODEX_PRESET_ID) return null
  return (
    <button
      type="button"
      role="menuitemcheckbox"
      disabled={snapshot.writable === false}
      aria-pressed={fast}
      aria-label={fast ? t('fastOn') : t('fastOff')}
      title={fast ? t('fastOn') : t('fastOff')}
      onClick={() => { void setSetting('fast', !fast) }}
      style={{
        boxSizing: 'border-box',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        width: '100%',
        height: 40,
        border: 0,
        borderRadius: 10,
        padding: '0 10px',
        color: fast ? 'var(--dsw-static-blue-500)' : 'var(--dsw-alias-label-secondary)',
        background: fast ? 'var(--dsw-alias-interactive-bg-selected)' : 'transparent',
        cursor: snapshot.writable === false ? 'default' : 'pointer',
        font: 'inherit',
        fontSize: 14,
        lineHeight: '22px',
        fontWeight: fast ? 600 : 400,
        textAlign: 'left',
      }}
    >
      <span>{t('fast')}</span>
      <span style={{ color: 'var(--dsw-alias-label-tertiary)', fontSize: 12 }}>
        {fast ? t('fastStateOn') : t('fastStateOff')}
      </span>
    </button>
  )
}

type ContextProps = { contextWindow: number }
  & InjectFace<InputSettingsControlInjected>
  & PropsLocale<'codex'>

function ContextSizeControl({ contextWindow, useSettings, setSetting, unsetSetting, t }: ContextProps) {
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
    <div style={{ marginTop: 10, display: 'grid', gap: 5 }}>
      <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', gap: 12 }}>
        <strong style={{ color: 'var(--dsw-alias-label-primary)', fontSize: 12 }}>{t('contextSize')}</strong>
        <span style={{ color: 'var(--dsw-alias-label-secondary)', fontSize: 11 }}>
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
      />
      <div style={{ display: 'flex', alignItems: 'center', gap: 7 }}>
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
            width: 76,
            border: '1px solid var(--dsw-alias-border-primary)',
            borderRadius: 5,
            padding: '3px 5px',
            color: 'var(--dsw-alias-label-primary)',
            background: 'var(--dsw-alias-fill-primary)',
            font: 'inherit',
            fontSize: 11,
          }}
        />
        <span style={{ color: 'var(--dsw-alias-label-secondary)', fontSize: 11 }}>K</span>
        <span style={{ color: 'var(--dsw-alias-label-secondary)', fontSize: 11 }}>
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

type ActivityProps = PropsRuntime<'conversation.input.dock'>
  & PropsLocale<'codex'>

type CodexActivityReader = (key: 'codexActivity') => CodexActivity | null | undefined

function elapsedSeconds(startedAt: number, now: number): number {
  return Math.max(0, Math.floor((now - startedAt) / 1_000))
}

export function ActivityLine({ sessionId, useSessions, useProjection, t }: ActivityProps) {
  const agentPreset = useSessions(state => state.byId[sessionId]?.agentPreset)
  // Keep the projection seam optional: this package must still load when the
  // host has no session-projection registry or has not carried this key.
  const activity = (useProjection as unknown as CodexActivityReader)('codexActivity')
  const [now, setNow] = useState(() => Date.now())

  useEffect(() => {
    if (agentPreset !== CODEX_PRESET_ID || activity === undefined || activity === null) return undefined
    setNow(Date.now())
    const timer = setInterval(() => { setNow(Date.now()) }, 1_000)
    return () => clearInterval(timer)
  }, [agentPreset, activity?.startedAt])

  if (agentPreset !== CODEX_PRESET_ID || activity === undefined || activity === null) return null
  const label = activity.activity === 'awaiting-model'
    ? t('activityAwaitingModel')
    : t('activityCompacting')

  return (
    <div
      id="codex-activity"
      role="status"
      aria-live="polite"
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 7,
        minHeight: 28,
        padding: '4px 10px',
        color: 'var(--dsw-alias-label-secondary)',
        fontSize: 12,
        lineHeight: '20px',
      }}
    >
      <span
        aria-hidden="true"
        style={{
          width: 7,
          height: 7,
          flex: '0 0 auto',
          borderRadius: '50%',
          background: 'var(--dsw-static-blue-500)',
        }}
      />
      <span>{label}</span>
      <span style={{ color: 'var(--dsw-alias-label-tertiary)' }}>
        · {elapsedSeconds(activity.startedAt, now)}s
      </span>
    </div>
  )
}

export const inject = ['slots', 'locale', 'settingsScope']

/** Mount Fast inside the model selector and context size inside the meter panel. */
export function apply(ctx: Context): void {
  ctx.effect(() => ctx.locale.register(NS, { en, zh }), 'codex client: dictionaries')
  const settings = ctx.settingsScope.bind<CodexSettings>({ namespace: SETTINGS_NAMESPACE })
  const injected = () => ({
    hooks: { settings },
    setSetting: (field: string, value: unknown) => settings.set(field, value),
    unsetSetting: (field: string) => settings.unset(field),
  })
  ctx.slots.inject('conversation.input.model.settings', () => ctx.slots.register({
    name: 'conversation.input.model.settings',
    id: 'codex-fast',
    order: 0,
    locale: NS,
    inject: injected,
  }, FastModeButton))
  ctx.slots.inject('conversation.input.context.settings', () => ctx.slots.register({
    name: 'conversation.input.context.settings',
    id: 'codex-context-size',
    order: 0,
    locale: NS,
    inject: injected,
  }, ContextSizeControl))
  ctx.slots.inject('conversation.input.dock', () => ctx.slots.register({
    name: 'conversation.input.dock',
    id: 'codex-activity',
    order: 5,
    locale: NS,
  }, ActivityLine))
}

export default { inject, apply }
