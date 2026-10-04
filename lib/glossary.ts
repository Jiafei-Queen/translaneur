// User-supplied source→target term pairs, rendered into the OpenAI system
// prompt.
//
// Why a glossary and not adjacent-paragraph context: a term has to be the same
// word every time it appears, and only a fixed instruction can promise that.
// Surrounding text is a probabilistic nudge that changes with the block; a term
// list is constant, so it fixes the inconsistency rather than averaging it out.
//
// Scope: the OpenAI path only. Google translateHtml and Bing ttranslatev3 take
// no prompt at all, and protecting terms on those endpoints would need the
// `<i id>` marker machinery documented in docs/translation-only-alignment.md —
// where real-prose marker survival was measured at 2/21. Imp Credits is a
// server-side black box. A field that appears for those providers but cannot
// act would be a lie, so the options page gates it on the provider.

export interface GlossaryEntry {
  source: string
  target: string
}

export type GlossaryParseResult =
  | { ok: true; value: GlossaryEntry[] }
  | { ok: false; error: string }

/**
 * A pasted dictionary easily runs to thousands of lines, and the prompt is
 * re-sent with every request — an unbounded list turns one stray paste into
 * every request on the page failing. Bounded and reported, never silently
 * truncated.
 */
export const MAX_GLOSSARY_ENTRIES = 200

/**
 * Parses the options-page textarea. One entry per line, `source = target`.
 *
 * Lines starting with `!` are comments and blank lines are skipped, matching
 * the syntax of lib/rules.txt and its custom-rules field — this is the same
 * "user types a rules list" gesture and should read the same way.
 *
 * Splits on the first `=` only, so a target may itself contain one. A repeated
 * source takes the last mapping: the textarea is ordered and the bottom line
 * is the one the user most recently typed.
 */
export function parseGlossary(raw: string): GlossaryParseResult {
  const bySource = new Map<string, GlossaryEntry>()
  for (const [index, line] of raw.split('\n').entries()) {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith('!')) continue

    const eq = trimmed.indexOf('=')
    if (eq === -1) {
      return {
        ok: false,
        error: `Line ${index + 1}: expected "source = target"`,
      }
    }
    const source = trimmed.slice(0, eq).trim()
    const target = trimmed.slice(eq + 1).trim()
    if (!source || !target) {
      return {
        ok: false,
        error: `Line ${index + 1}: both sides of "=" are required`,
      }
    }
    bySource.set(source, { source, target })
    if (bySource.size > MAX_GLOSSARY_ENTRIES) {
      return {
        ok: false,
        error: `Too many terms — the limit is ${MAX_GLOSSARY_ENTRIES}`,
      }
    }
  }
  return { ok: true, value: [...bySource.values()] }
}

/**
 * The prompt section for a parsed glossary, or '' when there are no entries —
 * the caller then substitutes nothing and the rendered prompt is byte-identical
 * to what a user with an empty field got before this feature existed.
 */
export function renderGlossary(entries: GlossaryEntry[]): string {
  if (entries.length === 0) return ''
  const lines = entries.map((e) => `- "${e.source}" → "${e.target}"`).join('\n')
  return [
    '## Glossary',
    'These renderings are fixed. Use them every time the term appears, even',
    'where a different rendering would read better in that sentence.',
    lines,
  ].join('\n')
}
