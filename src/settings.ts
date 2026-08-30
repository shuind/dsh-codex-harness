/** Shared host-side Codex settings contract. */

import z from '@deepseek-ai/schemastery'
import { settingsNamespace } from '@deepseek-ai/dsh-settings'
import { CODEX_CONTEXT_MAX } from './context.ts'
import { DEFAULT_CODEX_SYSTEM_PROMPT } from './prompt.ts'

/** Live Codex controls shared by the Web UI and agent layer. */
export const CODEX_SETTINGS_NAMESPACE = settingsNamespace('codex')

export interface CodexSettings {
  /** Use the Responses priority service tier for GPT requests. */
  fast: boolean
  /** Optional context capacity override, in tokens. */
  contextWindow?: number
  /** Complete plugin-owned Codex operating prompt. */
  systemPrompt?: string
}

/** Default settings exposed even before a Codex session is opened. */
export const CODEX_SETTINGS_ENTRY: CodexSettings = {
  fast: false,
  systemPrompt: DEFAULT_CODEX_SYSTEM_PROMPT,
}

export const CODEX_SETTINGS_SCHEMA: z<CodexSettings> = z.object({
  fast: z.boolean().default(false),
  contextWindow: z.number().step(1).min(1).max(CODEX_CONTEXT_MAX),
  systemPrompt: z.string().default(DEFAULT_CODEX_SYSTEM_PROMPT),
})
