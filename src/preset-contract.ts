/** Client-safe, versioned preset authoring contract. No filesystem or runtime imports. */
export interface PresetFields {
  name: string
  description: string
  systemPrompt: string
  inheritPrompt: boolean
}
export interface PresetPromptSection {
  id: string
  label: string
  text: string
  editable: boolean
  /** Excluded by a complete Persona; shown for inspection, never saved as an active section. */
  suppressed?: boolean
}
/** Codex capabilities stored with a preset. Activity status stays global. */
export interface CodexPresetOptions {
  promptEnabled: boolean
  terminalToolsEnabled: boolean
  patchToolEnabled: boolean
  planToolEnabled: boolean
  hostedWebSearchEnabled: boolean
  remoteCompactionEnabled: boolean
}
export interface PresetEditorDocument extends PresetFields {
  id: string
  revision: string
  editable: boolean
  codex: boolean
  codexOptions: CodexPresetOptions
  composition: string
  promptSections: PresetPromptSection[]
}
export interface PresetEditorInput extends PresetFields {
  id: string
  revision?: string
  composition?: string
  enableCodex?: boolean
  promptSections?: PresetPromptSection[]
  codexOptions?: Partial<CodexPresetOptions>
}
export interface PresetCreateInput extends PresetFields {
  sourceId: string
  enableCodex?: boolean
  promptSections?: PresetPromptSection[]
  composition?: string
  codexOptions?: Partial<CodexPresetOptions>
}
export interface PresetCatalogRow {
  id: string
  name: string
  description: string
  editable: boolean
  isDefault: boolean
  codex?: boolean
}
export interface PresetCatalog {
  presets: PresetCatalogRow[]
  authorable: boolean
  excludedCount: number
}

/** A portable instruction card, deliberately not executable YAML or a tool bundle. */
export interface PromptCard extends PresetFields {
  format: 'codex-harness/prompt-card'
  version: 1
}
export function parsePromptCard(text: string): PromptCard {
  if (text.length > 1_100_000) throw new Error('invalid-prompt-card')
  const value: unknown = JSON.parse(text)
  if (!value || typeof value !== 'object') throw new Error('invalid-prompt-card')
  const card = value as Record<string, unknown>
  if (card.format !== 'codex-harness/prompt-card' || card.version !== 1
    || typeof card.name !== 'string' || !card.name.trim() || card.name.length > 200
    || typeof card.description !== 'string' || card.description.length > 4000
    || typeof card.systemPrompt !== 'string' || card.systemPrompt.length > 1_000_000
    || typeof card.inheritPrompt !== 'boolean') throw new Error('invalid-prompt-card')
  return { format: card.format, version: 1, name: card.name, description: card.description,
    systemPrompt: card.systemPrompt, inheritPrompt: card.inheritPrompt }
}
export function exportPromptCard(fields: PresetFields): string {
  return JSON.stringify({ format: 'codex-harness/prompt-card', version: 1,
    name: fields.name, description: fields.description, systemPrompt: fields.systemPrompt,
    inheritPrompt: fields.inheritPrompt }, null, 2)
}
