import { existsSync, readFileSync } from 'node:fs'
import { parse } from 'yaml'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { desktopCodexHybridPreset, desktopCodexPreset, type DesktopPresetRow } from '../../src/presets/desktop-preset.ts'
import { verifyDesktopPreset } from './desktop-preset.runtime.mjs'

const hybridSource = fileURLToPath(new URL('../../presets/codex-hybrid/', import.meta.url))
const runtime = new URL('../../package.json', import.meta.url)
const stagedPlugin = new URL('../../lib/index.js', import.meta.url)

function flatten(rows: DesktopPresetRow[]): DesktopPresetRow[] {
  return rows.flatMap(row => row.group && Array.isArray(row.config) ? flatten(row.config) : [row])
}

describe('Desktop Codex hybrid preset', () => {
  it('builds the sole Codex 混合模式 preset with deferred and hidden tools', () => {
    const preset = desktopCodexHybridPreset(hybridSource)
    expect(desktopCodexPreset(hybridSource)).toEqual(preset)
    const rows = flatten(preset.plugins)
    expect(preset.id).toBe('codex-hybrid')
    expect(preset.name).toBe('Codex 混合模式')
    expect(preset.order).toBe(5)
    expect(rows.find(row => row.id === 'codex-tools')?.config)
      .toEqual({ globalEnhancements: false, codexCore: true })
    expect(rows.find(row => row.id === 'persona')?.config).toMatchObject({
      prefix: expect.stringContaining('You are Codex'), includeRuntimeContext: true,
    })
    expect(rows.find(row => row.id === 'terminal-bash')?.disabled)
      .toEqual({ __jsExpr: "process.platform === 'win32'" })
    expect(rows.find(row => row.id === 'terminal-pwsh')?.disabled)
      .toEqual({ __jsExpr: "process.platform !== 'win32'" })
    expect(rows.find(row => row.id === 'terminal-pwsh')?.config)
      .toMatchObject({ shellDialect: 'pwsh', timeoutMs: 300_000 })
    expect(rows.find(row => row.id === 'tool-fs')?.config)
      .toEqual({ read: true, readImage: true, write: false, edit: false, applyPatch: false })
    expect(rows.some(row => row.id === 'tool-fs-search')).toBe(true)
    expect(rows.find(row => row.id === 'codex-web-search')?.config).toEqual({ search: true, fetch: true })
    expect(rows.find(row => row.name === '@shuind/dsh-codex-harness/hybrid-executor')?.config).toEqual({
      hiddenTools: ['todo_write'],
      deferredTools: ['create_goal', 'get_goal', 'ralph', 'subagent_fork', 'update_goal', 'workflow'],
    })
    expect(rows.find(row => row.id === 'compaction-basic')?.config)
      .toEqual({ thresholdRatio: 0.9 })
    expect(rows.find(row => row.id === 'tool-result-pruner')?.config)
      .toEqual({ thresholdChars: 40_960, headChars: 20_000, tailChars: 20_000 })
    expect(rows.find(row => row.id === 'workflow-worker-thread')?.name)
      .toBe('@deepseek-ai/dsh-workflow-ptc')
    expect(rows.filter(row => row.disabled === true).map(row => row.id))
      .toEqual(['tool-subagent-codex', 'tool-subagent-claude-code'])
    expect(rows.find(row => row.id === 'plan-mode')?.config)
      .toMatchObject({ section: expect.stringContaining('Make exit_plan_mode the only and final tool call') })
    expect(rows.map(row => row.id)).toEqual(expect.arrayContaining([
      'codex-jobs', 'codex-web-search', 'tool-fs', 'hybrid-executor', 'terminal-pwsh',
      'compaction-basic', 'command-compact', 'tool-skill', 'tool-goal', 'tool-subagent',
      'tool-subagent-fork', 'tool-subagent-control', 'tool-workflow', 'tool-ralph', 'tool-ask-user', 'tool-todo',
    ]))
  })

  it('publishes only preset-codex-hybrid in cordis.patch.yml without codex-collaboration', () => {
    const rows = parse(readFileSync(new URL('../../cordis.patch.yml', import.meta.url), 'utf8'))[0].insert
    expect(rows.find((row: { id: string }) => row.id === 'preset-codex-collaboration')).toBeUndefined()
    const declaration = rows.find((row: { id: string }) => row.id === 'preset-codex-hybrid')
    expect(declaration.name).toBe('@deepseek-ai/dsh-agent-preset')
    expect(declaration.config).toEqual(desktopCodexHybridPreset(hybridSource))
    expect(rows.some((row: { name: string }) => row.name.endsWith('/installer'))).toBe(false)
    const plugins = flatten(declaration.config.plugins)
    expect(plugins.find(row => row.id === 'tool-subagent')?.config).toEqual({
      provider: 'spawn', toolName: 'subagent', modelSelection: true, modelDiscovery: true,
    })
    expect(plugins.find(row => row.id === 'tool-subagent-fork')?.config).toEqual({ provider: 'fork', toolName: 'subagent_fork' })
    expect(plugins.some(row => row.name.endsWith('/list-agents'))).toBe(false)
    expect(JSON.stringify(plugins)).not.toMatch(/modelSelectionSettings|backgroundMode/)
  })

  it.skipIf(!existsSync(runtime) || !existsSync(stagedPlugin))('mounts the built hybrid preset declaration in the current Harness registry and Loader', async () => {
    await verifyDesktopPreset(fileURLToPath(runtime), desktopCodexHybridPreset(hybridSource))
  }, 35000)
})
