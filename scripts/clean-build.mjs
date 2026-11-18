// Remove only this package's generated output before emitting a fresh bundle.
import { rmSync } from 'node:fs'
import { basename, dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(fileURLToPath(new URL('../', import.meta.url)))
const output = resolve(root, 'lib')
if (dirname(output) !== root || basename(output) !== 'lib') {
  throw new Error(`Refusing to clean an unexpected output directory: ${output}`)
}
rmSync(output, { recursive: true, force: true })
