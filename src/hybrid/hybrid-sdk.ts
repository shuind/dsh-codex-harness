/** Deterministic schema-to-SDK renderer for Codex hybrid `run_code` execution. */
import type { ToolSchema } from '@deepseek-ai/dsh-llm'
import type { PtcProgramFormat } from '@deepseek-ai/dsh-ptc-runtime'
import { assertSupportedJsonSchema } from '@deepseek-ai/dsh-tools'
import type { JsonSchemaNode, JsonSchemaScalar } from '@deepseek-ai/dsh-tools'

/** Hybrid SDK projection: model-facing schema plus validated canonical output schema. */
export interface HybridToolSdkSchema extends Readonly<ToolSchema> {
  readonly output: JsonSchemaNode
}

const IDENTIFIER = /^[A-Za-z_$][A-Za-z0-9_$]*$/

function renderKey(name: string): string {
  return IDENTIFIER.test(name) ? name : JSON.stringify(name)
}

function pad(indent: number): string {
  return '  '.repeat(indent)
}

function docLines(description: unknown, indent: number): string[] {
  if (typeof description !== 'string' || description.length === 0) return []
  const collapsed = description.replace(/\s+/gu, ' ').trim()
  if (collapsed.length === 0) return []
  return [`${pad(indent)}/** ${collapsed.replaceAll('*/', String.raw`*\/`)} */`]
}

function renderScalar(node: JsonSchemaNode, type: string): string {
  const broad = type === 'integer' ? 'number' : type
  if (Object.hasOwn(node, 'const')) return JSON.stringify(node.const as JsonSchemaScalar)
  if (Object.hasOwn(node, 'enum')) {
    return (node.enum as JsonSchemaScalar[]).map(value => JSON.stringify(value)).join(' | ')
  }
  return broad
}

function containsUnion(text: string): boolean {
  return text.includes(' | ')
}

function renderObjectNode(node: JsonSchemaNode, indent: number): string {
  const properties = node.properties ?? {}
  const required = new Set(node.required ?? [])
  const keys = Object.keys(properties).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))
  const lines: string[] = []
  for (const key of keys) {
    const child = properties[key]
    if (child === undefined) continue
    lines.push(...docLines(child.description, indent + 1))
    const optional = required.has(key) ? '' : '?'
    lines.push(`${pad(indent + 1)}${renderKey(key)}${optional}: ${renderNode(child, indent + 1)};`)
  }
  if (node.additionalProperties !== false) {
    lines.push(`${pad(indent + 1)}[key: string]: JsonValue;`)
  }
  if (lines.length === 0) return '{}'
  return `{\n${lines.join('\n')}\n${pad(indent)}}`
}

function renderNode(node: JsonSchemaNode, indent: number): string {
  if (Array.isArray(node.oneOf) && node.oneOf.length > 0) {
    return node.oneOf.map(branch => renderNode(branch, indent)).join(' | ')
  }
  switch (node.type) {
    case undefined:
      return 'JsonValue'
    case 'object':
      return renderObjectNode(node, indent)
    case 'array': {
      const itemText = node.items === undefined ? 'JsonValue' : renderNode(node.items, indent)
      return containsUnion(itemText) ? `(${itemText})[]` : `${itemText}[]`
    }
    case 'string':
    case 'number':
    case 'integer':
    case 'boolean':
    case 'null':
      return renderScalar(node, node.type)
    default:
      return 'unknown'
  }
}

/** Render one supported JSON Schema node to TypeScript, degrading invalid schemas safely. */
export function jsonSchemaToTs(schema: unknown, indent = 0): string {
  try {
    assertSupportedJsonSchema(schema)
    return renderNode(schema, indent)
  } catch {
    return 'unknown'
  }
}

function renderPythonAnnotation(node: JsonSchemaNode): string {
  if (Array.isArray(node.oneOf) && node.oneOf.length > 0) {
    return node.oneOf.map(renderPythonAnnotation).join(' | ')
  }
  switch (node.type) {
    case 'object':
      return 'dict[str, Any]'
    case 'array':
      return node.items === undefined ? 'list[Any]' : `list[${renderPythonAnnotation(node.items)}]`
    case 'string':
      return 'str'
    case 'integer':
      return 'int'
    case 'number':
      return 'float'
    case 'boolean':
      return 'bool'
    case 'null':
      return 'None'
    default:
      return 'Any'
  }
}

function safePyIdentifier(name: string): string {
  return /^[A-Za-z_][A-Za-z0-9_]*$/u.test(name) ? name : `tool_${name.replace(/[^A-Za-z0-9_]+/gu, '_')}`
}

function renderPythonSdk(sorted: readonly HybridToolSdkSchema[], programFormat: PtcProgramFormat): string {
  const methods = sorted.map((schema) => {
    let returnType = 'Any'
    try {
      assertSupportedJsonSchema(schema.output)
      returnType = renderPythonAnnotation(schema.output)
    } catch {
      returnType = 'Any'
    }
    const doc = schema.description.replace(/\s+/gu, ' ').trim().replaceAll('"""', '\\"\\"\\"')
    return [
      `    async def ${safePyIdentifier(schema.name)}(self, args: dict[str, Any]) -> ${returnType}:`,
      ...(doc ? [`        """${doc}"""`] : []),
      '        ...',
    ].join('\n')
  })
  const outputRule = programFormat === 'function-body'
    ? 'Print results cleanly with `print(...)` or `return`.'
    : 'Emit only concise summaries for the conversation.'
  return [
    '## Hybrid SDK bindings (`run_code`)',
    '',
    'Invoke the SDK tools below only inside `run_code` via `await tools.<name>(args)`. Direct wire tools must still be called directly, not through `tools`.',
    `Batch independent read/search calls with \`asyncio.gather\`. ${outputRule}`,
    '',
    '```python',
    'from typing import Any',
    '',
    'class ToolCallError(Exception):',
    '    toolName: str',
    '',
    'class _ToolsSdk:',
    ...methods,
    '',
    'tools: _ToolsSdk',
    '```',
  ].join('\n')
}

/** Render deterministic SDK declarations for hybrid `run_code` bindings. */
export function renderHybridToolsSdk(
  schemas: readonly HybridToolSdkSchema[],
  language: 'typescript' | 'python' = 'typescript',
  programFormat: PtcProgramFormat = 'function-body',
): string {
  if (schemas.length === 0) {
    return [
      '## Hybrid SDK bindings (`run_code`)',
      '',
      'No SDK tools are currently active in this step. Direct tools remain callable directly without `run_code`. If you need a deferred tool, call `activate_tools` first and invoke it on the next step.',
    ].join('\n')
  }
  const sorted = [...schemas].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
  if (language === 'python') return renderPythonSdk(sorted, programFormat)

  const programDescription = programFormat === 'function-body'
    ? 'the body of an async TypeScript function (erasable syntax only; top-level `await` and `return` work)'
    : 'the TypeScript program to execute'
  const outputInstruction = programFormat === 'function-body'
    ? 'Emit curated output with `return` and/or `console.log(...)`.'
    : 'Only printed/emitted program output enters the conversation.'

  const argsMembers: string[] = []
  const outputMembers: string[] = []
  for (const schema of sorted) {
    argsMembers.push(...docLines(schema.description, 1))
    argsMembers.push(`${pad(1)}${renderKey(schema.name)}: ${jsonSchemaToTs(schema.parameters, 1)};`)
    outputMembers.push(`${pad(1)}${renderKey(schema.name)}: ${jsonSchemaToTs(schema.output, 1)};`)
  }

  const declaration = [
    `interface ToolArgsMap {\n${argsMembers.join('\n')}\n}`,
    `interface ToolOutputMap {\n${outputMembers.join('\n')}\n}`,
    'type ToolName = keyof ToolOutputMap',
    ['declare class ToolCallError extends Error {', '  readonly name: "ToolCallError";', '  readonly toolName: ToolName;', '}'].join('\n'),
    ['declare const tools: {', '  [K in ToolName]: (args: ToolArgsMap[K]) => Promise<ToolOutputMap[K]>;', '}'].join('\n'),
  ].join('\n\n')

  return [
    '## Hybrid SDK bindings (`run_code`)',
    '',
    `\`run_code\` executes ${programDescription}. Direct wire tools are NOT available on \`tools\` unless explicitly configured — call those directly. Call every SDK tool below only inside \`run_code\`:`,
    '',
    '- Call tools as `await tools.name(args)` (quoted for exotic names: `tools["my-tool"](args)`). Each resolves to its typed canonical JSON value; arguments must be lossless JSON.',
    '- A failed tool call rejects with `ToolCallError` (carrying `.toolName` and `.message`); handle errors with `try/catch`.',
    '- Batch independent read/search calls concurrently with `Promise.all`; sequence dependent steps with `await`.',
    `- ${outputInstruction} Image-bearing subtool results are attached automatically after the run; extract only what you need from text/JSON results.`,
    '',
    '```ts',
    'type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue }',
    '',
    declaration,
    '```',
  ].join('\n')
}
