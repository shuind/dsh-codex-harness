import { describe, expect, it } from 'vitest'
import { APPLY_PATCH_GRAMMAR, applyPatchHunks, parsePatch } from '../../src/tools/patch.ts'

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

  it('accepts upstream-compatible marker whitespace and tolerant context matching without rewriting untouched context', () => {
    const [file] = parsePatch('  *** Begin Patch  \n*** Update File: file.txt  \n@@\n foo\n-old\n+new\n*** End Patch  ')
    if (file?.kind !== 'update') throw new Error('expected an update patch')
    expect(applyPatchHunks('foo  \nold\n', file.hunks)).toBe('foo  \nnew\n')
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

  it('uses soft @@ context anchors, falls back safely, and matches Unicode punctuation', () => {
    const file = [
      'fn first() {',
      '  const value = 1',
      '}',
      '',
      'fn second() {',
      '  const value = 1',
      '}',
      '',
    ].join('\n')
    const [anchored] = parsePatch('*** Begin Patch\n*** Update File: code.ts\n@@ -4,3 +4,3 @@ fn second() {\n-  const value = 1\n+  const value = 2\n*** End Patch')
    if (anchored?.kind !== 'update') throw new Error('expected update patch')
    expect(applyPatchHunks(file, anchored.hunks)).toContain('fn second() {\n  const value = 2\n}')
    expect(applyPatchHunks(file, anchored.hunks)).toContain('fn first() {\n  const value = 1\n}')

    // Soft fallback when anchor appears after the actual expected lines.
    const [soft] = parsePatch('*** Begin Patch\n*** Update File: code.ts\n@@ missing-anchor\n-  const value = 1\n+  const value = 9\n*** End Patch')
    if (soft?.kind !== 'update') throw new Error('expected update patch')
    expect(applyPatchHunks('fn one() {\n  const value = 1\n}\n', soft.hunks)).toBe('fn one() {\n  const value = 9\n}\n')

    // 4th-pass Unicode punctuation normalization (dashes, curly quotes, NBSP).
    const [unicode] = parsePatch('*** Begin Patch\n*** Update File: u.ts\n@@\n-console.log("a - b")\n+console.log("ok")\n*** End Patch')
    if (unicode?.kind !== 'update') throw new Error('expected update patch')
    expect(applyPatchHunks('console.log(\u201Ca\u00A0\u2014\u00A0b\u201D)\n', unicode.hunks)).toBe('console.log("ok")\n')
  })

  it('preserves CRLF, original trailing newlines, and appends pure additions at EOF', () => {
    const [crlf] = parsePatch('*** Begin Patch\n*** Update File: win.txt\n@@\n-two\n+TWO\n*** End Patch')
    if (crlf?.kind !== 'update') throw new Error('expected update patch')
    expect(applyPatchHunks('one\r\ntwo\r\nthree\r\n', crlf.hunks)).toBe('one\r\nTWO\r\nthree\r\n')

    // Keep trailing newline even with *** End of File when file already had one, and omit when absent.
    const [eof] = parsePatch('*** Begin Patch\n*** Update File: trail.txt\n@@\n-tail\n+TAIL\n*** End of File\n*** End Patch')
    if (eof?.kind !== 'update') throw new Error('expected update patch')
    expect(applyPatchHunks('head\ntail\n', eof.hunks)).toBe('head\nTAIL\n')
    const [noTrail] = parsePatch('*** Begin Patch\n*** Update File: notrail.txt\n@@\n-tail\n+TAIL\n*** End Patch')
    if (noTrail?.kind !== 'update') throw new Error('expected update patch')
    expect(applyPatchHunks('head\ntail', noTrail.hunks)).toBe('head\nTAIL')

    // Pure-addition hunk with *** End of File appends at EOF.
    const [pureAppend] = parsePatch('*** Begin Patch\n*** Update File: log.txt\n@@\n+appended\n*** End of File\n*** End Patch')
    if (pureAppend?.kind !== 'update') throw new Error('expected update patch')
    expect(applyPatchHunks('line1\nline2\n', pureAppend.hunks)).toBe('line1\nline2\nappended\n')
  })

  it('supports empty adds, indented patch markers in context, bare blank lines, BOM + CRLF majority, and order hints', () => {
    expect(parsePatch('*** Begin Patch\n*** Add File: empty.txt\n*** Add File: next.txt\n+x\n*** End Patch'))
      .toEqual([
        { kind: 'add', path: 'empty.txt', content: '' },
        { kind: 'add', path: 'next.txt', content: 'x\n' },
      ])

    const [nested] = parsePatch('*** Begin Patch\n*** Update File: doc.md\n@@\n *** Update File: example.ts\n\n-old\n+new\n*** End of File\n\n*** End Patch')
    if (nested?.kind !== 'update') throw new Error('expected update patch')
    expect(applyPatchHunks('\uFEFFstray\n*** Update File: example.ts\r\n\r\nold\r\n', nested.hunks))
      .toBe('\uFEFFstray\r\n*** Update File: example.ts\r\n\r\nnew\r\n')

    const [unicodeContext] = parsePatch('*** Begin Patch\n*** Update File: u.ts\n@@\n   const title = "a - b"\n-old\n+new\n*** End Patch')
    if (unicodeContext?.kind !== 'update') throw new Error('expected update patch')
    expect(applyPatchHunks('  const title = \u201Ca\u00A0\u2014\u00A0b\u201D\nold\n', unicodeContext.hunks))
      .toBe('  const title = \u201Ca\u00A0\u2014\u00A0b\u201D\nnew\n')

    const [anchoredAdd] = parsePatch('*** Begin Patch\n*** Update File: list.txt\n@@ [section]\n+added\n*** End Patch')
    if (anchoredAdd?.kind !== 'update') throw new Error('expected update patch')
    expect(applyPatchHunks('[section]\ntail\n', anchoredAdd.hunks)).toBe('[section]\nadded\ntail\n')

    const [outOfOrder] = parsePatch('*** Begin Patch\n*** Update File: order.txt\n@@\n-second\n+SECOND\n@@\n-first\n+FIRST\n*** End Patch')
    if (outOfOrder?.kind !== 'update') throw new Error('expected update patch')
    expect(() => applyPatchHunks('first\nsecond\n', outOfOrder.hunks, 'order.txt'))
      .toThrow('order hunks top-to-bottom')
  })
})
