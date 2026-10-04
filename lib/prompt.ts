import promptTemplate from '@/prompt.md?raw'
import { renderGlossary, type GlossaryEntry } from './glossary'

/** The shipped default system prompt. prompt.md stays the editable source of truth. */
export const DEFAULT_SYSTEM_PROMPT = promptTemplate

const TERMS_PLACEHOLDER = '{{terms_prompt}}'

function tidy(text: string): string {
  // Stripping a placeholder that owned its line leaves a hole; collapse the
  // resulting runs so the prompt keeps its paragraph structure.
  return text.replace(/\n{3,}/g, '\n\n').trim()
}

/**
 * Fills a prompt template for one target language.
 *
 * prompt.md is shared with Immersive Translate and carries placeholders this
 * extension has no producer for (title_prompt, summary_prompt, imt_style_guide).
 * Every remaining `{{word}}` is dropped rather than sent verbatim — a model
 * that sees a literal placeholder tends to echo it.
 *
 * `{{terms_prompt}}` is the exception: it is filled from the user's glossary
 * (lib/glossary.ts) and controls only *where* the glossary section lands.
 *
 * A template that has dropped the placeholder still gets its glossary,
 * appended at the end. The alternative — treating the placeholder as opt-in —
 * means a user who edits the system prompt and deletes the one line they were
 * told was optional ends up with a glossary that silently stops applying, with
 * no signal anywhere: the options page would still report every term as active.
 * Better a section in a slightly unexpected place than a feature that lies
 * about being on.
 *
 * The split runs before the glossary is inserted, so an entry containing
 * `{{word}}` cannot be mistaken for an unfilled placeholder and deleted. A
 * split rather than a sentinel token, because any literal used as a sentinel
 * would also be something a custom prompt might legitimately contain.
 */
export function renderSystemPrompt(
  template: string,
  targetLang: string,
  glossary: GlossaryEntry[] = [],
): string {
  const section = renderGlossary(glossary)
  const substituted = template
    .replaceAll('{{to}}', targetLang)
    .replaceAll('{{targetLang}}', targetLang)

  if (!substituted.includes(TERMS_PLACEHOLDER)) {
    return tidy(
      substituted.replace(/\{\{\s*\w+\s*\}\}/g, '') + (section ? `\n\n${section}` : ''),
    )
  }

  // Split first, strip each chunk second, and only then let the section fill
  // the gap the placeholder left.
  return tidy(
    substituted
      .split(TERMS_PLACEHOLDER)
      .map((chunk) => chunk.replace(/\{\{\s*\w+\s*\}\}/g, ''))
      .join(section),
  )
}
