// The real extracted Loader/registry and official preset plugins run in their
// own Node module graph. External host capabilities are fixtures;
// this test exercises registration, schemas, expressions, isolation and teardown.
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'
import { compileFunction, constants } from 'node:vm'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { parse } from 'yaml'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

export async function verifyDesktopPreset(runtimePath, definition) {
  const require = createRequire(pathToFileURL(runtimePath))
  const nativeImport = compileFunction('return import(url)', ['url'], {
    importModuleDynamically: constants.USE_MAIN_CONTEXT_DEFAULT_LOADER,
  })
  const load = async name => nativeImport(pathToFileURL(require.resolve(name)).href)
  const { Context } = await load('@deepseek-ai/cordis')
  const { Loader, Group } = await load('@deepseek-ai/cordis-plugin-loader')
  const { AgentPresetRegistry } = await load('@deepseek-ai/dsh-agent-preset-registry')
  const { renderPrompt } = await load('@deepseek-ai/dsh-system-prompt')
  const ctx = new Context()
  const profileHome = mkdtempSync(join(tmpdir(), 'codex-native-profile-'))
  const originalFetch = globalThis.fetch
  try {
    ctx.baseUrl = pathToFileURL(runtimePath).href
    const noop = () => () => {}
    const fixtures = {
      agents: { list: () => [] }, goals: {}, web: {}, userQuestions: {}, tokenMeter: {},
      shell: {}, subprocess: {}, fs: {}, llm: {}, credentials: {}, sessions: { list: () => [] },
      workingDirectory: { defaultDirectory: profileHome, get: () => profileHome },
      commands: { register: noop },
      subagentModelSelection: { current: () => ({ enabled: false, allowedModels: [] }) },
      jobs: { attachController: noop, events: { subscribe: noop } },
      subagents: { getProvider: () => undefined, resolveMaxDepth: () => undefined },
      ptcRuntime: { language: 'typescript' }, sandboxPolicy: {},
      skills: { registerProvider: noop },
    }
    for (const [name, service] of Object.entries(fixtures)) ctx.provide(name, service)
    const loader = new Loader(ctx, { baseUrl: pathToFileURL(runtimePath).href })
    loader.builtins.group = Group
    ctx.provide('profileContext', { home: profileHome, dir: profileHome, name: 'codex-test' })
    ctx.provide('configEditor', {
      entries: () => [...loader.entries()],
      configuration: () => [...loader.entries()].map(entry => ({ entry, inherited: {}, override: entry.options.config ?? {} })),
      edit: async (entry, transform) => loader.update(entry.id, { config: transform(entry.options.config ?? {}, {}) }),
    })
    await ctx.plugin((await load('@deepseek-ai/dsh-settings')).default).await()
    await loader.root.update([{ id: 'codex', name: '@shuind/dsh-codex-harness/preferences' }])
    await loader.await()
    const form = ctx.settings.describe().find(row => row.ns === 'codex')
    assert.ok(form, 'native SettingsForms must expose the preferences Config')
    assert.equal(ctx.settings.writable, true)
    assert.equal(form.applies, 'live')
    assert.equal(form.value.fast, false)
    assert.equal(form.value.terminalToolsEnabled, true)
    assert.ok('systemPrompt' in form.schema.refs[form.schema.uid].dict)
    assert.ok(form.value.systemPrompt.includes('## Working principles'))
    await ctx.settings.update('codex', { fast: true }, form.revision)
    assert.equal(ctx.codexPreferences.current().fast, true)
    assert.equal(ctx.settings.describe().find(row => row.ns === 'codex').value.fast, true)
    await ctx.plugin((await load('@deepseek-ai/dsh-session-projection')).default).await()
    await ctx.plugin((await load('@deepseek-ai/dsh-system-prompt')).default, {}).await()
    ctx.systemPrompt.variable('provider', () => 'openai')
    ctx.systemPrompt.variable('model', () => 'gpt-5.4')
    await ctx.plugin((await load('@deepseek-ai/dsh-tools')).default, {}).await()
    await ctx.plugin(await load('@deepseek-ai/dsh-tool-executor-native')).await()
    const registryFiber = ctx.plugin(AgentPresetRegistry, { default: definition.id })
    await registryFiber.await()
    const patch = parse(readFileSync(new URL('./cordis.patch.yml', pathToFileURL(runtimePath)), 'utf8'))
    await loader.root.update(patch[0].insert)
    await loader.await()
    assert.throws(() => loader.resolve('preset-codex-collaboration'), /cannot resolve entry/)
    const hybridOwner = loader.resolve('preset-codex-hybrid').fiber
    await hybridOwner.await()
    const rows = await ctx.agentPresets.list()
    assert.equal(rows.length, 1)
    assert.deepEqual(rows.map(row => row.id), ['codex-hybrid'])
    assert.ok(rows.every(row => row.broken === undefined))
    assert.equal(ctx.agentPresets.inspectCompositions().length, 1)
    await loader.resolve('codex-client').fiber.await()
    const editor = ctx.get('codexPresetEditor')
    assert.ok(editor)
    const catalog = await editor.catalog()
    assert.equal(catalog.presets.length, 1)
    assert.ok(catalog.presets.some(row => row.id === 'codex-hybrid' && row.isDefault))
    const hybridTools = await editor.tools('codex-hybrid')
    assert.equal(hybridTools.preset, 'codex-hybrid')
    assert.equal(hybridTools.registeredOnly, true)
    assert.equal(hybridTools.tools.some(row => row.name === 'todo_write'), false, 'todo_write must be hidden in codex-hybrid')
    for (const deferred of ['create_goal', 'get_goal', 'ralph', 'update_goal', 'workflow']) {
      assert.equal(hybridTools.tools.find(row => row.name === deferred)?.defaultDeferred, true, `expected defaultDeferred on ${deferred}`)
    }
    assert.equal(hybridTools.tools.find(row => row.name === 'exec_command')?.defaultDeferred, undefined)
    assert.equal(hybridTools.tools.find(row => row.name === 'exec_command')?.conditional, true)
    assert.equal(ctx.agents.list().length, 0, 'inventory must not create an Agent')
    const document = await editor.read('codex-hybrid')
    assert.equal(document.id, 'codex-hybrid')
    assert.ok(document.composition.includes('You are Codex'))

    const hybridLease = await ctx.agentPresets.acquireScope('codex-hybrid')
    try {
      const scope = hybridLease.key
      for (const name of ['exec_command', 'write_stdin', 'apply_patch', 'update_plan', 'job_output', 'web_search', 'workflow', 'ralph', 'ask_user_question']) {
        assert.ok(ctx.tools.get(name, scope), `missing preset tool ${name}`)
        assert.equal(ctx.tools.get(name), undefined, `preset tool leaked to host: ${name}`)
      }
      const hybridPrompt = await ctx.systemPrompt.assemble({ scope })
      const renderedHybridPrompt = renderPrompt(hybridPrompt)
      assert.ok(renderedHybridPrompt.includes('You are Codex, a coding agent based on the gpt-5.4 model.'))
      const hybridToolNames = hybridPrompt.tools.map(tool => tool.name)
      for (const direct of ['run_code', 'exec_command', 'write_stdin', 'apply_patch', 'update_plan']) {
        assert.ok(hybridToolNames.includes(direct), `missing hybrid wire tool ${direct}`)
      }
      for (const excluded of ['read', 'glob', 'grep', 'web_fetch', 'todo_write']) {
        assert.equal(hybridToolNames.includes(excluded), false, `excluded tool leaked onto wire: ${excluded}`)
      }
      assert.ok(hybridPrompt.sections.some(section => section.name === 'codex:base' && section.text.includes('## Working principles')))
      assert.ok(hybridPrompt.sections.some(section => section.text.includes('You are Codex')))
      assert.equal(hybridPrompt.sections.find(section => section.name === 'deployment:persona-suffix')?.text, '')
      assert.ok(hybridPrompt.sections.some(section => section.name === 'tools:hybrid'))
      const sdkSection = hybridPrompt.sections.find(section => section.name === 'tools:sdk')
      assert.ok(sdkSection, 'missing tools:sdk section')
      for (const sdkTool of ['read', 'glob', 'grep', 'web_fetch']) {
        assert.ok(sdkSection.text.includes(sdkTool), `missing ${sdkTool} in tools:sdk`)
      }
      assert.equal(sdkSection.text.includes('todo_write'), false)
      const inventory = await ctx.agentPresets.compositionInventory()
      const hybridInventory = inventory.find(entry => entry.id === 'codex-hybrid')
      assert.ok(hybridInventory)
      assert.ok(hybridInventory.rows.some(row => row.moduleName === '@deepseek-ai/dsh-workflow-ptc' && row.enabled))
      assert.ok(hybridInventory.rows.some(row => row.entryId.endsWith('tool-subagent-codex') && !row.enabled))
      await hybridOwner.dispose()
      assert.deepEqual(await ctx.agentPresets.list(), [])
      assert.equal(ctx.agentPresets.inspectCompositions().length, 1, 'a retained scope survives declaration disposal')
    } finally {
      await hybridLease[Symbol.asyncDispose]()
    }
    assert.equal(ctx.agentPresets.inspectCompositions().length, 0)
    console.log('desktop preset mounted and disposed')
  } finally {
    await ctx.fiber.dispose()
    rmSync(profileHome, { recursive: true, force: true })
    assert.equal(globalThis.fetch, originalFetch)
  }
}
