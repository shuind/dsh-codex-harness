import { describe, expect, it } from 'vitest'
import { apply } from '../src/client/index.tsx'
import { isCodexPresetId } from '../src/context.ts'

describe('Codex client settings', () => {
  it('mounts the composer controls and plugin settings card through shared slots', () => {
    const injected: string[] = []
    apply({
      effect: () => undefined,
      get: (name: string) => name === 'commandUi'
        ? { decorate: () => () => {} }
        : name === 'sessions'
          ? { binding: () => undefined }
          : undefined,
      locale: { register: () => undefined, bind: () => () => '' },
      settingsScope: {
        bind: () => ({ set: async () => {}, unset: async () => {} }),
      },
      slots: {
        inject: (key: string) => {
          injected.push(key)
          return () => {}
        },
      },
    } as never)
    expect(injected).toEqual([
      'conversation.input.right',
      'conversation.input.overlay',
      'settings.plugin.item',
    ])
  })

  it('recognizes the bundled preset and legacy Codex sessions', () => {
    expect(isCodexPresetId('codex')).toBe(true)
    expect(isCodexPresetId('codex-collaboration')).toBe(true)
    expect(isCodexPresetId('standard')).toBe(false)
  })
})
