import { describe, it, expect } from 'vitest'
import { DEFAULT_SYSTEM_PROMPT, renderSystemPrompt } from './prompt'

describe('renderSystemPrompt', () => {
  it('substitutes the Immersive Translate placeholder', () => {
    expect(renderSystemPrompt('Translate into {{to}} now', 'zh')).toBe(
      'Translate into zh now',
    )
  })

  it('substitutes the extension placeholder', () => {
    expect(renderSystemPrompt('Translate into {{targetLang}} now', 'zh')).toBe(
      'Translate into zh now',
    )
  })

  it('substitutes every occurrence, not just the first', () => {
    expect(renderSystemPrompt('{{to}} and {{to}}', 'ja')).toBe('ja and ja')
  })

  it('strips placeholders this extension has no producer for', () => {
    const rendered = renderSystemPrompt(
      'Head{{title_prompt}}{{summary_prompt}}{{terms_prompt}}\n\n\nTail{{imt_style_guide}}',
      'zh',
    )
    expect(rendered).toBe('Head\n\nTail')
    expect(rendered).not.toContain('{{')
  })

  it('collapses the blank runs left behind by stripped placeholders', () => {
    expect(renderSystemPrompt('A\n\n\n\n\nB', 'zh')).toBe('A\n\nB')
  })

  it('trims the result', () => {
    expect(renderSystemPrompt('\n\n  body  \n\n', 'zh')).toBe('body')
  })
})

describe('DEFAULT_SYSTEM_PROMPT', () => {
  it('is the shipped prompt.md template', () => {
    expect(DEFAULT_SYSTEM_PROMPT).toContain('## Translation Rules')
  })

  it('renders to a prompt with no placeholder left in it', () => {
    const rendered = renderSystemPrompt(DEFAULT_SYSTEM_PROMPT, 'zh')
    expect(rendered).toContain('zh native translator')
    expect(rendered).not.toContain('{{')
  })

  it('keeps the %% paragraph-separator instructions the parser relies on', () => {
    expect(DEFAULT_SYSTEM_PROMPT).toContain('%%')
  })
})