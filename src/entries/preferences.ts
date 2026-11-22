/** Profile-backed live preferences on DSH 0.2; legacy hosts keep settings.yaml. */
import { Service, type Context } from '@deepseek-ai/cordis'
import type z from '@deepseek-ai/schemastery'
import { CODEX_SETTINGS_ENTRY, CODEX_SETTINGS_SCHEMA, type CodexSettings } from '../contracts/settings.ts'

export const Config: z<CodexSettings, CodexSettings, 'volatile-defined'> = CODEX_SETTINGS_SCHEMA.default(CODEX_SETTINGS_ENTRY).volatile()

export default class CodexPreferences extends Service {
  static Config = Config

  constructor(ctx: Context, private readonly value: ReturnType<typeof Config>) {
    super(ctx, 'codexPreferences')
  }

  current(): CodexSettings {
    return this.value.get() ?? CODEX_SETTINGS_ENTRY
  }
}
