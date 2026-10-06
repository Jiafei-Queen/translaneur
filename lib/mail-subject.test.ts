import { describe, expect, it } from 'vitest'
import {
  clearSubjectBlock,
  extractSubject,
  isMailDisplayDocument,
  renderSubjectBlock,
  subjectLabel,
  SUBJECT_BLOCK_ATTR,
  SUBJECT_SKIP_SELECTOR,
} from './mail-subject'

function makeMailDoc(
  subject = 'Evaluating and improving agents with Langfuse',
): Document {
  const doc = document.implementation.createHTMLDocument('mail')
  doc.title = subject
  doc.body.innerHTML =
    '<table class="moz-header-part1 moz-main-header"></table><br>' +
    '<div class="moz-text-plain"><pre class="moz-quote-pre">Hey,</pre></div>'
  return doc
}

describe('subjectLabel', () => {
  it('labels the subject in the target language', () => {
    expect(subjectLabel('zh')).toBe('标题：')
    expect(subjectLabel('en')).toBe('Subject: ')
    expect(subjectLabel('ja')).toBe('件名：')
  })

  it('falls back to the base language code, then to English', () => {
    expect(subjectLabel('zh-CN')).toBe('标题：')
    expect(subjectLabel('xx')).toBe('Subject: ')
    expect(subjectLabel('')).toBe('Subject: ')
  })
})

describe('extractSubject', () => {
  it('reads the decoded subject from the document title', () => {
    expect(extractSubject(makeMailDoc('  Hello world  '))).toBe('Hello world')
    expect(extractSubject(makeMailDoc('好'))).toBe(null)
  })

  it('skips blank and bare-URL subjects', () => {
    expect(extractSubject(makeMailDoc(''))).toBe(null)
    expect(extractSubject(makeMailDoc('   '))).toBe(null)
    expect(extractSubject(makeMailDoc('https://example.com/a/b?c=1'))).toBe(null)
  })
})

describe('isMailDisplayDocument', () => {
  it('matches Thunderbird message documents by their header table', () => {
    expect(isMailDisplayDocument(makeMailDoc())).toBe(true)
  })

  it('leaves web pages alone', () => {
    const doc = document.implementation.createHTMLDocument('web')
    doc.body.innerHTML = '<div class="moz-text-html">page content</div>'
    expect(isMailDisplayDocument(doc)).toBe(false)
  })
})

describe('renderSubjectBlock / clearSubjectBlock', () => {
  it('inserts the labelled translation above the message body', () => {
    const doc = makeMailDoc()
    renderSubjectBlock(doc, 'Use Langfuse', '使用 Langfuse 评估', 'zh')
    const block = doc.querySelector(SUBJECT_SKIP_SELECTOR)!
    expect(block.tagName).toBe('BLOCKQUOTE')
    expect(block.getAttribute(SUBJECT_BLOCK_ATTR)).toBe('')
    expect(block.nextElementSibling?.className).toBe('moz-text-plain')
    // The label sits outside the wrapper so edits cover only the subject.
    expect(block.textContent).toBe('标题：使用 Langfuse 评估')
  })

  it('carries the translatable-block identity edit mode needs', () => {
    const doc = makeMailDoc()
    renderSubjectBlock(doc, 'Use Langfuse', '使用 Langfuse 评估', 'zh')
    const block = doc.querySelector(SUBJECT_SKIP_SELECTOR)!
    expect(block.getAttribute('data-imp-translated')).toBe('true')
    expect(block.getAttribute('data-imp-text')).toBe('Use Langfuse')
    const wrapper = block.querySelector('.imp-translate-result')!
    expect(wrapper.textContent).toBe('使用 Langfuse 评估')
  })

  it('replaces its previous block instead of stacking', () => {
    const doc = makeMailDoc()
    renderSubjectBlock(doc, 'Use Langfuse', '第一版', 'zh')
    renderSubjectBlock(doc, 'Use Langfuse', '第二版', 'zh')
    const blocks = doc.querySelectorAll(SUBJECT_SKIP_SELECTOR)
    expect(blocks).toHaveLength(1)
    expect(blocks[0]!.textContent).toBe('标题：第二版')
  })

  it('skips attachment wrappers when picking the anchor', () => {
    const doc = makeMailDoc()
    doc.body.innerHTML =
      '<table class="moz-header-part1 moz-main-header"></table>' +
      '<fieldset><div class="moz-text-plain">attachment wrapper</div></fieldset>' +
      '<div class="moz-text-html">body</div>'
    renderSubjectBlock(doc, 'hi', '你好', 'zh')
    const block = doc.querySelector(SUBJECT_SKIP_SELECTOR)!
    expect(block.nextElementSibling?.className).toBe('moz-text-html')
  })

  it('falls back to the top of the body without a container', () => {
    const doc = makeMailDoc()
    doc.body.innerHTML = '<table class="moz-header-part1 moz-main-header"></table>'
    renderSubjectBlock(doc, 'hi', '你好', 'zh')
    expect(doc.body.firstElementChild?.getAttribute(SUBJECT_BLOCK_ATTR)).toBe('')
  })

  it('clear removes the block and its stylesheet', () => {
    const doc = makeMailDoc()
    renderSubjectBlock(doc, 'Use Langfuse', '使用 Langfuse 评估', 'zh')
    expect(doc.getElementById('imp-subject-style')).not.toBeNull()
    clearSubjectBlock(doc)
    expect(doc.querySelector(SUBJECT_SKIP_SELECTOR)).toBeNull()
    expect(doc.getElementById('imp-subject-style')).toBeNull()
  })
})
