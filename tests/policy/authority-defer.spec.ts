import { describe, expect, it, vi } from 'vitest'
import { CompactionId } from '@deepseek-ai/dsh-compaction'
import { SessionId, SessionSeq } from '@deepseek-ai/dsh-session'
import { createAssistantMessage, createDeveloperMessage, createUserMessage, HarnessError, projectToolUpdates, ToolCallId } from '@deepseek-ai/dsh-llm'
import { registerHybridDefaultDeferredTools } from '../../src/policy/deferred-tools.ts'
import ToolPolicy, { apply, Config } from '../../src/entries/tool-policy.ts'
import { effectiveToolAction } from '../../src/contracts/tool-policy-contract.ts'
import { codexToolMetadata } from '../../src/policy/tool-capabilities.ts'
import { readPresetToolCatalog } from '../../src/presets/preset-tool-catalog.ts'
import { capability, harness, individualRule } from './policy-harness.ts'

const coreNames = ['exec_command', 'write_stdin', 'apply_patch', 'update_plan']
const disabledLegacy = { terminalToolsEnabled: false, planToolEnabled: false, patchToolEnabled: false }

describe('one snapshotted Codex capability authority', () => {
  it('preserves the effective disabled legacy replacement without installing an unavailable adapter', async () => {
    const h = await harness()
    h.setLegacy(disabledLegacy)
    h.preset('target')
    await h.mount({ rules: [{ preset: 'target' }] })
    const first = h.prepare('target')
    await first.publish()
    expect(h.names(first.agent)).not.toEqual(expect.arrayContaining(['pwsh', 'todo_write']))
    for (const name of ['pwsh', 'todo_write', 'exec_command', 'write_stdin', 'update_plan']) {
      expect(h.ctx.tools.get(name, first.agent)).toBeUndefined()
    }
    h.setLegacy({})
    expect(await h.visible(first.agent)).not.toContain('exec_command')
    const second = h.prepare('target')
    await second.publish()
    expect(await h.visible(second.agent)).toEqual(expect.arrayContaining(['exec_command', 'write_stdin', 'update_plan']))
  })

  it('fully installs explicit replacement choices over old shared false without affecting another preset', async () => {
    const h = await harness()
    h.setLegacy(disabledLegacy)
    h.preset('target')
    const native = h.preset('native')
    await h.mount({ rules: [individualRule('target', [
      { name: 'pwsh', action: 'codex-exec' }, { name: 'todo_write', action: 'codex-plan' },
    ])] })
    const first = h.prepare('target')
    const sibling = h.prepare('native')
    await first.publish()
    await sibling.publish()
    expect(await h.visible(first.agent)).toEqual(expect.arrayContaining(['exec_command', 'write_stdin', 'update_plan']))
    expect((await h.dispatch(first.agent, 'exec_command', { cmd: 'complete' })).results[0]!.result.isError).toBe(false)
    expect((await h.dispatch(first.agent, 'update_plan', { plan: [{ step: 'Plan authority', status: 'in_progress' }] })).results[0]!.result.isError).toBe(false)
    expect(h.ctx.tools.get('pwsh', sibling.agent)).toBe(native.definitions.pwsh)
    expect(h.ctx.tools.get('todo_write', sibling.agent)).toBe(native.definitions.todo_write)
    expect(h.ctx.tools.get('exec_command', sibling.agent)).toBeUndefined()
    h.setLegacy({ terminalToolsEnabled: true, planToolEnabled: false })
    expect(await h.visible(first.agent)).toEqual(expect.arrayContaining(['exec_command', 'write_stdin', 'update_plan']))
  })

  it('lets explicit Core keep override a deprecated shared false at both admission and execution', async () => {
    const h = await harness()
    h.setLegacy(disabledLegacy)
    await h.corePreset('core')
    await h.mount({ rules: [individualRule('core', coreNames.map(name => ({ name, action: 'keep' })))] })
    const candidate = h.prepare('core')
    await candidate.publish()
    expect(await h.visible(candidate.agent)).toEqual(expect.arrayContaining(coreNames))
    expect((await h.dispatch(candidate.agent, 'exec_command', { cmd: 'complete' })).results[0]!.result.isError).toBe(false)
    expect((await h.dispatch(candidate.agent, 'update_plan', { plan: [{ step: 'Keep Core', status: 'pending' }] })).results[0]!.result.isError).toBe(false)
    expect((await h.dispatch(candidate.agent, 'apply_patch', { input: '*** Begin Patch\n*** Add File: virtual.txt\n+test\n*** End Patch' })).results[0]!.result.isError).toBe(false)
    expect(h.patchWrites).toHaveBeenCalledOnce()
    const unguard = candidate.agent.ctx.get('tools')!.guard(exec => exec.name === 'exec_command' ? 'original permission denied' : undefined)
    expect((await h.dispatch(candidate.agent, 'exec_command', { cmd: 'must-not-run' })).results[0]!.result).toMatchObject({ isError: true, error: { message: 'original permission denied' } })
    unguard()
    expect(h.executeShell).toHaveBeenCalledTimes(1)
  })

  it('keeps local Core false authoritative while the policy action still says keep', async () => {
    const h = await harness()
    h.setLegacy(disabledLegacy)
    const source = await h.corePreset('core', disabledLegacy)
    const rule = individualRule('core', coreNames.map(name => ({ name, action: 'keep' })))
    await h.mount({ rules: [rule] })
    const candidate = h.prepare('core')
    await candidate.publish()
    expect(await h.visible(candidate.agent)).toEqual(['read'])
    for (const name of coreNames) {
      const metadata = codexToolMetadata(source.definitions[name]!)!
      expect(metadata.presetEnabled).toBe(false)
      expect(effectiveToolAction(rule, name, { legacyCapabilities: disabledLegacy, codexTool: metadata })).toBe('keep')
    }
    const exec = { agent: candidate.agent, signal: new AbortController().signal } as never
    await expect(source.definitions.exec_command!.execute({ cmd: 'must-not-run' }, exec)).rejects.toThrow(/disabled in Codex/)
    await expect(source.definitions.apply_patch!.execute({ input: 'invalid' }, exec)).rejects.toThrow(/disabled in Codex/)
    await expect(source.definitions.update_plan!.execute({ plan: [] }, exec)).rejects.toThrow(/disabled in Codex/)
    expect(h.executeShell).not.toHaveBeenCalled()
    expect(h.patchWrites).not.toHaveBeenCalled()
  })

  it('preserves a pre-existing explicit local true override of shared false', async () => {
    const h = await harness()
    h.setLegacy(disabledLegacy)
    const source = await h.corePreset('core', { terminalToolsEnabled: true, planToolEnabled: true, patchToolEnabled: true })
    await h.mount()
    const candidate = h.prepare('core')
    await candidate.publish()
    expect(await h.visible(candidate.agent)).toEqual(expect.arrayContaining(coreNames))
    for (const name of coreNames) {
      const metadata = codexToolMetadata(source.definitions[name]!)!
      expect(metadata).toMatchObject({ presetEnabled: true, presetOverridesLegacy: true })
      expect(effectiveToolAction(undefined, name, { legacyCapabilities: disabledLegacy, codexTool: metadata })).toBe('keep')
    }
    expect((await h.dispatch(candidate.agent, 'exec_command', { cmd: 'complete' })).results[0]!.result.isError).toBe(false)
  })

  it('snapshots old defaults even without a rule, while pre-existing Agents keep the old live path', async () => {
    const h = await harness()
    await h.corePreset('core')
    const old = h.prepare('core')
    await old.publish()
    await h.mount()
    const first = h.prepare('core')
    await first.publish()
    const admitted = await h.admit(first.agent)
    h.setLegacy(disabledLegacy)
    expect(await h.visible(old.agent)).toEqual(['read'])
    expect(await h.visible(first.agent)).toEqual(expect.arrayContaining(coreNames))
    expect((await h.dispatch(first.agent, 'exec_command', { cmd: 'snapshot body' }, admitted)).results[0]!.result.isError).toBe(false)
    const second = h.prepare('core')
    await second.publish()
    expect(await h.visible(second.agent)).toEqual(['read'])
    h.setLegacy({})
    expect(await h.visible(second.agent)).toEqual(['read'])
    expect(await h.visible(old.agent)).toEqual(expect.arrayContaining(coreNames))
  })

  it('does not apply old Codex switches to unmarked third-party tools with the same names', async () => {
    const h = await harness()
    h.setLegacy(disabledLegacy)
    const source = h.preset('third-party', coreNames)
    await h.mount()
    const candidate = h.prepare('third-party')
    await candidate.publish()
    expect(await h.visible(candidate.agent)).toEqual(coreNames)
    for (const name of coreNames) expect(codexToolMetadata(source.definitions[name]!)).toBeUndefined()
    expect((await h.dispatch(candidate.agent, 'exec_command', {})).results[0]!.result.isError).toBe(false)
  })

  it('keeps catalog preview and actual Core admission aligned without evaluating conditions', async () => {
    const h = await harness()
    h.setLegacy(disabledLegacy)
    const source = await h.corePreset('core', { planToolEnabled: true })
    const catalog = await readPresetToolCatalog(h.ctx, 'core')
    expect(catalog.legacyCapabilities).toEqual(disabledLegacy)
    expect(catalog.tools.find(tool => tool.name === 'exec_command')?.codexTool).toEqual({ capability: 'terminalToolsEnabled', presetEnabled: true })
    expect(catalog.tools.find(tool => tool.name === 'update_plan')?.codexTool).toEqual({ capability: 'planToolEnabled', presetEnabled: true, presetOverridesLegacy: true })
    expect(catalog.tools.find(tool => tool.name === 'read')?.codexTool).toBeUndefined()
    await h.mount()
    const candidate = h.prepare('core')
    await candidate.publish()
    const preview = catalog.tools.filter(tool => effectiveToolAction(undefined, tool.name, {
      legacyCapabilities: catalog.legacyCapabilities, ...(tool.codexTool === undefined ? {} : { codexTool: tool.codexTool }),
    }) !== 'hide' && tool.codexTool?.presetEnabled !== false).map(tool => tool.name).sort()
    expect((await h.visible(candidate.agent)).sort()).toEqual(preview)
    expect(h.ctx.tools.get('apply_patch', candidate.agent)).toBe(source.definitions.apply_patch)
  })

  it('still fails explicit conditional replacement atomically when the old capability was disabled', async () => {
    const h = await harness()
    h.setLegacy(disabledLegacy)
    const source = h.preset('target', ['pwsh', 'read'], { pwsh: () => false })
    await h.mount({ rules: [individualRule('target', [
      { name: 'read', action: 'hide' }, { name: 'pwsh', action: 'codex-exec' },
    ])] })
    const candidate = h.prepare('target')
    await expect(candidate.publish()).rejects.toThrow(/conditional source tool/)
    expect(h.names(candidate.agent)).toEqual(Object.keys(source.definitions))
    expect(h.ctx.tools.get('exec_command', candidate.agent)).toBeUndefined()
  })
})

describe('progressive deferred tool loading (deferLoading: true)', () => {
  it('withholds deferred tools on step 1, preserves prompt stability, activates via activate_tools, and projects deferLoading', async () => {
    const h = await harness()
    h.preset('target', ['pwsh', 'todo_write', 'read', 'workflow', 'ralph'])
    await h.mount({ rules: [{
      preset: 'target',
      tools: [
        { name: 'workflow', action: 'defer' },
        { name: 'ralph', action: 'defer' },
      ],
    }] })
    const candidate = h.prepare('target')
    await candidate.publish()

    expect(h.ctx.tools.get('workflow', candidate.agent)).toBeDefined()
    const step1Admitted = await h.admit(candidate.agent)
    const step1Schemas = h.ctx.tools.schemas(candidate.agent, step1Admitted)
    step1Admitted.dispose()
    const step1Names = step1Schemas.map(tool => tool.name)
    expect(step1Names).toContain('activate_tools')
    expect(step1Names).toContain('read')
    expect(step1Names).not.toContain('workflow')
    expect(step1Names).not.toContain('ralph')

    const prompt1 = await h.ctx.systemPrompt.assemble({ scope: candidate.agent, agent: candidate.agent })
    const deferredText1 = prompt1.sections.find(section => section.name === 'codex:deferred-tools')?.text
    expect(deferredText1).toContain('- `ralph`:')
    expect(deferredText1).toContain('- `workflow`:')

    const activation = await h.dispatch(candidate.agent, 'activate_tools', { names: ['workflow', 'missing_tool'] })
    expect(activation.results[0]!.result).toMatchObject({
      isError: false,
      value: { activated: ['workflow'], alreadyActive: [], unknown: ['missing_tool'] },
    })

    const step2Admitted = await h.admit(candidate.agent)
    const step2Schemas = h.ctx.tools.schemas(candidate.agent, step2Admitted)
    step2Admitted.dispose()
    expect(step2Schemas.map(tool => tool.name)).toContain('workflow')
    expect(step2Schemas.map(tool => tool.name)).not.toContain('ralph')

    const prompt2 = await h.ctx.systemPrompt.assemble({ scope: candidate.agent, agent: candidate.agent })
    expect(prompt2.sections.find(section => section.name === 'codex:deferred-tools')?.text).toBe(deferredText1)

    const projSession = h.ctx.sessions.create(SessionId('defer-projection-test'))
    const cfg = { provider: 'test', model: 'test' }
    projSession.append('turn/start', { turn: 1 })
    projSession.append('step/start', { turn: 1, step: 1 })
    projSession.append('request/header', { header: { config: cfg, tools: step1Schemas }, reason: 'initial' })
    projSession.append('user/message', createUserMessage({ content: [{ type: 'text', text: 'Need workflow' }], source: { kind: 'user' } }), { surfaceOp: 'append' })
    projSession.append('step/end', { turn: 1, step: 1 })

    projSession.append('step/start', { turn: 1, step: 2 })
    const header2 = projSession.append('request/header', { header: { config: cfg, tools: step2Schemas }, reason: 'change' })
    projSession.append('developer/message', {
      turn: 1,
      step: 2,
      headerSeq: header2.seq,
      message: createDeveloperMessage({ content: [{ type: 'tool-addition', toolName: 'workflow' }], source: { kind: 'user' } }),
    }, { surfaceOp: 'append' })

    const additionOnly = projectToolUpdates(projSession.deriveMessages(), step2Schemas, 'addition-only', projSession.toolHistory())
    expect(additionOnly.tools!.find(tool => tool.name === 'workflow')?.deferLoading).toBe(true)
    expect(additionOnly.tools!.find(tool => tool.name === 'read')?.deferLoading).toBeUndefined()
    expect(additionOnly.tools!.find(tool => tool.name === 'activate_tools')?.deferLoading).toBeUndefined()

    const inHistory = projectToolUpdates(projSession.deriveMessages(), step2Schemas, 'in-history', projSession.toolHistory())
    expect(inHistory.tools!.find(tool => tool.name === 'workflow')?.deferLoading).toBe(true)

    const unsupported = projectToolUpdates(projSession.deriveMessages(), step2Schemas, undefined, projSession.toolHistory())
    expect(unsupported.tools!.every(tool => tool.deferLoading === undefined)).toBe(true)
  })

  it('applies preset defaultDeferred baselines automatically, honors overrides, and validates defer rules', async () => {
    const h = await harness()
    const defaultsScope = h.preset('hybrid-defaults', ['pwsh', 'read', 'workflow', 'todo_write'])
    registerHybridDefaultDeferredTools(defaultsScope.ctx, new Set(['workflow', 'todo_write']))
    const plugin = await h.mount()

    const first = h.prepare('hybrid-defaults')
    await first.publish()
    const firstVisible = await h.visible(first.agent)
    expect(firstVisible).toContain('activate_tools')
    expect(firstVisible).not.toContain('workflow')
    expect(firstVisible).not.toContain('todo_write')

    await plugin.dispose()
    const secondPlugin = await h.mount({ rules: [{
      preset: 'hybrid-defaults',
      replaceShell: false,
      replacePlan: false,
      tools: [
        { name: 'workflow', action: 'keep' },
        { name: 'todo_write', action: 'hide' },
      ],
    }] })

    const second = h.prepare('hybrid-defaults')
    await second.publish()
    const secondVisible = await h.visible(second.agent)
    expect(secondVisible).toContain('workflow')
    expect(secondVisible).not.toContain('todo_write')
    expect(secondVisible).not.toContain('activate_tools')

    await secondPlugin.dispose()
    expect(() => apply(h.ctx, { rules: [individualRule('hybrid-defaults', [{ name: 'activate_tools', action: 'defer' }])] }))
      .toThrow(/cannot defer reserved tool/)

    const condSource = h.preset('cond-defer', ['workflow', 'read'], { workflow: () => false })
    await h.mount({ rules: [individualRule('cond-defer', [{ name: 'workflow', action: 'defer' }])] })
    const condAgent = h.prepare('cond-defer')
    await expect(condAgent.publish()).rejects.toThrow(/conditional source tool/)
    expect(h.names(condAgent.agent)).toEqual(Object.keys(condSource.definitions))
  })

  it('reclaims cold activated deferred tools after local compaction while keeping warm tools, summarizer cache, and remote compactions intact', async () => {
    const h = await harness()
    h.preset('target', ['pwsh', 'todo_write', 'read', 'workflow', 'ralph'])
    await h.mount({ rules: [{
      preset: 'target',
      tools: [
        { name: 'workflow', action: 'defer' },
        { name: 'ralph', action: 'defer' },
      ],
    }] })
    const candidate = h.prepare('target')
    await candidate.publish()

    const promptBefore = (await h.ctx.systemPrompt.assemble({ scope: candidate.agent, agent: candidate.agent }))
      .sections.find(section => section.name === 'codex:deferred-tools')?.text

    // Turn 1: activate both deferred tools.
    await h.dispatch(candidate.agent, 'activate_tools', { names: ['workflow', 'ralph'] })
    expect(await h.visible(candidate.agent)).toEqual(expect.arrayContaining(['workflow', 'ralph']))

    // Turn 2: unrelated work.
    await h.dispatch(candidate.agent, 'read', {})
    // Turn 3: execute `ralph` so it stays warm while `workflow` ages.
    expect((await h.dispatch(candidate.agent, 'ralph', {})).results[0]!.result.isError).toBe(false)
    // Turn 4: `workflow` is now 3 turns old (> 2), `ralph` is 1 turn old (<= 2).
    await h.dispatch(candidate.agent, 'read', {})

    const appendSummary = (compactionId: CompactionId, text: string) => {
      const seq = SessionSeq(0)
      candidate.agent.session.append('compaction/summary', {
        compactionId,
        summary: [{ type: 'text', text }],
        shadowedRange: { start: seq, end: seq },
        shadowedSeqs: [seq],
        shadowedTokenCount: 10,
        provider: 'test',
        model: 'test',
      })
    }

    // Failed compaction keeps both tools visible even after compaction/start.
    candidate.agent.session.append('compaction/start', { compactionId: CompactionId('c-fail'), turn: null })
    expect(await h.visible(candidate.agent)).toEqual(expect.arrayContaining(['workflow', 'ralph']))
    candidate.agent.session.append('compaction/end', { compactionId: CompactionId('c-fail'), turn: null, error: 'aborted' })
    expect(await h.visible(candidate.agent)).toEqual(expect.arrayContaining(['workflow', 'ralph']))

    // Remote encrypted compaction keeps cold tools during compaction, then reclaims cold ones at compaction/end.
    candidate.agent.session.append('compaction/start', { compactionId: CompactionId('c-remote'), turn: null })
    appendSummary(CompactionId('c-remote'), '<codex-remote-compaction>opaque</codex-remote-compaction>')
    expect(await h.visible(candidate.agent)).toEqual(expect.arrayContaining(['workflow', 'ralph']))
    candidate.agent.session.append('compaction/end', { compactionId: CompactionId('c-remote'), turn: null })
    const afterRemote = await h.visible(candidate.agent)
    expect(afterRemote).toContain('activate_tools')
    expect(afterRemote).toContain('ralph')
    expect(afterRemote).not.toContain('workflow')

    // Re-activate `workflow`, let it go cold again, and verify local summary compaction also reclaims cold tools.
    await h.dispatch(candidate.agent, 'activate_tools', { names: ['workflow'] })
    await h.dispatch(candidate.agent, 'read', {})
    await h.dispatch(candidate.agent, 'ralph', {})
    await h.dispatch(candidate.agent, 'read', {})

    // Local summary compaction keeps cold tools active during summarization, then reclaims only cold ones at compaction/end.
    candidate.agent.session.append('compaction/start', { compactionId: CompactionId('c-local'), turn: null })
    appendSummary(CompactionId('c-local'), '<compacted-summary>Local summary</compacted-summary>')
    expect(await h.visible(candidate.agent)).toEqual(expect.arrayContaining(['workflow', 'ralph']))
    candidate.agent.session.append('compaction/end', { compactionId: CompactionId('c-local'), turn: null })

    const afterLocal = await h.visible(candidate.agent)
    expect(afterLocal).toContain('activate_tools')
    expect(afterLocal).toContain('ralph')
    expect(afterLocal).not.toContain('workflow')

    // Re-activate `workflow` and ensure DSH Codex Connect remote checkpoints also reclaim cold tools at compaction/end.
    await h.dispatch(candidate.agent, 'activate_tools', { names: ['workflow'] })
    await h.dispatch(candidate.agent, 'read', {})
    await h.dispatch(candidate.agent, 'ralph', {})
    await h.dispatch(candidate.agent, 'read', {})
    candidate.agent.session.append('compaction/start', { compactionId: CompactionId('c-connect'), turn: null })
    appendSummary(CompactionId('c-connect'), '<dsh-codex-connect-native-compaction-v1>opaque</dsh-codex-connect-native-compaction-v1>')
    expect(await h.visible(candidate.agent)).toEqual(expect.arrayContaining(['workflow', 'ralph']))
    candidate.agent.session.append('compaction/end', { compactionId: CompactionId('c-connect'), turn: null })
    expect(await h.visible(candidate.agent)).not.toContain('workflow')
    expect(await h.visible(candidate.agent)).toContain('ralph')

    const promptAfter = (await h.ctx.systemPrompt.assemble({ scope: candidate.agent, agent: candidate.agent }))
      .sections.find(section => section.name === 'codex:deferred-tools')?.text
    expect(promptAfter).toBe(promptBefore)

    const reactivated = await h.dispatch(candidate.agent, 'activate_tools', { names: ['workflow'] })
    expect(reactivated.results[0]!.result).toMatchObject({
      isError: false,
      value: { activated: ['workflow'], alreadyActive: [], unknown: [] },
    })
    expect(await h.visible(candidate.agent)).toContain('workflow')
  })
})
