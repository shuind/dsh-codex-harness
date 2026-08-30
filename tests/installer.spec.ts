import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { describe, expect, it } from 'vitest'
import { installCodexCollaborationPreset, installCodexPreset } from '../src/installer.ts'

describe('Codex preset installer', () => {
  it('installs the complete preset atomically and preserves an existing preset', () => {
    const root = mkdtempSync(join(tmpdir(), 'dsh-codex-'))
    const target = join(root, '.agent-presets', 'codex')
    try {
      installCodexPreset(target)
      expect(existsSync(join(target, 'agent.cordis.yml'))).toBe(true)
      expect(existsSync(join(target, 'preset.yml'))).toBe(true)
      expect(readFileSync(join(target, 'preset.yml'), 'utf8'))
        .toContain('description: 使用精简版 Codex 提示词和工具，以及改善体验的功能。')
      const composition = readFileSync(join(target, 'agent.cordis.yml'), 'utf8')
      expect(composition).toContain("name: '@shuind/dsh-codex-harness'")
      expect(composition).toContain("name: '@deepseek-ai/dsh-tool-jobs'")
      expect(composition).toContain('completionDelivery: quiet')
      expect(composition).toContain("name: '@deepseek-ai/dsh-tool-web'")
      expect(composition).toContain("name: '@shuind/dsh-codex-harness/compaction'")
      expect(composition).toContain("name: '@deepseek-ai/dsh-command-compact'")

      const custom = 'name: user-owned\n'
      writeFileSync(join(target, 'preset.yml'), custom)
      installCodexPreset(target)
      expect(readFileSync(join(target, 'preset.yml'), 'utf8')).toBe(custom)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('installs a separate collaboration preset with the guidance enabled', () => {
    const root = mkdtempSync(join(tmpdir(), 'dsh-codex-'))
    const target = join(root, '.agent-presets', 'codex-collaboration')
    try {
      installCodexCollaborationPreset(target)
      const metadata = readFileSync(join(target, 'preset.yml'), 'utf8')
      expect(metadata).toContain('Codex 协作模式')
      expect(metadata).toContain('description: 额外加入协作提示词，预期获得更好的体验。')
      expect(readFileSync(join(target, 'agent.cordis.yml'), 'utf8')).toContain('collaborationPrompt: true')
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('keeps collaboration mode different from Codex mode only through its prompt flag', () => {
    const codex = readFileSync(new URL('../presets/codex/agent.cordis.yml', import.meta.url), 'utf8')
    const collaboration = readFileSync(
      new URL('../presets/codex-collaboration/agent.cordis.yml', import.meta.url),
      'utf8',
    )
    expect(collaboration).toBe(codex.replace('collaborationPrompt: false', 'collaborationPrompt: true'))
  })
})
