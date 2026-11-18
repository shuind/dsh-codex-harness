// Offline registry/native-dispatch benchmark. No model requests, file mutations, or OS commands.
import assert from 'node:assert/strict'
import { performance } from 'node:perf_hooks'
import { writeFileSync } from 'node:fs'
import { cpus, platform, arch } from 'node:os'
import { fileURLToPath } from 'node:url'
import { Context } from '@deepseek-ai/cordis'
import { createScope, scopeTarget } from '@deepseek-ai/dsh-scope'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import SessionProjections from '@deepseek-ai/dsh-session-projection'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import Tools from '@deepseek-ai/dsh-tools'
import * as NativeExecutor from '@deepseek-ai/dsh-tool-executor-native'
import * as FsTools from '@deepseek-ai/dsh-tool-fs'
import * as SearchTools from '@deepseek-ai/dsh-tool-fs-search'
import * as PwshTool from '@deepseek-ai/dsh-tool-pwsh'
import * as TodoTool from '@deepseek-ai/dsh-tool-todo'
import { getEncoding } from 'js-tiktoken'
import ToolPolicy from '../lib/types/entries/tool-policy.js'
import { registerCodexExecAndPlan } from '../lib/types/entries/index.js'
import { rewriteCodexResponsesBody } from '../lib/types/responses/wire-rewrite.js'

const samples = Number(process.env.BENCH_SAMPLES ?? 1200)
assert(Number.isSafeInteger(samples) && samples >= 100 && samples <= 10000)
const root = new Context()
const cwd = fileURLToPath(new URL('../', import.meta.url))
const presetIdentities = new WeakMap()
const agents = new Map()
let serial = 0
const probeName = '__tool_policy_benchmark_probe'
const identities = ['native', 'stacked', 'balanced', 'minimal', 'shadow']
const labels = {
  native: '原生工具', stacked: '原生与 Codex 直接叠加',
  balanced: '保留文件工具，替换执行与计划', minimal: '极简对照（非推荐）', shadow: '同名实现替换对照',
}

function summary(values) {
  const sorted = [...values].sort((a, b) => a - b)
  return { samples: values.length, medianUs: sorted[Math.floor(sorted.length / 2)], p95Us: sorted[Math.floor(sorted.length * .95)], meanUs: values.reduce((a, b) => a + b, 0) / values.length }
}
async function measure(profiles, key, task, count = samples) {
  for (let i = 0; i < 80; i++) for (const profile of profiles) await task(profile, i)
  const values = new Map(profiles.map(profile => [profile.id, []]))
  for (let i = 0; i < count; i++) for (const profile of profiles) {
    const start = performance.now()
    await task(profile, i)
    values.get(profile.id).push((performance.now() - start) * 1000)
  }
  for (const profile of profiles) profile.timings[key] = summary(values.get(profile.id))
}
const probe = {
  name: probeName, description: 'Internal constant-time benchmark probe; excluded from schema token totals.',
  parameters: { type: 'object', properties: {}, additionalProperties: false },
  output: { schema: { type: 'object', properties: { ok: { type: 'boolean' } }, required: ['ok'], additionalProperties: false }, render: value => JSON.stringify(value) },
  isConcurrencySafe: () => true,
  execute: async () => ({ ok: true }),
}

try {
  // Capability facts match a confining Windows composition. No provider body is executed.
  root.provide('fs', { sandboxMode: 'workspace-write' })
  root.provide('shell', { sandboxMode: 'workspace-write', resolve: value => value, execute: async () => { throw new Error('OS execution is outside this benchmark') } })
  root.provide('sandboxPolicy', { resolve: () => ({ mode: 'workspace-write', workspaceRoots: [cwd] }) })
  root.provide('subprocess', {})
  root.provide('shellEnv', { collect: () => ({}) })
  root.provide('workingDirectory', { get: () => cwd, defaultDirectory: cwd })
  root.provide('agents', { list: () => [...agents.values()], get: id => agents.get(id) })
  root.provide('agentPresets', {
    composedPreset: ctx => presetIdentities.get(ctx),
    presetForSession: session => [...agents.values()].find(agent => agent.session === session)?.preset,
  })
  await root.plugin(SessionStore)
  await root.plugin(SessionProjections)
  await root.plugin(SystemPrompt, {})
  await root.plugin(Tools)
  await root.plugin(NativeExecutor)

  const tools = root.get('tools')
  const systemPrompt = root.get('systemPrompt')
  const sessions = root.get('sessions')
  const presetKey = {}
  const preset = createScope(root, presetKey)
  await preset.ctx.plugin(FsTools, { readImage: false, applyPatch: true })
  await preset.ctx.plugin(SearchTools, { sampleOverCapGlobResults: false })
  await preset.ctx.plugin(PwshTool, {})
  await preset.ctx.plugin(TodoTool, { allowParallelInProgress: true })
  preset.ctx.get('tools').register(probe)
  const originalFiles = ['read', 'write', 'edit', 'apply_patch', 'glob', 'grep'].map(name => [name, tools.get(name, presetKey)])
  for (const [name, definition] of originalFiles) assert(definition, `missing native tool ${name}`)
  assert(tools.get('pwsh', presetKey))
  assert(tools.get('todo_write', presetKey))

  await root.plugin(ToolPolicy, { rules: [
    { preset: 'balanced', replaceShell: true, replacePlan: true },
    { preset: 'minimal', allow: ['pwsh', 'todo_write', 'apply_patch', probeName], replaceShell: true, replacePlan: true },
  ] })

  async function newAgent(id) {
    const session = sessions.create(SessionId(`bench-${id}-${++serial}`), { meta: { cwd } })
    const agent = { id: session.id, session, preset: id, status: 'idle', options: { provider: 'benchmark', model: 'gpt-5.4' } }
    const scope = createScope(root, agent, { parent: presetKey })
    agent.ctx = scope.ctx
    presetIdentities.set(agent.ctx, id)
    agents.set(agent.id, agent)
    const started = performance.now()
    await root.serial(scopeTarget(agent, agent), 'agent/created', { agent, source: 'startup' })
    const attachUs = (performance.now() - started) * 1000
    return { agent, scope, attachUs, async dispose() { await scope.dispose(); agents.delete(agent.id) } }
  }
  const profiles = []
  for (const id of identities) {
    const handle = await newAgent(id)
    const { agent } = handle
    if (id === 'stacked') registerCodexExecAndPlan(agent.ctx)
    if (id === 'shadow') agent.ctx.get('tools').register({ ...probe, execute: async () => ({ ok: true }) })
    const signal = new AbortController().signal
    const admission = await tools.resolve({ agent, modelSelection: agent.options, signal })
    const schemas = tools.schemas(agent, admission).filter(tool => tool.name !== probeName)
    const assembled = await systemPrompt.assemble({ scope: agent, toolSet: admission })
    const profile = { id, label: labels[id], handle, agent, signal, admission, schemas, assembled, timings: {} }
    if (id === 'balanced') {
      for (const [name, definition] of originalFiles) assert.equal(tools.get(name, agent), definition, `file tool changed: ${name}`)
      assert.equal(tools.executable('pwsh', agent, admission), undefined)
      assert.equal(tools.executable('todo_write', agent, admission), undefined)
      assert(schemas.some(tool => tool.name === 'exec_command'))
      assert(schemas.some(tool => tool.name === 'update_plan'))
    }
    profiles.push(profile)
  }

  await measure(profiles, 'resolveAndSchemas', async profile => {
    const set = await tools.resolve({ agent: profile.agent, modelSelection: profile.agent.options, signal: profile.signal })
    tools.schemas(profile.agent, set)
    set.dispose()
  })
  await measure(profiles, 'assemble', profile => systemPrompt.assemble({ scope: profile.agent, toolSet: profile.admission }), Math.min(samples, 600))
  await measure(profiles, 'nativeNoIoDispatch', async (profile, i) => {
    const batch = await tools.execute({ agent: profile.agent, signal: profile.signal, toolSet: profile.admission,
      calls: [{ type: 'tool-call', id: `benchmark-${i}`, name: probeName, arguments: '{}' }] })
    assert.equal(batch.results[0].result.isError, false)
  })
  const history = Array.from({ length: 16 }, (_, i) => [
    { type: 'function_call', call_id: `patch-${i}`, name: 'apply_patch', arguments: JSON.stringify({ input: '*** Begin Patch\n*** Add File: sample.txt\n+sample\n*** End Patch' }) },
    { type: 'function_call_output', call_id: `patch-${i}`, output: 'Success.' },
  ]).flat()
  for (const profile of profiles) profile.wireInput = { model: 'gpt-5.4', input: history, tools: profile.schemas.map(tool => ({ type: 'function', ...tool })) }
  await measure(profiles, 'rewrite16PatchHistoryCalls', profile => { rewriteCodexResponsesBody(profile.wireInput) })

  const attach = new Map(identities.map(id => [id, []]))
  for (let i = 0; i < 60; i++) for (const id of identities) {
    const handle = await newAgent(id)
    if (i >= 10) attach.get(id).push(handle.attachUs)
    await handle.dispose()
  }
  // Token counting is outside timing loops. This is a reference encoding, not provider billing.
  const tokenizer = getEncoding('o200k_base')
  const stats = value => {
    const text = typeof value === 'string' ? value : JSON.stringify(value)
    return { utf8Bytes: Buffer.byteLength(text), o200kBaseTokens: tokenizer.encode(text).length }
  }
  const result = {
    generatedAt: new Date().toISOString(), runtimeVersion: '0.2.2-rc.1', node: process.version,
    platform: platform(), arch: arch(), cpu: cpus()[0]?.model, samples,
    methodology: {
      setup: 'Real Cordis scopes, ToolsService, native executor, official FS/search/pwsh/todo tool registrations and the actual tool-policy plugin; lightweight Agent owners and preset identity table, no AgentLoop/model/OS or file I/O.',
      baseline: 'Eight native capabilities: read/write/edit/apply_patch/glob/grep/pwsh/todo_write. read_image excluded because no attachment store is mounted. All other Harness tools are held outside this subset.',
      probe: 'Every timing case also carries the same constant-time probe, excluded from reported model schema totals. Dispatch is unlogged outside a model step; not a full AgentLoop/logging benchmark.',
      timing: '80 warm-ups; cases interleaved per sample; performance.now microseconds. Attach: 10 warm-ups + 50 samples. Assembly capped at 600 samples.',
      tokens: 'JSON schema/body and assembled section text counted with js-tiktoken o200k_base. Not a claim about gpt-6.1-sol billing, TTFT, cache hits, or task success rate.',
      wire: 'Illustrative Responses function-tool mapping plus actual plugin rewrite with 16 correlated apply_patch call/results; no HTTP request.',
      limits: 'No React rendering, model latency, filesystem/OS process timing, permission interaction latency or process-memory savings measured.',
    },
    profiles: profiles.map(profile => ({
      id: profile.id, label: profile.label, tools: profile.schemas.map(tool => tool.name).sort(),
      schema: stats(profile.schemas), promptSections: stats(profile.assembled.sections.map(section => section.text).join('\n\n')),
      illustrativeWire: stats(rewriteCodexResponsesBody(profile.wireInput)),
      timings: { ...profile.timings, agentCreatedListener: summary(attach.get(profile.id)) },
    })),
  }
  const output = new URL('../docs/tool-policy-benchmark.json', import.meta.url)
  writeFileSync(output, JSON.stringify(result, null, 2) + '\n')
  console.log(JSON.stringify(result, null, 2))
  for (const profile of profiles) { profile.admission.dispose(); await profile.handle.dispose() }
} finally {
  await root.fiber.dispose()
}
