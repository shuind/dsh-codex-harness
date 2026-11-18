import { describe, expect, it, vi } from 'vitest'
import type { Agent } from '@deepseek-ai/dsh-agent'
import ToolPolicy, { apply, Config } from '../../src/entries/tool-policy.ts'
import type { Config as PolicyConfig, ToolAction, ToolPolicyRule } from '../../src/entries/tool-policy.ts'
import { effectiveToolAction } from '../../src/contracts/tool-policy-contract.ts'
import { capability, fsNames, harness, individualRule } from './policy-harness.ts'

describe('individual source tool choices', () => {
  it.each([
    ['bash', 'pwsh'],
    ['pwsh', 'bash'],
  ] as const)('replaces %s independently while keeping %s and todo_write native', async (replace, keep) => {
    const h = await harness()
    const source = h.preset('target', ['bash', 'pwsh', 'todo_write', ...fsNames])
    const rule = individualRule('target', [
      { name: replace, action: 'codex-exec' },
      { name: keep, action: 'keep' },
      { name: 'todo_write', action: 'keep' },
    ])
    await h.mount({ rules: [rule] })
    const candidate = h.prepare('target')
    await candidate.publish()
    expect(h.ctx.tools.get(replace, candidate.agent)).toBeUndefined()
    expect(h.ctx.tools.get(keep, candidate.agent)).toBe(source.definitions[keep])
    expect(h.ctx.tools.get('todo_write', candidate.agent)).toBe(source.definitions.todo_write)
    expect(h.ctx.tools.get('update_plan', candidate.agent)).toBeUndefined()
    for (const name of ['exec_command', 'write_stdin']) {
      expect(h.names(candidate.agent).filter(tool => tool === name)).toHaveLength(1)
    }
    for (const name of fsNames) expect(h.ctx.tools.get(name, candidate.agent)).toBe(source.definitions[name])
    const assembly = await h.ctx.systemPrompt.assemble({ scope: candidate.agent, agent: candidate.agent })
    const guide = assembly.sections.find(section => section.name === 'codex:tool-policy')!.text
    expect(guide).toContain(`${replace} is replaced`)
    expect(guide).not.toContain('todo_write is replaced')
    expect(effectiveToolAction(rule, replace)).toBe('codex-exec')
    expect(effectiveToolAction(rule, keep)).toBe('keep')
  })

  it('registers one shared execution pair when both shell sources select it', async () => {
    const h = await harness()
    const source = h.preset('target', ['bash', 'pwsh', 'todo_write', 'read'])
    await h.mount({ rules: [individualRule('target', [
      { name: 'bash', action: 'codex-exec' },
      { name: 'pwsh', action: 'codex-exec' },
    ])] })
    const candidate = h.prepare('target')
    await candidate.publish()
    expect(h.names(candidate.agent)).toEqual(['todo_write', 'read', 'exec_command', 'write_stdin'])
    expect(h.ctx.tools.get('todo_write', candidate.agent)).toBe(source.definitions.todo_write)
    expect(h.ctx.tools.get('update_plan', candidate.agent)).toBeUndefined()
  })

  it('replaces only todo_write without enabling an execution replacement', async () => {
    const h = await harness()
    const source = h.preset('target', ['bash', 'pwsh', 'todo_write', 'read'])
    await h.mount({ rules: [individualRule('target', [{ name: 'todo_write', action: 'codex-plan' }])] })
    const candidate = h.prepare('target')
    await candidate.publish()
    expect(h.names(candidate.agent)).toEqual(['bash', 'pwsh', 'read', 'update_plan'])
    expect(h.ctx.tools.get('bash', candidate.agent)).toBe(source.definitions.bash)
    expect(h.ctx.tools.get('pwsh', candidate.agent)).toBe(source.definitions.pwsh)
    const assembly = await h.ctx.systemPrompt.assemble({ scope: candidate.agent, agent: candidate.agent })
    const guide = assembly.sections.find(section => section.name === 'codex:tool-policy')!.text
    expect(guide).toContain('todo_write is replaced by update_plan')
    expect(guide).not.toContain('exec_command')
  })

  it('hides a generic tool without coupling it to execution or plan replacements', async () => {
    const h = await harness()
    const source = h.preset('target')
    await h.mount({ rules: [individualRule('target', [{ name: 'read', action: 'hide' }])] })
    const candidate = h.prepare('target')
    await candidate.publish()
    expect(h.names(candidate.agent)).toEqual(Object.keys(source.definitions).filter(name => name !== 'read'))
    for (const name of ['pwsh', 'todo_write', 'apply_patch']) {
      expect(h.ctx.tools.get(name, candidate.agent)).toBe(source.definitions[name])
    }
    expect(h.ctx.tools.get('exec_command', candidate.agent)).toBeUndefined()
    expect(h.ctx.tools.get('update_plan', candidate.agent)).toBeUndefined()
    const assembly = await h.ctx.systemPrompt.assemble({ scope: candidate.agent, agent: candidate.agent })
    expect(assembly.sections.some(section => section.name === 'codex:tool-policy')).toBe(false)
  })

  it('lets explicit keep/replacements override both old masks, including an empty allowlist', async () => {
    const h = await harness()
    const source = h.preset('target')
    const rule: ToolPolicyRule = {
      ...individualRule('target', [
        { name: 'read', action: 'keep' },
        { name: 'pwsh', action: 'codex-exec' },
        { name: 'todo_write', action: 'codex-plan' },
        { name: 'glob', action: 'hide' },
        { name: 'other_tool', action: 'hide' },
      ]),
      allow: [],
      deny: ['read', 'pwsh', 'todo_write', 'other_tool'],
    }
    await h.mount({ rules: [rule] })
    const candidate = h.prepare('target')
    await candidate.publish()
    expect(h.names(candidate.agent)).toEqual(['read', 'exec_command', 'write_stdin', 'update_plan'])
    expect(h.ctx.tools.get('read', candidate.agent)).toBe(source.definitions.read)
    for (const name of ['read', 'pwsh', 'todo_write', 'glob', 'other_tool']) {
      expect(effectiveToolAction(rule, name)).toBe(rule.tools!.find(tool => tool.name === name)!.action)
    }
  })

  it('lets per-tool keep/hide override legacy category defaults without changing other sources', async () => {
    const h = await harness()
    const source = h.preset('target', ['bash', 'pwsh', 'todo_write', 'read'])
    // Category fields are intentionally omitted: the old defaults remain true.
    await h.mount({ rules: [{ preset: 'target', tools: [
      { name: 'bash', action: 'hide' },
      { name: 'pwsh', action: 'keep' },
      { name: 'todo_write', action: 'keep' },
    ] }] })
    const candidate = h.prepare('target')
    await candidate.publish()
    expect(h.names(candidate.agent)).toEqual(['pwsh', 'todo_write', 'read'])
    for (const name of ['pwsh', 'todo_write', 'read']) {
      expect(h.ctx.tools.get(name, candidate.agent)).toBe(source.definitions[name])
    }
  })

  it('keeps legacy defaults for sources without an explicit override', async () => {
    const h = await harness()
    const source = h.preset('target', ['bash', 'pwsh', 'todo_write', 'read'])
    await h.mount({ rules: [{ preset: 'target', tools: [{ name: 'bash', action: 'keep' }] }] })
    const candidate = h.prepare('target')
    await candidate.publish()
    expect(h.ctx.tools.get('bash', candidate.agent)).toBe(source.definitions.bash)
    expect(h.ctx.tools.get('pwsh', candidate.agent)).toBeUndefined()
    expect(h.ctx.tools.get('todo_write', candidate.agent)).toBeUndefined()
    expect(h.names(candidate.agent)).toEqual(['bash', 'read', 'exec_command', 'write_stdin', 'update_plan'])
  })

  it.each([
    { choices: [{ name: 'read', action: 'keep' }, { name: 'read', action: 'hide' }], error: /duplicate tool choice/ },
    { choices: [{ name: '  ', action: 'keep' }], error: /non-empty source name/ },
    { choices: [{ name: 'read', action: 'drop' }], error: /invalid action/ },
    { choices: [{ name: 'read', action: 'codex-exec' }], error: /unsupported replacement/ },
    { choices: [{ name: 'todo_write', action: 'codex-exec' }], error: /unsupported replacement/ },
    { choices: [{ name: 'pwsh', action: 'codex-plan' }], error: /unsupported replacement/ },
    { choices: [{ name: 'bash', action: 'codex-plan' }], error: /unsupported replacement/ },
  ])('rejects malformed or unsupported source choices: $choices', async ({ choices, error }) => {
    const h = await harness()
    const source = h.preset('target')
    expect(() => apply(h.ctx, { rules: [individualRule('target', choices as readonly ToolActionRule[])] })).toThrow(error)
    const candidate = h.prepare('target')
    await candidate.publish()
    expect(h.names(candidate.agent)).toEqual(Object.keys(source.definitions))
  })

  it.each(['keep', 'hide'] as const)('refuses an unknown explicit %s target atomically', async action => {
    const h = await harness()
    const source = h.preset('target')
    await h.mount({ rules: [individualRule('target', [
      { name: 'read', action: 'hide' },
      { name: 'stale_tool', action },
    ])] })
    const candidate = h.prepare('target')
    await expect(candidate.publish()).rejects.toThrow(/unknown or unavailable source tool "stale_tool"/)
    expect(h.names(candidate.agent)).toEqual(Object.keys(source.definitions))
  })

  it('refuses an explicit missing replacement source instead of granting a new capability', async () => {
    const h = await harness()
    const source = h.preset('target', ['read'])
    await h.mount({ rules: [individualRule('target', [{ name: 'bash', action: 'codex-exec' }])] })
    const candidate = h.prepare('target')
    await expect(candidate.publish()).rejects.toThrow(/unknown or unavailable source tool "bash"/)
    expect(h.names(candidate.agent)).toEqual(Object.keys(source.definitions))
  })

  it.each(['keep', 'hide'] as const)('refuses explicit %s on an Agent-owned tool', async action => {
    const h = await harness()
    h.preset('target')
    await h.mount({ rules: [individualRule('target', [{ name: 'local_tool', action }])] })
    const own = capability('local_tool')
    const candidate = h.prepare('target', [own])
    await expect(candidate.publish()).rejects.toThrow(/Agent-local tool/)
    expect(h.ctx.tools.get('local_tool', candidate.agent)).toBe(own)
    expect(h.ctx.tools.get('pwsh', candidate.agent)).toBeDefined()
  })

  it.each([
    ['bash', 'codex-exec'],
    ['pwsh', 'codex-exec'],
    ['todo_write', 'codex-plan'],
  ] as const)('refuses conditional explicit replacement of %s and preserves preceding choices', async (name, action) => {
    const h = await harness()
    const when = vi.fn(() => false)
    const source = h.preset('target', [name, 'read'], { [name]: when })
    await h.mount({ rules: [individualRule('target', [
      { name: 'read', action: 'hide' },
      { name, action },
    ])] })
    const candidate = h.prepare('target')
    await expect(candidate.publish()).rejects.toThrow(/conditional source tool/)
    expect(h.names(candidate.agent)).toEqual(Object.keys(source.definitions))
    expect(h.ctx.tools.get(name, candidate.agent)).toBe(source.definitions[name])
    expect(when).not.toHaveBeenCalled()
  })

  it('keeps conditional capabilities without discarding their activation predicate', async () => {
    const h = await harness()
    const source = h.preset('target', ['conditional_tool', 'read'], { conditional_tool: () => false })
    await h.mount({ rules: [individualRule('target', [{ name: 'conditional_tool', action: 'keep' }])] })
    const candidate = h.prepare('target')
    await candidate.publish()
    expect(h.ctx.tools.get('conditional_tool', candidate.agent)).toBe(source.definitions.conditional_tool)
    expect(h.ctx.tools.executable('conditional_tool', candidate.agent)).toBeUndefined()
    const signal = new AbortController().signal
    const admitted = await h.ctx.tools.resolve({ agent: candidate.agent, signal, modelSelection: { provider: 'test', model: 'test' } })
    try {
      expect(h.ctx.tools.schemas(candidate.agent, admitted).map(tool => tool.name)).toEqual(['read'])
    } finally {
      admitted.dispose()
    }
  })

  it('snapshots individual choices across live saves and blank switches, then unwinds both versions', async () => {
    const h = await harness()
    const source = h.preset('target', ['bash', 'pwsh', 'todo_write', 'read'])
    h.preset('other')
    const plugin = await h.mountWithLoader({ rules: [individualRule('target', [
      { name: 'pwsh', action: 'codex-exec' },
      { name: 'todo_write', action: 'keep' },
    ])] })
    const first = h.prepare('target')
    await first.publish()
    const initialExec = h.ctx.tools.get('exec_command', first.agent)
    expect(initialExec).toBeDefined()
    await plugin.update({ rules: [individualRule('target', [
      { name: 'pwsh', action: 'keep' },
      { name: 'todo_write', action: 'codex-plan' },
    ])] })
    expect(h.ctx.tools.get('exec_command', first.agent)).toBe(initialExec)
    const second = h.prepare('target')
    await second.publish()
    expect(h.ctx.tools.get('pwsh', second.agent)).toBe(source.definitions.pwsh)
    expect(h.ctx.tools.get('update_plan', second.agent)).toBeDefined()
    expect(h.ctx.tools.get('exec_command', second.agent)).toBeUndefined()
    first.switchPreset('other')
    first.switchPreset('target')
    expect(h.ctx.tools.get('exec_command', first.agent)).toBeDefined()
    expect(h.ctx.tools.get('update_plan', first.agent)).toBeUndefined()
    expect(h.ctx.tools.get('todo_write', first.agent)).toBe(source.definitions.todo_write)
    await plugin.fiber.dispose()
    for (const candidate of [first, second]) {
      expect(h.names(candidate.agent)).toEqual(Object.keys(source.definitions))
      const assembly = await h.ctx.systemPrompt.assemble({ scope: candidate.agent, agent: candidate.agent })
      expect(assembly.sections.some(section => section.name === 'codex:tool-policy')).toBe(false)
    }
  })

  it('clones individual choice objects even for mutable direct-call configuration', async () => {
    const h = await harness()
    h.preset('target')
    h.preset('other')
    const choice: { name: string; action: ToolAction } = { name: 'pwsh', action: 'codex-exec' }
    const rule = individualRule('target', [choice])
    apply(h.ctx, { rules: [rule] })
    const first = h.prepare('target')
    await first.publish()
    choice.action = 'hide'
    const second = h.prepare('target')
    await second.publish()
    expect(h.ctx.tools.get('exec_command', second.agent)).toBeUndefined()
    expect(h.ctx.tools.get('pwsh', second.agent)).toBeUndefined()
    first.switchPreset('other')
    first.switchPreset('target')
    expect(h.ctx.tools.get('exec_command', first.agent)).toBeDefined()
  })
})

