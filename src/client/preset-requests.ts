import type { PresetCatalog } from '../contracts/ui-contracts.ts'
import type { PresetManagerActions } from './preset-manager.tsx'
import type { PresetPromptCatalog, PresetToolCatalog } from '../contracts/tool-policy-contract.ts'

const catalogs = new WeakMap<PresetManagerActions, PresetCatalog>()
const catalogRequests = new WeakMap<PresetManagerActions, Promise<PresetCatalog>>()

export function cachedPresetCatalog(manager: PresetManagerActions): PresetCatalog | undefined {
  return catalogs.get(manager)
}

export function cachePresetCatalog(manager: PresetManagerActions, catalog: PresetCatalog): void {
  catalogs.set(manager, catalog)
}

/** One cache and one in-flight catalog read for every surface using this manager. */
export function requestPresetCatalog(manager: PresetManagerActions, refresh = false): Promise<PresetCatalog> {
  const pending = catalogRequests.get(manager)
  if (pending !== undefined) return pending
  const cached = catalogs.get(manager)
  if (!refresh && cached !== undefined) return Promise.resolve(cached)
  const request = (async () => {
    await manager.ready
    const result = await manager.remote.codexPresetEditor.catalog()
    if (!result.ok) throw new Error(result.error.message ?? 'preset-catalog-unavailable')
    catalogs.set(manager, result.value)
    return result.value
  })()
  catalogRequests.set(manager, request)
  void request.finally(() => {
    if (catalogRequests.get(manager) === request) catalogRequests.delete(manager)
  }).catch(() => {})
  return request
}

const toolCatalogs = new WeakMap<PresetManagerActions, Map<string, PresetToolCatalog>>()
const toolRequests = new WeakMap<PresetManagerActions, Map<string, Promise<PresetToolCatalog>>>()

export function cachedPresetTools(manager: PresetManagerActions, id: string): PresetToolCatalog | undefined {
  return toolCatalogs.get(manager)?.get(id)
}

/** The requested preset owns this snapshot; never substitute current-Agent tools. */
export function requestPresetTools(manager: PresetManagerActions, id: string, refresh = false): Promise<PresetToolCatalog> {
  const pending = toolRequests.get(manager)?.get(id)
  if (pending !== undefined) return pending
  const cached = cachedPresetTools(manager, id)
  if (!refresh && cached !== undefined) return Promise.resolve(cached)
  const requests = toolRequests.get(manager) ?? new Map<string, Promise<PresetToolCatalog>>()
  toolRequests.set(manager, requests)
  const request = (async () => {
    await manager.ready
    const remote = manager.remote.codexPresetEditor
    if (typeof remote.tools !== 'function') throw new Error('preset-tools-unavailable')
    const result = await remote.tools(id)
    if (!result.ok) throw new Error(result.error.message ?? 'preset-tools-unavailable')
    if (result.value.preset !== id || result.value.registeredOnly !== true || !Array.isArray(result.value.tools)) {
      throw new Error('preset-tools-mismatched-snapshot')
    }
    const catalogs = toolCatalogs.get(manager) ?? new Map<string, PresetToolCatalog>()
    catalogs.set(id, result.value); toolCatalogs.set(manager, catalogs)
    return result.value
  })()
  requests.set(id, request)
  void request.finally(() => { if (requests.get(id) === request) requests.delete(id) }).catch(() => {})
  return request
}

const promptCatalogs = new WeakMap<PresetManagerActions, Map<string, PresetPromptCatalog>>()
const promptRequests = new WeakMap<PresetManagerActions, Map<string, Promise<PresetPromptCatalog>>>()

export function cachedPresetPrompts(manager: PresetManagerActions, id: string): PresetPromptCatalog | undefined {
  return promptCatalogs.get(manager)?.get(id)
}

export function requestPresetPrompts(manager: PresetManagerActions, id: string, refresh = false): Promise<PresetPromptCatalog> {
  const pending = promptRequests.get(manager)?.get(id)
  if (pending !== undefined) return pending
  const cached = cachedPresetPrompts(manager, id)
  if (!refresh && cached !== undefined) return Promise.resolve(cached)
  const requests = promptRequests.get(manager) ?? new Map<string, Promise<PresetPromptCatalog>>()
  promptRequests.set(manager, requests)
  const request = (async () => {
    await manager.ready
    const remote = manager.remote.codexPresetEditor
    if (typeof remote.prompts !== 'function') throw new Error('preset-prompts-unavailable')
    const result = await remote.prompts(id)
    if (!result.ok) throw new Error(result.error.message ?? 'preset-prompts-unavailable')
    if (result.value.preset !== id || !Array.isArray(result.value.sections)) throw new Error('preset-prompts-mismatched-snapshot')
    const catalogs = promptCatalogs.get(manager) ?? new Map<string, PresetPromptCatalog>()
    catalogs.set(id, result.value); promptCatalogs.set(manager, catalogs)
    return result.value
  })()
  requests.set(id, request)
  void request.finally(() => { if (requests.get(id) === request) requests.delete(id) }).catch(() => {})
  return request
}

/** Only transport failures from a read can be retried without duplicating writes. */
export function isPresetConnectionError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error)
  return /Failed to fetch|NetworkError|Load failed|network request failed|no active Connection|connection.*(?:closed|offline)/i.test(message)
}

export async function readPresetWithRetry<T>(read: () => Promise<T>, active: () => boolean): Promise<T> {
  try { return await read() }
  catch (error) {
    if (!isPresetConnectionError(error) || !active()) throw error
    await new Promise(resolve => setTimeout(resolve, 300))
    if (!active()) throw error
    return read()
  }
}
