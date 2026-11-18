import { describe, expect, it } from 'vitest'
import { remoteMethods } from '@deepseek-ai/dsh-typert-protocol'
import { CodexPresetEditor, type AgentPresetsForEditor } from '../../src/presets/preset-editor.ts'
import { TYPERT } from '../../src/entries/typert.host.ts'
import clientContract from '../../src/contracts/preset-editor-schema.ts'

describe('CodexPresetEditor', () => {
  it('ships symmetric read-only Host and Client RPC contracts', () => {
    expect(TYPERT.face).toBe('host')
    expect(TYPERT.package).toBe('@shuind/dsh-codex-harness')
    expect(TYPERT.invocations.map(invocation => invocation.method)).toEqual(['catalog', 'tools', 'prompts', 'read'])
    expect(clientContract.descriptors.map(d => d.method)).toEqual(['catalog', 'tools', 'prompts', 'read'])
    for (const invocation of TYPERT.invocations) {
      expect(typeof invocation.result.create).toBe('function')
      expect(invocation.result.create()).toBeTypeOf('object')
      for (const parameter of invocation.parameters) expect(typeof parameter.codec.create).toBe('function')
    }
  })

  it('marks every read-only editor method for the Typert gateway', () => {
    const service = Object.create(CodexPresetEditor.prototype) as object
    expect(remoteMethods(service).map(method => method.exportName ?? method.method)).toEqual(['catalog', 'tools', 'prompts', 'read'])
  })

  it('lists healthy presets and reads raw declarative definitions', async () => {
    const composition = '- id: persona\n  name: "@deepseek-ai/dsh-persona"\n'
    const fake: AgentPresetsForEditor = {
      remoteExportList: async () => ({
        presets: [
          { id: 'codex-collaboration', name: 'Codex', description: 'Built-in', isDefault: true },
          { id: 'broken-one', name: 'Broken', isDefault: false, broken: 'invalid-yaml' },
        ],
      }),
      resolve: async (id: string) => id === 'broken-one'
        ? { id, broken: 'invalid-yaml' }
        : { id, name: 'Codex', description: 'Built-in' },
      readDocument: async () => ({ content: composition, name: 'Codex', description: 'Built-in' }),
    }
    const service = Object.create(CodexPresetEditor.prototype) as CodexPresetEditor & { agentPresets: AgentPresetsForEditor }
    service.agentPresets = fake

    const catalog = await service.catalog()
    expect(catalog).toEqual({
      presets: [{ id: 'codex-collaboration', name: 'Codex', description: 'Built-in', isDefault: true }],
      excludedCount: 1,
    })

    const doc = await service.read('codex-collaboration')
    expect(doc).toEqual({
      id: 'codex-collaboration',
      name: 'Codex',
      description: 'Built-in',
      composition,
    })

    await expect(service.read('')).rejects.toThrow('invalid-preset-id')
    await expect(service.read('broken-one')).rejects.toThrow('invalid-preset')
  })
})
