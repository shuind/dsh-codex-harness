import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { parseDocument } from 'yaml'

export interface DesktopPresetRow {
  id: string
  name: string
  group?: boolean
  disabled?: boolean | { __jsExpr: string }
  config?: Record<string, unknown> | DesktopPresetRow[]
  isolate?: Record<string, boolean>
}

export interface DesktopPresetDefinition {
  id: string
  name?: string
  description?: string
  order?: number
  plugins: DesktopPresetRow[]
}

/** Keep expressions literal for the Desktop Loader, not YAML strings or eager eval. */
function readYaml(path: string): unknown {
  const document = parseDocument(readFileSync(path, 'utf8'), {
    customTags: [{
      tag: 'tag:yaml.org,2002:js',
      resolve: (expression: string) => ({ __jsExpr: expression }),
    }],
  })
  if (document.errors.length) throw document.errors[0]
  return document.toJS()
}

/** Convert the legacy file composition to Harness 0.2.2's declarative preset APIs. */
export function desktopCodexPreset(sourceDirectory: string, id = 'codex-hybrid'): DesktopPresetDefinition {
  const metadata = readYaml(join(sourceDirectory, 'preset.yml')) as Omit<DesktopPresetDefinition, 'id' | 'plugins'>
  const plugins = readYaml(join(sourceDirectory, 'agent.cordis.yml')) as DesktopPresetRow[]
  function adapt(rows: DesktopPresetRow[]): DesktopPresetRow[] {
    // Child discovery now belongs to the control plugin's root export.
    return rows.filter(row => row.name !== '@deepseek-ai/dsh-tool-subagent-control/list-agents').map(row => {
      if (row.name === '@deepseek-ai/dsh-workflow-worker-thread') {
        row.name = '@deepseek-ai/dsh-workflow-ptc'
      }
      if (row.name === '@deepseek-ai/dsh-tool-subagent' && row.config && !Array.isArray(row.config)) {
        const { modelSelectionSettings, backgroundMode: _backgroundMode, ...config } = row.config
        row.config = modelSelectionSettings === undefined ? config : {
          ...config, modelSelection: modelSelectionSettings, modelDiscovery: modelSelectionSettings,
        }
      }
      if (row.group && Array.isArray(row.config)) row.config = adapt(row.config)
      return row
    })
  }
  return { ...metadata, id, plugins: adapt(plugins) }
}

/** Build the experimental asymmetric hybrid Codex preset declaration. */
export function desktopCodexHybridPreset(sourceDirectory: string): DesktopPresetDefinition {
  return desktopCodexPreset(sourceDirectory, 'codex-hybrid')
}
