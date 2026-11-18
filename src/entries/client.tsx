/** Client plugin entry for DSH 0.2.2+ Web/Desktop ConfigForms. */
import type { Context } from '@deepseek-ai/cordis'
import { apply as applyDesktop } from '../client/desktop.tsx'

export const inject = [
  'commandUi', 'sessions', 'slots', 'locale',
  'remote',
]

export function apply(ctx: Context): void {
  ctx.inject(['configForms'], host => applyDesktop(host))
}

export default { inject, apply }
