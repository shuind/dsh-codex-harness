/** Browser controls for Codex requests and the editable operating prompt. */

import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import type { HostObservable, InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type { Context } from '@deepseek-ai/cordis'
import type { SettingsScope } from '@deepseek-ai/dsh-client-runtime/client'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
import type {} from '@deepseek-ai/dsh-client-runtime/client'
import type {} from '@deepseek-ai/dsh-client-ui-slots'
import type {} from '@deepseek-ai/dsh-api-remotes/client'
import type {} from '@deepseek-ai/dsh-agent-presets/remote'
import type { TypertClientRemote } from '@deepseek-ai/dsh-typert-protocol'
import { CODEX_CONTEXT_MAX, CODEX_CONTEXT_UNIT, isCodexPresetId } from '../context.ts'
import type { CodexActivity } from '../activity-types.ts'
import { modelActivity, sameModelActivity } from './activity.ts'
import presetEditorRemote from '../preset-editor-remote.ts'
import { PresetManagerCard } from './preset-manager.tsx'
import { presetEn, presetZh } from './preset-copy.ts'
import type { PresetClientRemote, PresetManagerActions } from './preset-manager.tsx'

interface CompactCommandOption {
  id: string
  label: string
  detail?: string
}

interface CompactCommandSession {
  command(line: string): Promise<{
    ok: true
    value: { matched: boolean }
  } | {
    ok: false
    error: { code: string; message: string }
  }>
}

interface CompactCommandUi {
  decorate(decoration: {
    name: string
    available(session: { sessionId: string }): boolean
    ui: {
      kind: 'popupSelect'
      options(session: { sessionId: string }, signal: AbortSignal): Promise<readonly CompactCommandOption[]>
      onSelect(option: CompactCommandOption, session: { sessionId: string }): void | Promise<void>
    }
  }): () => void
}

interface CompactCommandSessions {
  binding(sessionId: string): { session: CompactCommandSession } | undefined
}

const NS = 'codex' as const
const SETTINGS_NAMESPACE = 'codex'
const FAST_FALLBACK_SLOT = 'conversation.input.right' as const
const LEGACY_OVERLAY_SLOT = 'conversation.input.overlay' as const
const PLUGIN_SETTINGS_SLOT = 'settings.plugin.item' as const
const DEFAULT_CONTEXT_WINDOW = 262_144

interface CodexSettings {
  fast: boolean
  fastModeControlEnabled: boolean
  contextWindow?: number
  persona?: string
  harnessSourcePrompt?: string
  webSurfacePrompt?: string
  systemPrompt?: string
  promptEnabled: boolean
  terminalToolsEnabled: boolean
  patchToolEnabled: boolean
  planToolEnabled: boolean
  hostedWebSearchEnabled: boolean
  remoteCompactionEnabled: boolean
  activityIndicatorEnabled: boolean
}

type CodexScope = SettingsScope<CodexSettings>

const en = {
  ...presetEn,
  fast: 'Fast mode',
  fastOn: 'Fast mode on (priority tier)',
  fastOff: 'Fast mode off',
  fastStateOn: 'On',
  fastStateOff: 'Off',
  contextSize: 'Context size',
  contextSizeDescription: 'Next request capacity in K tokens.',
  contextRestore: 'Restore model default',
  promptCardTitle: 'Codex Harness',
  promptCardDescription: 'Edit presets, Codex capabilities, and the operating prompt. Activity status is global.',
  otherCapabilitiesLabel: 'Global capabilities',
  capabilityPrompt: 'Codex operating prompt',
  capabilityPromptHint: 'Inject the editable instructions and persona-first prompt layout.',
  compactRemote: 'Remote compaction',
  compactRemoteHint: 'Use the provider remote compaction endpoint first.',
  compactLocal: 'Local compaction',
  compactLocalHint: 'Use the DSH text-summary compaction engine directly.',
  capabilityTerminal: 'Terminal tools',
  capabilityTerminalHint: 'Expose exec_command and write_stdin.',
  capabilityPatch: 'Patch tool',
  capabilityPatchHint: 'Expose apply_patch, using the native Responses grammar when supported.',
  capabilityPlan: 'Plan tool',
  capabilityPlanHint: 'Expose update_plan for implementation task tracking.',
  capabilityWebSearch: 'Hosted web search',
  capabilityWebSearchHint: 'Use the provider-native Responses web_search tool when available.',
  capabilityCompaction: 'Remote compaction',
  capabilityCompactionHint: 'Prefer the provider Responses compact endpoint before local compaction.',
  capabilityActivity: 'Activity indicator',
  capabilityActivityHint: 'Show request, reply, and compaction status beside the conversation.',
  promptCustomizationLabel: 'Prompt customization',
  personaLabel: 'Persona',
  personaHint: 'Deployment identity and role. Supports {{model}} and {{cwd}}.',
  sourcePromptLabel: 'DSH Core source instructions',
  sourcePromptHint: 'Guidance about the DSH checkout and working directory. Supports {{sourceRoot}}.',
  webPromptLabel: 'DSH Core Web instructions',
  webPromptHint: 'Guidance about this Web GUI, HMR, builds, and verification. Supports {{webUrl}}.',
  promptRestoreAll: 'Restore all prompt defaults',
  promptLabel: 'Codex operating prompt',
  promptHint: 'This is the Codex operating prompt. Persona and DSH Core instructions are edited separately above.',
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
  ...presetZh,
  fast: 'Fast',
  fastOn: 'Fast mode on (priority tier)',
  fastOff: 'Fast mode off',
  fastStateOn: '\u5f00',
  fastStateOff: '\u5173',
  contextSize: '\u4e0a\u4e0b\u6587\u5927\u5c0f',
  contextSizeDescription: '\u8bbe\u7f6e\u4e0b\u6b21\u8bf7\u6c42\u7684\u4e0a\u4e0b\u6587\u5bb9\u91cf\uff0c\u5355\u4f4d\u4e3a K tokens\u3002',
  contextRestore: '\u6062\u590d\u6a21\u578b\u9ed8\u8ba4\u503c',
  promptCardTitle: 'Codex Harness',
  promptCardDescription: '\u7f16\u8f91\u9884\u8bbe\u3001Codex \u80fd\u529b\u548c\u64cd\u4f5c\u63d0\u793a\u8bcd\uff0c\u6d3b\u52a8\u72b6\u6001\u662f\u5168\u5c40\u8bbe\u7f6e\u3002',
  otherCapabilitiesLabel: '\u5168\u5c40\u80fd\u529b',
  capabilityPrompt: 'Codex \u64cd\u4f5c\u63d0\u793a\u8bcd',
  capabilityPromptHint: '\u6ce8\u5165\u53ef\u7f16\u8f91\u6307\u4ee4\uff0c\u5e76\u5c06 Persona \u653e\u5728\u63d0\u793a\u8bcd\u9996\u4f4d\u3002',
  compactRemote: '\u8fdc\u7a0b\u538b\u7f29',
  compactRemoteHint: '\u4f18\u5148\u4f7f\u7528\u63d0\u4f9b\u5546\u7684\u8fdc\u7a0b\u538b\u7f29\u7aef\u70b9\u3002',
  compactLocal: '\u672c\u5730\u538b\u7f29',
  compactLocalHint: '\u76f4\u63a5\u4f7f\u7528 DSH \u6587\u672c\u6458\u8981\u538b\u7f29\u5f15\u64ce\u3002',
  capabilityTerminal: '\u7ec8\u7aef\u5de5\u5177',
  capabilityTerminalHint: '\u63d0\u4f9b exec_command \u548c write_stdin\u3002',
  capabilityPatch: '\u8865\u4e01\u5de5\u5177',
  capabilityPatchHint: '\u63d0\u4f9b apply_patch\uff0c\u5e76\u5728\u652f\u6301\u65f6\u4f7f\u7528 Responses \u539f\u751f\u8bed\u6cd5\u3002',
  capabilityPlan: '\u8ba1\u5212\u5de5\u5177',
  capabilityPlanHint: '\u63d0\u4f9b update_plan\uff0c\u7528\u4e8e\u8ddf\u8e2a\u5b9e\u65bd\u4efb\u52a1\u3002',
  capabilityWebSearch: '\u6258\u7ba1\u7f51\u7edc\u641c\u7d22',
  capabilityWebSearchHint: '\u53ef\u7528\u65f6\u4f7f\u7528\u63d0\u4f9b\u5546\u539f\u751f\u7684 Responses web_search \u5de5\u5177\u3002',
  capabilityCompaction: '\u8fdc\u7a0b\u4e0a\u4e0b\u6587\u538b\u7f29',
  capabilityCompactionHint: '\u4f18\u5148\u8c03\u7528\u63d0\u4f9b\u5546\u7684 Responses compact \u7aef\u70b9\uff0c\u5931\u8d25\u65f6\u56de\u9000\u672c\u5730\u538b\u7f29\u3002',
  capabilityActivity: '\u6d3b\u52a8\u72b6\u6001',
  capabilityActivityHint: '\u5728\u5bf9\u8bdd\u65c1\u663e\u793a\u8bf7\u6c42\u3001\u56de\u590d\u548c\u538b\u7f29\u72b6\u6001\u3002',
  promptCustomizationLabel: '\u63d0\u793a\u8bcd\u5b9a\u5236',
  personaLabel: 'Persona',
  personaHint: '\u5b9a\u4e49 Agent \u7684\u8eab\u4efd\u4e0e\u89d2\u8272，\u652f\u6301 {{model}} \u548c {{cwd}}。',
  sourcePromptLabel: 'DSH Core \u6e90\u7801\u8bf4\u660e',
  sourcePromptHint: '\u8bf4\u660e DSH \u6e90\u7801\u68c0\u51fa\u76ee\u5f55\u4e0e\u5de5\u4f5c\u76ee\u5f55，\u652f\u6301 {{sourceRoot}}。',
  webPromptLabel: 'DSH Core Web \u8bf4\u660e',
  webPromptHint: '\u8bf4\u660e Web GUI、HMR、\u6784\u5efa\u4e0e\u9a8c\u8bc1，\u652f\u6301 {{webUrl}}。',
  promptRestoreAll: '\u6062\u590d\u6240\u6709\u63d0\u793a\u8bcd\u9ed8\u8ba4\u503c',
  promptLabel: 'Codex \u64cd\u4f5c\u63d0\u793a\u8bcd',
  promptHint: '\u8fd9\u662f Codex \u64cd\u4f5c\u63d0\u793a\u8bcd。Persona \u548c DSH Core \u8bf4\u660e\u5728\u4e0a\u65b9\u5206\u522b\u7f16\u8f91。',
  promptUnsaved: '\u672a\u4fdd\u5b58',
  promptDiscard: '\u653e\u5f03',
  promptSave: '\u4fdd\u5b58',
  promptSaving: '\u4fdd\u5b58\u4e2d...',
  promptSaveFailed: '\u63d0\u793a\u8bcd\u4fdd\u5b58\u5931\u8d25。',
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
  presetManager: PresetManagerActions
}

type BooleanCapabilitySetting = Exclude<
  keyof CodexSettings,
  'fast' | 'contextWindow' | 'persona' | 'harnessSourcePrompt' | 'webSurfacePrompt' | 'systemPrompt'
>

interface CapabilityToggleProps {
  field: BooleanCapabilitySetting
  label: string
  hint: string
  enabled: boolean
  disabled: boolean
  setSetting: (field: string, value: unknown) => Promise<void>
}

function CapabilityToggle({
  field, label, hint, enabled, disabled, setSetting,
}: CapabilityToggleProps) {
  return (
    <label style={{
      display: 'flex',
      alignItems: 'flex-start',
      gap: 12,
      padding: '9px 0',
      cursor: disabled ? 'default' : 'pointer',
    }}>
      <span style={{ flex: 1, minWidth: 0, display: 'grid', gap: 2 }}>
        <strong style={{ fontSize: 13, fontWeight: 500 }}>{label}</strong>
        <span style={{ color: 'var(--dsw-alias-label-tertiary)', fontSize: 12, lineHeight: 1.45 }}>
          {hint}
        </span>
      </span>
      <input
        type="checkbox"
        role="switch"
        checked={enabled}
        disabled={disabled}
        aria-label={label}
        onChange={event => { void setSetting(field, event.target.checked) }}
        style={{ marginTop: 3, accentColor: 'var(--dsw-static-blue-500)' }}
      />
    </label>
  )
}

/** One editor per preset; only display preferences are global. */
export function PromptSettingsCard(
  props: PropsRuntime<'settings.plugin.item'> & InjectFace<InputSettingsControlInjected> & PropsLocale<'codex'>,
) {
  const { useSettings, setSetting, presetManager, t } = props
  const snapshot = useSettings(state => state as { status: string; value?: CodexSettings; writable: boolean })
  const [open, setOpen] = useState(false)
  if (snapshot.status === 'unavailable') return null
  return <li style={{ listStyle: 'none', border: '1px solid var(--dsw-alias-border-l2)', borderRadius: 12, overflow: 'hidden' }}>
    <button type="button" aria-expanded={open} onClick={() => setOpen(!open)} style={{ width: '100%', padding: 16, textAlign: 'left', border: 0, background: 'none', color: 'inherit', cursor: 'pointer' }}>
      <strong>{t('promptCardTitle')}</strong><span style={{ float: 'right' }}>{open ? '−' : '+'}</span>
      <p style={{ marginBottom: 0 }}>{t('promptCardDescription')}</p>
    </button>
    {open && <div style={{ padding: 16, borderTop: '1px solid var(--dsw-alias-border-l2)' }}>
      <PresetManagerCard presetManager={presetManager} t={t} />
      <details style={{ marginTop: 22, borderTop: '1px solid var(--dsw-alias-border-l2)', paddingTop: 14 }}>
        <summary style={{ cursor: 'pointer', fontWeight: 600 }}>{t('pmGlobalSettings')}</summary>
        <CapabilityToggle field="activityIndicatorEnabled" label={t('capabilityActivity')} hint={t('capabilityActivityHint')}
          enabled={snapshot.value?.activityIndicatorEnabled ?? true} disabled={!snapshot.writable} setSetting={setSetting} />
      </details>
    </div>}
  </li>
}

/** The legacy composer seat is a compact inline row, not a menu panel. */
function FastModeFallback(
  props: Pick<PropsRuntime<'conversation.input.right'>, 'sessionId' | 'useSessions'>
    & InjectFace<InputSettingsControlInjected>
    & PropsLocale<'codex'>,
) {
  const { useSettings, setSetting, t } = props
  const snapshot = useSettings(state => state as { value?: CodexSettings; writable: boolean })
  const visible = snapshot.value?.fastModeControlEnabled ?? true
  const fast = snapshot.value?.fast ?? false
  if (!visible) return null
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
  contextWindow, sessionId: _sessionId, useSessions: _useSessions, useSettings, setSetting, unsetSetting, t,
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

/** Detect the host meter so the fallback does not duplicate its ring button. */
function hasHostContextMeter(): boolean {
  if (typeof document === 'undefined') return false
  return [...document.querySelectorAll<HTMLButtonElement>('button[aria-haspopup="dialog"]')]
    .some(button => button.querySelectorAll('circle').length >= 2)
}

function useHostContextMeter(): boolean {
  const [available, setAvailable] = useState(false)

  useEffect(() => {
    if (typeof document === 'undefined' || document.body === null) return undefined
    const refresh = (): void => { setAvailable(hasHostContextMeter()) }
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

  return available
}

type ContextFallbackProps = PropsRuntime<'conversation.input.right'>
  & InjectFace<InputSettingsControlInjected>
  & PropsLocale<'codex'>

/** Keep context configuration reachable before the host has a pressure meter. */
function ContextSizeFallback({
  sessionId, useSessions, useProjection, useSettings, setSetting, unsetSetting, t,
}: ContextFallbackProps) {
  const agentPreset = useSessions(state => state.byId[sessionId]?.agentPreset)
  const hostMeter = useHostContextMeter()
  const contextWindow = contextWindowFromProjection(useProjection as LegacyOverlayProps['useProjection'])
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

  if (!isCodexPresetId(agentPreset) || hostMeter) return null
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
            sessionId={sessionId}
            useSessions={useSessions}
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

type ActivityProps = Pick<
  LegacyOverlayProps,
  'sessionId' | 'useSession' | 'useSessions' | 'useProjection' | 'useSettings' | 't'
>

type CodexActivityReader = (key: 'codexActivity') => CodexActivity | null | undefined
type ActivityFallback = ReturnType<typeof modelActivity>

function elapsedSeconds(startedAt: number, now: number): number {
  return Math.max(0, Math.floor((now - startedAt) / 1_000))
}

/** Prefer the session snapshot when an older projection host only exposes null. */
export function resolveActivity(
  projectedActivity: CodexActivity | null | undefined,
  fallbackActivity: ActivityFallback,
): CodexActivity | null {
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
  sessionId: _sessionId, useSession, useSessions: _useSessions, useProjection, useSettings, t, position,
}: ActivityProps & { position?: { left: number; top: number } }) {
  const settings = useSettings(state => state as { value?: CodexSettings })
  const enabled = settings.value?.activityIndicatorEnabled ?? true
  // Keep the projection seam optional: this package must still load when the
  // host has no session-projection registry or has not carried this key.
  const projectedActivity = (useProjection as unknown as CodexActivityReader)('codexActivity')
  // The projection is the authoritative phase and clock. The session snapshot
  // fallback only covers the short wire gap before the next projection frame;
  // tool calls intentionally remain silent because their cards own the status.
  const fallbackActivity = useSession(modelActivity, sameModelActivity)
  const activity = resolveActivity(projectedActivity, fallbackActivity)
  const [now, setNow] = useState(() => Date.now())

  useEffect(() => {
    if (!enabled || activity === undefined || activity === null) return undefined
    setNow(Date.now())
    const timer = setInterval(() => { setNow(Date.now()) }, 1_000)
    return () => clearInterval(timer)
  }, [enabled, activity?.activity, activity?.startedAt])

  if (!enabled || activity === undefined || activity === null) return null
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

function isTurnStatus(status: HTMLElement): boolean {
  return status.textContent?.includes('Deep diving...') === true
    || status.className.toString().includes('turnStatus')
}

function hasLayout(status: HTMLElement): boolean {
  const rect = status.getBoundingClientRect()
  return rect.width > 0 && rect.height > 0
}

/** Prefer the actual Core turn status over unrelated global status nodes. */
export function selectTurnStatus(statuses: readonly HTMLElement[]): HTMLElement | null {
  const preferred = statuses.filter(isTurnStatus)
  return preferred.findLast(hasLayout)
    ?? preferred.at(-1)
    ?? statuses.filter(status => status.closest('[data-chat-flow]') !== null).findLast(hasLayout)
    ?? statuses.filter(status => status.closest('[data-chat-flow]') !== null).at(-1)
    ?? null
}

function findTurnStatus(): HTMLElement | null {
  return selectTurnStatus([...document.querySelectorAll<HTMLElement>('[role="status"]')])
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
          useSettings={useSettings}
          t={t}
          position={turnStatusPosition}
        />,
        document.body,
        'codex-activity',
      )}
    </>
  )
}

export const inject = [
  'commandUi', 'sessions', 'slots', 'locale', 'settingsScope',
  'remote', 'remote.agentPresets', 'remote.settings',
]

function createPresetManager(ctx: Context): PresetManagerActions {
  const remote = (ctx as unknown as { remote?: TypertClientRemote }).remote
  const ready: Promise<void> = remote === undefined
    ? Promise.resolve()
    : remote.$mount(presetEditorRemote).then(dispose => {
      ctx.effect(() => () => { void dispose() }, 'codex client: preset editor remote')
    })
  // Keep an unavailable optional host remote from becoming an unhandled rejection
  // when the settings card is never opened. The card still awaits the same promise
  // and renders the actual error if the user opens it.
  void ready.catch(() => {})
  return {
    remote: remote as unknown as PresetClientRemote,
    ready,
  }
}

/**
 * The Codex editor contribution is mounted by this client entry itself. Its
 * namespace therefore cannot be a top-level dependency (that would make the
 * entry wait for the contribution it is responsible for mounting). Wait for
 * the namespace in a child fiber instead, and capture that protected Remote
 * face for the settings card.
 */
function registerPresetSettingsCard(
  ctx: Context,
  settings: SettingsScope<CodexSettings>,
  presetManager: PresetManagerActions,
): () => void {
  const settingsPresetManager: PresetManagerActions = {
    ...presetManager,
    remote: (ctx as unknown as { remote: PresetClientRemote }).remote,
  }
  return ctx.slots.inject(PLUGIN_SETTINGS_SLOT, () => ctx.slots.register({
    name: PLUGIN_SETTINGS_SLOT,
    key: SETTINGS_NAMESPACE,
    locale: NS,
    inject: () => ({
      hooks: { settings },
      setSetting: (field: string, value: unknown) => settings.set(field, value),
      unsetSetting: (field: string) => settings.unset(field),
      presetManager: settingsPresetManager,
    }),
  }, PromptSettingsCard))
}

/** Mount request controls and the plugin settings card through shared slots. */
export function apply(ctx: Context): void {
  ctx.effect(() => ctx.locale.register(NS, { en, zh }), 'codex client: dictionaries')
  const commandUi = ctx.get('commandUi') as CompactCommandUi
  const sessions = ctx.get('sessions') as unknown as CompactCommandSessions
  const t = ctx.locale.bind(NS)
  const sessionFor = (session: { sessionId: string }): CompactCommandSession | undefined =>
    sessions.binding(session.sessionId)?.session
  ctx.effect(() => commandUi.decorate({
    name: 'compact',
    available: session => sessionFor(session) !== undefined,
    ui: {
      kind: 'popupSelect',
      options: async () => [
        { id: 'remote', label: t('compactRemote'), detail: t('compactRemoteHint') },
        { id: 'local', label: t('compactLocal'), detail: t('compactLocalHint') },
      ],
      onSelect: async (option, session) => {
        const live = sessionFor(session)
        if (live === undefined) throw new Error('this session is not materialized yet')
        const result = await live.command(`/compact ${option.id}`)
        if (!result.ok) throw new Error(`compact mode switch failed: ${result.error.code}: ${result.error.message}`)
        if (!result.value.matched) throw new Error('the host offers no /compact command')
      },
    },
  }), 'codex client: /compact mode picker')
  const settings = ctx.settingsScope.bind<CodexSettings>({ namespace: SETTINGS_NAMESPACE })
  const presetManager = createPresetManager(ctx)
  const injected = () => ({
    hooks: { settings },
    setSetting: (field: string, value: unknown) => settings.set(field, value),
    unsetSetting: (field: string) => settings.unset(field),
    presetManager,
  })
  ctx.slots.inject(FAST_FALLBACK_SLOT, () => ctx.slots.register({
    name: FAST_FALLBACK_SLOT,
    id: 'codex-fast',
    order: 0,
    locale: NS,
    inject: injected,
  }, FastModeFallback))
  ctx.slots.inject(FAST_FALLBACK_SLOT, () => ctx.slots.register({
    name: FAST_FALLBACK_SLOT,
    id: 'codex-context-size-fallback',
    order: 1,
    locale: NS,
    inject: injected,
  }, ContextSizeFallback))
  ctx.slots.inject(LEGACY_OVERLAY_SLOT, () => ctx.slots.register({
    name: LEGACY_OVERLAY_SLOT,
    id: 'codex-legacy-overlay',
    order: 0,
    locale: NS,
    inject: injected,
  }, LegacyOverlay))
  // `codexPresetEditor` is mounted by createPresetManager above. Keep its
  // namespace dependency local to the settings card so the main client entry
  // can start and perform that mount first.
  ctx.inject(
    ['remote', 'remote.agentPresets', 'remote.settings', 'remote.codexPresetEditor'],
    settingsCtx => registerPresetSettingsCard(settingsCtx, settings, presetManager),
  )
}

export default { inject, apply }
