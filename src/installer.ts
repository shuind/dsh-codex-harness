/** Install the user-visible Codex agent preset supplied by this bundle. */

import type { Context } from '@deepseek-ai/cordis'
import { createHash, randomUUID } from 'node:crypto'
import {
  copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync,
} from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  CODEX_SETTINGS_ENTRY, CODEX_SETTINGS_NAMESPACE, CODEX_SETTINGS_SCHEMA,
} from './settings.ts'

const PRESET_FILES = ['agent.cordis.yml', 'preset.yml'] as const
const MANAGED_SIGNATURE_FILE = '.dsh-codex-harness-managed'
const BUNDLED_PRESET_ID = 'codex-collaboration'
const LEGACY_PRESET_ID = 'codex'
const SOURCE_PRESET_DIR = fileURLToPath(new URL('../presets/codex-collaboration/', import.meta.url))

// Exact signatures of every previously shipped preset. Unknown directories
// remain user-owned; known copies can be migrated without erasing edits.
const LEGACY_PRESET_SIGNATURES = new Set([
  '2f6222b6c9fed417d0f8fbfef9b221f0c9088c63347466219309c1c2ca2426bb',
  '40ae944220ca57daae93d1483d6cb6264e6847ed77ee84f38171c34c36f0598e',
  'c6a594797f7044c44c09254635b8381f20533cd26a4661239529dc44ec423d0c',
  '2c373798b9cadbda5fb377dab0d43ac5637263546a5a4fc1740752658fdec658',
  'a4062b59ad0e512e1b1b7e80ae56d8cde4efdaa5ba958364a17653ba1ff3c2ed',
  '16016e7f68ee61354de232151be5b6ad0cda1785183ca0c72f9d0946b6a1d6cd',
  '7f72b1bea9b30074788f05d20b841a797a5b29bb945dd1fb0597c8d03eb2b9b9',
  '6a6c8dc2e7a7dbc1ac30ce608a53c238f19066a786f951f9a295ada86e56ed9e',
])
const BUNDLED_PRESET_SIGNATURES = new Set([
  '2a7ef181266e69275d25091adc74dd619af7c7d3577573887aaaecd2663e13c8',
  'd1de30f5c13049621b1c1ae3fb22d35b031797a4762638265822b0ff62749854',
  'b50e1d616f9b4188a33c0da0fe355478b7b75b615f3792c094e2b67995622cf4',
  '6132523d92893f6ae9214b30105e9cc1ba64854df6ca8a84213069eb6c38d286',
  '7957bc5e9b0f2fa0b74d2d8bae0d4ee153a2ba7bb430f5a848e700386cc7ce3f',
])

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
export const inject = ['settings']

function presetSignature(directory: string): string | undefined {
  if (PRESET_FILES.some(file => !existsSync(join(directory, file)))) return undefined
  const hash = createHash('sha256')
  hash.update(readFileSync(join(directory, PRESET_FILES[0])))
  hash.update(Buffer.from([0]))
  hash.update(readFileSync(join(directory, PRESET_FILES[1])))
  return hash.digest('hex')
}

function stagePreset(targetDir: string, sourceDir: string, presetId: string): string {
  const parentDir = dirname(targetDir)
  mkdirSync(parentDir, { recursive: true })
  const stagingDir = mkdtempSync(join(parentDir, `.${presetId}-`))
  try {
    for (const file of PRESET_FILES) copyFileSync(join(sourceDir, file), join(stagingDir, file))
    const signature = presetSignature(stagingDir)
    if (signature === undefined) throw new Error(`incomplete bundled preset: ${sourceDir}`)
    writeFileSync(join(stagingDir, MANAGED_SIGNATURE_FILE), `${signature}\n`)
    return stagingDir
  } catch (error) {
    rmSync(stagingDir, { recursive: true, force: true })
    throw error
  }
}

function installPreset(targetDir: string, sourceDir: string, presetId: string): void {
  const stagingDir = stagePreset(targetDir, sourceDir, presetId)
  try {
    renameSync(stagingDir, targetDir)
  } catch (error) {
    if (!existsSync(targetDir)) throw error
    rmSync(stagingDir, { recursive: true, force: true })
  }
}

function replacePreset(targetDir: string, sourceDir: string, presetId: string): void {
  const stagingDir = stagePreset(targetDir, sourceDir, presetId)
  const backupDir = join(dirname(targetDir), `.${presetId}-backup-${randomUUID()}`)
  renameSync(targetDir, backupDir)
  try {
    renameSync(stagingDir, targetDir)
    rmSync(backupDir, { recursive: true, force: true })
  } catch (error) {
    if (existsSync(stagingDir)) rmSync(stagingDir, { recursive: true, force: true })
    if (!existsSync(targetDir)) renameSync(backupDir, targetDir)
    throw error
  }
}

function hasMatchingManagedMarker(targetDir: string, signature: string): boolean {
  const marker = join(targetDir, MANAGED_SIGNATURE_FILE)
  return existsSync(marker) && readFileSync(marker, 'utf8').trim() === signature
}

/**
 * Install or upgrade the single shipped Codex preset.
 *
 * The directory is committed with a staging rename so a failed copy cannot
 * leave a half-written preset that hides the mode from the roster. A known
 * shipped copy upgrades in place; any changed or unknown copy is preserved.
 *
 * @param targetDir - destination preset directory.
 * @param sourceDir - directory containing the packaged preset files.
 */
export function installCodexPreset(
  targetDir = dshHomePath('.agent-presets', BUNDLED_PRESET_ID),
  sourceDir = SOURCE_PRESET_DIR,
): void {
  if (!existsSync(targetDir)) {
    installPreset(targetDir, sourceDir, BUNDLED_PRESET_ID)
    return
  }
  const signature = presetSignature(targetDir)
  if (signature !== undefined
    && (BUNDLED_PRESET_SIGNATURES.has(signature) || hasMatchingManagedMarker(targetDir, signature))) {
    replacePreset(targetDir, sourceDir, BUNDLED_PRESET_ID)
  }
}

/** Remove an unmodified copy of the retired second Codex mode. */
export function retireLegacyCodexPreset(
  targetDir = dshHomePath('.agent-presets', LEGACY_PRESET_ID),
  managedSignatures: ReadonlySet<string> = LEGACY_PRESET_SIGNATURES,
): void {
  if (!existsSync(targetDir)) return
  const signature = presetSignature(targetDir)
  if (signature !== undefined && managedSignatures.has(signature)) {
    rmSync(targetDir, { recursive: true, force: true })
  }
}

/** Install the preset during profile boot without changing the host tool catalog. */
export function apply(ctx: Context): void {
  try {
    ctx.settings.register(CODEX_SETTINGS_NAMESPACE, CODEX_SETTINGS_SCHEMA, { base: CODEX_SETTINGS_ENTRY })
    installCodexPreset()
    retireLegacyCodexPreset()
  } catch (error) {
    ctx.logger.warn(`dsh-codex: could not reconcile the Codex preset: ${String(error)}`)
  }
}

export default { name, inject, apply }
