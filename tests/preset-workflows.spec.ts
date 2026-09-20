import { afterEach, describe, expect, it } from 'vitest'
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve, sep } from 'node:path'
import { parse } from 'yaml'
import { CodexPresetEditor, enhanceComposition, patchCodexPresetOptions, patchPresetComposition, patchPresetMetadata, readCodexPresetOptions, readPromptSections, patchPromptSections, readPresetSystemPrompt, supportsCodex, validateComposition } from '../src/preset-editor.ts'
import type { AgentPresetsForEditor } from '../src/preset-editor.ts'
import { exportPromptCard, parsePromptCard } from '../src/preset-contract.ts'
import { withPresetPrompt } from '../src/index.ts'
import { CODEX_SETTINGS_ENTRY } from '../src/settings.ts'

const generic = '# story instructions\n- id: persona\n  name: story-plugin\n  config:\n    prefix: Story teller\n    disabled: !!js process.platform === "win32"\n'
const harness = `${generic}\n- id: custom-row-name\n  name: '@shuind/dsh-codex-harness'\n  config:\n    codexCore: true\n`
const directories: string[] = []
afterEach(async () => {
  for (const path of directories.splice(0)) {
    if (!resolve(path).startsWith(`${resolve(tmpdir())}${sep}`)) throw new Error('unsafe test cleanup')
    await rm(path, { recursive: true, force: true })
  }
})
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'codex-workflows-')); directories.push(root)
  const ids = new Set(['story', 'codex'])
  for (const [id, source] of [['story', generic], ['codex', harness]]) {
    await mkdir(join(root, id!)); await writeFile(join(root, id!, 'agent.cordis.yml'), source!)
    await writeFile(join(root, id!, 'preset.yml'), `name: ${id}\ndescription: |-\n  first line\n  second line\ncustom: keep\n`)
  }
  const host: AgentPresetsForEditor = {
    roots: [{ path: root, trust: 'user' }],
    resolve: async id => {
      if (!ids.has(id)) throw new Error('missing preset')
      validateComposition(await readFile(join(root, id, 'agent.cordis.yml'), 'utf8'))
      return { id, path: join(root, id, 'agent.cordis.yml'), trust: id === 'codex' ? 'system' : 'user' }
    },
    readDocument: async id => ({ content: await readFile(join(root, id, 'agent.cordis.yml'), 'utf8') }),
    remoteExportList: async () => ({ presets: [...ids].map(id => ({ id, name: id, trust: id === 'codex' ? 'system' as const : 'user' as const, isDefault: id === 'codex' })), authorable: true }),
    copy: async (from, id) => { if (ids.has(id)) throw new Error('exists'); await cp(join(root, from), join(root, id), { recursive: true, errorOnExist: true, force: false }); ids.add(id) },
    remove: async id => { if (!ids.has(id)) throw new Error('missing'); await rm(join(root, id), { recursive: true }); ids.delete(id) },
  }
  const service = Object.create(CodexPresetEditor.prototype) as CodexPresetEditor
  Object.defineProperty(service, 'agentPresets', { value: host })
  return { service, host, root, ids }
}
describe('preset product workflows', () => {
  it('exposes DSH host templates for an ordinary preset independently of Codex', async () => {
    const sections = readPromptSections(generic, { harnessSourcePrompt: 'Codex-only legacy override', webSurfacePrompt: 'Codex web override' })
    expect(sections.find(s => s.id === 'harness:source')).toMatchObject({ editable: true, text: expect.stringContaining('{{sourceRoot}}') })
    expect(sections.find(s => s.id === 'app:web-surface')).toMatchObject({ editable: true, text: expect.stringContaining('{{webUrl}}') })
    expect(sections.some(s => s.id === 'codex:base')).toBe(false)
    const { service } = await fixture()
    const before = await service.read('story')
    const copy = await service.create({ ...before, sourceId: before.id, name: 'Ordinary copy' })
    expect(copy.codex).toBe(false)
    expect(copy.composition).not.toContain('@shuind/dsh-codex-harness')
  })
  it('saves DSH template edits in an ordinary copy without enabling Codex or changing its source', async () => {
    const { service } = await fixture()
    const before = await service.read('story')
    const sections = before.promptSections.map(s => ({ ...s, text: s.id === 'harness:source' ? 'Read {{sourceRoot}}' : s.id === 'app:web-surface' ? '' : s.text }))
    const copy = await service.create({ ...before, sourceId: before.id, name: 'DSH customization', promptSections: sections })
    expect(copy.codex).toBe(false)
    expect(copy.promptSections).toEqual(sections)
    expect(parse(copy.composition).find((row: { name: string }) => row.name === '@shuind/dsh-codex-harness')).toBeUndefined()
    expect(parse(copy.composition).find((row: { name: string }) => row.name === '@shuind/dsh-codex-harness/prompt-sections')?.config).toEqual({ harnessSourcePrompt: 'Read {{sourceRoot}}', webSurfacePrompt: '' })
    expect((await service.read('story')).composition).toBe(before.composition)
  })
  it('does not add DSH templates to a complete Persona and preserves that when copied', async () => {
    const { service, root } = await fixture()
    const minimal = '- id: persona\n  name: "@deepseek-ai/dsh-persona"\n  config:\n    prefix: Only this identity\n    complete: true\n'
    await writeFile(join(root, 'story', 'agent.cordis.yml'), minimal)
    const before = await service.read('story')
    expect(before.promptSections.some(s => s.id === 'harness:source')).toBe(false)
    expect(before.promptSections.some(s => s.id === 'app:web-surface')).toBe(false)
    const copy = await service.create({ ...before, sourceId: before.id, name: 'Minimal copy', promptSections: before.promptSections })
    expect(copy.promptSections).toEqual(before.promptSections)
    expect(parse(copy.composition)[0].config.complete).toBe(true)
    expect(copy.composition).not.toContain('@shuind/dsh-codex-harness')
    expect(() => patchPromptSections(minimal, [{ id: 'harness:source', label: 'DSH Core 源码说明', text: 'ignored', editable: true }])).toThrow('invalid-prompt-section')
    const enhanced = readPromptSections(enhanceComposition(minimal))
    expect(enhanced.find(s => s.id === 'harness:source')).toMatchObject({ editable: true })
    expect(enhanced.find(s => s.id === 'app:web-surface')).toMatchObject({ editable: true })
  })
  it('does not show host templates when a preset explicitly clears them', () => {
    const story = `- id: story-prompt-clean-slate
  name: './tools/prompt/clean-slate.mjs'
- id: story-operating-prompt
  name: './tools/prompt/index.mjs'
  config:
    text: Story instructions
`
    const sections = readPromptSections(story)
    expect(sections.some(s => s.id === 'harness:source')).toBe(false)
    expect(sections.some(s => s.id === 'app:web-surface')).toBe(false)
    expect(sections.some(s => s.id.includes('story-operating-prompt'))).toBe(true)
  })
  it('reads and edits the actual persona and nested prompt fields while preserving tools', () => {
    const composition = `- id: persona
  name: '@deepseek-ai/dsh-persona'
  config:
    prefix: Original identity
    suffix: In {{cwd}}
- id: group
  name: cordis:group
  config:
    - id: prompt
      name: local-prompt
      config:
        text: Local instructions
    - id: plan-mode
      name: '@deepseek-ai/dsh-plan-mode'
      config:
        section: Planning policy
- id: tool
  name: tool-plugin
  config:
    description: Tool description
`
    const sections = readPromptSections(composition)
    expect(sections.map(s => s.text)).toContain('Original identity')
    expect(sections.map(s => s.text)).toContain('Local instructions')
    expect(sections.map(s => s.text)).not.toContain('Tool description')
    expect(sections.map(s => s.text)).not.toContain('Planning policy')
    const saved = patchPromptSections(composition, sections.map(s => ({ ...s, text: s.text === 'Original identity' ? 'New identity' : s.text })))
    expect(parse(saved)[0].config.prefix).toBe('New identity')
    expect(parse(saved)[0].config.suffix).toBe('In {{cwd}}')
    expect(saved).toContain('Tool description')
    expect(parse(saved)[1].config[1].config.section).toBe('Planning policy')
    expect(supportsCodex(saved)).toBe(false)
  })
  it('copies all Codex prompt sections independently and does not change the original', async () => {
    const { service } = await fixture()
    const source = await service.read('codex')
    const sections = source.promptSections.map(s => ({ ...s, text: 'Copy: ' + s.text }))
    const copy = await service.create({ ...source, sourceId: source.id, name: 'Independent Codex', promptSections: sections })
    expect(copy.promptSections.map(s => s.text)).toEqual(sections.map(s => s.text))
    expect((await service.read('codex')).promptSections).toEqual(source.promptSections)
    const second = await service.create({ ...copy, sourceId: copy.id, name: 'Copy of copy' })
    expect(second.promptSections).toEqual(copy.promptSections)
  })
  it('reads a literal file-backed Story prompt without evaluating JS and saves edited text in the preset', async () => {
    const { service, root } = await fixture()
    await mkdir(join(root, 'story', 'prompts'))
    await writeFile(join(root, 'story', 'prompts', 'operating.md'), 'Actual Story instructions')
    const source = `- id: story-prompt
  name: './tools/prompt.mjs'
  config:
    text: !!js "process.getBuiltinModule('node:fs').readFileSync(new URL('prompts/operating.md', baseUrl), 'utf8')"
- id: expression
  name: local-plugin
  config:
    text: !!js process.exit(1)
`
    await writeFile(join(root, 'story', 'agent.cordis.yml'), source)
    const before = await service.read('story')
    expect(before.promptSections.find(s => s.id.includes('story-prompt'))).toMatchObject({ text: 'Actual Story instructions', editable: true })
    expect(before.promptSections.find(s => s.id.includes('expression'))).toMatchObject({ editable: false })
    const saved = await service.update({ ...before, promptSections: before.promptSections.filter(s => s.editable).map(s => ({ ...s, text: s.text === 'Actual Story instructions' ? 'Edited Story instructions' : s.text })) })
    expect(saved.promptSections.find(s => s.id.includes('story-prompt'))?.text).toBe('Edited Story instructions')
    expect(saved.composition).toContain('!!js process.exit(1)')
    expect(await readFile(join(root, 'story', 'prompts', 'operating.md'), 'utf8')).toBe('Actual Story instructions')
  })
  it('uses the catalog index for reads, but resolves again before writes and rejects stale revisions', async () => {
    const { service, host, root } = await fixture()
    const resolvePreset = host.resolve
    const indexed = await Promise.all(['story', 'codex'].map(resolvePreset))
    host.list = async () => indexed
    await service.catalog()
    let calls = 0
    host.resolve = async id => { calls++; return resolvePreset(id) }
    const before = await service.read('story')
    await service.read('codex')
    await service.read('story')
    expect(calls).toBe(0)
    await writeFile(join(root, 'story', 'preset.yml'), 'name: Changed externally')
    await expect(service.update({ ...before, name: 'Stale edit' })).rejects.toThrow('preset-conflict')
    expect(calls).toBe(1)
  })
  it('allows Codex instructions alongside a fixed persona without changing its identity', () => {
    const source = '- id: persona\n  name: "@deepseek-ai/dsh-persona"\n  config:\n    prefix: Keep my identity\n    complete: true\n    includeRuntimeContext: false\n'
    const rows = parse(enhanceComposition(source))
    expect(rows[0].config).toEqual({ prefix: 'Keep my identity', complete: false, includeRuntimeContext: false })
    expect(rows[1].name).toBe('@shuind/dsh-codex-harness')
    expect(source).toContain('complete: true')
  })
  it('lists metadata without opening or resolving any preset composition', async () => {
    const { service, host } = await fixture()
    host.readDocument = async () => { throw new Error('catalog must not read compositions') }
    const resolvePreset = host.resolve
    host.resolve = async () => { throw new Error('catalog must not resolve compositions') }
    expect((await service.catalog()).presets).toMatchObject([{ id: 'story' }, { id: 'codex' }])
    host.resolve = resolvePreset
    expect((await service.read('story')).description).toBe('first line\nsecond line')
  })
  it('enhances a generic copy without changing the source or removing plugins', async () => {
    const { service, root } = await fixture()
    const created = await service.create({ sourceId: 'story', name: 'Story + Codex', description: 'custom', systemPrompt: 'Special instructions', inheritPrompt: false, enableCodex: true })
    expect(created).toMatchObject({ name: 'Story + Codex', codex: true, systemPrompt: 'Special instructions', editable: true })
    expect(created.composition).toContain('!!js')
    expect(created.composition).toContain('story-plugin')
    expect(await readFile(join(root, 'story', 'agent.cordis.yml'), 'utf8')).toBe(generic)
    expect(supportsCodex(enhanceComposition(created.composition))).toBe(true)
    expect(enhanceComposition(created.composition)).toBe(created.composition)
  })
  it('copies a generic preset without opting into Harness', async () => {
    const { service } = await fixture()
    const created = await service.create({ sourceId: 'story', name: 'Story copy', description: '', systemPrompt: '', inheritPrompt: true })
    expect(created.codex).toBe(false)
    expect(created.composition).toBe(generic)
  })
  it('adds Harness directly to an edited user preset and preserves YAML edits', async () => {
    const { service } = await fixture()
    const { promptSections: _sections, ...doc } = await service.read('story')
    const saved = await service.update({ ...doc, composition: doc.composition.replace('Story teller', 'Edited persona'), enableCodex: true })
    expect(saved.id).toBe('story')
    expect(saved.codex).toBe(true)
    expect(saved.composition).toContain('Edited persona')
  })
  it('saves edited YAML as a copy without changing the source', async () => {
    const { service } = await fixture()
    const { promptSections: _sections, ...doc } = await service.read('story')
    const saved = await service.create({ ...doc, sourceId: doc.id, name: 'Edited copy', composition: doc.composition.replace('Story teller', 'Copy persona'), enableCodex: true })
    expect(saved.codex).toBe(true)
    expect(saved.composition).toContain('Copy persona')
    expect((await service.read('story')).composition).toBe(doc.composition)
  })
  it('rejects stale editors and preserves the successful writer plus a backup', async () => {
    const { service, root } = await fixture()
    const before = await service.read('story')
    const saved = await service.update({ ...before, name: 'Writer A', composition: generic.replace('Story teller', 'New storyteller') })
    expect(saved.name).toBe('Writer A')
    await expect(service.update({ ...before, name: 'Writer B' })).rejects.toThrow('preset-conflict')
    expect((await service.read('story')).name).toBe('Writer A')
    const backup = JSON.parse(await readFile(join(root, 'story', '.codex-editor-backup.json'), 'utf8'))
    expect(backup.composition).toBe(generic)
  })
  it('refuses invalid internal YAML and editing built-ins without writing anything', async () => {
    const { service } = await fixture()
    const before = await service.read('story')
    await expect(service.update({ ...before, composition: '- [' })).rejects.toThrow('invalid-preset-yaml')
    expect((await service.read('story')).revision).toBe(before.revision)
    const builtin = await service.read('codex')
    await expect(service.update({ ...builtin, name: 'changed' })).rejects.toThrow('built-in')
  })
  it('rolls back both files if host validation fails after a write', async () => {
    const { service, host, root } = await fixture()
    const before = await service.read('story')
    const originalResolve = host.resolve
    let calls = 0
    host.resolve = async id => { if (++calls === 2) throw new Error('host failure'); return originalResolve(id) }
    await expect(service.update({ ...before, name: 'failed' })).rejects.toThrow('host failure')
    expect(await readFile(join(root, 'story', 'agent.cordis.yml'), 'utf8')).toBe(before.composition)
    expect((await service.read('story')).name).toBe(before.name)
  })
  it('does not leave a new copy behind if its update fails', async () => {
    const { service, host, ids } = await fixture()
    const originalResolve = host.resolve
    host.resolve = async id => { if (!['story', 'codex'].includes(id)) throw new Error('failure'); return originalResolve(id) }
    await expect(service.create({ sourceId: 'story', name: 'copy', description: '', systemPrompt: '', inheritPrompt: true })).rejects.toThrow('failure')
    expect([...ids]).toEqual(['story', 'codex'])
  })
  it('patches multiline metadata and custom row names without corrupting siblings', () => {
    const result = patchPresetMetadata('name: Old\ndescription: |\n  Old\n  details\ncustom: keep\n', 'New', 'new description')
    expect(parse(result)).toEqual({ name: 'New', description: 'new description', custom: 'keep' })
    const withPrompt = patchPresetComposition(harness, "Quotes: 'hi'\nblank line\n\n")
    expect(readPresetSystemPrompt(withPrompt)).toBe("Quotes: 'hi'\nblank line\n\n")
    expect(withPrompt).toContain('!!js')
  })
  it('stores Codex capabilities with a preset while activity remains outside the preset contract', () => {
    expect(readCodexPresetOptions(harness)).toMatchObject({ hostedWebSearchEnabled: true, remoteCompactionEnabled: true })
    const patched = patchCodexPresetOptions(harness, { hostedWebSearchEnabled: false, remoteCompactionEnabled: false, planToolEnabled: false })
    expect(readCodexPresetOptions(patched)).toMatchObject({ hostedWebSearchEnabled: false, remoteCompactionEnabled: false, planToolEnabled: false })
    expect(patched).toContain('codexCore: true')
  })
  it('uses preset instructions over global instructions, preserving other controls and empty prompts', () => {
    const shared = { ...CODEX_SETTINGS_ENTRY, systemPrompt: 'global', patchToolEnabled: false }
    expect(withPresetPrompt(shared, 'local')).toMatchObject({ systemPrompt: 'local', patchToolEnabled: false })
    expect(withPresetPrompt(shared, '')).toMatchObject({ systemPrompt: '' })
    expect(withPresetPrompt(shared, undefined)).toBe(shared)
  })
  it('exports only portable instruction fields and rejects unknown schema versions', () => {
    const fields = { name: 'Review', description: '', systemPrompt: 'Check tests', inheritPrompt: false, secret: 'not exported' }
    const serialized = exportPromptCard(fields)
    expect(serialized).not.toContain('secret')
    expect(parsePromptCard(serialized)).toMatchObject({ name: 'Review', version: 1 })
    expect(() => parsePromptCard(serialized.replace('"version": 1', '"version": 2'))).toThrow()
  })
})
