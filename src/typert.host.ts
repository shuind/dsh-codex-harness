import { z } from 'zod'

const PACKAGE = '@shuind/dsh-codex-harness'
const SERVICE = 'codexPresetEditor'

const promptSections = z.array(z.object({ id: z.string(), label: z.string(), text: z.string().max(1_000_000), editable: z.boolean(), suppressed: z.boolean().optional() })).max(200)
const fields = {
  name: z.string().max(200),
  description: z.string().max(4000),
  systemPrompt: z.string().max(1_000_000),
  inheritPrompt: z.boolean(),
}
const codexOptions = z.object({
  promptEnabled: z.boolean(),
  terminalToolsEnabled: z.boolean(),
  patchToolEnabled: z.boolean(),
  planToolEnabled: z.boolean(),
  hostedWebSearchEnabled: z.boolean(),
  remoteCompactionEnabled: z.boolean(),
})
const document = z.object({
  ...fields,
  id: z.string(),
  revision: z.string(),
  editable: z.boolean(),
  codex: z.boolean(),
  codexOptions,
  promptSections, composition: z.string(),
})
const catalog = z.object({
  presets: z.array(z.object({
    id: z.string(),
    name: z.string(),
    description: z.string(),
    editable: z.boolean(),
    isDefault: z.boolean(),
  })),
  authorable: z.boolean(),
  excludedCount: z.number(),
})
const codexOptionsPatch = codexOptions.partial()

function descriptor(
  method: string,
  parameter: string | undefined,
  input: z.ZodType,
  output: z.ZodType,
) {
  const id = `${PACKAGE}#${SERVICE}/${method}`
  return {
    id,
    service: SERVICE,
    namespace: SERVICE,
    method,
    invocation: { kind: 'direct' as const },
    parameters: parameter === undefined ? [] : [{
      name: parameter,
      wire: parameter,
      source: 'json' as const,
      codec: { mode: 'strict' as const, typeSymbol: `${id}:${parameter}`, schema: input },
    }],
    result: { mode: 'strict' as const, typeSymbol: `${id}:result`, schema: output },
  }
}

const updateInput = z.object({
  ...fields,
  id: z.string(),
  revision: z.string().optional(),
  composition: z.string().max(1_000_000).optional(),
  enableCodex: z.boolean().optional(),
  promptSections: promptSections.optional(), codexOptions: codexOptionsPatch.optional(),
})
const createInput = z.object({
  ...fields,
  sourceId: z.string(),
  enableCodex: z.boolean().optional(),
  composition: z.string().max(1_000_000).optional(),
  promptSections: promptSections.optional(), codexOptions: codexOptionsPatch.optional(),
})

/** Host-side Remote contract consumed by the browser's preset editor. */
export const TYPERT = {
  package: PACKAGE,
  face: 'host' as const,
  schemas: [],
  invocations: [
    descriptor('catalog', undefined, z.unknown(), catalog),
    descriptor('read', 'id', z.string(), document),
    descriptor('update', 'rawInput', updateInput, document),
    descriptor('create', 'rawInput', createInput, document),
  ],
  model: {
    services: [{
      description: 'Author and inspect DSH agent presets with Codex capabilities.',
      summary: 'Codex preset editor.',
      tags: [],
      jsDoc: '',
      key: SERVICE,
      exportName: 'CodexPresetEditor',
      members: [],
      types: [],
    }],
    events: [],
    objects: [],
  },
}

export default TYPERT
