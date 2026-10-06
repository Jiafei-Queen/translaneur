import type { RenderMode } from './storage'
import { isUrlOnly } from './utils'

// The tab title is a single string, not a DOM subtree: the body walker has
// nothing to walk, so the title gets its own small pipeline — extract the
// current text, translate it through the same `translate` message (cache and
// batching come for free), and write the result back to document.title.
// decomposeTitle is what keeps the page's own title changes flowing in while
// a bilingual translation owns the head of the string, so a stop restores
// what the page last showed, not a stale snapshot from start time.

/** Titles that need no translation: blank, a bare URL, or pure decoration. */
export function shouldTranslateTitle(title: string): boolean {
  const trimmed = title.trim()
  if (trimmed.length < 2) return false
  return !isUrlOnly(trimmed)
}

/**
 * The string to write to document.title, given the display mode.
 *
 * Bilingual keeps the original visible after the translation — a tab bar has
 * room for one line, so the translation leads and the original follows as the
 * reference, the same order the page layout shows. Translation-only replaces
 * the title outright, matching the in-page behaviour of the mode.
 */
export const TITLE_SEPARATOR = ' — '

export function composeTitle(
  translated: string,
  original: string,
  renderMode: RenderMode,
): string {
  return renderMode === 'bilingual'
    ? `${translated}${TITLE_SEPARATOR}${original}`
    : translated
}

/**
 * The part of a composed title that is the page's vs ours.
 *
 * When the page changes its title under a bilingual translation, the mutation
 * observer sees the full document.title — our prefix plus the page's new
 * suffix. Splitting on the separator recovers the page's own part so it can
 * be tracked as the new original (and re-translated on its own). Returns null
 * when the title carries no marker of ours, i.e. it is entirely the page's.
 *
 * The separator is written as ` — ` by composeTitle; reading back must match
 * that exact spacing. An em dash already inside the page's own text stays
 * ambiguous by design: the split takes the FIRST separator, so an original
 * containing one keeps everything after it as page text rather than wrongly
 * chopping our translation prefix into it.
 */
export function decomposeTitle(
  title: string,
  renderMode: RenderMode,
): string | null {
  if (renderMode !== 'bilingual') return null
  const idx = title.indexOf(TITLE_SEPARATOR)
  if (idx <= 0) return null
  return title.slice(idx + TITLE_SEPARATOR.length)
}
