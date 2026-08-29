/** Parser and line-oriented applicator for Codex's `apply_patch` language. */

/** The grammar sent to providers that support OpenAI custom grammar tools. */
export const APPLY_PATCH_GRAMMAR = String.raw`start: begin_patch environment_id? hunk+ end_patch
begin_patch: "*** Begin Patch" LF
environment_id: "*** Environment ID: " filename LF
end_patch: "*** End Patch" LF?
hunk: add_hunk | delete_hunk | update_hunk
add_hunk: "*** Add File: " filename LF add_line+
delete_hunk: "*** Delete File: " filename LF
update_hunk: "*** Update File: " filename LF change_move? change?
filename: /(.+)/
add_line: "+" /(.*)/ LF -> line
change_move: "*** Move to: " filename LF
change: (change_context | change_line)+ eof_line?
change_context: ("@@" | "@@ " /(.+)/) LF
change_line: ("+" | "-" | " ") /(.*)/ LF
eof_line: "*** End of File" LF
%import common.LF
`

export type PatchLine =
  | { kind: 'context'; text: string }
  | { kind: 'delete'; text: string }
  | { kind: 'add'; text: string }

export interface PatchHunk {
  context?: string
  lines: PatchLine[]
  endOfFile: boolean
}

export type PatchFile =
  | { kind: 'add'; path: string; content: string }
  | { kind: 'delete'; path: string }
  | { kind: 'update'; path: string; moveTo?: string; hunks: PatchHunk[] }

function invalid(message: string): never {
  throw new Error(`apply_patch: ${message}`)
}

function isFileHeader(line: string): boolean {
  const trimmed = line.trim()
  return trimmed.startsWith('*** Add File: ')
    || trimmed.startsWith('*** Delete File: ')
    || trimmed.startsWith('*** Update File: ')
}

const ENVIRONMENT_ID_MARKER = '*** Environment ID:'

function unwrapHeredoc(input: string): string {
  const normalized = input.replaceAll('\r\n', '\n').trim()
  const lines = normalized.split('\n')
  const first = lines[0]?.trim()
  const last = lines.at(-1)?.trim()
  if (lines.length >= 4
    && (first === '<<EOF' || first === "<<'EOF'" || first === '<<"EOF"')
    && last === 'EOF') {
    return lines.slice(1, -1).join('\n').trim()
  }
  return normalized
}

function pathFrom(line: string, prefix: string): string {
  const path = line.slice(prefix.length).trim()
  if (path.length === 0) invalid(`${prefix.trim()} requires a file path`)
  return path
}

function isChangeMarker(line: string): boolean {
  const marker = line.trimEnd()
  return marker === '@@' || marker.startsWith('@@ ')
}

function isPotentialChangeMarker(line: string): boolean {
  return line.trimEnd().startsWith('@@')
}

/** Parse one complete Codex patch after normalizing CRLF input to LF. */
export function parsePatch(input: string): PatchFile[] {
  const lines = unwrapHeredoc(input).split('\n')
  if (lines[0]?.trim() !== '*** Begin Patch') invalid('input must start with "*** Begin Patch"')
  if (lines.at(-1)?.trim() !== '*** End Patch') invalid('input must end with "*** End Patch"')

  const files: PatchFile[] = []
  let index = 1
  const end = lines.length - 1
  if (lines[index]?.trim().startsWith(ENVIRONMENT_ID_MARKER) === true) {
    const environmentId = lines[index]!.trim().slice(ENVIRONMENT_ID_MARKER.length).trim()
    if (environmentId.length === 0) invalid('environment id cannot be empty')
    index++
    if (lines[index]?.trim().startsWith(ENVIRONMENT_ID_MARKER) === true) {
      invalid('environment id cannot be specified more than once')
    }
  }
  while (index < end) {
    const header = lines[index++]?.trim()
    if (header === undefined) invalid('unexpected end of input')
    if (header.startsWith('*** Add File: ')) {
      const path = pathFrom(header, '*** Add File: ')
      const content: string[] = []
      while (index < end && lines[index]?.startsWith('+') === true) {
        content.push(lines[index]!.slice(1))
        index++
      }
      if (content.length === 0) invalid(`add file ${JSON.stringify(path)} needs at least one content line`)
      files.push({ kind: 'add', path, content: `${content.join('\n')}\n` })
      continue
    }
    if (header.startsWith('*** Delete File: ')) {
      files.push({ kind: 'delete', path: pathFrom(header, '*** Delete File: ') })
      continue
    }
    if (!header.startsWith('*** Update File: ')) invalid(`unexpected directive ${JSON.stringify(header)}`)

    const path = pathFrom(header, '*** Update File: ')
    let moveTo: string | undefined
    if (lines[index]?.trim().startsWith('*** Move to: ') === true) {
      moveTo = pathFrom(lines[index]!.trim(), '*** Move to: ')
      index++
    }
    const hunks: PatchHunk[] = []
    while (index < end && !isFileHeader(lines[index]!)) {
      const patchLines: PatchLine[] = []
      let context: string | undefined
      if (isPotentialChangeMarker(lines[index]!)) {
        const marker = lines[index]!.trimEnd()
        if (!isChangeMarker(marker)) {
          invalid(`invalid update hunk marker ${JSON.stringify(lines[index])}`)
        }
        index++
        context = marker.length === 2 ? undefined : marker.slice(3)
      }
      while (index < end && !isFileHeader(lines[index]!)
        && !isPotentialChangeMarker(lines[index]!)
        && lines[index]!.trimEnd() !== '*** End of File') {
        const line = lines[index++]!
        const kind = line[0]
        if (kind !== ' ' && kind !== '+' && kind !== '-') {
          invalid(`unexpected update line ${JSON.stringify(line)}`)
        }
        patchLines.push({ kind: kind === ' ' ? 'context' : kind === '+' ? 'add' : 'delete', text: line.slice(1) })
      }
      const endOfFile = lines[index]?.trimEnd() === '*** End of File'
      if (endOfFile) index++
      if (patchLines.length === 0) {
        if (context !== undefined || endOfFile) invalid('an update hunk needs context or changed lines')
        break
      }
      hunks.push({
        ...context === undefined ? {} : { context },
        lines: patchLines,
        endOfFile,
      })
    }
    if (hunks.length === 0 && moveTo === undefined) invalid(`update file ${JSON.stringify(path)} has no changes`)
    files.push({
      kind: 'update',
      path,
      ...moveTo === undefined ? {} : { moveTo },
      hunks,
    })
  }
  if (files.length === 0) invalid('no files were modified')
  return files
}

interface TextLines {
  lines: string[]
  trailingNewline: boolean
}

function splitText(text: string): TextLines {
  if (text.length === 0) return { lines: [], trailingNewline: false }
  const trailingNewline = text.endsWith('\n')
  const lines = text.split('\n')
  if (trailingNewline) lines.pop()
  return { lines, trailingNewline }
}

function joinText(value: TextLines): string {
  const body = value.lines.join('\n')
  return value.trailingNewline ? `${body}\n` : body
}

function findSequence(
  lines: readonly string[],
  expected: readonly string[],
  from: number,
  endOfFile: boolean,
): number {
  if (expected.length === 0) return Math.min(from, lines.length)
  if (expected.length > lines.length) return -1
  const first = endOfFile ? Math.max(from, lines.length - expected.length) : from
  const last = lines.length - expected.length
  const matchers: ((actual: string, wanted: string) => boolean)[] = [
    (actual, wanted) => actual === wanted,
    (actual, wanted) => actual.trimEnd() === wanted.trimEnd(),
    (actual, wanted) => actual.trim() === wanted.trim(),
  ]
  for (const matchesLine of matchers) {
    for (let index = first; index <= last; index++) {
      let matches = true
      for (let offset = 0; offset < expected.length; offset++) {
        if (!matchesLine(lines[index + offset]!, expected[offset]!)) {
          matches = false
          break
        }
      }
      if (matches) return index
    }
  }
  return -1
}

/** Apply parsed update hunks and return LF-normalized text. */
export function applyPatchHunks(original: string, hunks: readonly PatchHunk[]): string {
  const value = splitText(original.replaceAll('\r\n', '\n'))
  let cursor = 0
  for (const hunk of hunks) {
    const expected = hunk.lines.filter(line => line.kind !== 'add').map(line => line.text)
    const start = findSequence(value.lines, expected, cursor, hunk.endOfFile)
    if (start < 0) {
      const detail = expected.join('\n')
      invalid(`could not find expected lines${detail.length === 0 ? '' : `:\n${detail}`}`)
    }
    const replacement = hunk.lines.filter(line => line.kind !== 'delete').map(line => line.text)
    value.lines.splice(start, expected.length, ...replacement)
    cursor = start + replacement.length
    value.trailingNewline = !hunk.endOfFile
  }
  return joinText(value)
}
