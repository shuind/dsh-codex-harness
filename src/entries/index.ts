/** Codex-compatible prompt overlay and core tools for a dsh agent preset. */

import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type {} from '@deepseek-ai/dsh-settings'
import type {} from '@deepseek-ai/dsh-llm'
import type {} from '@deepseek-ai/dsh-system-prompt'
import type {} from '@deepseek-ai/dsh-tools'
import type {} from '@deepseek-ai/dsh-fs'
import {
  DEFAULT_CODEX_PERSONA,
  DEFAULT_CODEX_SYSTEM_PROMPT,
  DEFAULT_DSH_CORE_SOURCE_PROMPT,
  DEFAULT_DSH_CORE_WEB_PROMPT,
  resolveCodexSystemPrompt,
} from '../contracts/prompt.ts'
import {
  CODEX_SETTINGS_ENTRY,
  CODEX_SETTINGS_NAMESPACE,
  isGptModel,
  readHostSettings,
} from '../contracts/settings.ts'
import type { CodexSettings } from '../contracts/settings.ts'
import { CODEX_CONTEXT_MAX, OPENAI_CODEX_MODEL_LIMITS } from '../contracts/ui-contracts.ts'
import { hasPresetPromptOverride } from '../policy/tool-capabilities.ts'
import { registerCodexActivityProjection } from '../presets/activity.ts'
import {
  applyCodexPresentationSettings,
  applyCodexRequestSettings,
  buildCodexSystemPrompt,
  enrichCodexModel,
  installCodexContextProjection,
  installPresetEditor,
  normalizeCodexPromptAssembly,
  syncCodexContextWindow,
  watchConfiguredGptModels,
  withPresetPrompt,
} from '../presets/runtime-enhancements.ts'
import type { CodexModelProfile, CodexRequestConfig } from '../presets/runtime-enhancements.ts'
import { installSmallWindowCompaction } from '../presets/small-window-compaction.ts'
import { collectTrustedCompactionMarkers } from '../responses/compact-checkpoint.ts'
import { installHostedWebSearch, hostedWebSearchStream } from '../responses/fetch-transport.ts'
import { hasDirectResponsesCompactRoute, remoteCompactStream } from '../responses/remote-compact.ts'
import { repairLegacyPiAiContextOverflow } from '../responses/sse-diagnostics.ts'
import {
  DEFAULT_MAX_OUTPUT_BYTES,
  registerCodexExecAndPlan,
  registerExecTools,
  registerPlanTool,
} from '../tools/exec-plan-tools.ts'
import type { CodexExecAndPlanOptions } from '../tools/exec-plan-tools.ts'
import { registerPatchTool } from '../tools/patch-tool.ts'
import { installGlobalCompactCommand } from './compact-command.ts'
import { codexCompactionMode, withExplicitLocalCompactionInstruction } from './compaction.ts'

export {
  DEFAULT_CODEX_PERSONA,
  DEFAULT_CODEX_SYSTEM_PROMPT,
  DEFAULT_DSH_CORE_SOURCE_PROMPT,
  DEFAULT_DSH_CORE_WEB_PROMPT,
}
export { CODEX_SETTINGS_NAMESPACE, CODEX_SETTINGS_SCHEMA } from '../contracts/settings.ts'
export type { CodexSettings }
export { registerCodexExecAndPlan }
export type { CodexExecAndPlanOptions }
export {
  enrichCodexModel,
  syncCodexContextWindow,
  applyCodexRequestSettings,
  normalizeCodexPromptAssembly,
  applyCodexPresentationSettings,
  buildCodexSystemPrompt,
  withPresetPrompt,
}
export type { CodexRequestConfig, CodexModelProfile }

export const name = 'codex'
export const inject = ['tools', 'systemPrompt', 'shell', 'fs', 'llm', 'credentials', 'settings']

/** Configuration for the Codex shell result bridge. */
export interface Config {
  /** Install request/transport/activity enhancements for every agent scope. */
  globalEnhancements?: boolean
  /** Install the Codex operating prompt and four core tools in this scope. */
  codexCore?: boolean
  /** Default wait before a pipe-backed command yields a session id. */
  defaultYieldTimeMs?: number
  /** Default wait for an empty `write_stdin` poll. */
  pollYieldTimeMs?: number
  /** Default wait for a non-empty `write_stdin` send. */
  writeYieldTimeMs?: number
  /** Maximum output retained in one canonical result, in UTF-8 bytes. */
  maxOutputBytes?: number
  /** Send GPT Responses requests with the native hosted web_search tool first. */
  hostedWebSearch?: boolean
  /** Use the provider's /responses/compact endpoint before local compaction. */
  remoteCompact?: boolean
  /** Complete plugin-owned Codex operating prompt. */
  systemPrompt?: string
  /** Explicit per-preset operating prompt; overrides the shared prompt only. */
  presetPrompt?: string
  /** Per-preset Codex capability overrides. Omitted values follow shared settings. */
  promptEnabled?: boolean
  terminalToolsEnabled?: boolean
  patchToolEnabled?: boolean
  planToolEnabled?: boolean
  hostedWebSearchEnabled?: boolean
  remoteCompactionEnabled?: boolean
  /** Deployment Persona template. */
  persona?: string
  /** DSH Core source-checkout guidance template. */
  harnessSourcePrompt?: string
  /** DSH Core Web GUI guidance template. */
  webSurfacePrompt?: string
}

/** Runtime configuration schema for the Codex tool bridge. */
export const Config: z<Config> = z.object({
  globalEnhancements: z.boolean().default(true),
  codexCore: z.boolean().default(true),
  defaultYieldTimeMs: z.number().step(1).min(0).default(10_000),
  pollYieldTimeMs: z.number().step(1).min(0).default(5_000),
  writeYieldTimeMs: z.number().step(1).min(0).default(250),
  maxOutputBytes: z.number().step(1).min(1).default(DEFAULT_MAX_OUTPUT_BYTES),
  hostedWebSearch: z.boolean().default(true),
  remoteCompact: z.boolean().default(true),
  systemPrompt: z.string().default(DEFAULT_CODEX_SYSTEM_PROMPT),
  presetPrompt: z.string(),
  promptEnabled: z.boolean(),
  terminalToolsEnabled: z.boolean(),
  patchToolEnabled: z.boolean(),
  planToolEnabled: z.boolean(),
  hostedWebSearchEnabled: z.boolean(),
  remoteCompactionEnabled: z.boolean(),
  persona: z.string().default(DEFAULT_CODEX_PERSONA),
  harnessSourcePrompt: z.string().default(DEFAULT_DSH_CORE_SOURCE_PROMPT),
  webSurfacePrompt: z.string().default(DEFAULT_DSH_CORE_WEB_PROMPT),
})

/** Mount the Codex prompt/tool layer inside one fixed agent preset. */
export function apply(ctx: Context, config: Config = {}): void {
  const resolved = {
    globalEnhancements: config.globalEnhancements ?? true,
    codexCore: config.codexCore ?? true,
    defaultYieldTimeMs: config.defaultYieldTimeMs ?? 10_000,
    pollYieldTimeMs: config.pollYieldTimeMs ?? 5_000,
    writeYieldTimeMs: config.writeYieldTimeMs ?? 250,
    maxOutputBytes: config.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES,
    hostedWebSearch: config.hostedWebSearch ?? true,
    remoteCompact: config.remoteCompact ?? true,
    systemPrompt: config.systemPrompt ?? DEFAULT_CODEX_SYSTEM_PROMPT,
    persona: config.persona ?? DEFAULT_CODEX_PERSONA,
    harnessSourcePrompt: config.harnessSourcePrompt ?? DEFAULT_DSH_CORE_SOURCE_PROMPT,
    webSurfacePrompt: config.webSurfacePrompt ?? DEFAULT_DSH_CORE_WEB_PROMPT,
  }
  if (resolved.codexCore
    && ctx.fs.sandboxMode !== undefined
    && ctx.get('sandboxPolicy') === undefined) {
    throw new Error('codex: a sandboxing filesystem requires ctx.sandboxPolicy')
  }
  const baseSettings: CodexSettings = {
    ...CODEX_SETTINGS_ENTRY,
    systemPrompt: resolved.systemPrompt,
    persona: resolved.persona,
    harnessSourcePrompt: resolved.harnessSourcePrompt,
    webSurfacePrompt: resolved.webSurfacePrompt,
  }
  const sharedSettings = {
    current: (): CodexSettings => ({
      ...baseSettings,
      ...readHostSettings<CodexSettings>(ctx, CODEX_SETTINGS_NAMESPACE),
    }),
  }
  const codexSettings = { current: () => {
    const shared = withPresetPrompt(sharedSettings.current(), config.presetPrompt)
    return {
      ...shared,
      ...(config.promptEnabled === undefined ? {} : { promptEnabled: config.promptEnabled }),
      ...(config.terminalToolsEnabled === undefined ? {} : { terminalToolsEnabled: config.terminalToolsEnabled }),
      ...(config.patchToolEnabled === undefined ? {} : { patchToolEnabled: config.patchToolEnabled }),
      ...(config.planToolEnabled === undefined ? {} : { planToolEnabled: config.planToolEnabled }),
      ...(config.hostedWebSearchEnabled === undefined ? {} : { hostedWebSearchEnabled: config.hostedWebSearchEnabled }),
      ...(config.remoteCompactionEnabled === undefined ? {} : { remoteCompactionEnabled: config.remoteCompactionEnabled }),
    }
  } }
  const execConfig = {
    ...resolved,
    currentSettings: codexSettings.current,
    presetEnabled: config.terminalToolsEnabled !== false,
    presetOverridesLegacy: config.terminalToolsEnabled !== undefined,
  }

  if (resolved.globalEnhancements) {
    // Native presets reject host services in their isolated composition.
    installPresetEditor(ctx)
    installGlobalCompactCommand(ctx)
    // The generic pi-ai plugin remains the owner of provider routes. This
    // layer adds only request metadata and remote-first transport behavior.
    watchConfiguredGptModels(ctx)
    registerCodexActivityProjection(ctx)
    installCodexContextProjection(ctx, codexSettings.current)
    const lastRequestByAgent = new WeakMap<object, unknown>()
    installSmallWindowCompaction(ctx, codexSettings.current, lastRequestByAgent)
    ctx.on('agent/request', async (payload, next) => {
      const request = await next()
      const updated = applyCodexRequestSettings(request, codexSettings.current())
      const agent = (payload as { agent?: unknown } | undefined)?.agent
      if (agent !== null && typeof agent === 'object') lastRequestByAgent.set(agent, updated)
      return updated
    })
    if (typeof (ctx as unknown as { effect?: unknown }).effect === 'function') {
      const disposeHostedWebSearch = installHostedWebSearch()
      ctx.effect(() => disposeHostedWebSearch, 'codex: Responses transport wrapper')
    }
    ctx.on('llm/stream', ((options: any, next: any) => {
      const settings = codexSettings.current()
      const isCodexConnect = options.provider === 'openai-codex'
      const contextWindow = options.contextWindow ?? (isCodexConnect ? undefined : settings.contextWindow)
      const modelMax = typeof options.model === 'string'
        ? OPENAI_CODEX_MODEL_LIMITS[options.model]?.maxTokens
        : undefined
      const repairCeiling = isCodexConnect
        ? (modelMax ?? CODEX_CONTEXT_MAX)
        : options.purpose === 'compaction'
          ? Math.max(contextWindow ?? 0, modelMax ?? CODEX_CONTEXT_MAX)
          : contextWindow
      const serviceTier: string | undefined = options.serviceTier ?? (!isCodexConnect && settings.fast ? 'priority' : undefined)
      const trustedCheckpoints = Array.isArray(options.messages) ? collectTrustedCompactionMarkers(options.messages) : undefined
      const compactionMode = codexCompactionMode()
      const legacySafeNext = () => repairLegacyPiAiContextOverflow(
        next(),
        options.model,
        repairCeiling,
      )
      if (options.purpose === 'compaction' && isGptModel(options.model)) {
        if (compactionMode === 'local') {
          const localOptions = withExplicitLocalCompactionInstruction(options)
          if (localOptions !== options) {
            if (!Object.isFrozen(options)) {
              options.messages = localOptions.messages
            } else {
              return repairLegacyPiAiContextOverflow(
                ctx.llm.stream(localOptions),
                options.model,
                repairCeiling,
              )
            }
          }
          return legacySafeNext()
        }
        const useRemoteCompaction = compactionMode === 'remote'
          || (compactionMode !== 'local' && resolved.remoteCompact && settings.remoteCompactionEnabled)
        if (useRemoteCompaction && hasDirectResponsesCompactRoute(ctx, options.provider)) {
          return remoteCompactStream(ctx, options, legacySafeNext, {
            ...serviceTier === undefined ? {} : { serviceTier },
            hostedWebSearch: resolved.hostedWebSearch && settings.hostedWebSearchEnabled,
            customApplyPatch: settings.patchToolEnabled,
            ...trustedCheckpoints === undefined ? {} : { trustedCheckpoints },
          })
        }
        return legacySafeNext()
      }
      if (options.purpose === undefined && isGptModel(options.model)) {
        return repairLegacyPiAiContextOverflow(
          hostedWebSearchStream(next, {
            ...serviceTier === undefined ? {} : { serviceTier },
            hostedWebSearch: !isCodexConnect && resolved.hostedWebSearch && settings.hostedWebSearchEnabled,
            customApplyPatch: settings.patchToolEnabled,
            ...trustedCheckpoints === undefined ? {} : { trustedCheckpoints },
          }),
          options.model,
          repairCeiling,
        )
      }
      return next()
    }) as any)
  }

  if (resolved.codexCore) {
    ctx.on('system-prompt/assemble', async (_assembly, context, next) => {
      const protectedNames = new Set(['deployment:persona-prefix', 'deployment:persona-suffix', 'codex:base']
        .filter(name => hasPresetPromptOverride(ctx, context, name)))
      return applyCodexPresentationSettings(await next(), codexSettings.current(), protectedNames)
    })
    ctx.systemPrompt.section({
      name: 'codex:base',
      order: 10,
      text: () => codexSettings.current().promptEnabled
        ? resolveCodexSystemPrompt(codexSettings.current().systemPrompt)
        : '',
    })
    registerExecTools(ctx, execConfig)
    registerPatchTool(ctx, codexSettings.current, config.patchToolEnabled !== false, undefined, config.patchToolEnabled !== undefined)
    registerPlanTool(ctx, codexSettings.current, config.planToolEnabled !== false, undefined, config.planToolEnabled !== undefined)
  }
}

export default { name, inject, Config, apply }
