/** Read-only capability inventory for a preset; never creates an Agent or evaluates `when`. */
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-agent-preset-registry'
import type {} from '@deepseek-ai/dsh-tools'
import { createScope } from '@deepseek-ai/dsh-scope'
import type { Scope } from '@deepseek-ai/dsh-scope'
import type { PresetToolCatalog, PresetToolReplacement } from '../contracts/tool-policy-contract.ts'
import { codexToolMetadata, readLegacyCapabilities } from '../policy/tool-capabilities.ts'
import { readDefaultDeferredTools, readDefaultHiddenTools } from '../policy/deferred-tools.ts'

export async function readPresetToolCatalog(ctx: Context, preset: string): Promise<PresetToolCatalog> {
  if (typeof preset !== 'string' || !preset.trim() || preset.length > 256) throw new Error('invalid-preset-id')
  const registry = ctx.get('agentPresets')
  const tools = ctx.get('tools')
  if (registry === undefined || typeof registry.acquireScope !== 'function' || tools === undefined) {
    throw new Error('preset-tool-catalog-unavailable')
  }
  const lease = await registry.acquireScope(preset)
  let view: Scope | undefined
  try {
    // A child view applies inherited masks exactly as an Agent would, but has no
    // Agent driver, session, model selection, or initialization callbacks.
    const key = {}
    view = createScope(ctx, key, { parent: lease.key })
    const defaultHidden = readDefaultHiddenTools(view.ctx, key)
    const definitions = tools.definitions(key).filter(tool => !defaultHidden?.has(tool.name))
    const names = new Set(definitions.map(tool => tool.name))
    const defaultDeferred = readDefaultDeferredTools(view.ctx, key)
    return {
      preset,
      registeredOnly: true,
      legacyCapabilities: readLegacyCapabilities(ctx),
      tools: definitions.map(definition => {
        const conditional = tools.executable(definition.name, key) !== definition
        const replacements: PresetToolReplacement[] = []
        const action = definition.name === 'bash' || definition.name === 'pwsh' ? 'codex-exec'
          : definition.name === 'todo_write' ? 'codex-plan'
          : definition.name === 'edit' || definition.name === 'write' ? 'codex-patch' : undefined
        if (action !== undefined) {
          const targets = action === 'codex-exec' ? ['exec_command', 'write_stdin']
            : action === 'codex-plan' ? ['update_plan']
            : ['apply_patch']
          const reason = conditional ? 'conditional' as const
            : targets.some(target => names.has(target)) ? 'target-exists' as const : undefined
          replacements.push({ action, tools: targets, available: reason === undefined,
            ...(reason === undefined ? {} : { reason }) })
        }
        const codexTool = codexToolMetadata(definition)
        return { name: definition.name, description: definition.description.slice(0, 300), conditional, replacements,
          ...(defaultDeferred?.has(definition.name) ? { defaultDeferred: true } : {}),
          ...(codexTool === undefined ? {} : { codexTool }) }
      }).sort((a, b) => a.name.localeCompare(b.name, 'en')),
    }
  } finally {
    try { await view?.dispose() }
    finally { await lease[Symbol.asyncDispose]() }
  }
}
