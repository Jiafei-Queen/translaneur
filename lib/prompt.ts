import promptTemplate from '@/prompt.md?raw'

/** The shipped default system prompt. prompt.md stays the editable source of truth. */
export const DEFAULT_SYSTEM_PROMPT = promptTemplate

/**
 * Fills a prompt template for one target language.
 *
 * prompt.md is shared with Immersive Translate and carries placeholders this
 * extension has no producer for (title_prompt, summary_prompt, terms_prompt,
 * imt_style_guide). Every remaining `{{word}}` is dropped rather than sent
 * verbatim — a model that sees a literal placeholder tends to echo it.
 */
export function renderSystemPrompt(
  template: string,
  targetLang: string,
): string {
  return template
    .replaceAll('{{to}}', targetLang)
    .replaceAll('{{targetLang}}', targetLang)
    .replace(/\{\{\s*\w+\s*\}\}/g, '')
    // Stripping a placeholder that owned its line leaves a hole; collapse the
    // resulting runs so the prompt keeps its paragraph structure.
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}