/** Browser-safe shared constants, activity shapes, and read-only preset contracts. */

/** User-selectable Codex context controls use whole K-token units. */
export const CODEX_CONTEXT_UNIT = 1_000
export const CODEX_CONTEXT_MIN = 16_000
export const CODEX_CONTEXT_MAX = 1_000_000
export const OPENAI_CODEX_PROVIDER = 'openai-codex'
export const OPENAI_CODEX_SETTINGS_NAMESPACE = 'llm-openai-codex'
export const OPENAI_CODEX_MODEL_CATALOG_PATH = '/plugins/dsh-codex-connect/models'

export interface ContextWindowBounds {
  readonly defaultTokens?: number
  readonly maxTokens: number
}

export const OPENAI_CODEX_MODEL_LIMITS: Readonly<Record<string, { readonly defaultTokens: number; readonly maxTokens: number }>> = {
  'gpt-6.1-sol': { defaultTokens: 500_000, maxTokens: 872_000 },
  'gpt-6.1-terra': { defaultTokens: 500_000, maxTokens: 872_000 },
  'gpt-6-astra': { defaultTokens: 272_000, maxTokens: 872_000 },
  'gpt-6-sol': { defaultTokens: 272_000, maxTokens: 872_000 },
  'gpt-6-luna': { defaultTokens: 272_000, maxTokens: 872_000 },
  'gpt-5.6-sol': { defaultTokens: 272_000, maxTokens: 872_000 },
  'gpt-5.6-terra': { defaultTokens: 272_000, maxTokens: 872_000 },
  'gpt-5.6-luna': { defaultTokens: 272_000, maxTokens: 872_000 },
  'gpt-5.4': { defaultTokens: 272_000, maxTokens: 1_000_000 },
  'gpt-5.5': { defaultTokens: 272_000, maxTokens: 272_000 },
  'gpt-5.4-mini': { defaultTokens: 272_000, maxTokens: 272_000 },
}

const CONTEXT_PRESET_TIERS: readonly number[] = [64_000, 128_000, 200_000, 272_000, 400_000, 500_000, 872_000, 1_000_000]

export function resolveContextWindowBounds(
  provider: string | undefined,
  model: string | undefined,
  dynamicCatalog?: Readonly<Record<string, { readonly defaultTokens: number; readonly maxTokens: number }>>,
): ContextWindowBounds {
  if (provider === OPENAI_CODEX_PROVIDER) {
    return (model !== undefined ? dynamicCatalog?.[model] ?? OPENAI_CODEX_MODEL_LIMITS[model] : undefined)
      ?? { defaultTokens: 272_000, maxTokens: 272_000 }
  }
  return { maxTokens: CODEX_CONTEXT_MAX }
}

export function formatCompactTokens(tokens: number): string {
  if (tokens >= 1_000) {
    return tokens % 1_000 === 0
      ? `${tokens / 1_000}k`
      : `${(tokens / 1_000).toFixed(1).replace(/\.0$/, '')}k`
  }
  return `${tokens}`
}

export function contextPresetsForBounds(bounds: ContextWindowBounds): number[] {
  const filtered = CONTEXT_PRESET_TIERS.filter(v => v <= bounds.maxTokens && v !== bounds.defaultTokens)
  if (bounds.maxTokens > 0 && bounds.maxTokens !== bounds.defaultTokens && !filtered.includes(bounds.maxTokens)) {
    filtered.push(bounds.maxTokens)
  }
  return filtered.sort((a, b) => a - b)
}

export function parseCustomContextInput(raw: string, maxTokens: number): number | undefined {
  const trimmed = raw.trim()
  if (trimmed.length === 0) return undefined
  const match = /^(\d+(?:\.\d+)?)\s*(k)?$/i.exec(trimmed)
  if (match === null) return undefined
  const num = Number(match[1])
  if (!Number.isFinite(num) || num <= 0) return undefined
  const tokens = match[2] !== undefined
    ? Math.round(num * CODEX_CONTEXT_UNIT)
    : Number.isSafeInteger(num) && num > Math.floor(maxTokens / CODEX_CONTEXT_UNIT) && num <= maxTokens
      ? num
      : Math.round(num * CODEX_CONTEXT_UNIT)
  return Number.isSafeInteger(tokens) && tokens >= Math.min(CODEX_CONTEXT_MIN, maxTokens) && tokens <= maxTokens ? tokens : undefined
}

export function nextOpenAICodexOverrides(
  currentValue: Readonly<Record<string, unknown>> | undefined,
  baseValue: Readonly<Record<string, unknown>> | undefined,
  modelId: string,
  tokens: number | undefined,
): Record<string, number | null> | undefined {
  const next: Record<string, number | null> = {}
  if (currentValue !== undefined) {
    for (const [id, value] of Object.entries(currentValue)) {
      if (id.length > 0 && id.trim() === id && (value === null || (typeof value === 'number' && Number.isSafeInteger(value) && value > 0))) {
        next[id] = value
      }
    }
  }
  if (tokens !== undefined) {
    next[modelId] = tokens
    return next
  }
  if (typeof baseValue?.[modelId] === 'number') next[modelId] = null
  else delete next[modelId]
  return Object.keys(next).length === 0 ? undefined : next
}

/** Pure client/host-shared type for the Codex activity projection value. */
export type CodexActivity = {
  activity: 'compaction' | 'requesting-model' | 'model-reply'
  startedAt: number
}

/** Client-safe read-only preset catalog and definition types for Harness 0.2.2+. */
export interface PresetCatalogRow {
  readonly id: string
  readonly name: string
  readonly description: string
  readonly isDefault: boolean
}

export interface PresetCatalog {
  readonly presets: readonly PresetCatalogRow[]
  readonly excludedCount: number
}

export interface PresetDefinitionDocument {
  readonly id: string
  readonly name: string
  readonly description: string
  readonly composition: string
}

/** Client-safe current-preset prompt catalog; editable targets have reviewed native contracts. */
export const PRESET_PROMPT_NAMES = ['deployment:persona-prefix', 'deployment:persona-suffix', 'codex:base'] as const
export type PresetPromptName = typeof PRESET_PROMPT_NAMES[number]

export interface PresetPromptOverride {
  readonly name: PresetPromptName
  readonly text: string
}

export interface PresetPromptEntry {
  readonly name: string
  readonly label: string
  readonly text: string
  readonly editable: boolean
  readonly order?: number
  readonly complete?: boolean
  readonly interpolate?: boolean
  readonly reason?: string
}

export interface ModelDirectorySnapshot {
  readonly status?: string
  readonly current?: { readonly provider?: string; readonly model?: string } | undefined
}

export interface ModelDirectoryStore {
  subscribe(listener: () => void): () => void
  getSnapshot(): ModelDirectorySnapshot | undefined
}

export interface CodexConnectSnapshot {
  readonly status: string
  readonly writable: boolean
  readonly overrides?: Readonly<Record<string, number | null>> | undefined
  readonly baseOverrides?: Readonly<Record<string, number | null>> | undefined
  readonly nativeCompaction?: boolean | undefined
}

export interface CodexConnectScope {
  getSnapshot(): CodexConnectSnapshot
  subscribe(listener: () => void): () => void
  setModelOverride(modelId: string, tokens: number | undefined): Promise<void>
  setNativeCompaction?(enabled: boolean): Promise<void>
}

export interface PresetPromptCatalog {
  readonly preset: string
  readonly sections: readonly PresetPromptEntry[]
}
