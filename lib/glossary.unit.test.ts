import { describe, it, expect } from 'vitest'
import {
  parseGlossary,
  renderGlossary,
  MAX_GLOSSARY_ENTRIES,
} from './glossary'

describe('parseGlossary', () => {
  it('parses a source = target line', () => {
    const r = parseGlossary('Transformer = 变换器')
    expect(r).toEqual({ ok: true, value: [{ source: 'Transformer', target: '变换器' }] })
  })

  it('keeps a target that itself contains an "="', () => {
    const r = parseGlossary('x = a = b')
    expect(r.ok && r.value[0].target).toBe('a = b')
  })

  it('trims whitespace around both sides', () => {
    const r = parseGlossary('  Node.js  =   Node.js  ')
    expect(r.ok && r.value[0]).toEqual({ source: 'Node.js', target: 'Node.js' })
  })

  it('skips blank lines and ! comments', () => {
    const r = parseGlossary('! my notes\n\nA = 甲\n\n! trailing\nB = 乙')
    expect(r.ok && r.value).toEqual([
      { source: 'A', target: '甲' },
      { source: 'B', target: '乙' },
    ])
  })

  it('lets a later line win for a repeated source', () => {
    const r = parseGlossary('Tensor = 甲\nTensor = 乙')
    expect(r.ok && r.value).toEqual([{ source: 'Tensor', target: '乙' }])
  })

  // A repeated source is a redefinition, not a new entry, so it must not
  // consume budget the way distinct terms do.
  it('does not count redefinitions toward the entry limit', () => {
    const atLimit = Array.from(
      { length: MAX_GLOSSARY_ENTRIES },
      (_, i) => `t${i} = v${i}`,
    )
    expect(parseGlossary(atLimit.join('\n')).ok).toBe(true)

    const manyRedefs = Array.from(
      { length: MAX_GLOSSARY_ENTRIES * 2 },
      (_, i) => `t${i % 10} = v${i}`,
    )
    expect(parseGlossary(manyRedefs.join('\n')).ok).toBe(true)
  })

  it('reports the line number of a line with no "="', () => {
    const r = parseGlossary('A = 甲\nbroken line')
    expect(r.ok).toBe(false)
    expect(!r.ok && r.error).toContain('Line 2')
  })

  it('rejects an entry with an empty target', () => {
    const r = parseGlossary('A =')
    expect(r.ok).toBe(false)
    expect(!r.ok && r.error).toContain('Line 1')
  })

  it('rejects an entry with an empty source', () => {
    const r = parseGlossary('= 甲')
    expect(r.ok).toBe(false)
    expect(!r.ok && r.error).toContain('Line 1')
  })

  // Unbounded, the prompt is re-sent with every request; one stray paste would
  // take down every translation on the page.
  it('rejects more than the entry limit', () => {
    const lines = Array.from(
      { length: MAX_GLOSSARY_ENTRIES + 1 },
      (_, i) => `t${i} = v${i}`,
    )
    const r = parseGlossary(lines.join('\n'))
    expect(r.ok).toBe(false)
    expect(!r.ok && r.error).toContain(String(MAX_GLOSSARY_ENTRIES))
  })

  it('returns an empty list for empty or comment-only input', () => {
    expect(parseGlossary('')).toEqual({ ok: true, value: [] })
    expect(parseGlossary('! just a comment\n\n')).toEqual({ ok: true, value: [] })
  })
})

describe('renderGlossary', () => {
  it('renders nothing for an empty list', () => {
    // The caller substitutes this into the prompt; an empty string keeps the
    // rendered prompt byte-identical to the no-glossary one.
    expect(renderGlossary([])).toBe('')
  })

  it('pairs every term on its own line', () => {
    const out = renderGlossary([
      { source: 'A', target: '甲' },
      { source: 'B', target: '乙' },
    ])
    expect(out).toContain('- "A" → "甲"')
    expect(out).toContain('- "B" → "乙"')
  })

  it('quotes both sides so a term containing markdown cannot break the list', () => {
    const out = renderGlossary([{ source: 'a - b', target: '甲 *乙*' }])
    expect(out).toContain('- "a - b" → "甲 *乙*"')
  })
})
