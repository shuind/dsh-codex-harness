/** User-selectable Codex context controls use whole K-token units. */
export const CODEX_CONTEXT_UNIT = 1_000
export const CODEX_CONTEXT_MAX = 1_000_000
export const CODEX_PRESET_ID = 'codex'
export const CODEX_COLLABORATION_PRESET_ID = 'codex-collaboration'

const CODEX_PRESET_IDS = new Set([
  CODEX_PRESET_ID,
  CODEX_COLLABORATION_PRESET_ID,
])

/** Both shipped presets use the same Codex request controls in Web. */
export function isCodexPresetId(value: string | undefined): boolean {
  return value !== undefined && CODEX_PRESET_IDS.has(value)
}
