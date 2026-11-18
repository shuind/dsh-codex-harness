/** Shared host-side Codex settings contract, Host reader, and GPT route matcher. */

import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type { SettingsNamespace } from '@deepseek-ai/dsh-settings'
import { CODEX_CONTEXT_MAX } from './ui-contracts.ts'
import {
  DEFAULT_CODEX_PERSONA,
  DEFAULT_CODEX_SYSTEM_PROMPT,
  DEFAULT_DSH_CORE_SOURCE_PROMPT,
  DEFAULT_DSH_CORE_WEB_PROMPT,
} from './prompt.ts'

/** Live Codex controls shared by the Web UI and agent layer. */
export const CODEX_SETTINGS_NAMESPACE = 'codex' as SettingsNamespace

export interface CodexSettings {
  /** Use the Responses priority service tier for GPT requests. */
  fast: boolean
  /** Show the Fast mode switch in the conversation composer. */
  fastModeControlEnabled: boolean
  /** Show the quick context-window control in the conversation composer. */
  contextWindowControlEnabled: boolean
  /** Optional context capacity override, in tokens. */
  contextWindow?: number
  /** Deployment Persona template; supports the host's prompt variables. */
  persona?: string
  /** DSH Core source-checkout guidance template. */
  harnessSourcePrompt?: string
  /** DSH Core Web GUI guidance template. */
  webSurfacePrompt?: string
  /** Complete plugin-owned Codex operating prompt. */
  systemPrompt?: string
  /** Inject the plugin-owned Codex operating prompt. */
  promptEnabled: boolean
  /** Deprecated compatibility baseline, snapshotted into future Agent tool plans. */
  terminalToolsEnabled: boolean
  /** Deprecated tool baseline; also retains the legacy JSON/custom wire-format preference. */
  patchToolEnabled: boolean
  /** Deprecated compatibility baseline, not a live veto of a compiled plan. */
  planToolEnabled: boolean
  /** Upgrade local web_search declarations to the hosted Responses tool. */
  hostedWebSearchEnabled: boolean
  /** Prefer the provider's Responses compact endpoint. */
  remoteCompactionEnabled: boolean
  /** Show the Codex request/compaction activity indicator. */
  activityIndicatorEnabled: boolean
}

/** Default settings exposed even before a Codex session is opened. */
export const CODEX_SETTINGS_ENTRY: CodexSettings = {
  fast: false,
  fastModeControlEnabled: true,
  contextWindowControlEnabled: true,
  persona: DEFAULT_CODEX_PERSONA,
  harnessSourcePrompt: DEFAULT_DSH_CORE_SOURCE_PROMPT,
  webSurfacePrompt: DEFAULT_DSH_CORE_WEB_PROMPT,
  systemPrompt: DEFAULT_CODEX_SYSTEM_PROMPT,
  promptEnabled: true,
  terminalToolsEnabled: true,
  patchToolEnabled: true,
  planToolEnabled: true,
  hostedWebSearchEnabled: true,
  remoteCompactionEnabled: true,
  activityIndicatorEnabled: true,
}

export const CODEX_SETTINGS_SCHEMA: z<CodexSettings> = z.object({
  fast: z.boolean().default(false),
  fastModeControlEnabled: z.boolean().default(true),
  contextWindowControlEnabled: z.boolean().default(true),
  contextWindow: z.number().step(1).min(1).max(CODEX_CONTEXT_MAX).hidden(),
  persona: z.string().default(DEFAULT_CODEX_PERSONA),
  harnessSourcePrompt: z.string().default(DEFAULT_DSH_CORE_SOURCE_PROMPT),
  webSurfacePrompt: z.string().default(DEFAULT_DSH_CORE_WEB_PROMPT),
  systemPrompt: z.string().default(DEFAULT_CODEX_SYSTEM_PROMPT),
  promptEnabled: z.boolean().default(true),
  terminalToolsEnabled: z.boolean().default(true).hidden(),
  patchToolEnabled: z.boolean().default(true).hidden(),
  planToolEnabled: z.boolean().default(true).hidden(),
  hostedWebSearchEnabled: z.boolean().default(true),
  remoteCompactionEnabled: z.boolean().default(true),
  activityIndicatorEnabled: z.boolean().default(true),
})

interface SettingsReader {
  describe?: () => Array<{ ns: string; value: unknown }>
}

/** Host-only reads: never expose the unredacted provider configuration to clients. */
export function readHostSettings<T>(ctx: Context, namespace: string): T | undefined {
  if (namespace === 'codex') {
    const preferences = ctx.get('codexPreferences') as { current(): T } | undefined
    if (preferences !== undefined) return preferences.current()
  }
  const settings = ctx.get('settings') as SettingsReader | undefined
  return settings?.describe?.().find(row => row.ns === namespace)?.value as T | undefined
}

/** Match GPT / ChatGPT model ids that consume Codex wire & capacity extensions. */
export function isGptModel(model: unknown): model is string {
  return typeof model === 'string' && /(?:^|\/)(?:gpt|chatgpt)(?:[-_.]|\d|$)/i.test(model)
}
