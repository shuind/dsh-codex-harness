import { createHash, randomUUID } from 'node:crypto'
import { readFile, realpath, stat, unlink } from 'node:fs/promises'
import { dirname, isAbsolute, relative, resolve } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import { Remote, TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol'
import { isMap, isScalar, isSeq, parseDocument, Scalar, YAMLMap } from 'yaml'
import { DEFAULT_CODEX_PERSONA, DEFAULT_CODEX_SYSTEM_PROMPT, DEFAULT_DSH_CORE_SOURCE_PROMPT, DEFAULT_DSH_CORE_WEB_PROMPT } from './prompt.ts'
import type { CodexSettings } from './settings.ts'
import type { CodexPresetOptions, PresetCatalog, PresetCreateInput, PresetEditorInput, PresetEditorDocument, PresetPromptSection } from './preset-contract.ts'
export type { PresetEditorInput, PresetEditorDocument } from './preset-contract.ts'

type AtomicWriteModule = typeof import('@deepseek-ai/dsh-atomic-write')
let atomicWriteModule: Promise<AtomicWriteModule> | undefined
function loadAtomicWrite(): Promise<AtomicWriteModule> {
  return atomicWriteModule ??= import('@deepseek-ai/dsh-atomic-write')
}
const PRESET_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/
export const DEFAULT_CODEX_PRESET_OPTIONS: CodexPresetOptions = {
  promptEnabled: true,
  terminalToolsEnabled: true,
  patchToolEnabled: true,
  planToolEnabled: true,
  hostedWebSearchEnabled: true,
  remoteCompactionEnabled: true,
}
const CODEX_OPTION_KEYS = Object.keys(DEFAULT_CODEX_PRESET_OPTIONS) as Array<keyof CodexPresetOptions>
export interface ResolvedPresetForEditor {
  id: string; trust: 'system' | 'user'; path: string; broken?: string
  name?: string; description?: string
}
export interface AgentPresetsForEditor {
  list?(): Promise<ResolvedPresetForEditor[]>
  readonly defaultId?: string
  readonly authorable?: boolean
  resolve(id: string): Promise<ResolvedPresetForEditor>
  readDocument(id: string): Promise<{ content: string; name?: string; description?: string }>
  remoteExportList(): Promise<{ presets: Array<{ id: string; name?: string; description?: string; trust: 'system' | 'user'; isDefault: boolean; broken?: string }>; authorable: boolean }>
  copy(from: string, id: string, name?: string): Promise<void>
  remove(id: string): Promise<void>
  readonly roots?: readonly { path: string; trust: 'system' | 'user' }[]
}

/** Parse tags as syntax only; never execute !!js or resolve aliases into objects. */
function yaml(content: string) {
  const doc = parseDocument(content, { strict: true, uniqueKeys: true })
  if (doc.errors.length) throw new Error('invalid-preset-yaml')
  return doc
}
function harnessConfig(content: string) {
  const doc = yaml(content)
  if (!isSeq(doc.contents)) throw new Error('unsupported-preset')
  const rows = doc.contents.items.filter(row => isMap(row)
    && (row as YAMLMap).get('name') === '@shuind/dsh-codex-harness'
    && (row as YAMLMap).get('disabled') !== true)
  if (rows.length !== 1) throw new Error('unsupported-preset')
  const row = rows[0] as YAMLMap
  let config: unknown = row.get('config', true)
  if (config === undefined) { config = new YAMLMap(); row.set('config', config) }
  if (!isMap(config) || config.get('codexCore') === false) throw new Error('unsupported-preset')
  return { doc, config }
}
function explicitPrompt(content: string): string | undefined {
  const { config } = harnessConfig(content)
  const node = config.get('presetPrompt', true) ?? config.get('systemPrompt', true)
  if (node === undefined) return undefined
  if (!isScalar(node) || typeof node.value !== 'string' || node.tag) throw new Error('unsupported-prompt-expression')
  return node.value
}

const SECTION_PLUGIN = '@shuind/dsh-codex-harness/prompt-sections'
function promptFile(node: Scalar): string | undefined {
  if (!node.tag || typeof node.value !== 'string') return undefined
  // Recognize this literal file reference only. Never evaluate arbitrary JS.
  return node.value.match(/^process\.getBuiltinModule\(['"]node:fs['"]\)\.readFileSync\(new URL\(['"]([^'"]+)['"],\s*baseUrl\),\s*['"]utf8['"]\)$/)?.[1]
}
/** Read the actual literal prompt fields, including nested groups, without evaluating YAML tags. */
function promptFields(doc: ReturnType<typeof yaml>) {
  const fields: Array<{ id: string; label: string; node: Scalar; row: YAMLMap; key: string }> = []
  function visit(sequence: unknown, parents: string[] = []) {
    if (!isSeq(sequence)) return
    for (const row of sequence.items) {
      if (!isMap(row) || row.get('disabled') === true) continue
      const path = [...parents, String(row.get('id'))]
      const config = row.get('config', true)
      if (isSeq(config)) { visit(config, path); continue }
      if (!isMap(config)) continue
      const plugin = String(row.get('name'))
      // Plan-mode instructions are mode-specific policy, not preset prompt customization.
      if (plugin === '@deepseek-ai/dsh-plan-mode') continue
      const keys = plugin === '@deepseek-ai/dsh-persona' ? ['prefix', 'text', 'suffix']
        : plugin === '@shuind/dsh-codex-harness' || plugin === SECTION_PLUGIN ? []
          : ['prefix', 'suffix', 'text', 'section', 'prompt', 'systemPrompt', 'instructions']
      for (const key of keys) {
        const node = config.get(key, true)
        if (!isScalar(node)) continue
        fields.push({ id: JSON.stringify([...path, key]), label: plugin === '@deepseek-ai/dsh-persona'
          ? (key === 'suffix' ? 'Persona · suffix' : 'Persona') : `${path.join(' / ')} · ${key}`, node, row: config, key })
      }
    }
  }
  visit(doc.contents)
  return fields
}
function sectionConfig(content: string): YAMLMap | undefined {
  if (supportsCodex(content)) {
    const value = harnessConfig(content).config.get('presetSections', true)
    return isMap(value) ? value : undefined
  }
  const doc = yaml(content)
  if (!isSeq(doc.contents)) return undefined
  const row = doc.contents.items.find(row => isMap(row) && (row as YAMLMap).get('name') === SECTION_PLUGIN)
  const config = isMap(row) ? row.get('config', true) : undefined
  return isMap(config) ? config : undefined
}
/** Some presets intentionally shadow host prompt sections with empty entries. */
function suppressesHostSections(content: string): boolean {
  const doc = yaml(content)
  let suppressed = false
  function visit(sequence: unknown): void {
    if (!isSeq(sequence)) return
    for (const row of sequence.items) {
      if (!isMap(row)) continue
      const id = String(row.get('id') ?? '')
      const plugin = String(row.get('name') ?? '')
      if (id === 'story-prompt-clean-slate' || plugin === './tools/prompt/clean-slate.mjs' || /(?:^|[\\/])clean-slate\.mjs$/u.test(plugin)) {
        suppressed = true
        return
      }
      const config = row.get('config', true)
      if (isSeq(config)) visit(config)
      if (suppressed) return
    }
  }
  visit(doc.contents)
  return suppressed
}
export function readPromptSections(content: string, shared: Partial<CodexSettings> = {}): PresetPromptSection[] {
  const codex = supportsCodex(content)
  const overrides = sectionConfig(content)
  const fields = promptFields(yaml(content))
  const sections: PresetPromptSection[] = fields.map(({ id, label, node }) => ({ id, label, text: String(node.value ?? ''), editable: !node.tag && typeof node.value === 'string' }))
  // Legacy Codex global overrides remain visible until the preset is saved locally.
  const persona = sections.find(section => section.label === 'Persona')
  const personaOverride = !overrides?.has('persona') && codex ? shared.persona : undefined
  if (persona && typeof personaOverride === 'string' && personaOverride !== DEFAULT_CODEX_PERSONA) persona.text = personaOverride
  const complete = fields.some(field => field.label.startsWith('Persona') && field.row.get('complete') === true)
  // These are host prompt sections, not Codex capability toggles. The Web
  // host registers them for non-complete agents unless the composition
  // explicitly shadows them (Story's clean-slate plugin does exactly that).
  const hasHostSections = !complete && !suppressesHostSections(content)
  if (hasHostSections) sections.splice(persona ? 1 : 0, 0,
    { id: 'harness:source', label: 'DSH Core 源码说明', text: String(overrides?.get('harnessSourcePrompt') ?? (codex ? shared.harnessSourcePrompt : undefined) ?? DEFAULT_DSH_CORE_SOURCE_PROMPT), editable: true },
    { id: 'app:web-surface', label: 'DSH Core Web 说明', text: String(overrides?.get('webSurfacePrompt') ?? (codex ? shared.webSurfacePrompt : undefined) ?? DEFAULT_DSH_CORE_WEB_PROMPT), editable: true })
  if (codex) {
    const index = persona ? (hasHostSections ? 3 : 1) : (hasHostSections ? 2 : 0)
    sections.splice(index, 0, { id: 'codex:base', label: 'Codex 操作提示词', text: explicitPrompt(content) ?? shared.systemPrompt ?? DEFAULT_CODEX_SYSTEM_PROMPT, editable: true })
  }
  return sections
}
/** Patch the contributing fields, not a disconnected secondary prompt. */
export function patchPromptSections(content: string, sections: PresetPromptSection[]): string {
  const doc = yaml(content)
  const fields = promptFields(doc)
  const known = new Map(readPromptSections(content).map(section => [section.id, section]))
  const overrides: Record<string, string> = {}
  const seen = new Set<string>()
  for (const section of sections) {
    const field = fields.find(field => field.id === section.id)
    if (seen.has(section.id) || (!known.get(section.id)?.editable && !(field && promptFile(field.node))) || typeof section.text !== 'string' || section.text.length > 1_000_000) throw new Error('invalid-prompt-section')
    seen.add(section.id)
    if (field) {
      const node = new Scalar(section.text); node.type = Scalar.BLOCK_LITERAL
      field.row.set(field.key, node)
      continue
    }
    // Merely saving a generic preset must not freeze inherited DSH defaults or
    // install an override plugin. An actual edit is enough; it never needs Codex.
    if (!supportsCodex(content) && known.get(section.id)?.text === section.text) continue
    if (section.id === 'harness:source') overrides.harnessSourcePrompt = section.text
    if (section.id === 'app:web-surface') overrides.webSurfacePrompt = section.text
  }
  // Persona is edited at its original source. Override legacy shared settings with
  // that same value in Codex scopes, without touching another preset's identity.
  const personaFields = fields.filter(field => known.get(field.id)?.label.startsWith('Persona'))
  if (supportsCodex(content) && personaFields.length) overrides.persona = personaFields.map(field => sections.find(section => section.id === field.id)?.text ?? String(field.node.value)).join('\n\n')
  let result = doc.toString({ lineWidth: 0 })
  if (supportsCodex(result)) {
    const { doc: next, config } = harnessConfig(result)
    const previous = config.get('presetSections', true)
    const merged = isMap(previous) ? previous : new YAMLMap()
    for (const [key, value] of Object.entries(overrides)) merged.set(key, value)
    config.set('presetSections', merged)
    result = next.toString({ lineWidth: 0 })
    const operating = sections.find(section => section.id === 'codex:base')
    if (operating) result = patchPresetComposition(result, operating.text)
  } else if (Object.keys(overrides).length) {
    const next = yaml(result)
    if (!isSeq(next.contents)) throw new Error('invalid-preset-yaml')
    let row: unknown = next.contents.items.find(row => isMap(row) && (row as YAMLMap).get('name') === SECTION_PLUGIN)
    if (!isMap(row)) { const created = new YAMLMap(); created.set('id', `prompt-sections-${randomUUID().slice(0, 8)}`); created.set('name', SECTION_PLUGIN); next.add(created); row = created }
    const map = row as YAMLMap
    let config: unknown = map.get('config', true)
    if (!isMap(config)) { config = new YAMLMap(); map.set('config', config) }
    for (const [key, value] of Object.entries(overrides)) (config as YAMLMap).set(key, value)
    result = next.toString({ lineWidth: 0 })
  }
  return result
}
export function readCodexPresetOptions(content: string): CodexPresetOptions {
  try {
    const { config } = harnessConfig(content)
    const options = { ...DEFAULT_CODEX_PRESET_OPTIONS }
    for (const key of CODEX_OPTION_KEYS) {
      const value = config.get(key)
      if (typeof value === 'boolean') options[key] = value
    }
    return options
  } catch {
    return { ...DEFAULT_CODEX_PRESET_OPTIONS }
  }
}
export function supportsCodex(content: string): boolean {
  try { harnessConfig(content); return true } catch { return false }
}
/** Structural validation only: executable tags stay inert until DSH mounts a selected preset. */
export function validateComposition(content: string): void {
  if (content.length > 1_000_000) throw new Error('invalid-preset-yaml')
  const doc = yaml(content)
  if (!isSeq(doc.contents) || !doc.contents.items.length) throw new Error('invalid-preset-yaml')
  const ids = new Set<string>()
  for (const entry of doc.contents.items) {
    if (!isMap(entry)) throw new Error('invalid-preset-yaml')
    const row = entry as YAMLMap
    if (typeof row.get('name') !== 'string') throw new Error('invalid-preset-yaml')
    const id = row.get('id')
    if (typeof id !== 'string' || ids.has(id)) throw new Error('invalid-preset-yaml')
    ids.add(id)
  }
}
export function enhanceComposition(content: string): string {
  validateComposition(content)
  if (supportsCodex(content)) return content
  // A disabled/ambiguous Harness row needs explicit advanced editing, not a second instance.
  const doc = yaml(content)
  if (!isSeq(doc.contents)) throw new Error('invalid-preset-yaml')
  if (doc.contents.items.some(row => isMap(row) && (row as YAMLMap).get('name') === '@shuind/dsh-codex-harness')) throw new Error('ambiguous-harness-row')
  // A complete persona suppresses all contributed sections, including Codex's.
  // Keep its identity text while allowing the enhanced copy to compose prompts.
  for (const row of doc.contents.items) {
    if (!isMap(row) || (row as YAMLMap).get('name') !== '@deepseek-ai/dsh-persona') continue
    const persona = (row as YAMLMap).get('config', true)
    if (isMap(persona) && persona.get('complete') === true) persona.set('complete', false)
  }
  doc.add(doc.createNode({ id: `codex-harness-${randomUUID().slice(0, 8)}`,
    name: '@shuind/dsh-codex-harness', config: { globalEnhancements: false, codexCore: true } }))
  return doc.toString({ lineWidth: 0 })
}
export function readPresetSystemPrompt(content: string): string {
  return explicitPrompt(content) ?? DEFAULT_CODEX_SYSTEM_PROMPT
}
export function patchPresetComposition(content: string, prompt: string, inherit = false): string {
  const { doc, config } = harnessConfig(content)
  // Migrate the old field, avoiding two competing prompt sources.
  config.delete('systemPrompt')
  if (inherit) config.delete('presetPrompt')
  else {
    const node = new Scalar(prompt)
    node.type = prompt.includes('\n') ? Scalar.BLOCK_LITERAL : Scalar.QUOTE_DOUBLE
    config.set('presetPrompt', node)
  }
  return doc.toString({ lineWidth: 0 })
}
/** Store user-facing Codex capability switches in the Harness row. */
export function patchCodexPresetOptions(content: string, options: Partial<CodexPresetOptions>): string {
  const { doc, config } = harnessConfig(content)
  for (const key of CODEX_OPTION_KEYS) {
    const value = options[key]
    if (value !== undefined) config.set(key, value)
  }
  return doc.toString({ lineWidth: 0 })
}
export function patchPresetMetadata(content: string, name: string, description: string): string {
  const doc = yaml(content)
  if (doc.contents !== null && !isMap(doc.contents)) throw new Error('invalid-preset-metadata')
  for (const [key, value] of Object.entries({ name, description })) {
    const node = new Scalar(value)
    node.type = Scalar.QUOTE_DOUBLE
    doc.set(key, node)
  }
  return doc.toString({ lineWidth: 0 })
}
function validate<T extends PresetCreateInput | PresetEditorInput>(input: T): T {
  if (typeof input.name !== 'string' || !input.name.trim() || /[\r\n]/.test(input.name) || input.name.length > 200) throw new Error('invalid-preset-name')
  if (typeof input.description !== 'string' || input.description.length > 4000) throw new Error('invalid-preset-description')
  if (typeof input.systemPrompt !== 'string' || input.systemPrompt.length > 1_000_000) throw new Error('invalid-preset-prompt')
  return { ...input, name: input.name.trim() }
}
function revision(composition: string, metadata: string | undefined): string {
  return createHash('sha256').update(composition).update('\0').update(metadata ?? '').digest('hex')
}
async function optionalFile(path: string): Promise<string | undefined> {
  try { return await readFile(path, 'utf8') }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined; throw error }
}
async function mode(path: string): Promise<number> {
  try { return (await stat(path)).mode & 0o777 } catch { return 0o600 }
}
async function assertWithinRoot(path: string, roots: AgentPresetsForEditor['roots']): Promise<void> {
  if (!roots?.length) throw new Error('preset-root-unavailable')
  const target = await realpath(path)
  for (const root of roots) {
    if (root.trust !== 'user') continue
    const home = process.env.DSH_HOME ?? process.env.USERPROFILE ?? process.env.HOME ?? ''
    const expanded = root.path.replace(/^~(?=[\\/]|$)/, home)
    try {
      const rel = relative(await realpath(resolve(expanded)), target)
      if (!isAbsolute(rel) && rel !== '..' && !rel.startsWith('../') && !rel.startsWith('..\\')) return
    } catch { /* An absent root cannot own this path. */ }
  }
  throw new Error('preset-outside-user-root')
}
export class CodexPresetEditor extends TypertRemoteService {
  static inject = ['agentPresets', 'settings']
  private readonly agentPresets: AgentPresetsForEditor
  private sharedSettings?: () => Partial<CodexSettings>
  private indexed?: Map<string, ResolvedPresetForEditor>
  constructor(ctx: Context, _config?: undefined) {
    super(ctx, 'codexPresetEditor')
    this.agentPresets = ctx.get('agentPresets') as unknown as AgentPresetsForEditor
    const settings = ctx.get('settings') as unknown as { get(ns: string): Partial<CodexSettings> | undefined }
    this.sharedSettings = () => settings?.get('codex') ?? {}
  }
  async catalog(): Promise<PresetCatalog> {
    if (this.agentPresets.list) {
      const rows = await this.agentPresets.list()
      this.indexed = new Map(rows.map(row => [row.id, row]))
      return { presets: rows.filter(row => row.broken === undefined).map(row => ({
        id: row.id, name: row.name || row.id, description: row.description ?? '',
        editable: row.trust === 'user', isDefault: row.id === this.agentPresets.defaultId,
      })), authorable: this.agentPresets.authorable ?? false, excludedCount: rows.filter(row => row.broken !== undefined).length }
    }
    const roster = await this.agentPresets.remoteExportList()
    // Listing must not read/resolve every composition: each host read rescans roots.
    const presets = roster.presets.filter(row => row.broken === undefined).map(row => ({
      id: row.id, name: row.name || row.id, description: row.description ?? '',
      editable: row.trust === 'user', isDefault: row.isDefault,
    }))
    return { presets, authorable: roster.authorable, excludedCount: roster.presets.length - presets.length }
  }
  async read(id: string): Promise<PresetEditorDocument> {
    // The catalog owns path discovery. Re-read the selected files on every cache
    // miss, and rebuild paths on Refresh; elapsed time must not trigger a full scan.
    const cached = this.indexed?.get(id)
    const preset = cached ?? await this.preset(id)
    if (preset.broken !== undefined) throw new Error('invalid-preset')
    const [composition, metadata] = await Promise.all([readFile(preset.path, 'utf8'), optionalFile(resolve(dirname(preset.path), 'preset.yml'))])
    const meta = metadata ? yaml(metadata) : undefined
    validateComposition(composition)
    const codex = supportsCodex(composition)
    const prompt = codex ? explicitPrompt(composition) : undefined
    const shared = this.sharedSettings?.() ?? {}
    const promptSections = readPromptSections(composition, shared)
    for (const field of promptFields(yaml(composition))) {
      const reference = promptFile(field.node)
      if (!reference) continue
      const section = promptSections.find(section => section.id === field.id)!
      try {
        const root = await realpath(dirname(preset.path))
        const target = await realpath(resolve(root, reference))
        const rel = relative(root, target)
        if (isAbsolute(rel) || rel === '..' || rel.startsWith('../') || rel.startsWith('..\\')) continue
        if ((await stat(target)).size > 1_000_000) continue
        section.text = await readFile(target, 'utf8')
        section.editable = true
      } catch { /* Unavailable references remain visible and read-only, with their expression intact. */ }
    }
    return { id, name: String(meta?.get('name') ?? id), description: String(meta?.get('description') ?? ''),
      systemPrompt: prompt ?? shared.systemPrompt ?? DEFAULT_CODEX_SYSTEM_PROMPT, inheritPrompt: prompt === undefined,
      revision: revision(composition, metadata), editable: preset.trust === 'user', codex,
      codexOptions: readCodexPresetOptions(composition), composition, promptSections }
  }
  async create(rawInput: PresetCreateInput): Promise<PresetEditorDocument> {
    const input = validate(rawInput)
    await this.preset(input.sourceId)
    const id = `codex-${randomUUID().slice(0, 12)}`
    await this.agentPresets.copy(input.sourceId, id, input.name)
    try {
      const copy = await this.read(id)
      const base = input.composition ?? copy.composition
      const composition = input.enableCodex ? enhanceComposition(base) : base
      let next = composition
      if (supportsCodex(next)) {
        next = patchPresetComposition(next, input.systemPrompt, input.inheritPrompt)
        next = patchCodexPresetOptions(next, input.codexOptions ?? {})
      }
      return await this.update({ ...input, id, revision: copy.revision, composition: next })
    } catch (error) {
      // Only the copy created by this operation is rolled back.
      await this.agentPresets.remove(id)
      throw error
    }
  }
  async update(rawInput: PresetEditorInput): Promise<PresetEditorDocument> {
    const input = validate(rawInput)
    const preset = await this.preset(input.id)
    if (preset.trust !== 'user') throw new Error('built-in presets cannot be edited here')
    const composition = resolve(preset.path)
    if (composition.split(/[\\/]/).at(-1) !== 'agent.cordis.yml') throw new Error('invalid-preset-path')
    await assertWithinRoot(composition, this.agentPresets.roots)
    const metadata = resolve(dirname(composition), 'preset.yml')
    if (await optionalFile(metadata) !== undefined) await assertWithinRoot(metadata, this.agentPresets.roots)
    const { withFileLock, writeFileAtomic } = await loadAtomicWrite()
    return withFileLock(composition, async () => {
      const oldComposition = await readFile(composition, 'utf8')
      const oldMetadata = await optionalFile(metadata)
      if (input.revision !== undefined && input.revision !== revision(oldComposition, oldMetadata)) throw new Error('preset-conflict')
      const editedComposition = input.composition !== undefined ? input.composition : oldComposition
      let nextComposition = input.enableCodex && !supportsCodex(editedComposition)
        ? enhanceComposition(editedComposition) : editedComposition
      if (supportsCodex(nextComposition)) {
        nextComposition = patchPresetComposition(nextComposition, input.systemPrompt, input.inheritPrompt)
        if (input.codexOptions !== undefined) nextComposition = patchCodexPresetOptions(nextComposition, input.codexOptions)
      }
      if (input.promptSections) nextComposition = patchPromptSections(nextComposition, input.promptSections)
      validateComposition(nextComposition)
      const nextMetadata = patchPresetMetadata(oldMetadata ?? '', input.name, input.description)
      const compositionMode = await mode(composition)
      const metadataMode = await mode(metadata)
      await writeFileAtomic(resolve(dirname(composition), '.codex-editor-backup.json'),
        JSON.stringify({ composition: oldComposition, metadata: oldMetadata ?? null }), { mode: 0o600, dirMode: 0o700 })
      try {
        await writeFileAtomic(composition, nextComposition, { mode: compositionMode, dirMode: 0o700 })
        await writeFileAtomic(metadata, nextMetadata, { mode: metadataMode, dirMode: 0o700 })
        const result = await this.agentPresets.resolve(input.id)
        if (result.broken !== undefined) throw new Error('invalid-preset-after-save')
        this.indexed?.set(input.id, result)
        return await this.read(input.id)
      } catch (error) {
        await writeFileAtomic(composition, oldComposition, { mode: compositionMode, dirMode: 0o700 })
        if (oldMetadata !== undefined) await writeFileAtomic(metadata, oldMetadata, { mode: metadataMode, dirMode: 0o700 })
        else await unlink(metadata).catch(cause => { if (cause.code !== 'ENOENT') throw cause })
        throw error
      }
    }, { waitMs: 10_000 })
  }
  private async preset(id: string): Promise<ResolvedPresetForEditor> {
    if (!PRESET_ID.test(id)) throw new Error('invalid-preset-id')
    const preset = await this.agentPresets.resolve(id)
    if (preset.broken !== undefined) throw new Error('invalid-preset')
    this.indexed ??= new Map()
    this.indexed.set(id, preset)
    return preset
  }
}

// Same decorator registration as the host, consumable by the Vitest transform.
function markRemoteMethod(methodName: 'read' | 'update' | 'catalog' | 'create'): void {
  const descriptor = Object.getOwnPropertyDescriptor(CodexPresetEditor.prototype, methodName)!
  const initializers: Array<(this: object) => void> = []
  const decorator = Remote(methodName) as unknown as (method: unknown, context: {
    kind: 'method'; name: string; static: false; private: false; addInitializer(initializer: (this: object) => void): void
  }) => void
  decorator(descriptor.value, { kind: 'method', name: methodName, static: false, private: false,
    addInitializer: initializer => { initializers.push(initializer) } })
  const receiver = Object.create(CodexPresetEditor.prototype) as object
  for (const initializer of initializers) initializer.call(receiver)
}
for (const method of ['read', 'update', 'catalog', 'create'] as const) markRemoteMethod(method)
export default CodexPresetEditor
