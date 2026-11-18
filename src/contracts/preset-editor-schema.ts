/** Shared wire codecs and RPC descriptors for Host/Client preset inspection. */
import { z } from 'zod'
import type { InvocationDescriptor, TypertRemoteContribution } from '@deepseek-ai/dsh-typert-protocol'

export const PRESET_EDITOR_PACKAGE = '@shuind/dsh-codex-harness'
export const PRESET_EDITOR_SERVICE = 'codexPresetEditor'

export const presetIdSchema = z.string().min(1).max(256)

export const presetCatalogSchema = z.object({
  presets: z.array(z.object({
    id: z.string(),
    name: z.string(),
    description: z.string(),
    isDefault: z.boolean(),
  })),
  excludedCount: z.number(),
})

export const presetDefinitionSchema = z.object({
  id: z.string(),
  name: z.string(),
  description: z.string(),
  composition: z.string(),
})

export const presetToolCatalogSchema = z.object({
  preset: z.string(),
  registeredOnly: z.literal(true),
  legacyCapabilities: z.object({
    terminalToolsEnabled: z.boolean().optional(),
    planToolEnabled: z.boolean().optional(),
    patchToolEnabled: z.boolean().optional(),
  }).optional(),
  tools: z.array(z.object({
    name: z.string(),
    description: z.string(),
    conditional: z.boolean(),
    defaultDeferred: z.boolean().optional(),
    codexTool: z.object({
      capability: z.enum(['terminalToolsEnabled', 'planToolEnabled', 'patchToolEnabled']),
      presetEnabled: z.boolean(),
      presetOverridesLegacy: z.boolean().optional(),
    }).optional(),
    replacements: z.array(z.object({
      action: z.enum(['codex-exec', 'codex-plan', 'codex-patch']),
      tools: z.array(z.string()),
      available: z.boolean(),
      reason: z.enum(['conditional', 'target-exists']).optional(),
    })),
  })),
})

export const presetPromptCatalogSchema = z.object({
  preset: z.string(),
  sections: z.array(z.object({
    name: z.string(),
    label: z.string(),
    text: z.string().max(1_000_000),
    editable: z.boolean(),
    order: z.number().finite().optional(),
    complete: z.boolean().optional(),
    interpolate: z.boolean().optional(),
    reason: z.string().optional(),
  })).max(200),
})

function descriptor(
  method: string,
  parameter: string | undefined,
  input: z.ZodType,
  output: z.ZodType,
): InvocationDescriptor {
  const id = `${PRESET_EDITOR_PACKAGE}#${PRESET_EDITOR_SERVICE}/${method}`
  const strictCodec = (typeSymbol: string, schema: z.ZodType) => ({
    mode: 'strict' as const,
    typeSymbol,
    create: () => schema,
  })
  return {
    id,
    service: PRESET_EDITOR_SERVICE,
    namespace: PRESET_EDITOR_SERVICE,
    method,
    invocation: { kind: 'direct' as const },
    parameters: parameter === undefined ? [] : [{
      name: parameter,
      wire: parameter,
      source: 'json' as const,
      codec: strictCodec(`${id}:${parameter}`, input),
    }],
    result: strictCodec(`${id}:result`, output),
  }
}

export function buildPresetEditorDescriptors(): readonly InvocationDescriptor[] {
  return [
    descriptor('catalog', undefined, z.unknown(), presetCatalogSchema),
    descriptor('tools', 'id', presetIdSchema, presetToolCatalogSchema),
    descriptor('prompts', 'id', presetIdSchema, presetPromptCatalogSchema),
    descriptor('read', 'id', presetIdSchema, presetDefinitionSchema),
  ]
}

export const presetEditorRemote = {
  package: PRESET_EDITOR_PACKAGE,
  descriptors: buildPresetEditorDescriptors(),
} satisfies TypertRemoteContribution

export default presetEditorRemote
