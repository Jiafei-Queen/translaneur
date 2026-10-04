// Enforces user glossary terms on providers that take no instructions.
//
// Google translateHtml, Bing ttranslatev3 and the Imp endpoint send text and
// return text with no place to put a prompt, so the OpenAI path's
// "here is your glossary" approach does not reach them. What they do guarantee
// is that a string they do not recognise passes through untouched. So a term
// is replaced by an opaque sentinel before the request, and the sentinel is
// swapped for the target rendering after it comes back.
//
// The sentinel is an INDEX, not the term itself, and that is a measured
// decision rather than a stylistic one. Measured on real Wikipedia prose
// against the live endpoint, using the substrate the alignment doc insists on —
// synthetic fixtures previously produced a confident wrong answer here:
//
//   ⟦<term>⟧     3/6   fails as soon as the term is ambiguous, because the
//                        provider TRANSLATES the payload: ⟦Shanzhai⟧ came back
//                        as ⟦山寨⟧, so it survives structurally and still
//                        matches nothing
//   <x id="<term>"></x>   4/6   same failure, same reason
//   ZQX<term>QXZ  6/6   survives, but only because the provider echoed the term
//                        back byte-for-byte — case, spacing, hyphenation and
//                        all. A term the provider chose to localise would not
//                        match, and the term is precisely the thing most likely
//                        to be localised.
//   ZQX<index>QXZ 6/6   no such dependency: the payload carries no source
//                        language in it at all, so there is nothing to translate.
//
// Cost of losing a sentinel, for contrast with run markers: a missing run
// marker cuts text at wrong offsets, which is why lib/render.ts refuses to
// write unverified alignment. A missing term sentinel only means that one
// occurrence was not forced — the sentence still translates, just without the
// user's preferred rendering. The failure mode is benign, and it is silent:
// see `restoreTerms` for how the caller learns about it.
//
// Not measured: Bing. Its token is bound to the IP that scraped it and the
// endpoint 401s from any other origin, so there is no way to run this probe
// against it from a build machine. The text-sentinel shape is the same one the
// run markers already rely on there, but treat the Bing row as unproven until
// someone measures it from a browser session.

/**
 * Term sentinels are plain ASCII alphanumerics wrapped in a fixed prefix and
 * suffix. Chosen so that:
 *  - the provider has no reason to treat it as a word and translate it,
 *  - it survives Google's HTML round-trip as text (measured, unlike the tags),
 *  - and it cannot collide with run markers, which are `⟦N⟧` or the Google wire
 *    form `<i id="N">…</i>`.
 */
const SENTINEL_PREFIX = 'ZQX'
const SENTINEL_SUFFIX = 'QXZ'
const SENTINEL_RE = /ZQX(\d{1,4})QXZ/g

/** Entries of one block's glossary, in the order they will be sent. */
export interface TermBinding {
  /** The glossary source term, exactly as the user typed it. */
  source: string
  /** What it renders as in the target language. */
  target: string
  /** What replaces `source` on the wire. */
  sentinel: string
}

export interface MaskResult {
  text: string
  bindings: TermBinding[]
}

function sentinelFor(index: number): string {
  return `${SENTINEL_PREFIX}${index}${SENTINEL_SUFFIX}`
}

/**
 * Longest-first, so `Kubernetes` is masked as one term before the shorter
 * `en` inside it can be matched on its own. A glossary listing both would
 * otherwise produce nested sentinels and the inner one would be restored
 * inside the outer's replacement text.
 */
function byLengthDescending(a: { source: string }, b: { source: string }): number {
  return b.source.length - a.source.length
}

/**
 * Replaces every glossary term in `text` with a sentinel.
 *
 * Matching is a plain substring search with no word boundaries. That is
 * deliberate: the terms are the user's, and a user writing `AI` means the
 * acronym, not a judgement about which words `AI` is a word inside. Chinese
 * terms have no spaces to bound on, and a boundary rule tuned for English
 * would silently stop matching the half of the list that is not.
 *
 * Case-insensitive, because a glossary entry is about which rendering a term
 * gets, not about capitalisation; the returned `bindings` carry the user's
 * original spelling so the restored text is not silently recased.
 */
export function maskTerms(text: string, terms: { source: string; target: string }[]): MaskResult {
  const bindings: TermBinding[] = []
  if (terms.length === 0 || text === '') return { text, bindings }

  // One combined regex rather than a pass per term: a page block with 50
  // glossary entries would otherwise be 50 full scans of the text.
  const sorted = [...terms].sort(byLengthDescending)
  const pattern = new RegExp(
    sorted.map((t) => escapeRegExp(t.source)).join('|'),
    'gi',
  )
  const indexByLower = new Map(sorted.map((t) => [t.source.toLowerCase(), t]))
  const bySentinel = new Map<string, TermBinding>()

  let counter = 0
  const masked = text.replace(pattern, (match) => {
    const entry = indexByLower.get(match.toLowerCase())
    if (!entry) return match
    // Reuse one sentinel per distinct source, so a term appearing three
    // times costs one binding and stays consistent across the block.
    const existing = bySentinel.get(entry.source)
    if (existing) return existing.sentinel
    const binding: TermBinding = { ...entry, sentinel: sentinelFor(++counter) }
    bySentinel.set(entry.source, binding)
    bindings.push(binding)
    return binding.sentinel
  })

  return { text: masked, bindings }
}

export interface RestoreResult {
  text: string
  /** Sentinel-shaped strings with no binding — ours that got mangled, or page text. */
  unresolved: string[]
  /**
   * Bindings that never came back at all. A dropped sentinel leaves no trace
   * in the response, so this cannot be derived from `unresolved`: without this
   * the missing-term case would be indistinguishable from a translation that
   * legitimately had no such term in it. `true` means the block was translated
   * with the term hidden and the caller should redo it unmasked.
   */
  lost: boolean
}

/**
 * Swaps sentinels back for their target rendering.
 *
 * Sentinels with no binding are left in place rather than deleted. A leftover
 * `ZQX3QXZ` in the page is visibly wrong; silently deleting it would instead
 * produce fluent text with the term missing, which is exactly the kind of
 * corruption this feature exists to prevent. The caller is expected to treat
 * any leftover as a signal that alignment was lost and fall back to the
 * provider's own translation of the unmasked text.
 */
export function restoreTerms(text: string, bindings: TermBinding[]): RestoreResult {
  // No early return on empty bindings: a sentinel in the response with no
  // binding is exactly the case the caller must hear about, and it is the one
  // a "nothing to do" shortcut would have silently swallowed. (Page text can
  // also contain this shape on its own, which is reported the same way.)
  const bySentinel = new Map(bindings.map((b) => [b.sentinel, b.target]))
  const unresolved: string[] = []
  const restored = new Set<string>()
  const out = text.replace(SENTINEL_RE, (match) => {
    const target = bySentinel.get(match)
    if (target !== undefined) {
      restored.add(match)
      return target
    }
    unresolved.push(match)
    return match
  })
  const lost = bindings.some((b) => !restored.has(b.sentinel))
  return { text: out, unresolved, lost }
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}
