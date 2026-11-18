/** Read-only Host Remote service for inspecting declarative agent presets. */
import type { Context } from '@deepseek-ai/cordis'
import { Remote, TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol'
import type { PresetCatalog, PresetDefinitionDocument, PresetPromptCatalog } from '../contracts/ui-contracts.ts'
import { PRESET_EDITOR_SERVICE } from '../contracts/preset-editor-schema.ts'
import type { PresetToolCatalog } from '../contracts/tool-policy-contract.ts'
import { readPresetPromptCatalog } from './preset-prompt-catalog.ts'
import { readPresetToolCatalog } from './preset-tool-catalog.ts'

export type { PresetDefinitionDocument } from '../contracts/ui-contracts.ts'

export interface AgentPresetsForEditor {
  readonly defaultId?: string
  list?(): Promise<Array<{ id: string; name?: string; description?: string; broken?: string }>>
  remoteExportList?(): Promise<{ presets: Array<{ id: string; name?: string; description?: string; isDefault: boolean; broken?: string }> }>
  resolve(id: string): Promise<{ id: string; name?: string; description?: string; broken?: string }>
  readDocument(id: string): Promise<{ content: string; name?: string; description?: string }>
}

export class CodexPresetEditor extends TypertRemoteService {
  static inject = ['agentPresets']
  private readonly agentPresets: AgentPresetsForEditor
  private readonly toolContext: Context

  constructor(ctx: Context, _config?: undefined) {
    super(ctx, PRESET_EDITOR_SERVICE)
    this.toolContext = ctx
    this.agentPresets = ctx.get('agentPresets') as unknown as AgentPresetsForEditor
  }

  async catalog(): Promise<PresetCatalog> {
    if (this.agentPresets.remoteExportList !== undefined) {
      const roster = await this.agentPresets.remoteExportList()
      const presets = roster.presets
        .filter(row => row.broken === undefined)
        .map(row => ({
          id: row.id,
          name: row.name || row.id,
          description: row.description ?? '',
          isDefault: row.isDefault,
        }))
      return { presets, excludedCount: roster.presets.length - presets.length }
    }
    if (this.agentPresets.list !== undefined) {
      const rows = await this.agentPresets.list()
      const presets = rows
        .filter(row => row.broken === undefined)
        .map(row => ({
          id: row.id,
          name: row.name || row.id,
          description: row.description ?? '',
          isDefault: row.id === this.agentPresets.defaultId,
        }))
      return { presets, excludedCount: rows.length - presets.length }
    }
    throw new Error('preset-catalog-unavailable')
  }

  async tools(id: string): Promise<PresetToolCatalog> {
    return readPresetToolCatalog(this.toolContext, id)
  }

  async prompts(id: string): Promise<PresetPromptCatalog> {
    return readPresetPromptCatalog(this.toolContext, id)
  }

  async read(id: string): Promise<PresetDefinitionDocument> {
    if (typeof id !== 'string' || !id.trim() || id.length > 256) throw new Error('invalid-preset-id')
    const resolved = await this.agentPresets.resolve(id)
    if (resolved.broken !== undefined) throw new Error('invalid-preset')
    const doc = await this.agentPresets.readDocument(id)
    return {
      id,
      name: doc.name || resolved.name || id,
      description: doc.description ?? resolved.description ?? '',
      composition: doc.content,
    }
  }
}

// Same decorator registration as the host, consumable by the Vitest transform.
function markRemoteMethod(methodName: 'catalog' | 'tools' | 'prompts' | 'read'): void {
  const descriptor = Object.getOwnPropertyDescriptor(CodexPresetEditor.prototype, methodName)!
  const initializers: Array<(this: object) => void> = []
  const decorator = Remote(methodName) as unknown as (method: unknown, context: {
    kind: 'method'; name: string; static: false; private: false; addInitializer(initializer: (this: object) => void): void
  }) => void
  decorator(descriptor.value, {
    kind: 'method',
    name: methodName,
    static: false,
    private: false,
    addInitializer: initializer => { initializers.push(initializer) },
  })
  const receiver = Object.create(CodexPresetEditor.prototype) as object
  for (const initializer of initializers) initializer.call(receiver)
}

for (const method of ['catalog', 'tools', 'prompts', 'read'] as const) markRemoteMethod(method)

export default CodexPresetEditor
