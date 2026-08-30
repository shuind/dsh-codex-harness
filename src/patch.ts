/** Parser and line-oriented applicator for Codex's `apply_patch` language. */

export const APPLY_PATCH_DESCRIPTION = 'Edits files using Codex patch syntax with Begin/End Patch markers and file update directives. In hunk lines, the first character is the operation marker; repeat a source-leading marker when the source line itself starts with one.'

/** The grammar sent to providers that support OpenAI custom grammar tools. */
export const APPLY_PATCH_GRAMMAR = String.raw`start: begin_patch hunk+ end_patch
begin_patch: "*** Begin Patch" LF
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
  if (lines[index]?.trim().startsWith('*** Environment ID:') === true) {
    invalid('environment selection is unavailable in this single-environment DSH plugin')
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

function displayPatchLine(line: string): string {
  if (line.length === 0) return '<empty>'
  return line.replaceAll(' ', '[space]').replaceAll('\t', '[tab]')
}

function formatPatchExcerpt(lines: readonly string[], start: number, count: number): string {
  if (lines.length === 0) return '  <empty file>'
  const first = Math.max(0, Math.min(start, lines.length - 1))
  return lines.slice(first, first + count)
    .map((line, offset) => `  ${first + offset + 1}: ${displayPatchLine(line)}`)
    .join('\n')
}

function mismatchMessage(
  label: string,
  hunkIndex: number,
  expected: readonly string[],
  actual: readonly string[],
  from: number,
  endOfFile: boolean,
): string {
  const expectedPreview = expected.slice(0, 12)
    .map((line, index) => `  ${index + 1}: ${displayPatchLine(line)}`)
    .join('\n')
  const expectedSuffix = expected.length > 12 ? '\n  ...' : ''
  const excerptStart = endOfFile ? Math.max(0, actual.length - 6) : Math.max(0, from - 2)
  const markerHint = expected.some(wanted => wanted.length > 0 && actual.includes(`-${wanted}`))
    ? '\nHint: if a source line starts with a patch marker, repeat that marker after the operation marker; for example, `-- item` deletes the source line `- item`.'
    : ''
  return `could not find expected lines in ${label} hunk ${hunkIndex + 1} (search starts at line ${from + 1})\nExpected:\n${expectedPreview}${expectedSuffix}\nFile excerpt:\n${formatPatchExcerpt(actual, excerptStart, 10)}${markerHint}`
}

/** Apply parsed update hunks and return LF-normalized text. */
export function applyPatchHunks(original: string, hunks: readonly PatchHunk[], label = 'file'): string {
  const value = splitText(original.replaceAll('\r\n', '\n'))
  let cursor = 0
  for (const [hunkIndex, hunk] of hunks.entries()) {
    const expected = hunk.lines.filter(line => line.kind !== 'add').map(line => line.text)
    const start = findSequence(value.lines, expected, cursor, hunk.endOfFile)
    if (start < 0) {
      invalid(mismatchMessage(label, hunkIndex, expected, value.lines, cursor, hunk.endOfFile))
    }
    const replacement = hunk.lines.filter(line => line.kind !== 'delete').map(line => line.text)
    value.lines.splice(start, expected.length, ...replacement)
    cursor = start + replacement.length
    value.trailingNewline = !hunk.endOfFile
  }
  return joinText(value)
}
