/** Install the user-visible Codex agent preset supplied by this bundle. */

import type { Context } from '@deepseek-ai/cordis'
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, renameSync, rmSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const PRESET_FILES = ['agent.cordis.yml', 'preset.yml'] as const
const SOURCE_PRESET_DIR = fileURLToPath(new URL('../presets/codex/', import.meta.url))
const SOURCE_COLLABORATION_PRESET_DIR = fileURLToPath(new URL('../presets/codex-collaboration/', import.meta.url))

function dshHomePath(...segments: string[]): string {
  const configured = process.env.DSH_HOME?.trim()
  const expanded = configured === undefined || configured.length === 0
    ? join(homedir(), '.dsh')
    : configured === '~'
      ? homedir()
      : configured.startsWith('~/') || configured.startsWith('~\\')
        ? join(homedir(), configured.slice(2))
        : configured
  return join(resolve(expanded), ...segments)
}

/** Bundle plugin name for the preset installer. */
export const name = 'codex-preset-installer'

function installPreset(targetDir: string, sourceDir: string, presetId: string): void {
  if (existsSync(targetDir)) return

  const parentDir = dirname(targetDir)
  mkdirSync(parentDir, { recursive: true })
  const stagingDir = mkdtempSync(join(parentDir, `.${presetId}-`))
  try {
    for (const file of PRESET_FILES) copyFileSync(join(sourceDir, file), join(stagingDir, file))
    try {
      renameSync(stagingDir, targetDir)
    } catch (error) {
      if (!existsSync(targetDir)) throw error
    }
  } finally {
    if (existsSync(stagingDir)) rmSync(stagingDir, { recursive: true, force: true })
  }
}

/**
 * Install the shipped Codex preset only when the user has not authored one.
 *
 * The directory is committed with a staging rename so a failed copy cannot
 * leave a half-written preset that hides the mode from the roster. Existing
 * directories are intentionally preserved, including user customizations.
 *
 * @param targetDir - destination preset directory.
 * @param sourceDir - directory containing the packaged preset files.
 */
export function installCodexPreset(
  targetDir = dshHomePath('.agent-presets', 'codex'),
  sourceDir = SOURCE_PRESET_DIR,
): void {
  installPreset(targetDir, sourceDir, 'codex')
}

/** Install the shipped Codex preset with the optional collaboration guidance enabled. */
export function installCodexCollaborationPreset(
  targetDir = dshHomePath('.agent-presets', 'codex-collaboration'),
  sourceDir = SOURCE_COLLABORATION_PRESET_DIR,
): void {
  installPreset(targetDir, sourceDir, 'codex-collaboration')
}

/** Install the preset during profile boot without changing the host tool catalog. */
export function apply(ctx: Context): void {
  try {
    installCodexPreset()
    installCodexCollaborationPreset()
  } catch (error) {
    ctx.logger.warn(`dsh-codex: could not install the Codex presets: ${String(error)}`)
  }
}

export default { name, apply }
