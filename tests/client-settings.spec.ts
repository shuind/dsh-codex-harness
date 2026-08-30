import { describe, expect, it } from 'vitest'
import { apply } from '../src/client/index.tsx'
import { isCodexPresetId } from '../src/context.ts'

describe('Codex client settings', () => {
  it('mounts through official composer seats only', () => {
    const injected: string[] = []
    apply({
      effect: () => undefined,
      locale: { register: () => undefined },
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
      'conversation.input.right',
      'conversation.composer.dock',
    ])
  })

  it('recognizes both shipped Codex presets', () => {
    expect(isCodexPresetId('codex')).toBe(true)
    expect(isCodexPresetId('codex-collaboration')).toBe(true)
    expect(isCodexPresetId('standard')).toBe(false)
  })
})
