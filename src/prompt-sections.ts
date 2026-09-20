import type { Context } from '@deepseek-ai/cordis'
import type { PromptAssembly } from '@deepseek-ai/dsh-system-prompt'
import z from '@deepseek-ai/schemastery'

export interface Config { persona?: string; harnessSourcePrompt?: string; webSurfacePrompt?: string }
export const Config: z<Config> = z.object({ persona: z.string(), harnessSourcePrompt: z.string(), webSurfacePrompt: z.string() })
export const name = 'preset-prompt-sections'
export const inject = ['systemPrompt']

/** Override only existing sections; dynamic runtime context and tool guidance remain host-owned. */
export function applyPromptSections(assembly: PromptAssembly, config: Config): PromptAssembly {
  const variables = { ...assembly.variables }
  variables.sourceRoot ??= assembly.sections.find(s => s.name === 'harness:source')?.text.match(/^The DeepSeek Harness implementation checkout is at (.+?)\. The checkout location/u)?.[1]
  variables.webUrl ??= assembly.sections.find(s => s.name === 'app:web-surface')?.text.match(/^You are interacting with the user through the DeepSeek Harness Web GUI at (.+?)\. When/u)?.[1]
  const values: Record<string, string | undefined> = {
    'deployment:persona': config.persona,
    'harness:source': config.harnessSourcePrompt,
    'app:web-surface': config.webSurfacePrompt,
  }
  return { ...assembly, sections: assembly.sections.map(section => {
    const text = values[section.name]
    return text === undefined ? section : { ...section, text: text.replace(/\{\{([\w.-]+)\}\}/g, (whole, key: string) => variables[key] ?? whole) }
  }) }
}
export function apply(ctx: Context, config: Config): void {
  ctx.on('system-prompt/assemble', async (_assembly, _context, next) => applyPromptSections(await next(), config))
}
