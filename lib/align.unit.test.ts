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

  it('strips a marker-shaped opener but keeps a bare closing tag', () => {
    // `</i>` is ordinary prose on documentation and code sites, and deleting it
    // would change what the page says — the same reason single-run blocks skip
    // sanitising. It cannot forge a marker either, since ANY_MARK_RE only
    // matches a full pair.
    expect(buildMarkedSource(['<i id="1">keep', '</i>more'])).toBe('⟦1⟧keep⟦2⟧</i>more')
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

  it('removes the Google inline-tag form too', () => {
    expect(stripMarkers('<i id="1"></i>Click<i id="2"></i>here')).toBe('Clickhere')
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
      '<i id="1"></i>a<i id="2"></i>b<i id="3"></i>c',
    )
  })

  it('escapes markup inside run text but not the markers', () => {
    expect(toGoogleMarkupSource('⟦1⟧<b>⟦2⟧&x', esc)).toBe(
      '<i id="1"></i>&lt;b&gt;<i id="2"></i>&amp;x',
    )
  })

  it('treats text before the first marker as run text', () => {
    expect(toGoogleMarkupSource('pre⟦1⟧a', esc)).toBe(esc('pre') + '<i id="1"></i>a')
  })

  it('is stateless across calls', () => {
    const marked = '⟦1⟧a⟦2⟧b'
    expect(toGoogleMarkupSource(marked, esc)).toBe(toGoogleMarkupSource(marked, esc))
    expect(toGoogleMarkupSource('plain', esc)).toBe(toGoogleMarkupSource('plain', esc))
  })
})

describe('splitTranslation', () => {
  it('passes single-run translations through verbatim', () => {
    expect(splitTranslation('hello ⟦2⟧', ['x'])).toEqual({
      pieces: ['hello ⟦2⟧'],
      exact: true,
      reordered: false,
    })
  })

  it('returns no pieces for zero runs', () => {
    expect(splitTranslation('anything', [])).toEqual({
      pieces: [],
      exact: true,
      reordered: false,
    })
  })

  it('maps pieces by marker id when segments are reordered', () => {
    expect(splitTranslation('X⟦2⟧B⟦1⟧A', ['a', 'b'])).toEqual({
      pieces: ['A', 'XB'],
      exact: true,
      reordered: true,
    })
  })

  it('prepends the orphan prefix to the first-appearing marker run', () => {
    const out = splitTranslation('[翻译] ⟦1⟧Go to Page 2⟦2⟧\n  ', ['Go to Page 2', '\n  '])
    expect(out).toEqual({ pieces: ['[翻译] Go to Page 2', '\n  '], exact: true, reordered: false })
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
      reordered: false,
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
      reordered: true,
    })
  })

  it('scans both marker syntaxes in one ordered pass', () => {
    expect(splitTranslation('⟦2⟧B<x id="1"></x>A', ['a', 'b'])).toEqual({
      pieces: ['A', 'B'],
      exact: true,
      reordered: true,
    })
  })

  it('strips x-tag residue after fallback', () => {
    const out = splitTranslation('<x id="1"></x>abc⟦3⟧def', ['a', 'b', 'c'])
    expect(out.exact).toBe(false)
    expect(out.pieces.join('')).toBe('abcdef')
  })

  it('strips inline-tag residue after fallback', () => {
    const out = splitTranslation('<i id="1"></i>abc<i id="3"></i>def', ['a', 'b', 'c'])
    expect(out.exact).toBe(false)
    expect(out.pieces.join('')).toBe('abcdef')
  })

  // Below are real captured responses, not hand-written shapes — see
  // docs/marker-behaviour.md. They are what the shipped providers actually
  // return for one fixed paragraph, EN→ZH, and the difference between the
  // first two is the whole reason the wire tag changed.
  const RUNS = [
    'Translaneur is a ',
    'cross-platform ',
    'browser ',
    'extension ',
    'for reading ',
    'foreign ',
    'pages.',
  ]

  it('parses a legacy <x id> response, which is inert rather than wrong', () => {
    // Marks all present, order untouched, translation dead: `extension` → 扩大,
    // the expansion of something. This is what a fragment-by-fragment
    // translation looks like while reporting a perfect alignment, so `exact`
    // says nothing about whether the text is any good.
    const out = splitTranslation(
      '<x id="1"></x>Translaneur 是一家<x id="2"></x>跨平台<x id="3"></x>浏览器' +
        '<x id="4"></x>扩大<x id="5"></x>供阅读<x id="6"></x>外国的<x id="7"></x>页数。',
      RUNS,
    )
    expect(out.pieces).toEqual([
      'Translaneur 是一家',
      '跨平台',
      '浏览器',
      '扩大',
      '供阅读',
      '外国的',
      '页数。',
    ])
    expect(out.exact).toBe(true)
    expect(out.reordered).toBe(false)
  })

  it('parses an inline-tag response and keeps inter-run text with its run', () => {
    // Same source and target with a known inline tag. The endpoint moved the
    // runs to 1,5,6,2,3,4,7 and the text is an ordinary translation. `网页的`
    // sits between the closing tag and the next marker and belongs to run 6.
    const out = splitTranslation(
      '<i id="1">Translaneur 是一款</i><i id="5">用于阅读</i><i id="6">外文</i>网页的' +
        '<i id="2">跨平台</i><i id="3">浏览器</i><i id="4">扩展程序</i><i id="7">。</i>',
      RUNS,
    )
    expect(out.pieces).toEqual([
      'Translaneur 是一款',
      '跨平台',
      '浏览器',
      '扩展程序',
      '用于阅读',
      '外文网页的',
      '。',
    ])
    expect(out.exact).toBe(true)
    expect(out.reordered).toBe(true)
  })

  it('keeps a literal closing tag that belongs to the page text', () => {
    // Run text is escaped on the wire, so a page's own `</i>` comes back as
    // text inside the pair rather than as a second closer.
    const out = splitTranslation(
      '<i id="1">keep</i></i><i id="2">more</i>',
      ['a', 'b'],
    )
    expect(out.pieces).toEqual(['keep</i>', 'more'])
  })

  it('reports a reordered model response instead of silently scrambling it', () => {
    // gpt-6-luna, `⟦N⟧` moved to 1,6,7,2,3,4,5 — the target word order. The
    // pieces are id-correct, but the runs hold fixed source-order slots, so a
    // caller writing them in place would show this nonsense.
    const out = splitTranslation(
      '⟦1⟧Translaneurは、⟦6⟧外国語⟦7⟧のページを読むための⟦2⟧クロスプラットフォーム対応' +
        '⟦3⟧ブラウザー⟦4⟧拡張機能⟦5⟧です。',
      RUNS,
    )
    expect(out.pieces).toEqual([
      'Translaneurは、',
      'クロスプラットフォーム対応',
      'ブラウザー',
      '拡張機能',
      'です。',
      '外国語',
      'のページを読むための',
    ])
    expect(out.exact).toBe(true)
    expect(out.reordered).toBe(true)
  })

  it('reports no reordering when a response keeps source order', () => {
    const out = splitTranslation('⟦1⟧a⟦2⟧b⟦3⟧c', ['a', 'b', 'c'])
    expect(out.reordered).toBe(false)
  })
})
