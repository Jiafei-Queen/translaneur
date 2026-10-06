import { describe, it, expect } from 'vitest'
import {
  shouldTranslateTitle,
  composeTitle,
  decomposeTitle,
  TITLE_SEPARATOR,
} from './title'

describe('shouldTranslateTitle', () => {
  it('skips blank and single-character titles', () => {
    expect(shouldTranslateTitle('')).toBe(false)
    expect(shouldTranslateTitle('   ')).toBe(false)
    expect(shouldTranslateTitle('a')).toBe(false)
  })

  it('skips bare URLs', () => {
    expect(shouldTranslateTitle('https://example.com/a/b?c=1')).toBe(false)
  })

  it('accepts ordinary titles, including very short ones', () => {
    expect(shouldTranslateTitle('Home')).toBe(true)
    expect(shouldTranslateTitle('测试页面')).toBe(true)
  })
})

describe('composeTitle / decomposeTitle', () => {
  it('bilingual puts the translation first and the original after the separator', () => {
    expect(composeTitle('测试', 'Test', 'bilingual')).toBe(
      `测试${TITLE_SEPARATOR}Test`,
    )
  })

  it('translation-only replaces the title outright', () => {
    expect(composeTitle('测试', 'Test', 'translation-only')).toBe('测试')
  })

  it('decomposeTitle recovers the page part from a composed bilingual title', () => {
    expect(decomposeTitle(`测试${TITLE_SEPARATOR}Test`, 'bilingual')).toBe(
      'Test',
    )
  })

  it('decomposeTitle splits on the first separator, keeping page text intact', () => {
    // The page's own title already contains an em dash: only the first
    // separator is ours, so everything after it stays page text.
    expect(
      decomposeTitle(`测试${TITLE_SEPARATOR}A${TITLE_SEPARATOR}B`, 'bilingual'),
    ).toBe(`A${TITLE_SEPARATOR}B`)
  })

  it('decomposeTitle returns null for page-owned titles', () => {
    expect(decomposeTitle('Just the page title', 'bilingual')).toBe(null)
    expect(decomposeTitle('Test', 'bilingual')).toBe(null)
    // Translation-only composes nothing, so there is nothing of ours to strip.
    expect(decomposeTitle('测试', 'translation-only')).toBe(null)
  })
})
