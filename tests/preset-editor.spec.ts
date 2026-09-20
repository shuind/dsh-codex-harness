import { mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { remoteMethods } from '@deepseek-ai/dsh-typert-protocol'
import {
  CodexPresetEditor,
  patchPresetComposition,
  patchPresetMetadata,
  readPresetSystemPrompt,
  type AgentPresetsForEditor,
  type ResolvedPresetForEditor,
} from '../src/preset-editor.ts'
import { TYPERT } from '../src/typert.host.ts'

const bundledComposition = `# keep this comment and YAML tag
- id: persona
  name: '@deepseek-ai/dsh-persona'
  config:
    prefix: >-
      You are Codex, based on {{model}} in {{cwd}}.
    disabled: !!js process.platform === 'win32'

- id: codex-tools
  name: '@shuind/dsh-codex-harness'
  config:
    globalEnhancements: false
    codexCore: true

- id: preserved-plugin
  name: '@deepseek-ai/dsh-tool-web'
  config:
    search: true
`

describe('preset editor YAML patches', () => {
  it('changes only the Codex prompt and preserves tags, interpolation, and rows', () => {
    const prompt = 'Follow {{model}} carefully.\nKeep the special YAML untouched.'
    const next = patchPresetComposition(bundledComposition, prompt)
    expect(next).toContain("disabled: !!js process.platform === 'win32'")
    expect(next).toContain('You are Codex, based on {{model}} in {{cwd}}.')
    expect(next).toContain("name: '@deepseek-ai/dsh-tool-web'")
    expect(readPresetSystemPrompt(next)).toBe(prompt)
  })

  it('replaces an existing block without consuming the next plugin row', () => {
    const first = patchPresetComposition(bundledComposition, 'first')
    const second = patchPresetComposition(first, 'second\n')
    expect(second).toContain('presetPrompt: |')
    expect(readPresetSystemPrompt(second)).toBe('second\n')
    expect(second.match(/presetPrompt:/g)).toHaveLength(1)
    expect(second).toContain('- id: preserved-plugin')
  })

  it('updates metadata fields while retaining comments and unknown keys', () => {
    const source = '# user note\norder: 5\ncustom: keep\n'
    const next = patchPresetMetadata(source, 'My "Codex"', 'A custom\ndescription')
    expect(next).toContain('# user note')
    expect(next).toContain('custom: keep')
    expect(next).toContain(`name: ${JSON.stringify('My "Codex"')}`)
    expect(next).toContain(`description: ${JSON.stringify('A custom\ndescription')}`)
    expect(next).toContain('order: 5')
  })
})

describe('CodexPresetEditor', () => {
  it('ships the Host Remote contract needed by the browser editor', () => {
    expect(TYPERT.face).toBe('host')
    expect(TYPERT.package).toBe('@shuind/dsh-codex-harness')
    expect(TYPERT.invocations.map(invocation => invocation.method)).toEqual(['catalog', 'read', 'update', 'create'])
  })

  it('marks every editor method for the Typert gateway', () => {
    const service = Object.create(CodexPresetEditor.prototype) as object
    expect(remoteMethods(service).map(method => method.exportName ?? method.method)).toEqual(['read', 'update', 'catalog', 'create'])
  })

  it('serializes concurrent user edits atomically and refuses built-ins', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'dsh-codex-preset-'))
    const composition = join(directory, 'agent.cordis.yml')
    const metadata = join(directory, 'preset.yml')
    await writeFile(composition, bundledComposition, 'utf8')
    await writeFile(metadata, '# keep\norder: 5\n', 'utf8')
    let trust: 'system' | 'user' = 'user'
    const resolve = async (id: string): Promise<ResolvedPresetForEditor> => ({
      id,
      trust,
      path: composition,
    })
    const fake: AgentPresetsForEditor = {
      resolve,
      roots: [{ path: directory, trust: 'user' }],
      readDocument: async () => ({ content: await readFile(composition, 'utf8') }),
    }
    const service = Object.create(CodexPresetEditor.prototype) as {
      agentPresets: AgentPresetsForEditor
      update(input: { id: string; name: string; description: string; systemPrompt: string }): Promise<unknown>
    }
    service.agentPresets = fake

    await Promise.all([
      service.update({ id: 'custom', name: 'A', description: 'A', systemPrompt: 'prompt A' }),
      service.update({ id: 'custom', name: 'B', description: 'B', systemPrompt: 'prompt B' }),
    ])
    const finalComposition = await readFile(composition, 'utf8')
    const finalMetadata = await readFile(metadata, 'utf8')
    expect(['prompt A', 'prompt B']).toContain(readPresetSystemPrompt(finalComposition))
    expect(finalMetadata).toMatch(/name: "[AB]"/)
    expect(finalComposition).toContain("disabled: !!js process.platform === 'win32'")

    trust = 'system'
    await expect(service.update({ id: 'custom', name: 'C', description: '', systemPrompt: 'nope' }))
      .rejects.toThrow('built-in presets cannot be edited here')
  })
})
