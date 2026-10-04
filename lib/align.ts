// A block's text-node runs, and how a translated block maps back onto them.
//
// A block is sent as one string, so a provider that reorders segments loses the
// run boundaries. Each run is therefore marked with an id, and the response is
// re-split on those ids.
//
// Every block is sent marked, in both display modes. That is what makes the
// cache key mode-independent — a bilingual run and a later translation-only run
// of the same block ask for the same string, so the second one is a cache hit
// instead of a second bill. Bilingual shows the response's plain text instead
// (see replaceWithTranslation), so the markers never reach the page.
//
// Two syntaxes, one per transport. What decides survival is not the provider
// but whether the marker is an anchor the translator can move; the captures are
// in docs/marker-behaviour.md.
//
//   `<i id="N">text</i>` — Google translateHtml, which parses markup. The tag
//                      must *carry* the run: an inert marker (an empty tag) has
//                      its ids dropped for CJK source, and the response comes
//                      back as one merged run.
//
//   `⟦N⟧`            — plain-text providers (Bing, OpenAI, Imp): passed through,
//                      or moved by the model.
//
// Reordering is therefore normal: `splitTranslation` returns pieces in the
// provider's *output* order, the target language's reading order. Writing those
// into document-order slots puts the sentence back together; what it cannot do
// is hold an inline element to the words it started with. See lib/render.ts.
//
// Runs carrying no words — whitespace, punctuation, digits, `isPassthroughRun` —
// are sent untagged and left untouched on the page: they need no translation,
// and a tagged one makes Google nest the next tag inside it, losing its id.
//
// buildMarkedSource always emits the `⟦N⟧` canonical form, because that is what
// `data-imp-text` tokens and the idb cache key are derived from; the Google wire
// form is produced per request by toGoogleMarkupSource. Parsing accepts the
// bracket form too, so a response cached from another provider still reads (the
// cache key carries no provider).
//
// Markers can still be lost, and fallback pieces cut at offsets unrelated to the
// run boundaries — so callers must not write them into a block whose boundaries
// are visible (links, inline styling). See lib/render.ts.

/**
 * Runs sent as bare text instead of as a tagged segment: whitespace, brackets,
 * digits and quotes need no translation, and tagging one is what makes Google
 * emit the *next* tag nested inside it, losing that tag's id. Sent bare, the
 * characters still reach the endpoint as a separator between the runs around
 * them, and the node they came from is left untouched on the page.
 *
 * Both sides of the wire call this — `toGoogleMarkupSource` to decide what gets
 * a tag, `splitTranslation` to work out which ids to expect back.
 */
export function isPassthroughRun(text: string): boolean {
  return /^[\s\[\]\d"'“”‘’]*$/.test(text)
}

/**
 * Marker-shaped tags, for sanitising run text: page text must not be able to
 * present itself as a run marker. Anti-forgery is the whole job — not whitespace
 * stripping — and that is what bounds the pattern.
 *
 * First branch: the legacy `<x id="N"></x>` pair, consumed as a unit so a page
 * carrying the literal does not lose half of it. Second: a bare or self-closing
 * opener, which cannot forge anything alone — `ANY_MARK_RE` only matches a
 * *complete* pair, so deleting the opener is enough, and the text it would have
 * enclosed is page text to keep. Bare closers stay for the same reason (`</i>`
 * is ordinary prose on documentation sites). No branch may span from an opener
 * to an unrelated closer.
 */
const MARK_TAG_RE = /<x id="\d+"><\/x>|<[xi] id="\d+"\s*\/?>/g

/**
 * Wire tags *and* closers: when markers did not parse the pairs are ours, and a
 * closer left behind would be written to the page. Covers the `<x id>` era too.
 */
const WIRE_RESIDUE_RE = /<[xi] id="\d+"\s*\/?>|<\/[xi]>/g

/** Splits a canonical marked source into `[lead, id, text, id, text, …]`. */
const BRACKET_SPLIT_RE = /⟦(\d+)⟧/
/**
 * One pass over both syntaxes: the Google wire tag and the `⟦N⟧` token. The
 * `<i>` branch captures its inner text because translateHtml returns the run
 * *wrapped* in the tag, while a bracket mark leaves the run after it. Run text is
 * escaped on the wire, so an `<i id="N">` inside a run can only be another
 * marker — hence the lookahead, which stops an unclosed tag from swallowing the
 * rest of the response as one run.
 */
const ANY_MARK_RE = /<i id="(\d+)">((?:(?!<i id=")[\s\S])*?)<\/i>|⟦(\d+)⟧/g

/**
 * Canonical marked source for a block whose visible text is split into
 * `runTexts` (document order). Empty input yields an empty string.
 *
 * Multi-run blocks strip wire-tag literals and marker brackets from run text so
 * page text can't forge a marker — the `<i id>` form reappears in decoded text
 * after a Google round-trip, and a surviving literal would parse as a phantom
 * run id. Single-run blocks skip both the markers and that strip: their response
 * is returned verbatim, so there is nothing to forge against, and sanitising
 * would only destroy page text — `⟦a, b⟧` is how Wikipedia writes a closed
 * interval, and single-run paragraphs are the common case.
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
 * Only the canonical `⟦N⟧` form counts: the wire tag carries its run's
 * translated text *inside* the tag, so matching that shape here would delete the
 * very text this function exists to keep. Wire residue is a response-side
 * problem, handled in `splitTranslation`'s fallback. The digits are part of the
 * marker — stripping only `[⟦⟧]` would leave `1`/`2`/`3` behind and the result
 * would no longer equal what the page shows.
 */
export function stripMarkers(marked: string): string {
  return marked.replace(/⟦\d+⟧/g, '')
}

/**
 * Rewrites a canonical `⟦N⟧`-marked source into the Google wire format: each run
 * becomes `<i id="N">run text</i>`, except passthrough runs, which stay bare.
 *
 * Unmarked input (single-run blocks, every bilingual string) is escaped
 * wholesale, so callers that never mark anything keep byte-identical output to a
 * plain `escape(text)`. Ids stay the canonical run numbers, and stay sparse when
 * a run is passthrough — the endpoint returns them unchanged, so nothing
 * downstream has to map a compacted index back to a run. `escape` is the
 * caller's, to keep one HTML-escaping implementation in the codebase.
 */
export function toGoogleMarkupSource(
  marked: string,
  escape: (s: string) => string,
): string {
  const parts = marked.split(BRACKET_SPLIT_RE)
  if (parts.length === 1) return escape(marked)
  let out = escape(parts[0]!)
  for (let i = 1; i < parts.length; i += 2) {
    const text = parts[i + 1] ?? ''
    out += isPassthroughRun(text)
      ? escape(text)
      : `<i id="${parts[i]!}">${escape(text)}</i>`
  }
  return out
}

export interface SplitResult {
  /**
   * One piece per run that gets written back, in the provider's output order:
   * `pieces[k]` goes into the k-th written run in document order. Passthrough
   * runs are absent, and empty when nothing is written.
   */
  pieces: string[]
  /**
   * The response's own text with its markers removed, in the provider's output
   * order and with nothing dropped — passthrough text included. This is what a
   * caller showing one string for the whole block needs (bilingual).
   */
  plain: string
  /** True when marker-based alignment succeeded; false after fallback. */
  exact: boolean
}

/**
 * Splits a translated block string back into per-run pieces.
 *
 * A response is complete when it carries, exactly once each, either the ids the
 * wire form tagged — the Google path leaves passthrough runs untagged — or every
 * run id, which is what the canonical `⟦N⟧` payload asks for on the plain-text
 * and model paths. Anything else has lost or invented a marker: fallback, which
 * cuts the marker-free text proportionally by the tagged runs' lengths.
 *
 * Pieces come back in the provider's output order, one per run that will be
 * written: each is the text between its own mark and the next mark in appearance
 * order, so text pushed outside the tags stays with the piece it follows.
 */
export function splitTranslation(translated: string, runTexts: string[]): SplitResult {
  if (runTexts.length === 0) return { pieces: [], plain: translated, exact: true }
  // A single run was sent unmarked, so its response is the block's text as-is —
  // including a `⟦N⟧` the page itself wrote, which is why nothing is stripped.
  if (runTexts.length === 1) return { pieces: [translated], plain: translated, exact: true }

  const plain = translated.replace(/⟦\d+⟧/g, '').replace(WIRE_RESIDUE_RE, '')
  const fullIds = runTexts.map((_, k) => k + 1)
  const taggedIds = fullIds.filter((id) => !isPassthroughRun(runTexts[id - 1]!))

  const marks: { id: number; start: number; end: number; inner: string }[] = []
  for (let m = ANY_MARK_RE.exec(translated); m; m = ANY_MARK_RE.exec(translated)) {
    marks.push({
      id: Number(m[1] ?? m[3]),
      start: m.index,
      end: m.index + m[0].length,
      inner: m[2] ?? '',
    })
  }
  ANY_MARK_RE.lastIndex = 0

  const found = new Set(marks.map((m) => m.id))
  const complete = (expected: number[]): boolean =>
    marks.length === expected.length &&
    found.size === expected.length &&
    expected.every((id) => found.has(id))

  const writable = (id: number): boolean => !isPassthroughRun(runTexts[id - 1]!)

  if (complete(taggedIds) || complete(fullIds)) {
    const ordered = marks.map((mark, k) => ({
      id: mark.id,
      // A wrapped run's own text came back inside its tag; the rest is whatever
      // sits between that tag and the next mark.
      text:
        mark.inner +
        translated.slice(mark.end, k + 1 < marks.length ? marks[k + 1]!.start : translated.length),
    }))
    // The mark the prefix sits in front of may belong to a passthrough run,
    // whose piece is dropped — so the prefix goes to the first piece kept.
    const first = ordered.findIndex((piece) => writable(piece.id))
    if (first >= 0) {
      ordered[first]!.text = translated.slice(0, marks[0]!.start) + ordered[first]!.text
    }
    return {
      pieces: ordered.filter((piece) => writable(piece.id)).map((piece) => piece.text),
      plain,
      exact: true,
    }
  }

  const out = [...plain]
  const lens = taggedIds.map((id) => [...runTexts[id - 1]!].length)
  const total = lens.reduce((a, b) => a + b, 0)
  const pieces: string[] = []
  let cum = 0
  let prev = 0
  for (let i = 0; i < lens.length; i++) {
    cum += lens[i]!
    const boundary = i === lens.length - 1 ? out.length : Math.round((cum / total) * out.length)
    pieces.push(out.slice(prev, boundary).join(''))
    prev = boundary
  }
  return { pieces, plain, exact: false }
}
