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

  it('does not delete page text between a marker-shaped opener and a later closer', () => {
    // A doc page quoting HTML: the opener and the ordinary `</i>` are in the
    // SAME run, so a lazy span between them can reach across. The text inside
    // the tag is page text, not a forged marker — it must survive.
    expect(buildMarkedSource(['<i id="4">getElementById</i> returns a node', 'x'])).toBe(
      '⟦1⟧getElementById</i> returns a node⟦2⟧x',
    )
  })

  it('keeps every quoted tag body when a run holds more than one', () => {
    expect(
      buildMarkedSource(['Example: <i id="7">bold</i> and <i id="8">italic</i> ok.', 'x']),
    ).toBe('⟦1⟧Example: bold</i> and italic</i> ok.⟦2⟧x')
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

  it('leaves a wire tag alone, since it is not a canonical marker', () => {
    // The wire tag holds its run's translated text *inside* itself, so treating
    // that shape as a marker would delete the text this function exists to keep.
    expect(stripMarkers('<i id="1">Click</i>')).toBe('<i id="1">Click</i>')
    expect(stripMarkers('<i id="1"></i>here')).toBe('<i id="1"></i>here')
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

  it('wraps each run in its tag and escapes the run text only', () => {
    expect(toGoogleMarkupSource('⟦1⟧a⟦2⟧b⟦3⟧c', esc)).toBe(
      '<i id="1">a</i><i id="2">b</i><i id="3">c</i>',
    )
  })

  it('escapes markup inside run text but leaves the tags alone', () => {
    expect(toGoogleMarkupSource('⟦1⟧<b>⟦2⟧&x', esc)).toBe(
      '<i id="1">&lt;b&gt;</i><i id="2">&amp;x</i>',
    )
  })

  it('treats text before the first marker as run text', () => {
    expect(toGoogleMarkupSource('pre⟦1⟧a', esc)).toBe(esc('pre') + '<i id="1">a</i>')
  })

  it('sends a passthrough run bare, leaving the next run its own id', () => {
    expect(toGoogleMarkupSource('⟦1⟧这是⟦2⟧第一⟦3⟧ ⟦4⟧部分', esc)).toBe(
      '<i id="1">这是</i><i id="2">第一</i> <i id="4">部分</i>',
    )
    expect(toGoogleMarkupSource('⟦1⟧a⟦2⟧123⟦3⟧b', esc)).toBe(
      '<i id="1">a</i>123<i id="3">b</i>',
    )
  })

  it('is stateless across calls', () => {
    const marked = '⟦1⟧a⟦2⟧b'
    expect(toGoogleMarkupSource(marked, esc)).toBe(toGoogleMarkupSource(marked, esc))
    expect(toGoogleMarkupSource('plain', esc)).toBe(toGoogleMarkupSource('plain', esc))
  })
})

describe('splitTranslation', () => {
  it('passes single-run translations through verbatim', () => {
    // `plain` stays verbatim too: nothing was marked, so nothing is stripped —
    // a `⟦N⟧` here is the page's own text.
    expect(splitTranslation('hello ⟦2⟧', ['x'])).toEqual({
      pieces: ['hello ⟦2⟧'],
      plain: 'hello ⟦2⟧',
      exact: true,
    })
  })

  it('returns no pieces for zero runs', () => {
    expect(splitTranslation('anything', [])).toEqual({ pieces: [], plain: 'anything', exact: true })
  })

  it('returns pieces in the order the provider wrote them, not by id', () => {
    expect(splitTranslation('X⟦2⟧B⟦1⟧A', ['a', 'b'])).toEqual({
      pieces: ['XB', 'A'],
      plain: 'XBA',
      exact: true,
    })
    expect(splitTranslation('<i id="2">B</i><i id="1">A</i>', ['a', 'b'])).toEqual({
      pieces: ['B', 'A'],
      plain: 'BA',
      exact: true,
    })
  })

  it('prepends the orphan prefix to the first-appearing marker run', () => {
    expect(splitTranslation('[翻译] ⟦1⟧A⟦2⟧B', ['a', 'b'])).toEqual({
      pieces: ['[翻译] A', 'B'],
      plain: '[翻译] AB',
      exact: true,
    })
  })

  it('leaves a passthrough run out of the piece list', () => {
    // The middle run holds only whitespace, so it was never tagged and comes
    // back as bare characters: the space rides on the preceding piece.
    expect(splitTranslation('<i id="1">A</i> <i id="3">C</i>', ['a', ' ', 'c'])).toEqual({
      pieces: ['A ', 'C'],
      plain: 'A C',
      exact: true,
    })
  })

  it('accepts a response that marks every run, dropping the passthrough piece', () => {
    // The canonical `⟦N⟧` payload marks every run, so a plain-text or model
    // provider legitimately answers with all three ids — including one for the
    // whitespace run. That piece is dropped by `pieces`; `plain` keeps it,
    // which is what the block-level (bilingual) renderer needs.
    expect(
      splitTranslation('⟦1⟧[翻译] Go to Page 2⟦2⟧\n  ⟦3⟧Open PDF', [
        'Go to Page 2',
        '\n  ',
        'Open PDF',
      ]),
    ).toEqual({
      pieces: ['[翻译] Go to Page 2', 'Open PDF'],
      plain: '[翻译] Go to Page 2\n  Open PDF',
      exact: true,
    })
  })

  it('gives the orphan prefix to the first kept piece', () => {
    // Run 1 holds only digits, so its run is not written; the text the provider
    // put before its first mark belongs with the first piece that survives.
    expect(splitTranslation('[翻译] ⟦1⟧123⟦2⟧甲⟦3⟧乙', ['123', 'a', 'b'])).toEqual({
      pieces: ['[翻译] 甲', '乙'],
      plain: '[翻译] 123甲乙',
      exact: true,
    })
  })

  it('falls back when a tagged run never came back', () => {
    // The Google wire form sent ids 1 and 3; only 1 returned. A partial
    // response is not an alignment.
    const out = splitTranslation('<i id="1">A</i>', ['a', ' ', 'c'])
    expect(out.exact).toBe(false)
    expect(out.pieces).toEqual(['A', ''])
  })

  it('falls back when a marker id is missing', () => {
    const out = splitTranslation('⟦1⟧a⟦3⟧c', ['a', 'b', 'c'])
    expect(out.exact).toBe(false)
    expect(out.pieces).toEqual(['a', '', 'c'])
  })

  it('falls back on duplicated marker ids', () => {
    expect(splitTranslation('⟦1⟧ab⟦1⟧cd', ['x', 'y']).exact).toBe(false)
  })

  it('falls back on marker ids that were never sent', () => {
    const out = splitTranslation('⟦9⟧X⟦3⟧Y', ['a', 'b'])
    expect(out.exact).toBe(false)
    expect(out.pieces).toEqual(['X', 'Y'])
  })

  it('splits proportionally by run length without markers', () => {
    expect(splitTranslation('123456', ['abc', 'de'])).toEqual({
      pieces: ['1234', '56'],
      plain: '123456',
      exact: false,
    })
  })

  it('cuts the fallback by tagged-run length, skipping passthrough runs', () => {
    expect(splitTranslation('abcd', ['ab', ' ', 'cd'])).toEqual({
      pieces: ['ab', 'cd'],
      plain: 'abcd',
      exact: false,
    })
  })

  it('keeps all text and no marker residue after fallback', () => {
    const out = splitTranslation('⟦1⟧abc⟦2⟧def', ['a', 'b', 'c'])
    expect(out.exact).toBe(false)
    expect(out.pieces.join('')).toBe('abcdef')
    expect(out.pieces.some((p) => /[⟦⟧]/.test(p))).toBe(false)
  })

  it('strips inline-tag residue after fallback', () => {
    const out = splitTranslation('<i id="1"></i>abc<i id="3"></i>def', ['a', 'b', 'c'])
    expect(out.exact).toBe(false)
    expect(out.pieces.join('')).toBe('abcdef')
  })

  // Below are real captured responses, not hand-written shapes — see
  // docs/marker-behaviour.md. They are what the shipped providers actually
  // return for one fixed paragraph, EN→ZH.
  const RUNS = [
    'Translaneur is a ',
    'cross-platform ',
    'browser ',
    'extension ',
    'for reading ',
    'foreign ',
    'pages.',
  ]

  it('parses an inline-tag response in output order, keeping inter-run text', () => {
    // The endpoint moved the runs to 1,5,6,2,3,4,7 and the text is an ordinary
    // translation. `网页的` sits between the closing tag and the next mark and
    // belongs to run 6 — the tag it follows in the output, not the slot it
    // occupies on the page.
    const out = splitTranslation(
      '<i id="1">Translaneur 是一款</i><i id="5">用于阅读</i><i id="6">外文</i>网页的' +
        '<i id="2">跨平台</i><i id="3">浏览器</i><i id="4">扩展程序</i><i id="7">。</i>',
      RUNS,
    )
    expect(out.pieces).toEqual([
      'Translaneur 是一款',
      '用于阅读',
      '外文网页的',
      '跨平台',
      '浏览器',
      '扩展程序',
      '。',
    ])
    expect(out.exact).toBe(true)
  })

  it('does not let an unterminated inline tag swallow the rest of the response', () => {
    // The lookahead in ANY_MARK_RE exists for exactly this. Today the input finds
    // zero complete marks and takes the proportional fallback; without the
    // lookahead it would parse as one run carrying the whole remaining response.
    const out = splitTranslation('<i id="1">alpha beta gamma', ['a', 'b', 'c'])
    expect(out.exact).toBe(false)
    expect(out.pieces.join('')).toBe('alpha beta gamma')
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

  it('returns a reordered model response in the target word order', () => {
    // gpt-6-luna, `⟦N⟧` moved to 1,6,7,2,3,4,5 — the target word order. Pieces
    // come back in that order because that is the order they get written in.
    const out = splitTranslation(
      '⟦1⟧Translaneurは、⟦6⟧外国語⟦7⟧のページを読むための⟦2⟧クロスプラットフォーム対応' +
        '⟦3⟧ブラウザー⟦4⟧拡張機能⟦5⟧です。',
      RUNS,
    )
    expect(out.pieces).toEqual([
      'Translaneurは、',
      '外国語',
      'のページを読むための',
      'クロスプラットフォーム対応',
      'ブラウザー',
      '拡張機能',
      'です。',
    ])
    expect(out.exact).toBe(true)
  })

  it('keeps source order when the response kept it', () => {
    expect(splitTranslation('⟦1⟧a⟦2⟧b⟦3⟧c', ['a', 'b', 'c'])).toEqual({
      pieces: ['a', 'b', 'c'],
      plain: 'abc',
      exact: true,
    })
  })
})
