import { describe, expect, it, vi } from 'vitest'
import { cachePresetCatalog, cachedPresetCatalog, cachedPresetPrompts, cachedPresetTools, readPresetWithRetry, requestPresetCatalog, requestPresetPrompts, requestPresetTools } from '../../src/client/preset-requests.ts'
import type { PresetManagerActions } from '../../src/client/preset-manager.tsx'

const value = { presets: [{ id: 'actual-id', name: 'Readable label', description: '', isDefault: true }], excludedCount: 0 }

describe('shared preset catalog reads', () => {
  it('coalesces concurrent surfaces and reuses accepted results until explicit refresh', async () => {
    let release!: () => void
    const ready = new Promise<void>(resolve => { release = resolve })
    const catalog = vi.fn(async () => ({ ok: true, value }))
    const manager = { ready, remote: { codexPresetEditor: { catalog } } } as unknown as PresetManagerActions
    const tabRead = requestPresetCatalog(manager)
    const sourceRead = requestPresetCatalog(manager, true)
    expect(sourceRead).toBe(tabRead)
    expect(catalog).not.toHaveBeenCalled()
    release()
    expect(await tabRead).toBe(value)
    expect(await sourceRead).toBe(value)
    expect(catalog).toHaveBeenCalledOnce()
    expect(cachedPresetCatalog(manager)).toBe(value)
    expect(await requestPresetCatalog(manager)).toBe(value)
    expect(catalog).toHaveBeenCalledOnce()
    await requestPresetCatalog(manager, true)
    expect(catalog).toHaveBeenCalledTimes(2)
  })

  it('does not cache failures or poll and permits an explicit retry', async () => {
    const catalog = vi.fn().mockRejectedValueOnce(new Error('offline')).mockResolvedValue({ ok: true, value })
    const manager = { ready: Promise.resolve(), remote: { codexPresetEditor: { catalog } } } as unknown as PresetManagerActions
    await expect(requestPresetCatalog(manager)).rejects.toThrow('offline')
    expect(cachedPresetCatalog(manager)).toBeUndefined()
    for (let turn = 0; turn < 20; turn++) await Promise.resolve()
    expect(catalog).toHaveBeenCalledOnce()
    expect(await requestPresetCatalog(manager, true)).toBe(value)
    expect(catalog).toHaveBeenCalledTimes(2)
  })

  it('shares catalog updates from the existing preset manager', async () => {
    const catalog = vi.fn()
    const manager = { ready: Promise.resolve(), remote: { codexPresetEditor: { catalog } } } as unknown as PresetManagerActions
    cachePresetCatalog(manager, value)
    expect(await requestPresetCatalog(manager)).toBe(value)
    expect(catalog).not.toHaveBeenCalled()
  })

  it('coalesces tool reads per manager and exact preset ID without sharing different presets', async () => {
    const tools = vi.fn(async (preset: string) => ({ ok: true, value: { preset, registeredOnly: true, tools: [] } }))
    const manager = { ready: Promise.resolve(), remote: { codexPresetEditor: { tools } } } as unknown as PresetManagerActions
    const first = requestPresetTools(manager, 'A')
    expect(requestPresetTools(manager, 'A', true)).toBe(first)
    const other = requestPresetTools(manager, 'B')
    expect(other).not.toBe(first)
    expect((await first).preset).toBe('A'); expect((await other).preset).toBe('B')
    await requestPresetTools(manager, 'A'); expect(tools).toHaveBeenCalledTimes(2)
    await requestPresetTools(manager, 'A', true); expect(tools).toHaveBeenCalledTimes(3)
    expect(cachedPresetTools(manager, 'B')?.preset).toBe('B')
  })

  it('refuses mismatched snapshots and old endpoints without inventing tools or polling', async () => {
    const tools = vi.fn(async () => ({ ok: true, value: { preset: 'wrong', registeredOnly: true, tools: [] } }))
    const manager = { ready: Promise.resolve(), remote: { codexPresetEditor: { tools } } } as unknown as PresetManagerActions
    await expect(requestPresetTools(manager, 'selected')).rejects.toThrow('mismatched')
    expect(cachedPresetTools(manager, 'selected')).toBeUndefined()
    for (let i = 0; i < 20; i++) await Promise.resolve()
    expect(tools).toHaveBeenCalledOnce()
    const old = { ready: Promise.resolve(), remote: { codexPresetEditor: {} } } as unknown as PresetManagerActions
    await expect(requestPresetTools(old, 'selected')).rejects.toThrow('unavailable')
  })

  it('shares prompt reads per exact preset without reusing another preset’s text', async () => {
    const prompts = vi.fn(async (preset: string) => ({ ok: true, value: { preset, sections: [] } }))
    const manager = { ready: Promise.resolve(), remote: { codexPresetEditor: { prompts } } } as unknown as PresetManagerActions
    const a = requestPresetPrompts(manager, 'A'); expect(requestPresetPrompts(manager, 'A', true)).toBe(a)
    const b = requestPresetPrompts(manager, 'B'); expect(b).not.toBe(a)
    expect((await a).preset).toBe('A'); expect((await b).preset).toBe('B')
    await requestPresetPrompts(manager, 'A'); expect(prompts).toHaveBeenCalledTimes(2)
    await requestPresetPrompts(manager, 'A', true); expect(prompts).toHaveBeenCalledTimes(3)
    expect(cachedPresetPrompts(manager, 'B')?.preset).toBe('B')
  })

  it('rejects wrong/unsupported prompt snapshots instead of falling back to editor defaults', async () => {
    const read = vi.fn()
    const prompts = vi.fn(async () => ({ ok: true, value: { preset: 'wrong', sections: [] } }))
    const manager = { ready: Promise.resolve(), remote: { codexPresetEditor: { prompts, read } } } as unknown as PresetManagerActions
    await expect(requestPresetPrompts(manager, 'selected')).rejects.toThrow('mismatched')
    expect(cachedPresetPrompts(manager, 'selected')).toBeUndefined(); expect(read).not.toHaveBeenCalled()
    const old = { ready: Promise.resolve(), remote: { codexPresetEditor: { read } } } as unknown as PresetManagerActions
    await expect(requestPresetPrompts(old, 'selected')).rejects.toThrow('unavailable'); expect(read).not.toHaveBeenCalled()
  })

  it('retries transient connection failures once while active and rethrows logic errors immediately', async () => {
    const conn = vi.fn().mockRejectedValueOnce(new Error('Failed to fetch')).mockResolvedValueOnce('recovered')
    await expect(readPresetWithRetry(conn, () => true)).resolves.toBe('recovered')
    expect(conn).toHaveBeenCalledTimes(2)

    const perm = vi.fn().mockRejectedValueOnce(new Error('invalid-preset-id'))
    await expect(readPresetWithRetry(perm, () => true)).rejects.toThrow('invalid-preset-id')
    expect(perm).toHaveBeenCalledTimes(1)
  })
})
