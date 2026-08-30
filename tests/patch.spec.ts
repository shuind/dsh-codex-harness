import { describe, expect, it } from 'vitest'
import { APPLY_PATCH_GRAMMAR, applyPatchHunks, parsePatch } from '../src/patch.ts'

describe('Codex apply_patch language', () => {
  it('parses an added file and applies an update with context', () => {
    expect(parsePatch('*** Begin Patch\n*** Add File: new.txt\n+one\n+two\n*** End Patch'))
      .toEqual([{ kind: 'add', path: 'new.txt', content: 'one\ntwo\n' }])

    const [file] = parsePatch('*** Begin Patch\n*** Update File: old.txt\n@@ section\n before\n-old\n+new\n after\n*** End Patch')
    if (file?.kind !== 'update') throw new Error('expected an update patch')
    expect(applyPatchHunks('before\nold\nafter\n', file.hunks)).toBe('before\nnew\nafter\n')
  })

  it('parses delete and move directives, including a move without content changes', () => {
    expect(parsePatch('*** Begin Patch\n*** Delete File: old.txt\n*** End Patch'))
      .toEqual([{ kind: 'delete', path: 'old.txt' }])
    expect(parsePatch('*** Begin Patch\n*** Update File: old.txt\n*** Move to: new.txt\n*** End Patch'))
      .toEqual([{ kind: 'update', path: 'old.txt', moveTo: 'new.txt', hunks: [] }])
  })

  it('rejects native multi-environment preambles instead of silently using the primary workspace', () => {
    expect(() => parsePatch("<<'EOF'\n*** Begin Patch\n*** Environment ID: remote\n*** Add File: new.txt\n+one\n*** End Patch\nEOF\n"))
      .toThrow('environment selection is unavailable in this single-environment DSH plugin')
  })

  it('normalizes CRLF input and honors the end-of-file marker', () => {
    const [file] = parsePatch('*** Begin Patch\r\n*** Update File: file.txt\r\n@@\r\n-a\r\n+b\r\n@@\r\n-c\r\n+d\r\n*** End of File\r\n*** End Patch\r\n')
    if (file?.kind !== 'update') throw new Error('expected an update patch')
    expect(applyPatchHunks('a\nmiddle\nc', file.hunks)).toBe('b\nmiddle\nd')
  })

  it('accepts upstream-compatible marker whitespace and tolerant context matching', () => {
    const [file] = parsePatch('  *** Begin Patch  \n*** Update File: file.txt  \n@@\n foo\n-old\n+new\n*** End Patch  ')
    if (file?.kind !== 'update') throw new Error('expected an update patch')
    expect(applyPatchHunks('foo  \nold\n', file.hunks)).toBe('foo\nnew\n')
  })

  it('rejects malformed hunk markers and mismatched context', () => {
    expect(() => parsePatch('*** Begin Patch\n*** Update File: file.txt\n@@@ wrong\n-old\n+new\n*** End Patch'))
      .toThrow('invalid update hunk marker')
    const [file] = parsePatch('*** Begin Patch\n*** Update File: file.txt\n@@\n-missing\n+new\n*** End Patch')
    if (file?.kind !== 'update') throw new Error('expected an update patch')
    expect(() => applyPatchHunks('actual\n', file.hunks, 'src/index.ts')).toThrow(
      'could not find expected lines in src/index.ts hunk 1 (search starts at line 1)\n'
      + 'Expected:\n'
      + '  1: missing\n'
      + 'File excerpt:\n'
      + '  1: actual',
    )
  })

  it('explains patch-marker collisions and makes whitespace visible', () => {
    expect(() => applyPatchHunks('- item\n', [{
      lines: [{ kind: 'delete', text: ' item' }],
      endOfFile: false,
    }], 'README.md')).toThrow(
      'Hint: if a source line starts with a patch marker, repeat that marker after the operation marker; for example, `-- item` deletes the source line `- item`.',
    )

    expect(() => applyPatchHunks('  actual\n', [{
      lines: [{ kind: 'context', text: ' missing' }],
      endOfFile: false,
    }], 'file.txt')).toThrow(
      'Expected:\n  1: [space]missing\nFile excerpt:\n  1: [space][space]actual',
    )
  })

  it('publishes the OpenAI custom grammar used by the freeform tool', () => {
    expect(APPLY_PATCH_GRAMMAR).toContain('start: begin_patch hunk+ end_patch')
    expect(APPLY_PATCH_GRAMMAR).not.toContain('environment_id')
    expect(APPLY_PATCH_GRAMMAR).toContain('*** Add File: ')
    expect(APPLY_PATCH_GRAMMAR).toContain('*** End of File')
    expect(APPLY_PATCH_GRAMMAR).toContain('%import common.LF')
    expect(APPLY_PATCH_GRAMMAR).not.toContain('\nupdate:')
  })
})
