import { describe, it, expect } from 'vitest'
import { maskTerms, restoreTerms } from './term-sentinel'

const terms = [
  { source: 'Kubernetes', target: '库伯内特斯' },
  { source: 'Mercury', target: '汞' },
]

describe('maskTerms', () => {
  it('replaces a term with a sentinel and binds it back', () => {
    const { text, bindings } = maskTerms('Mercury is an element.', terms)
    expect(text).not.toContain('Mercury')
    expect(bindings).toHaveLength(1)
    expect(bindings[0]).toMatchObject({ source: 'Mercury', target: '汞' })
    expect(restoreTerms(text, bindings).text).toBe('汞 is an element.')
  })

  it('leaves text with no glossary term untouched', () => {
    const { text, bindings } = maskTerms('Nothing to see here.', terms)
    expect(text).toBe('Nothing to see here.')
    expect(bindings).toHaveLength(0)
  })

  it('reuses one sentinel for repeated occurrences of a term', () => {
    const { text, bindings } = maskTerms('Mercury and Mercury again.', terms)
    expect(bindings).toHaveLength(1)
    const sentinel = bindings[0]!.sentinel
    expect(text.split(sentinel)).toHaveLength(3)
  })

  it('masks case-insensitively but restores the target, not the source', () => {
    const { text, bindings } = maskTerms('MERCURY is an element.', terms)
    expect(bindings[0]!.source).toBe('Mercury')
    expect(restoreTerms(text, bindings).text).toBe('汞 is an element.')
  })

  // Longest-first: 'Kubernetes' contains a plausible shorter glossary entry, and
  // matching the short one first would nest sentinels, leaving the inner one to
  // be restored inside the outer's target text.
  it('prefers the longest term when one contains another', () => {
    const { text, bindings } = maskTerms('Kubernetes runs.', [
      { source: 'Kuber', target: '短' },
      { source: 'Kubernetes', target: '库伯内特斯' },
    ])
    expect(bindings).toHaveLength(1)
    expect(bindings[0]!.source).toBe('Kubernetes')
    expect(restoreTerms(text, bindings).text).toBe('库伯内特斯 runs.')
  })

  it('escapes regex metacharacters in a term', () => {
    const { text, bindings } = maskTerms('Node.js is here.', [
      { source: 'Node.js', target: '节点' },
    ])
    expect(bindings).toHaveLength(1)
    expect(restoreTerms(text, bindings).text).toBe('节点 is here.')
  })

  it('returns the input unchanged for an empty term list', () => {
    expect(maskTerms('Hello', []).text).toBe('Hello')
  })

  it('returns the input unchanged for empty text', () => {
    expect(maskTerms('', terms).text).toBe('')
  })

  it('masks a Chinese term', () => {
    const { text, bindings } = maskTerms('这是一个山寨机', [
      { source: '山寨', target: '仿冒' },
    ])
    expect(restoreTerms(text, bindings).text).toBe('这是一个仿冒机')
  })
})

describe('restoreTerms', () => {
  // A sentinel-shaped string with no binding is still reported: it is either
  // one of ours that the provider mangled, or page text that happens to match.
  // Either way the caller needs to know rather than write it through.
  it('reports a sentinel-shaped string when there are no bindings', () => {
    expect(restoreTerms('ZQX1QXZ is not ours', [])).toEqual({
      text: 'ZQX1QXZ is not ours',
      unresolved: ['ZQX1QXZ'],
      lost: false,
    })
  })

  it('returns the input unchanged when it holds no sentinel', () => {
    expect(restoreTerms('plain text', [])).toEqual({
      text: 'plain text',
      unresolved: [],
      lost: false,
    })
  })

  // A leftover sentinel in the page is visibly wrong; deleting it would
  // instead yield fluent text with the term silently missing. It stays, and
  // the caller is told, so it can fall back.
  it('keeps an unbound sentinel and reports it', () => {
    const { text, unresolved } = restoreTerms('a ZQX7QXZ b', [])
    expect(text).toBe('a ZQX7QXZ b')
    expect(unresolved).toEqual(['ZQX7QXZ'])
  })

  // The real failure mode: the provider dropped OUR sentinel. The text now
  // has no trace of it, so `unresolved` is empty and only the binding
  // comparison can reveal it.
  it('flags a dropped sentinel as lost', () => {
    const { bindings } = maskTerms('Mercury', terms)
    const { text, unresolved, lost } = restoreTerms('is an element.', bindings)
    expect(text).toBe('is an element.')
    expect(unresolved).toEqual([])
    expect(lost).toBe(true)
  })

  it('does not flag a fully restored block as lost', () => {
    const { text, bindings } = maskTerms('Mercury and Kubernetes', terms)
    expect(restoreTerms(text, bindings).lost).toBe(false)
  })

  it('flags a block where only some sentinels came back', () => {
    const { text, bindings } = maskTerms('Mercury and Kubernetes', terms)
    const { bindings: onlyFirst } = maskTerms('Mercury', terms)
    // First sentinel restored, second replaced by the provider with its own text.
    const mangled = text.replace(bindings[1]!.sentinel, '库伯内特斯')
    expect(restoreTerms(mangled, bindings).lost).toBe(true)
    expect(onlyFirst).toHaveLength(1)
  })

  it('restores several terms in one string', () => {
    const { text, bindings } = maskTerms('Mercury and Kubernetes', terms)
    expect(restoreTerms(text, bindings).text).toBe('汞 and 库伯内特斯')
  })
})
