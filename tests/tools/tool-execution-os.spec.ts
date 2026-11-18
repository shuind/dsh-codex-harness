import { describe, expect, it } from 'vitest'
import LocalSubprocessRuntime from '@deepseek-ai/dsh-subprocess-local'
import PwshLocalExecutor from '@deepseek-ai/dsh-pwsh-local'
import { call, createToolHarness } from '../fixtures/tool-execution-fixture.ts'

/** This really spawns pwsh; a sandbox EPERM is a failure, never a fabricated success/skip. */
describe.runIf(process.platform === 'win32')('official Windows process execution through native dispatch', () => {
  it('runs exec_command through pwsh-local and subprocess-local', async () => {
    const h = await createToolHarness({ installShell: async (ctx, root) => {
      await ctx.plugin(LocalSubprocessRuntime)
      await ctx.plugin(PwshLocalExecutor, { cwd: root })
    } })
    try {
      const batch = await h.dispatch([call('exec_command', { cmd: "Write-Output 'codex-native-shell-ok'; exit 0" })])
      const result = batch.results[0]!.result
      console.info('official pwsh/subprocess native-dispatch outcome', result)
      expect(result.isError).toBe(false)
      expect(result.value).toMatchObject({ exit_code: 0 })
      expect((result.value as { output: string }).output).toContain('codex-native-shell-ok')
    } finally {
      await h.dispose()
    }
  }, 25_000)
})
