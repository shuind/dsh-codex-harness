/** Shared `apply_patch` tool registration over DSH `ctx.fs` and sandbox policy. */

import type { Context } from '@deepseek-ai/cordis'
import { isAbsolute } from 'node:path'
import { FsError } from '@deepseek-ai/dsh-fs'
import type { FsInfo, FsTarget, FsWriteIntent } from '@deepseek-ai/dsh-fs'
import { sandboxDenialMarker } from '@deepseek-ai/dsh-sandbox'
import type { SandboxExecutionPolicy } from '@deepseek-ai/dsh-sandbox'
import type { Session } from '@deepseek-ai/dsh-session'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { FileDiff, ToolCallView, ToolExecution } from '@deepseek-ai/dsh-tools'
import { APPLY_PATCH_DESCRIPTION, applyPatchHunks, parsePatch } from './patch.ts'
import type { PatchFile } from './patch.ts'
import type { CodexSettings } from '../contracts/settings.ts'
import { assertCapabilityEnabled, codexToolEnabled, markCodexTool } from '../policy/tool-capabilities.ts'

export interface AppliedFile {
  path: string
  operation: 'created' | 'updated' | 'deleted' | 'moved'
  moveTo?: string
}

export interface ApplyPatchResult {
  files: AppliedFile[]
}

function sessionCwd(ctx: Context, exec: ToolExecution): string | undefined {
  if (exec.agent === undefined) return undefined
  const directories = ctx.get('workingDirectory') as { get(session: Session): string } | undefined
  return directories?.get(exec.agent.session) ?? exec.agent.session.header.cwd
}

function resolvePolicy(ctx: Context, exec: ToolExecution): SandboxExecutionPolicy | undefined {
  const policy = ctx.get('sandboxPolicy')
  return policy?.resolve(exec.agent === undefined ? {} : { session: exec.agent.session })
}

async function resolveTarget(ctx: Context, path: string, exec: ToolExecution): Promise<{ target: FsTarget; cwd: string | undefined }> {
  const cwd = sessionCwd(ctx, exec)
  const target = await ctx.fs.resolve(path, cwd === undefined ? { signal: exec.signal } : { cwd, signal: exec.signal })
  return { target, cwd }
}

async function observedTarget(
  ctx: Context,
  target: FsTarget,
  exec: ToolExecution,
  rawPath: string,
  cwd: string | undefined,
): Promise<FsInfo> {
  const info = await ctx.fs.stat(target, exec.signal)
  if (info === undefined) {
    const cwdHint = !isAbsolute(rawPath) && cwd !== undefined ? ` (cwd: ${cwd})` : ''
    throw new Error(`apply_patch: file not found: ${target.displayPath}${cwdHint}`)
  }
  if (info.type !== 'file') throw new Error(`apply_patch: not a regular file: ${target.displayPath}`)
  ctx.emit('fs/observed', target, { kind: 'present', version: info.version }, exec)
  return info
}

function withSandboxDenialMarker(error: unknown, policy: SandboxExecutionPolicy | undefined): unknown {
  if (!(error instanceof FsError) || error.code !== 'FS_SANDBOX_DENIED' || policy === undefined) return error
  const marker = sandboxDenialMarker(policy.mode)
  if (error.message.includes(marker)) return error
  return new FsError(`${error.message}\n${marker}`, 'FS_SANDBOX_DENIED', { cause: error })
}

async function writePatchedFile(
  ctx: Context,
  target: FsTarget,
  content: string,
  fallback: FsWriteIntent,
  exec: ToolExecution,
  policy: SandboxExecutionPolicy | undefined,
): Promise<FsInfo['version']> {
  const intent = await ctx.waterfall('fs/write-intent', target, exec, () => fallback)
  try {
    const outcome = await ctx.fs.writeText(target, content, intent, exec.signal, policy)
    ctx.emit('fs/observed', target, { kind: 'present', version: outcome.version }, exec)
    return outcome.version
  } catch (error) {
    throw withSandboxDenialMarker(error, policy)
  }
}

async function deletePatchedFile(
  ctx: Context,
  target: FsTarget,
  version: FsInfo['version'],
  exec: ToolExecution,
  policy: SandboxExecutionPolicy | undefined,
): Promise<void> {
  const expected = await ctx.waterfall('fs/delete-intent', target, exec, () => ({ version }))
  try {
    await ctx.fs.deleteFile(target, expected, exec.signal, policy)
    ctx.emit('fs/observed', target, { kind: 'absent' }, exec)
  } catch (error) {
    throw withSandboxDenialMarker(error, policy)
  }
}

interface VirtualPatchFile {
  target: FsTarget
  exists: boolean
  content: string
}

type PlannedPatchOp =
  | { kind: 'write'; target: FsTarget; content: string }
  | { kind: 'delete'; target: FsTarget }

interface PlannedPatchBatch {
  applied: AppliedFile[]
  ops: PlannedPatchOp[]
  initialVersions: Map<string, FsInfo['version']>
}

async function preflightPatchFiles(
  ctx: Context,
  files: readonly PatchFile[],
  exec: ToolExecution,
): Promise<PlannedPatchBatch> {
  const virtual = new Map<string, VirtualPatchFile>()
  const initialVersions = new Map<string, FsInfo['version']>()
  const ops: PlannedPatchOp[] = []
  const applied: AppliedFile[] = []

  const ensureAbsent = async (target: FsTarget, messagePrefix: string): Promise<void> => {
    const existing = virtual.get(target.targetKey)
    if (existing !== undefined) {
      if (existing.exists) throw new Error(`${messagePrefix}: ${target.displayPath}`)
      return
    }
    const stat = await ctx.fs.stat(target, exec.signal)
    if (stat !== undefined) throw new Error(`${messagePrefix}: ${target.displayPath}`)
    ctx.emit('fs/observed', target, { kind: 'absent' }, exec)
    virtual.set(target.targetKey, { target, exists: false, content: '' })
  }

  const ensureReadable = async (target: FsTarget, rawPath: string, cwd: string | undefined): Promise<VirtualPatchFile> => {
    const existing = virtual.get(target.targetKey)
    if (existing !== undefined) {
      if (!existing.exists) throw new Error(`apply_patch: file not found: ${target.displayPath}`)
      return existing
    }
    const info = await observedTarget(ctx, target, exec, rawPath, cwd)
    const content = await ctx.fs.readText(target, exec.signal)
    initialVersions.set(target.targetKey, info.version)
    const entry: VirtualPatchFile = { target, exists: true, content }
    virtual.set(target.targetKey, entry)
    return entry
  }

  for (const file of files) {
    const { target, cwd } = await resolveTarget(ctx, file.path, exec)
    if (file.kind === 'add') {
      await ensureAbsent(target, 'apply_patch: file already exists')
      virtual.set(target.targetKey, { target, exists: true, content: file.content })
      ops.push({ kind: 'write', target, content: file.content })
      applied.push({ path: file.path, operation: 'created' })
      continue
    }

    const source = await ensureReadable(target, file.path, cwd)
    if (file.kind === 'delete') {
      virtual.set(target.targetKey, { target, exists: false, content: '' })
      ops.push({ kind: 'delete', target })
      applied.push({ path: file.path, operation: 'deleted' })
      continue
    }

    const updated = applyPatchHunks(source.content, file.hunks, file.path)
    if (file.moveTo === undefined) {
      virtual.set(target.targetKey, { target, exists: true, content: updated })
      ops.push({ kind: 'write', target, content: updated })
      applied.push({ path: file.path, operation: 'updated' })
      continue
    }

    const { target: destination } = await resolveTarget(ctx, file.moveTo, exec)
    if (destination.targetKey === target.targetKey) {
      virtual.set(target.targetKey, { target, exists: true, content: updated })
      ops.push({ kind: 'write', target, content: updated })
      applied.push({ path: file.path, operation: 'updated', moveTo: file.moveTo })
      continue
    }

    await ensureAbsent(destination, 'apply_patch: move destination already exists')
    virtual.set(target.targetKey, { target, exists: false, content: '' })
    virtual.set(destination.targetKey, { target: destination, exists: true, content: updated })
    ops.push({ kind: 'write', target: destination, content: updated })
    ops.push({ kind: 'delete', target })
    applied.push({ path: file.path, operation: 'moved', moveTo: file.moveTo })
  }

  return { applied, ops, initialVersions }
}

async function applyPatchBatch(
  ctx: Context,
  files: readonly PatchFile[],
  exec: ToolExecution,
  policy: SandboxExecutionPolicy | undefined,
): Promise<AppliedFile[]> {
  const { applied, ops, initialVersions } = await preflightPatchFiles(ctx, files, exec)
  const versions = new Map(initialVersions)
  for (const op of ops) {
    if (op.kind === 'write') {
      const currentVersion = versions.get(op.target.targetKey)
      const fallback: FsWriteIntent = currentVersion === undefined
        ? { kind: 'createIfAbsent' }
        : { kind: 'replaceIfVersion', version: currentVersion }
      const nextVersion = await writePatchedFile(ctx, op.target, op.content, fallback, exec, policy)
      versions.set(op.target.targetKey, nextVersion)
      continue
    }
    const version = versions.get(op.target.targetKey)
    if (version === undefined) throw new Error(`apply_patch: missing version for delete: ${op.target.displayPath}`)
    await deletePatchedFile(ctx, op.target, version, exec, policy)
    versions.delete(op.target.targetKey)
  }
  return applied
}

export function patchSummary(value: ApplyPatchResult): string {
  const letter = (operation: AppliedFile['operation']): string => {
    switch (operation) {
      case 'created': return 'A'
      case 'updated': return 'M'
      case 'deleted': return 'D'
      case 'moved': return 'M'
      default: return operation satisfies never
    }
  }
  return `Success. Updated the following files:\n${value.files.map(file => `${letter(file.operation)} ${file.operation === 'moved' ? file.moveTo : file.path}`).join('\n')}\n`
}

export function presentPatchCall(input: string): ToolCallView {
  try {
    const files = parsePatch(input)
    const diffs: FileDiff[] = files.flatMap((file): FileDiff[] => {
      if (file.kind === 'add') return [{ path: file.path, oldText: null, newText: file.content }]
      if (file.kind === 'delete') return []
      return [{
        path: file.moveTo ?? file.path,
        oldText: file.hunks.flatMap(hunk => hunk.lines.filter(line => line.kind !== 'add').map(line => line.text)).join('\n') || null,
        newText: file.hunks.flatMap(hunk => hunk.lines.filter(line => line.kind !== 'delete').map(line => line.text)).join('\n'),
      }]
    })
    const paths = new Set(files.flatMap(file => (
      file.kind === 'update' && file.moveTo !== undefined ? [file.path, file.moveTo] : [file.path]
    )))
    return {
      card: 'diff',
      title: `Apply patch (${paths.size} ${paths.size === 1 ? 'file' : 'files'})`,
      diffs,
      locations: [...paths].map(path => ({ path })),
    }
  } catch {
    return {
      card: 'generic',
      title: 'Apply patch',
      kind: 'edit',
      rawInput: input,
    }
  }
}

export function registerPatchTool(
  ctx: Context,
  currentSettings: () => CodexSettings,
  presetEnabled = true,
  authority?: boolean,
  presetOverridesLegacy = false,
): () => void {
  const tools = ctx.get('tools')
  if (tools === undefined) throw new Error('Codex patch tools require ctx.tools')
  const fs = ctx.get('fs') ?? (ctx as { fs?: Context['fs'] }).fs
  if (fs === undefined) throw new Error('Codex patch tools require ctx.fs')
  if (fs.sandboxMode !== undefined && ctx.get('sandboxPolicy') === undefined) {
    throw new Error('Codex patch tools: a sandboxing filesystem requires ctx.sandboxPolicy')
  }
  const metadata = {
    capability: 'patchToolEnabled' as const,
    presetEnabled,
    ...(presetOverridesLegacy ? { presetOverridesLegacy: true } : {}),
  }
  return tools.register(markCodexTool(defineTool({
    name: 'apply_patch',
    description: APPLY_PATCH_DESCRIPTION,
    parameters: {
      input: { type: 'string', required: true, description: 'The complete patch text.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          files: {
            type: 'array',
            required: true,
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                path: { type: 'string', required: true },
                operation: { type: 'string', required: true, enum: ['created', 'updated', 'deleted', 'moved'] },
                moveTo: { type: 'string' },
              },
            },
          },
        },
      },
      render: (_args, value) => [{ type: 'text', text: patchSummary(value) }],
    },
    async execute(args: { input: string }, exec): Promise<ApplyPatchResult> {
      assertCapabilityEnabled(ctx, currentSettings, 'apply_patch', exec.agent, metadata, authority)
      const files = parsePatch(args.input)
      const policy = resolvePolicy(ctx, exec)
      return { files: await applyPatchBatch(ctx, files, exec, policy) }
    },
    presentCall(args): ToolCallView {
      return presentPatchCall(args.input)
    },
    presentResult(args, result) {
      if (result.isError) return undefined
      const view = presentPatchCall(args.input)
      return view.card === 'diff' ? { card: 'diff', title: view.title, diffs: view.diffs } : undefined
    },
  }), metadata), { when: context => codexToolEnabled(ctx, context?.agent, 'apply_patch', metadata, currentSettings, authority) })
}
