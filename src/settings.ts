/** Shared host-side Codex settings contract. */

import z from '@deepseek-ai/schemastery'
import { settingsNamespace } from '@deepseek-ai/dsh-settings'
import { CODEX_CONTEXT_MAX } from './context.ts'
import {
  DEFAULT_CODEX_PERSONA,
  DEFAULT_CODEX_SYSTEM_PROMPT,
  DEFAULT_DSH_CORE_SOURCE_PROMPT,
  DEFAULT_DSH_CORE_WEB_PROMPT,
} from './prompt.ts'

/** Live Codex controls shared by the Web UI and agent layer. */
export const CODEX_SETTINGS_NAMESPACE = settingsNamespace('codex')

export interface CodexSettings {
  /** Use the Responses priority service tier for GPT requests. */
  fast: boolean
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
  /** Expose exec_command and write_stdin. */
  terminalToolsEnabled: boolean
  /** Expose apply_patch. */
  patchToolEnabled: boolean
  /** Expose update_plan. */
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
  contextWindow: z.number().step(1).min(1).max(CODEX_CONTEXT_MAX),
  persona: z.string().default(DEFAULT_CODEX_PERSONA),
  harnessSourcePrompt: z.string().default(DEFAULT_DSH_CORE_SOURCE_PROMPT),
  webSurfacePrompt: z.string().default(DEFAULT_DSH_CORE_WEB_PROMPT),
  systemPrompt: z.string().default(DEFAULT_CODEX_SYSTEM_PROMPT),
  promptEnabled: z.boolean().default(true),
  terminalToolsEnabled: z.boolean().default(true),
  patchToolEnabled: z.boolean().default(true),
  planToolEnabled: z.boolean().default(true),
  hostedWebSearchEnabled: z.boolean().default(true),
  remoteCompactionEnabled: z.boolean().default(true),
  activityIndicatorEnabled: z.boolean().default(true),
})
