import { describe, expect, it } from 'vitest'
import { buildMarkedSource, splitTranslation, stripMarkers, toGoogleMarkupSource } from './align'

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')

describe('buildMarkedSource', () => {
  it('marks each run in document order', () => {
    expect(buildMarkedSource(['a', 'b', 'c'])).toBe('⟦1⟧a⟦2⟧b⟦3⟧c')
  })

  it('skips markers for single-run blocks', () => {
    expect(buildMarkedSource(['only one'])).toBe('only one')
  })

  it('returns empty string for zero runs', () => {
    expect(buildMarkedSource([])).toBe('')
  })

  it('strips marker brackets from run text', () => {
    expect(buildMarkedSource(['a⟦x', 'b⟧c'])).toBe('⟦1⟧ax⟦2⟧bc')
  })

  it('strips x-tag literals that survive a Google round-trip', () => {
    // A surviving literal would otherwise be read back as a phantom run id.
    expect(buildMarkedSource([`<x id="1"></x>${'k'}eep`, 'more'])).toBe('⟦1⟧keep⟦2⟧more')
  })

  // A single-run block is never split (splitTranslation returns the response
  // verbatim at n === 1), so its text cannot forge a marker — nothing parses it.
  // Sanitizing there only destroys page text, and `⟦a, b⟧` is how Wikipedia
  // writes a closed interval. These run text verbatim now.
  it('leaves a single run exactly as written, brackets included', () => {
    expect(buildMarkedSource(['The interval is denoted ⟦a, b⟧ here.'])).toBe(
      'The interval is denoted ⟦a, b⟧ here.',
    )
  })

  it('leaves a single run with a literal numbered marker exactly as written', () => {
    expect(buildMarkedSource(['A literal ⟦1⟧ marker typed here.'])).toBe(
      'A literal ⟦1⟧ marker typed here.',
    )
  })

  it('leaves a single run with an x-tag literal exactly as written', () => {
    expect(buildMarkedSource(['An unknown tag <x id="1"></x> survives.'])).toBe(
      'An unknown tag <x id="1"></x> survives.',
    )
  })
})

describe('stripMarkers', () => {
  it('returns single-run text unchanged', () => {
    expect(stripMarkers('plain text')).toBe('plain text')
  })

  it('removes canonical markers and rejoins the runs in order', () => {
    expect(stripMarkers(buildMarkedSource(['Click ', 'here', ' now']))).toBe('Click here now')
  })

  // The digits are part of the marker. Stripping only the brackets leaves
  // `1`/`2`/`3` behind, so the "plain" text stops being the page text — and it
  // stops matching the other mode's cache key, which is the whole point of the
  // shared form.
  it('removes the run id with the brackets', () => {
    expect(stripMarkers('⟦1⟧a⟦2⟧b⟦3⟧c')).toBe('abc')
  })

  it('removes the Google x-tag form too', () => {
    expect(stripMarkers('<x id="1"></x>Click<x id="2"></x>here')).toBe('Clickhere')
  })

  it('round-trips buildMarkedSource for multi-run blocks', () => {
    const runs = ['the ', 'free', ' encyclopedia']
    expect(stripMarkers(buildMarkedSource(runs))).toBe(runs.join(''))
  })
})

describe('toGoogleMarkupSource', () => {
  it('escapes unmarked text exactly like a plain escape', () => {
    expect(toGoogleMarkupSource('a <b> & c', esc)).toBe(esc('a <b> & c'))
  })

  it('emits raw empty tags for markers and escapes run text only', () => {
    expect(toGoogleMarkupSource('⟦1⟧a⟦2⟧b⟦3⟧c', esc)).toBe(
      '<x id="1"></x>a<x id="2"></x>b<x id="3"></x>c',
    )
  })

  it('escapes markup inside run text but not the markers', () => {
    expect(toGoogleMarkupSource('⟦1⟧<b>⟦2⟧&x', esc)).toBe(
      '<x id="1"></x>&lt;b&gt;<x id="2"></x>&amp;x',
    )
  })

  it('treats text before the first marker as run text', () => {
    expect(toGoogleMarkupSource('pre⟦1⟧a', esc)).toBe(esc('pre') + '<x id="1"></x>a')
  })

  it('is stateless across calls', () => {
    const marked = '⟦1⟧a⟦2⟧b'
    expect(toGoogleMarkupSource(marked, esc)).toBe(toGoogleMarkupSource(marked, esc))
    expect(toGoogleMarkupSource('plain', esc)).toBe(toGoogleMarkupSource('plain', esc))
  })
})

describe('splitTranslation', () => {
  it('passes single-run translations through verbatim', () => {
    expect(splitTranslation('hello ⟦2⟧', ['x'])).toEqual({ pieces: ['hello ⟦2⟧'], exact: true })
  })

  it('returns no pieces for zero runs', () => {
    expect(splitTranslation('anything', [])).toEqual({ pieces: [], exact: true })
  })

  it('maps pieces by marker id when segments are reordered', () => {
    expect(splitTranslation('X⟦2⟧B⟦1⟧A', ['a', 'b'])).toEqual({ pieces: ['A', 'XB'], exact: true })
  })

  it('prepends the orphan prefix to the first-appearing marker run', () => {
    const out = splitTranslation('[翻译] ⟦1⟧Go to Page 2⟦2⟧\n  ', ['Go to Page 2', '\n  '])
    expect(out).toEqual({ pieces: ['[翻译] Go to Page 2', '\n  '], exact: true })
  })

  it('falls back when a marker id is missing', () => {
    const out = splitTranslation('⟦1⟧a⟦3⟧c', ['a', 'b', 'c'])
    expect(out.exact).toBe(false)
    expect(out.pieces).toEqual(['a', '', 'c'])
  })

  it('falls back on duplicated marker ids', () => {
    expect(splitTranslation('⟦1⟧ab⟦1⟧cd', ['x', 'y']).exact).toBe(false)
  })

  it('falls back on out-of-range marker ids', () => {
    const out = splitTranslation('⟦9⟧X⟦3⟧Y', ['a', 'b'])
    expect(out.exact).toBe(false)
    expect(out.pieces).toEqual(['X', 'Y'])
  })

  it('splits proportionally by run length without markers', () => {
    expect(splitTranslation('123456', ['abc', 'de'])).toEqual({
      pieces: ['1234', '56'],
      exact: false,
    })
  })

  it('keeps all text and no marker residue after fallback', () => {
    const out = splitTranslation('⟦1⟧abc⟦2⟧def', ['a', 'b', 'c'])
    expect(out.exact).toBe(false)
    expect(out.pieces.join('')).toBe('abcdef')
    expect(out.pieces.some((p) => /[⟦⟧]/.test(p))).toBe(false)
  })

  it('maps Google x-tag markers by id when segments are reordered', () => {
    expect(splitTranslation('<x id="2"></x>B<x id="1"></x>A', ['a', 'b'])).toEqual({
      pieces: ['A', 'B'],
      exact: true,
    })
  })

  it('scans both marker syntaxes in one ordered pass', () => {
    expect(splitTranslation('⟦2⟧B<x id="1"></x>A', ['a', 'b'])).toEqual({
      pieces: ['A', 'B'],
      exact: true,
    })
  })

  it('strips x-tag residue after fallback', () => {
    const out = splitTranslation('<x id="1"></x>abc⟦3⟧def', ['a', 'b', 'c'])
    expect(out.exact).toBe(false)
    expect(out.pieces.join('')).toBe('abcdef')
  })
})
