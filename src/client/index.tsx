/** Browser controls, /compact decorator, and live activity line for Codex Harness. */

import { useEffect, useState } from 'react'
import type { HostObservable, InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type {} from '@deepseek-ai/dsh-client-ui-session/client'
import type {} from '@deepseek-ai/dsh-api-remotes/client'
import type { TypertClientRemote } from '@deepseek-ai/dsh-typert-protocol'
import { OPENAI_CODEX_PROVIDER } from '../contracts/ui-contracts.ts'
import type {
  CodexActivity,
  CodexConnectScope,
  CodexConnectSnapshot,
  ModelDirectorySnapshot,
  ModelDirectoryStore,
} from '../contracts/ui-contracts.ts'
import { modelActivity, sameModelActivity } from './activity.ts'
import presetEditorRemote from '../contracts/preset-editor-schema.ts'
import { toolPolicyEn, toolPolicyZh } from './tool-policy.tsx'
import { ContextWindowControl, isGptModelName, pillStyle, useModelDirectory } from './preset-manager.tsx'
import type { PresetClientRemote, PresetManagerActions } from './preset-manager.tsx'
export { ContextWindowControl }
export type { CodexConnectScope, CodexConnectSnapshot, ModelDirectorySnapshot, ModelDirectoryStore }

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
  scope?(sessionId: string): {
    get?(name: string): {
      input?: {
        for?(actx: unknown): { notify?(level: 'error' | 'info' | 'warning', text: string): void }
      }
    } | undefined
  } | undefined
}

function notifyCompactError(sessions: CompactCommandSessions, sessionId: string, text: string): void {
  const actx = sessions.scope?.(sessionId)
  actx?.get?.('conversation')?.input?.for?.(actx)?.notify?.('error', text)
}

const NS = 'codex' as const
const FAST_FALLBACK_SLOT = 'conversation.input.right' as const

export interface CodexSettings {
  fast: boolean
  fastModeControlEnabled: boolean
  contextWindowControlEnabled: boolean
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

/** Observable ConfigForms settings snapshot shared with the desktop adapter. */
export interface CodexSettingsSnapshot {
  readonly status: string
  readonly value?: CodexSettings | undefined
  readonly base?: Partial<CodexSettings> | undefined
  readonly user?: Partial<CodexSettings> | undefined
  readonly revision?: number | string | undefined
  readonly writable: boolean
}

export interface CodexScope extends HostObservable<CodexSettingsSnapshot> {
  set(field: string, value: unknown): Promise<void>
  unset(field: string): Promise<void>
}

const en = {
  ...toolPolicyEn,
  fast: 'Fast mode',
  fastModeControl: 'Show fast mode control',
  contextWindowControl: 'Show context window control',
  fastOn: 'Fast mode on (priority tier)',
  fastOff: 'Fast mode off',
  fastStateOn: 'On',
  fastStateOff: 'Off',
  contextSize: 'Context size',
  contextShortDefault: 'Ctx',
  contextDefaultOption: 'Default',
  contextCustomPlaceholder: '≥16k (e.g. 64)',
  contextApply: 'Set',
  compactRemote: 'Remote compaction',
  compactRemoteHint: 'Use the provider remote compaction endpoint first.',
  compactLocal: 'Local compaction',
  compactLocalHint: 'Use the DSH text-summary compaction engine directly.',
  capabilityActivity: 'Activity indicator',
  promptDiscard: 'Discard',
  promptSaving: 'Saving...',
  promptReadOnly: 'This settings document is read-only.',
  activityCompacting: 'Compacting context...',
  activityRequestingModel: 'Requesting model...',
  activityModelReply: 'Model replying...',
} as const

const zh: Record<keyof typeof en, string> = {
  ...toolPolicyZh,
  fastModeControl: '显示快速模式开关',
  contextWindowControl: '显示上下文大小快捷按钮',
  fast: '快速模式',
  fastOn: '快速模式已开启（优先通道）',
  fastOff: '快速模式已关闭',
  fastStateOn: '开',
  fastStateOff: '关',
  contextSize: '上下文大小',
  contextShortDefault: '上下文',
  contextDefaultOption: '默认',
  contextCustomPlaceholder: '≥16k (如 64)',
  contextApply: '确定',
  compactRemote: '远程压缩',
  compactRemoteHint: '优先使用提供商的远程压缩端点。',
  compactLocal: '本地压缩',
  compactLocalHint: '直接使用 DSH 文本摘要压缩引擎。',
  capabilityActivity: '活动状态',
  promptDiscard: '放弃',
  promptSaving: '保存中...',
  promptReadOnly: '当前设置文件为只读。',
  activityCompacting: '正在压缩上下文...',
  activityRequestingModel: '请求中...',
  activityModelReply: '回复中...',
}

type CodexKey = keyof typeof en

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    codex: CodexKey
  }
}

interface ModelDirectoriesService {
  directoryFor(sessionId: unknown): { readonly store?: ModelDirectoryStore } | undefined
}

/** Show the fallback Fast toggle only when the session uses a non-Codex-Connect GPT model. */
export function isFallbackFastEligible(snapshot: ModelDirectorySnapshot | undefined, hasDirectory: boolean): boolean {
  if (!hasDirectory) return true
  if (snapshot?.status !== 'ready' || snapshot.current === undefined) return false
  return snapshot.current.provider !== OPENAI_CODEX_PROVIDER && isGptModelName(snapshot.current.model)
}

export interface InputSettingsControlInjected {
  hooks: { settings: HostObservable<ReturnType<CodexScope['getSnapshot']>> }
  setSetting: (field: string, value: unknown) => Promise<void>
  unsetSetting: (field: string) => Promise<void>
  presetManager: PresetManagerActions
  modelDirectory?: ModelDirectoryStore | undefined
  getCodexConnectScope?: (() => CodexConnectScope | undefined) | undefined
}

type InputRightProps = Pick<PropsRuntime<'conversation.input.right'>, 'sessionId' | 'useSessions'>
  & InjectFace<InputSettingsControlInjected>
  & PropsLocale<'codex'>

export function FastModeFallback(props: InputRightProps) {
  const { useSettings, setSetting, modelDirectory, t } = props
  const dirSnapshot = useModelDirectory(modelDirectory)
  const snapshot = useSettings(state => state as { value?: CodexSettings; writable: boolean })
  const visible = snapshot.value?.fastModeControlEnabled ?? true
  const fast = snapshot.value?.fast ?? false
  if (!visible || !isFallbackFastEligible(dirSnapshot, modelDirectory !== undefined)) return null
  return (
    <button
      type="button" role="switch" disabled={snapshot.writable === false} aria-checked={fast}
      aria-label={fast ? t('fastOn') : t('fastOff')} title={fast ? t('fastOn') : t('fastOff')}
      onClick={() => { void setSetting('fast', !fast) }}
      style={pillStyle(fast, snapshot.writable !== false)}
    >
      <span>{t('fast')}</span>
      <span style={{ color: 'var(--dsw-alias-label-secondary)', fontSize: 11 }}>{fast ? t('fastStateOn') : t('fastStateOff')}</span>
    </button>
  )
}

export function ComposerControls(props: InputRightProps) {
  return <><ContextWindowControl {...props} /><FastModeFallback {...props} /></>
}

type ActivityProps = PropsRuntime<'conversation.input.dock'>
  & InjectFace<InputSettingsControlInjected>
  & PropsLocale<'codex'>

type CodexActivityReader = (key: 'codexActivity') => CodexActivity | null | undefined
type ActivityFallback = ReturnType<typeof modelActivity>

function elapsedSeconds(startedAt: number, now: number): number {
  return Math.max(0, Math.floor((now - startedAt) / 1_000))
}

/** Prefer the session snapshot when a projection has not emitted an open phase yet. */
export function resolveActivity(
  projectedActivity: CodexActivity | null | undefined,
  fallbackActivity: ActivityFallback,
): CodexActivity | null {
  if (projectedActivity === null) return fallbackActivity ?? null
  return projectedActivity ?? fallbackActivity ?? null
}

export function ActivityLine({
  sessionId: _sessionId, useSession, useSessions: _useSessions, useProjection, useSettings, t,
}: ActivityProps) {
  const settings = useSettings(state => state as { value?: CodexSettings })
  const enabled = settings.value?.activityIndicatorEnabled ?? true
  const projectedActivity = (useProjection as unknown as CodexActivityReader)('codexActivity')
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
        boxSizing: 'border-box',
        display: 'flex',
        alignItems: 'center',
        flex: 'none',
        gap: 6,
        width: 'calc(100% - 2 * var(--dsh-composer-side-clearance, 16px) - 4 * var(--dsh-composer-dock-inset, 8px))',
        maxWidth: 'calc(var(--dsh-composer-card-max-width, 952px) - 4 * var(--dsh-composer-dock-inset, 8px))',
        minWidth: 0,
        minHeight: 22,
        margin: '0 auto',
        padding: '0 4px',
        color: 'var(--dsw-alias-label-secondary)',
        fontSize: 12,
        lineHeight: '20px',
        whiteSpace: 'nowrap',
        pointerEvents: 'none',
      }}
    >
      <span
        aria-hidden="true"
        style={{
          width: 5,
          height: 5,
          flex: '0 0 auto',
          borderRadius: '50%',
          background: 'var(--dsw-alias-brand-primary)',
          opacity: 0.55,
        }}
      />
      <span style={{ minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis' }}>{label}</span>
      <span aria-hidden="true" style={{ flex: '0 0 auto', fontVariantNumeric: 'tabular-nums' }}>
        {'\u00b7'} {elapsedSeconds(activity.startedAt, now)}s
      </span>
    </span>
  )
}

function createPresetManager(ctx: Context): PresetManagerActions {
  const remote = (ctx as unknown as { remote?: TypertClientRemote }).remote
  const ready: Promise<void> = remote === undefined
    ? Promise.resolve()
    : remote.$mount(presetEditorRemote).then(dispose => {
      ctx.effect(() => () => { void dispose() }, 'codex client: preset editor remote')
    })
  void ready.catch(() => {})
  return {
    remote: remote as unknown as PresetClientRemote,
    ready,
  }
}

/** Mount request controls and the plugin settings card through shared slots. */
export interface ClientSettingsApi {
  bind(ctx: Context): CodexScope
  getCodexConnectScope?: () => CodexConnectScope | undefined
  register(ctx: Context, settings: CodexScope, manager: PresetManagerActions): () => void
}

export function applyWithSettingsApi(ctx: Context, api: ClientSettingsApi): void {
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
      onSelect: (option, session) => {
        const live = sessionFor(session)
        if (live === undefined) throw new Error('this session is not materialized yet')
        void live.command(`/compact ${option.id}`).then(result => {
          if (!result.ok) {
            notifyCompactError(sessions, session.sessionId, `compact failed: ${result.error.code}: ${result.error.message}`)
            return
          }
          if (!result.value.matched) {
            notifyCompactError(sessions, session.sessionId, 'the host offers no /compact command')
          }
        }, error => {
          notifyCompactError(sessions, session.sessionId, error instanceof Error ? error.message : String(error))
        })
      },
    },
  }), 'codex client: /compact mode picker')
  const settings = api.bind(ctx)
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
    inject: (sessionId?: unknown) => ({
      ...injected(),
      getCodexConnectScope: api.getCodexConnectScope,
      modelDirectory: sessionId === undefined
        ? undefined
        : ((ctx as unknown as { get(key: string): ModelDirectoriesService | undefined }).get('modelDirectories'))?.directoryFor(sessionId)?.store,
    }),
  }, ComposerControls))
  ctx.slots.inject('conversation.input.dock', () => ctx.slots.register({
    name: 'conversation.input.dock',
    id: 'codex-activity',
    order: -100,
    locale: NS,
    inject: injected,
  }, ActivityLine))
  ctx.inject(
    ['remote', 'remote.codexPresetEditor'],
    settingsCtx => api.register(settingsCtx, settings, presetManager),
  )
}
