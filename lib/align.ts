// A block's text-node runs, and how a translated block maps back onto them.
//
// A block is sent as one string, so a provider that reorders segments loses the
// run boundaries. Each run is therefore prefixed with an id marker, and the
// response is re-split on those ids.
//
// Every block is sent marked, in both display modes. That is what makes the
// cache key mode-independent — a bilingual run and a later translation-only run
// of the same block ask for the same string, so the second one is a cache hit
// instead of a second bill. The bilingual renderer pays the split back by
// rejoining the pieces (see replaceWithTranslation), so the markers never reach
// the page.
//
// Two marker syntaxes exist, chosen per provider from measurements on real prose
// (synthetic `word1 word2…` inputs are misleading — they preserve markers that
// real text drops). What decides behaviour is not the provider but the *tag
// class*: whether the marker carries semantic weight a translator can use as an
// anchor. See docs/marker-behaviour.md for the captures.
//
//   `<i id="N"></i>` — Google translateHtml, which parses markup. A known inline
//                      tag is an anchor: the endpoint moves it to where the target
//                      language wants it and returns the run wrapped in it,
//                      `<i id="N">translated</i>`, ids intact. An unknown empty
//                      tag — `<x id="N"></x>`, shipped until this was measured —
//                      survives just as reliably and is inert, so every run is
//                      translated as an isolated fragment (`extension` → 扩大, the
//                      expansion of something) and the ids return in source
//                      order. Perfect alignment over a dead translation.
//
//   `⟦N⟧`            — plain-text providers (Bing, OpenAI, Imp). A plain-text
//                      endpoint passes the marker through; a model reinterprets
//                      it. Both keep every marker, but only the model moves the
//                      text, to the target language's word order.
//
// Reordering is therefore possible on every path. `splitTranslation` undoes it —
// the pieces stay id-correct — but the page cannot express it, because the runs
// are fixed slots. See `reordered`.
//
// buildMarkedSource always emits the `⟦N⟧` canonical form, because that is what
// `data-imp-text` tokens and the idb cache key are derived from; the Google wire
// form is produced per request by toGoogleMarkupSource. Parsing accepts every
// syntax so a response cached from one provider still reads after a switch (the
// cache key carries no provider).
//
// Markers can still be lost, and the fallback cuts at offsets unrelated to the
// run boundaries — so callers must not write fallback pieces into a block whose
// run boundaries are visible (links, inline styling). See lib/render.ts.

/**
 * Google wire marker for run id `n` (1-based).
 *
 * `<i>` because translateHtml treats a known inline tag as a reordering anchor,
 * and an inert marker costs a fragment translation of every run in the block.
 * Both forms survive the round trip with their ids; only one survives with its
 * meaning. The wire form is balanced so the endpoint receives well-formed markup
 * — it comes back wrapping the run, not empty.
 */
function googleRunMarker(n: number): string {
  return `<i id="${n}"></i>`
}

/**
 * Marker-shaped tags, for sanitising run text: page text must not be able to
 * present itself as a run marker. Anti-forgery is the whole job here — not
 * whitespace stripping — and that is what bounds the pattern.
 *
 * First branch: the legacy `<x id="N"></x>` empty pair, consumed as a unit. It
 * is a real marker, so removing it whole is the point; nothing else encloses
 * text, because the empty pair cannot carry any.
 *
 * Second branch: a bare or self-closing opener, which cannot forge anything on
 * its own — `ANY_MARK_RE` only ever matches a *complete* pair, so deleting the
 * opener is sufficient to stop page text passing as a marker. The text it would
 * have enclosed is page text, not part of any forgery, and must be kept. Same
 * reason bare closers are left alone: `</i>` is ordinary prose on documentation
 * and code sites, and deleting it would change what the page says — which is
 * also why single-run blocks skip sanitising altogether.
 *
 * No branch may span from an opener to an unrelated closer. `ANY_MARK_RE`
 * matching a pair does not license deleting the run text between one.
 */
const MARK_TAG_RE = /<x id="\d+"><\/x>|<[xi] id="\d+"\s*\/?>/g

/**
 * Wire tags *and* closers, for cleaning a response whose markers did not parse:
 * there the pairs are ours, and the closers would otherwise be written to the
 * page. Covers the `<x id>` era too, so a response cached before the wire-form
 * change still reads.
 */
const WIRE_RESIDUE_RE = /<[xi] id="\d+"\s*\/?>|<\/[xi]>/g

const BRACKET_MARK_RE = /⟦(\d+)⟧/g
/**
 * One pass over all three syntaxes, oldest first. The `<i>` branch captures its
 * inner text because translateHtml returns the run *wrapped* in the tag, while
 * the other two leave the run after an empty mark.
 *
 * Run text is escaped on the wire, so an `<i id="N">` inside a run can only be
 * another marker — hence the lookahead, which stops an unclosed tag from
 * swallowing the rest of the response as one run.
 */
const ANY_MARK_RE =
  /<x id="(\d+)"><\/x>|<i id="(\d+)">((?:(?!<i id=")[\s\S])*?)<\/i>|⟦(\d+)⟧/g

/**
 * Canonical marked source for a block whose visible text is split into
 * `runTexts` (document order). Single-run blocks skip the marker noise; empty
 * input yields an empty string.
 *
 * Multi-run blocks strip marker brackets and wire-tag literals from run text so
 * page text can't forge a marker — the `<i id>` form reappears in decoded text
 * after a Google round-trip, and a surviving literal would parse as a phantom
 * run id.
 *
 * Single-run blocks skip that strip: `splitTranslation` returns the response
 * verbatim for them and never parses a marker, so there is nothing to forge
 * against. Sanitizing there only destroys page text — `⟦a, b⟧` is how Wikipedia
 * writes a closed interval, and single-run paragraphs are the common case.
 */
export function buildMarkedSource(runTexts: string[]): string {
  if (runTexts.length === 0) return ''
  if (runTexts.length === 1) return runTexts[0]!
  const sanitized = runTexts.map((text) => text.replace(/[⟦⟧]/g, '').replace(MARK_TAG_RE, ''))
  return sanitized.map((text, i) => `⟦${i + 1}⟧${text}`).join('')
}

/**
 * A canonical marked source with every run marker removed, giving back the
 * block's visible text.
 *
 * The digits are part of the marker: stripping only `[⟦⟧]` leaves `1`/`2`/`3`
 * behind and the "plain" text no longer equals what the page shows.
 */
export function stripMarkers(marked: string): string {
  return marked.replace(ANY_MARK_RE, '')
}

/**
 * Rewrites a canonical `⟦N⟧`-marked source into the Google wire format: markers
 * become raw empty tags, run text is escaped. Unmarked input (single-run
 * blocks, every bilingual string) is escaped wholesale, so callers that never
 * mark anything keep byte-identical output to a plain `escape(text)`.
 *
 * `escape` is supplied by the caller to keep one HTML-escaping implementation
 * in the codebase.
 */
export function toGoogleMarkupSource(
  marked: string,
  escape: (s: string) => string,
): string {
  let out = ''
  let prev = 0
  let saw = false
  for (let m = BRACKET_MARK_RE.exec(marked); m; m = BRACKET_MARK_RE.exec(marked)) {
    saw = true
    // slice from prev to m.index, so text before the first marker is escaped
    // as run text rather than dropped.
    out += escape(marked.slice(prev, m.index)) + googleRunMarker(Number(m[1]))
    prev = m.index + m[0].length
  }
  BRACKET_MARK_RE.lastIndex = 0
  return saw ? out + escape(marked.slice(prev)) : escape(marked)
}

export interface SplitResult {
  /** One piece per run, in run order (`pieces[i]` ↔ `runTexts[i]`). */
  pieces: string[]
  /** True when marker-based alignment succeeded; false after fallback. */
  exact: boolean
  /**
   * True when the provider emitted run markers out of source order, so the
   * target language wanted the runs somewhere else.
   *
   * The pieces are still id-correct — this is not a parsing failure. But a
   * caller that writes them into fixed source-order slots cannot express the
   * move, and would show scrambled text while reporting `exact: true`.
   *
   * Only the exact path can answer this: after fallback there are no
   * trustworthy markers left, so there is no reordering to report and the
   * arbitrary cut is governed by `exact` alone. See `swapTextNodes`.
   */
  reordered: boolean
}

/**
 * Splits a translated block string back into per-run pieces.
 *
 * Exact path: markers occur exactly once each for ids 1..N, in any order — a
 * reordered segment is re-mapped by id rather than by position. A piece is the
 * text between its marker and the next marker in appearance order; text between
 * a wrapped run's closing tag and the next marker stays with that run, and an
 * orphan prefix before the first marker joins the first-appearing marker's run.
 *
 * Fallback (`exact: false`): residual markers are stripped and the text is cut
 * proportionally by run codepoint length.
 */
export function splitTranslation(translated: string, runTexts: string[]): SplitResult {
  const n = runTexts.length
  if (n === 0) return { pieces: [], exact: true, reordered: false }
  if (n === 1) return { pieces: [translated], exact: true, reordered: false }

  const marks: { id: number; start: number; end: number; inner?: string }[] = []
  for (let m = ANY_MARK_RE.exec(translated); m; m = ANY_MARK_RE.exec(translated)) {
    marks.push({
      id: Number(m[1] ?? m[2] ?? m[4]),
      start: m.index,
      end: m.index + m[0].length,
      inner: m[3],
    })
  }
  ANY_MARK_RE.lastIndex = 0

  const ids = new Set(marks.map((m) => m.id))
  const valid =
    marks.length === n &&
    ids.size === n &&
    marks.every((m) => m.id >= 1 && m.id <= n)

  if (valid) {
    const pieces: string[] = Array.from({ length: n }, () => '')
    marks.forEach((mark, k) => {
      const nextStart = k + 1 < marks.length ? marks[k + 1]!.start : translated.length
      // A wrapped run's own text came back inside its tag; the rest is whatever
      // sits between that tag and the next marker.
      const trailing = translated.slice(mark.end, nextStart)
      let piece = mark.inner === undefined ? trailing : mark.inner + trailing
      if (k === 0) piece = translated.slice(0, mark.start) + piece
      pieces[mark.id - 1] = piece
    })
    return { pieces, exact: true, reordered: marks.some((m, k) => m.id !== k + 1) }
  }

  const out = [...translated.replace(/⟦\d+⟧/g, '').replace(WIRE_RESIDUE_RE, '')]
  const lens = runTexts.map((t) => [...t].length)
  const total = lens.reduce((a, b) => a + b, 0)
  const pieces: string[] = []
  let cum = 0
  let prev = 0
  for (let i = 0; i < n; i++) {
    cum += lens[i]!
    const boundary = i === n - 1 ? out.length : Math.round((cum / total) * out.length)
    pieces.push(out.slice(prev, boundary).join(''))
    prev = boundary
  }
  return { pieces, exact: false, reordered: false }
}
