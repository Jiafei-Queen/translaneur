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
      'Head{{title_prompt}}{{summary_prompt}}\n\n\nTail{{imt_style_guide}}',
      'zh',
    )
    expect(rendered).toBe('Head\n\nTail')
    expect(rendered).not.toContain('{{')
  })

  it('strips {{terms_prompt}} when no glossary is given', () => {
    const rendered = renderSystemPrompt('Head{{terms_prompt}}\n\n\nTail', 'zh')
    expect(rendered).toBe('Head\n\nTail')
  })

  it('fills {{terms_prompt}} from the glossary', () => {
    const rendered = renderSystemPrompt(
      'Head{{terms_prompt}}\n\nTail',
      'zh',
      [{ source: 'Tensor', target: '张量' }],
    )
    expect(rendered).toContain('- "Tensor" → "张量"')
    expect(rendered).not.toContain('{{')
  })

  // renderSystemPrompt replaces {{terms_prompt}} before the generic
  // placeholder-stripping pass, so a glossary section containing a literal
  // {{word}} must not be mistaken for an unfilled placeholder and deleted.
  it('keeps a glossary entry whose text contains a placeholder', () => {
    const rendered = renderSystemPrompt(
      'Head{{terms_prompt}}',
      'zh',
      [{ source: 'weird', target: '{{to}}' }],
    )
    expect(rendered).toContain('{{to}}')
  })

  it('is unchanged by an empty glossary', () => {
    const template = 'Head{{terms_prompt}}\n\nTail'
    expect(renderSystemPrompt(template, 'zh', [])).toBe(
      renderSystemPrompt(template, 'zh'),
    )
  })

  // The options page reports every parsed term as active. A user who edits
  // the system prompt and deletes {{terms_prompt}} must still get those terms,
  // or the field is claiming to work while doing nothing.
  it('still injects the glossary when the template dropped the placeholder', () => {
    const rendered = renderSystemPrompt('Head\n\nTail', 'zh', [
      { source: 'Tensor', target: '张量' },
    ])
    expect(rendered).toContain('- "Tensor" → "张量"')
    expect(rendered.indexOf('- "Tensor"')).toBeGreaterThan(rendered.indexOf('Tail'))
  })

  it('appends nothing for a template without the placeholder and no glossary', () => {
    expect(renderSystemPrompt('Head\n\nTail', 'zh', [])).toBe('Head\n\nTail')
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