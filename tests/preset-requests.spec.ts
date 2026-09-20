import { describe, expect, it, vi } from 'vitest'
import { readPresetWithRetry } from '../src/client/preset-requests.ts'

describe('preset reads across a disconnected carrier', () => {
  it('recovers once when the connection resumes', async () => {
    const read = vi.fn().mockRejectedValueOnce(new Error('client api: codexPresetEditor/read failed: Failed to fetch')).mockResolvedValue({ id: 'minimal' })
    await expect(readPresetWithRetry(read, () => true)).resolves.toEqual({ id: 'minimal' })
    expect(read).toHaveBeenCalledTimes(2)
  })
  it('stops after one retry and leaves a persistent failure visible', async () => {
    const read = vi.fn().mockRejectedValue(new Error('Failed to fetch'))
    await expect(readPresetWithRetry(read, () => true)).rejects.toThrow('Failed to fetch')
    expect(read).toHaveBeenCalledTimes(2)
  })
  it('does not retry invalid presets or an abandoned selection', async () => {
    const invalid = vi.fn().mockRejectedValue(new Error('invalid-preset-yaml'))
    await expect(readPresetWithRetry(invalid, () => true)).rejects.toThrow('invalid-preset-yaml')
    expect(invalid).toHaveBeenCalledTimes(1)
    const abandoned = vi.fn().mockRejectedValue(new Error('Failed to fetch'))
    await expect(readPresetWithRetry(abandoned, () => false)).rejects.toThrow('Failed to fetch')
    expect(abandoned).toHaveBeenCalledTimes(1)
  })
})
