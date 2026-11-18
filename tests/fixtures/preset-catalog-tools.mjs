import { defineTool } from '@deepseek-ai/dsh-tools'
export const inject = ['tools']
export function apply(ctx, config) {
  const tools = ctx.get('tools')
  if (config.defaultDeferred) {
    ctx.effect(() => ctx.get('catalogTestDefaults')(ctx, config.defaultDeferred))
  }
  if (config.deniedBeforeShadow) tools.restrict({ deny: config.deniedBeforeShadow })
  for (const name of config.names) {
    const definition = defineTool({
      name, description: name === 'read' ? 'x'.repeat(500) : name, parameters: {},
      output: { schema: { type: 'object', properties: {}, additionalProperties: false }, render: () => [] },
      execute: async () => { throw new Error('catalog-must-not-execute-tools') },
    })
    tools.register(definition, config.conditional?.includes(name) ? { when: () => {
      ctx.get('catalogTestCounter').calls++
      return true
    } } : {})
  }
}
