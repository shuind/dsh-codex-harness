/** Public, read-only preset prompt discovery. No private registry, Agent, or JS/YAML evaluation. */
import { randomUUID } from 'node:crypto'
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-agent-preset-registry'
import { createScope } from '@deepseek-ai/dsh-scope'
import type { Scope, ScopeKey } from '@deepseek-ai/dsh-scope'
import { PERSONA_PREFIX_SECTION, PERSONA_SUFFIX_SECTION } from '@deepseek-ai/dsh-system-prompt'
import type { PromptSection } from '@deepseek-ai/dsh-system-prompt'
import { isMap, isScalar, isSeq, parseDocument, YAMLMap } from 'yaml'
import type { PresetPromptCatalog, PresetPromptEntry, PresetPromptName, PresetPromptOverride } from '../contracts/ui-contracts.ts'

interface Candidate {
  name: PresetPromptName
  label: string
  module: string
  order: number
  complete: boolean
  interpolate: boolean
  literal?: string
  reason?: string
}
export interface PresetPromptProbe {
  readonly catalog: PresetPromptCatalog
  readonly scope: ScopeKey
  readonly modules: string
  readonly definitions: ReadonlyMap<PresetPromptName, PromptSection>
}
export interface PreparedPromptOverride {
  readonly scope: ScopeKey
  readonly modules: string
  readonly sections: readonly PromptSection[]
}

function literal(map: YAMLMap, key: string): unknown {
  const node = map.get(key, true)
  return isScalar(node) && !node.tag ? node.value : undefined
}

/** Native Persona's public source owns these exact names/placements/complete semantics. */
function candidates(content: string, placement: (name: 'DEPLOYMENT_PERSONA_PREFIX' | 'DEPLOYMENT_PERSONA_SUFFIX') => number) {
  const doc = parseDocument(content, { strict: true, uniqueKeys: true, logLevel: 'silent' })
  if (doc.errors.length || !isSeq(doc.contents)) throw new Error('invalid-preset-prompt-declaration')
  const found: Candidate[] = []
  const readonly: PresetPromptEntry[] = []
  function visit(rows: unknown, parent = '', conditionalParent = false, isolatedParent = false): void {
    if (!isSeq(rows)) return
    for (const [index, row] of rows.items.entries()) {
      if (!isMap(row) || literal(row, 'disabled') === true) continue
      const module = literal(row, 'name')
      const path = `${parent}/${String(literal(row, 'id') ?? index)}`
      const conditionalRow = conditionalParent || row.has('disabled') && literal(row, 'disabled') === undefined
      const isolation = row.get('isolate', true)
      const isolated = isolatedParent || row.has('isolate') && (!isMap(isolation) || isolation.has('systemPrompt'))
      let config: unknown = row.get('config', true)
      if (isSeq(config)) { visit(config, path, conditionalRow, isolated); continue }
      if (config === undefined && module === '@shuind/dsh-codex-harness') config = new YAMLMap()
      if (typeof module !== 'string' || !isMap(config)) continue
      if (module === '@deepseek-ai/dsh-persona') {
        const completeNode = config.get('complete', true)
        const complete = literal(config, 'complete')
        const uncertain = conditionalRow || completeNode !== undefined && typeof complete !== 'boolean'
        for (const [key, name, order, label] of [
          ['prefix', PERSONA_PREFIX_SECTION, placement('DEPLOYMENT_PERSONA_PREFIX'), 'Persona'],
          ['suffix', PERSONA_SUFFIX_SECTION, placement('DEPLOYMENT_PERSONA_SUFFIX'), 'Persona · suffix'],
        ] as const) {
          const text = literal(config, key)
          const missingSuffix = key === 'suffix' && !config.has(key)
          // Native Persona validates prefix/suffix to strings at mount, then
          // registers static text. A !!js declaration is never evaluated here;
          // its actual registered text is read by assemble and marker-verified.
          const reason = isolated ? 'isolated-prompt-registry' : uncertain ? 'dynamic-declaration' : undefined
          found.push({ name, label, module, order, complete: key === 'prefix' && complete === true, interpolate: true,
            ...(typeof text === 'string' ? { literal: text } : missingSuffix ? { literal: '' } : {}),
            ...(reason === undefined ? {} : { reason }) })
        }
      } else if (module === '@shuind/dsh-codex-harness' && literal(config, 'codexCore') !== false) {
        found.push({ name: 'codex:base', label: 'Codex 操作提示词', module, order: 10, complete: false, interpolate: true,
          ...(isolated ? { reason: 'isolated-prompt-registry' } : conditionalRow || config.has('codexCore') && literal(config, 'codexCore') === undefined ? { reason: 'dynamic-declaration' } : {}) })
      } else {
        // Unknown field-to-section mappings are not editable just because their
        // spelling resembles a prompt. Never return a !!js expression as prose.
        for (const key of ['prefix', 'suffix', 'text', 'section', 'prompt', 'systemPrompt', 'instructions']) {
          if (!config.has(key) || module === '@deepseek-ai/dsh-plan-mode') continue
          const text = literal(config, key)
          readonly.push({ name: `declaration:${path}:${key}`, label: `${module} · ${key}`,
            text: typeof text === 'string' ? text : '', editable: false,
            reason: typeof text === 'string' ? 'unknown-section-contract' : 'dynamic-declaration' })
        }
      }
    }
  }
  visit(doc.contents)
  return { found, readonly }
}

function moduleSignature(rows: readonly { moduleName: string; baseUrl?: string; useHostBase: boolean }[]): string {
  return JSON.stringify(rows.map(row => [row.moduleName, row.baseUrl ?? '', row.useHostBase]))
}

const probeCache = new WeakMap<ScopeKey, Map<string, PresetPromptProbe>>()

async function runProbePresetPrompts(
  ctx: Context,
  preset: string,
  expectedScope: ScopeKey | undefined,
  useCache: boolean,
): Promise<PresetPromptProbe> {
  if (typeof preset !== 'string' || !preset.trim() || preset.length > 256) throw new Error('invalid-preset-id')
  const registry = ctx.get('agentPresets')
  const prompt = ctx.get('systemPrompt')
  if (registry === undefined || prompt === undefined || typeof registry.acquireScope !== 'function'
    || typeof registry.readDocument !== 'function' || typeof registry.inspectCompositions !== 'function') {
    throw new Error('preset-prompt-catalog-unavailable')
  }
  const document = await registry.readDocument(preset)
  const lease = await registry.acquireScope(preset)
  let view: Scope | undefined
  try {
    if (expectedScope !== undefined && lease.key !== expectedScope) throw new Error('preset-prompt-revision-mismatch')
    const key = {}
    view = createScope(ctx, key, { parent: lease.key })
    const inspection = registry.inspectCompositions(view.ctx)
    if (inspection.length !== 1 || inspection[0]?.id !== preset) throw new Error('preset-prompt-revision-unavailable')
    const modules = moduleSignature(inspection[0].modules)
    const cacheKey = `${preset}\0${modules}\0${document.content}`
    if (useCache) {
      const cached = probeCache.get(lease.key)?.get(cacheKey)
      if (cached !== undefined) return cached
    }
    const active = new Set(inspection[0].modules.map(row => row.moduleName))
    const declared = candidates(document.content, name => prompt.getSectionOrder(name))
    const definitions = new Map<PresetPromptName, PromptSection>()
    const sections: PresetPromptEntry[] = []
    // Show the actual effective original, including legacy own-plugin rewrites.
    // Only marker validation suppresses those rewrites; no model runs here.
    let baseline
    try { baseline = await prompt.assemble({ scope: key }) }
    catch {
      return { scope: lease.key, modules, definitions, catalog: { preset, sections: [
        ...declared.found.map(row => ({ name: row.name, label: row.label, text: row.literal ?? '', editable: false, reason: 'assembly-unavailable' })),
        ...declared.readonly,
      ].slice(0, 200) } }
    }
    const seen = new Set<string>()
    for (const row of declared.found) {
      if (seen.has(row.name)) continue
      seen.add(row.name)
      const actual = baseline.sections.find(section => section.name === row.name)
      let reason = row.reason
        ?? (!active.has(row.module) ? 'inactive-contribution' : undefined)
        ?? (declared.found.filter(candidate => candidate.name === row.name).length !== 1 ? 'ambiguous-contribution' : undefined)
        ?? (actual === undefined ? 'not-effective-or-complete-suppressed' : undefined)
      if (reason === undefined && row.complete && (baseline.sections.length !== 1 || baseline.sections[0]?.name !== row.name)) reason = 'complete-contract-mismatch'
      if (reason === undefined) {
        const marker = `preset-prompt-probe:${randomUUID()}`
        const undo = view.ctx.get('systemPrompt')!.section({ name: row.name, order: row.order, complete: row.complete,
          interpolate: row.interpolate, text: marker })
        try {
          const probed = await prompt.assemble({ scope: key, codexPresetPromptProbe: true })
          if (probed.sections.find(section => section.name === row.name)?.text !== marker
            || JSON.stringify(probed.sections.map(section => section.name)) !== JSON.stringify(baseline.sections.map(section => section.name))
            || row.complete && (probed.sections.length !== 1 || probed.sections[0]?.name !== row.name)) reason = 'not-directly-overridable'
        } catch { reason = 'not-directly-overridable' }
        finally { undo() }
      }
      const text = actual?.text ?? row.literal ?? ''
      if (text.length > 1_000_000) reason = 'prompt-too-large'
      sections.push({ name: row.name, label: row.label, text: text.slice(0, 1_000_000), editable: reason === undefined,
        order: row.order, complete: row.complete, interpolate: row.interpolate,
        ...(reason === undefined ? {} : { reason }) })
      if (reason === undefined) definitions.set(row.name, { name: row.name, order: row.order, complete: row.complete,
        interpolate: row.interpolate, text })
    }
    for (const row of baseline.sections) {
      if (!seen.has(row.name)) sections.push({ name: row.name, label: row.name, text: row.text.slice(0, 1_000_000), editable: false, reason: 'unknown-or-host-owned-section' })
    }
    sections.push(...declared.readonly)
    if ((await registry.readDocument(preset)).content !== document.content) throw new Error('preset-prompt-revision-mismatch')
    const probe: PresetPromptProbe = { scope: lease.key, modules, definitions, catalog: { preset, sections: sections.slice(0, 200) } }
    if (useCache) {
      let byKey = probeCache.get(lease.key)
      if (byKey === undefined) {
        byKey = new Map()
        probeCache.set(lease.key, byKey)
      }
      byKey.set(cacheKey, probe)
    }
    return probe
  } finally {
    try { await view?.dispose() }
    finally { await lease[Symbol.asyncDispose]() }
  }
}

/** The opaque scope identity is retained only for runtime revision validation, not sent over RPC. */
export async function probePresetPrompts(ctx: Context, preset: string, expectedScope?: ScopeKey): Promise<PresetPromptProbe> {
  return runProbePresetPrompts(ctx, preset, expectedScope, false)
}

/** Cached variant keyed by live scope identity, active modules, and document content. */
export async function probePresetPromptsCached(ctx: Context, preset: string, expectedScope?: ScopeKey): Promise<PresetPromptProbe> {
  return runProbePresetPrompts(ctx, preset, expectedScope, true)
}

export async function readPresetPromptCatalog(ctx: Context, preset: string): Promise<PresetPromptCatalog> {
  return (await probePresetPrompts(ctx, preset)).catalog
}

export function preparePromptOverrides(probe: PresetPromptProbe, overrides: readonly PresetPromptOverride[]): PreparedPromptOverride {
  const sections = overrides.map(override => {
    const original = probe.definitions.get(override.name)
    if (original === undefined) throw new Error(`unsupported-preset-prompt-override: ${override.name}`)
    return { ...original, text: override.text }
  })
  return { scope: probe.scope, modules: probe.modules, sections }
}

export function matchesPromptRevision(ctx: Context, preset: string, prepared: PreparedPromptOverride): boolean {
  const inspection = ctx.get('agentPresets')?.inspectCompositions(ctx)
  return inspection?.length === 1 && inspection[0]?.id === preset && moduleSignature(inspection[0].modules) === prepared.modules
}
