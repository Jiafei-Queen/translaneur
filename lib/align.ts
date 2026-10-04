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
// Two marker syntaxes exist because survival is provider-specific, measured on
// real prose (synthetic `word1 word2…` inputs are misleading — they preserve
// markers that real text drops):
//
//   `<x id="N"></x>` — Google translateHtml, which parses markup and preserved
//                      paired empty unknown tags in every real sample tried,
//                      where `⟦N⟧` collapsed to as few as 2/21 markers.
//   `⟦N⟧`            — plain-text providers (Bing, OpenAI, Imp).
//
// buildMarkedSource always emits the `⟦N⟧` canonical form, because that is what
// `data-imp-text` tokens and the idb cache key are derived from; the Google wire
// form is produced per request by toGoogleMarkupSource. Parsing accepts both so
// a response cached from one provider still reads after a switch (the cache key
// carries no provider).
//
// Markers can still be lost, and the fallback cuts at offsets unrelated to the
// run boundaries — so callers must not write fallback pieces into a block whose
// run boundaries are visible (links, inline styling). See lib/render.ts.

/** Google wire marker for run id `n` (1-based). */
function googleRunMarker(n: number): string {
  return `<x id="${n}"></x>`
}

const X_TAG_RE = /<x id="\d+"><\/x>/g
const BRACKET_MARK_RE = /⟦(\d+)⟧/g
const ANY_MARK_RE = /<x id="(\d+)"><\/x>|⟦(\d+)⟧/g

/**
 * Canonical marked source for a block whose visible text is split into
 * `runTexts` (document order). Single-run blocks skip the marker noise; empty
 * input yields an empty string.
 *
 * Multi-run blocks strip marker brackets and x-tag literals from run text so
 * page text can't forge a marker — the x-tag form reappears in decoded text
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
  const sanitized = runTexts.map((text) => text.replace(/[⟦⟧]/g, '').replace(X_TAG_RE, ''))
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
}

/**
 * Splits a translated block string back into per-run pieces.
 *
 * Exact path: markers occur exactly once each for ids 1..N, in any order — a
 * reordered segment is re-mapped by id rather than by position. A piece is the
 * text between its marker and the next marker in appearance order; an orphan
 * prefix before the first marker joins the first-appearing marker's run.
 *
 * Fallback (`exact: false`): residual markers are stripped and the text is cut
 * proportionally by run codepoint length.
 */
export function splitTranslation(translated: string, runTexts: string[]): SplitResult {
  const n = runTexts.length
  if (n === 0) return { pieces: [], exact: true }
  if (n === 1) return { pieces: [translated], exact: true }

  const marks: { id: number; start: number; end: number }[] = []
  for (let m = ANY_MARK_RE.exec(translated); m; m = ANY_MARK_RE.exec(translated)) {
    marks.push({
      id: Number(m[1] ?? m[2]),
      start: m.index,
      end: m.index + m[0].length,
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
      let piece = translated.slice(mark.end, nextStart)
      if (k === 0) piece = translated.slice(0, mark.start) + piece
      pieces[mark.id - 1] = piece
    })
    return { pieces, exact: true }
  }

  const out = [...translated.replace(/⟦\d+⟧/g, '').replace(X_TAG_RE, '')]
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
  return { pieces, exact: false }
}
