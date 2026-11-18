import {
  buildPresetEditorDescriptors,
  PRESET_EDITOR_PACKAGE,
  PRESET_EDITOR_SERVICE,
} from '../contracts/preset-editor-schema.ts'

/** Host-side Remote contract consumed by the browser's preset inspector. */
export const TYPERT = {
  package: PRESET_EDITOR_PACKAGE,
  face: 'host' as const,
  schemas: [],
  invocations: buildPresetEditorDescriptors(),
  model: {
    services: [{
      description: 'Inspect DSH agent presets, registered tools, and prompt sections.',
      summary: 'Codex preset inspector.',
      tags: [],
      jsDoc: '',
      key: PRESET_EDITOR_SERVICE,
      exportName: 'CodexPresetEditor',
      members: [],
      types: [],
    }],
    events: [],
    objects: [],
  },
}

export default TYPERT
