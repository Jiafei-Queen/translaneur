import { shouldTranslateTitle } from './title'
import { PROCESSED_ATTR, RESULT_CLASS } from './dom'

// Thunderbird renders the visible subject line in its own privileged header
// document (about:message's #expandedsubjectBox), which content scripts cannot
// reach — so the translation is rendered as a quote block at the top of the
// message body instead, right under that header. The block is one line in both
// render modes: the original stays visible in Thunderbird's header above it.
//
// The subject is static per message document (Thunderbird rewrites the whole
// document per message), so unlike lib/title.ts there is nothing to track:
// read once, translate once, insert, and drop when translation stops.

/** Marker attribute of the block; also the walker's skip selector for it. */
export const SUBJECT_BLOCK_ATTR = 'data-imp-subject'
export const SUBJECT_SKIP_SELECTOR = `[${SUBJECT_BLOCK_ATTR}]`

const SUBJECT_CLASS = 'imp-subject-quote'
const SUBJECT_STYLE_ID = 'imp-subject-style'

// The subject-line label in each supported target language (the codes of
// lib/languages.ts), matching the wording Thunderbird localizes the Subject
// header with. The separator is part of the label so every language keeps its
// own typographic convention (fullwidth colon for zh/ja, space before the
// colon for fr, and so on).
const SUBJECT_LABELS: Record<string, string> = {
  zh: '标题：',
  en: 'Subject: ',
  ja: '件名：',
  ko: '제목: ',
  fr: 'Objet : ',
  de: 'Betreff: ',
  es: 'Asunto: ',
  pt: 'Assunto: ',
  ru: 'Тема: ',
  ar: 'الموضوع: ',
  it: 'Oggetto: ',
  nl: 'Onderwerp: ',
  pl: 'Temat: ',
  tr: 'Konu: ',
  vi: 'Chủ đề: ',
  th: 'เรื่อง: ',
  id: 'Subjek: ',
  uk: 'Тема: ',
  cs: 'Předmět: ',
  sv: 'Ämne: ',
}

const FALLBACK_SUBJECT_LABEL = 'Subject: '

/** The label for the target language, falling back to English. */
export function subjectLabel(targetLang: string): string {
  const base = targetLang.split(/[-_]/)[0] ?? ''
  return SUBJECT_LABELS[targetLang] ?? SUBJECT_LABELS[base] ?? FALLBACK_SUBJECT_LABEL
}

/**
 * The mail subject as the translation source — the display document's
 * <title>, which the MIME HTML emitter writes as the decoded Subject header.
 * Null when there is nothing worth translating (blank, bare URL, decoration).
 */
export function extractSubject(doc: Document): string | null {
  const source = (doc.title ?? '').trim()
  return shouldTranslateTitle(source) ? source : null
}

/**
 * Thunderbird message-display documents only. The MIME emitter always writes
 * its header tables into the body (hidden on screen, shown in print), and the
 * class name is Thunderbird's own — web pages never match. Web pages keep
 * their subject-as-tab-title translations via lib/title.ts.
 */
export function isMailDisplayDocument(doc: Document): boolean {
  return doc.querySelector('table.moz-main-header') !== null
}

const SUBJECT_STYLES_TEXT = `
  .${SUBJECT_CLASS} {
    margin: 0 0 1em 0;
    padding: 0.25em 0 0.25em 0.75em;
    border-inline-start: 3px solid currentColor;
    opacity: 0.85;
    font-size: 1em;
    font-weight: normal;
    font-style: normal;
    color: inherit;
    white-space: pre-wrap;
  }
`

function ensureSubjectStyles(doc: Document) {
  if (doc.getElementById(SUBJECT_STYLE_ID)) return
  const style = doc.createElement('style')
  style.id = SUBJECT_STYLE_ID
  style.textContent = SUBJECT_STYLES_TEXT
  doc.head.appendChild(style)
}

function removeSubjectNodes(doc: Document) {
  for (const el of doc.querySelectorAll(SUBJECT_SKIP_SELECTOR)) el.remove()
}

/**
 * Insert (or replace) the subject quote block at the top of the message body —
 * before the body container, never inside it, so a plain-text mail's <pre>
 * keeps its structure. Attachment wrappers carry the same container classes,
 * so they are skipped when picking the anchor.
 *
 * The block carries the standard translatable-block identity (mark plus source
 * payload) and the translation sits in the standard wrapper, so page-wide edit
 * mode can edit and save it just like body text — the walker itself never
 * touches it (SUBJECT_SKIP_SELECTOR), and the label stays outside the wrapper
 * so a saved override contains only the subject.
 */
export function renderSubjectBlock(
  doc: Document,
  source: string,
  translated: string,
  targetLang: string,
): void {
  ensureSubjectStyles(doc)
  removeSubjectNodes(doc)
  const block = doc.createElement('blockquote')
  block.className = SUBJECT_CLASS
  block.setAttribute(SUBJECT_BLOCK_ATTR, '')
  block.setAttribute(PROCESSED_ATTR, 'true')
  block.setAttribute('data-imp-text', source)
  const wrapper = doc.createElement('font')
  wrapper.className = RESULT_CLASS
  wrapper.textContent = translated
  block.append(subjectLabel(targetLang), wrapper)
  const anchor = Array.from(
    doc.querySelectorAll('div.moz-text-plain, div.moz-text-flowed, div.moz-text-html'),
  ).find((el) => !el.closest('fieldset'))
  if (anchor?.parentElement) {
    anchor.parentElement.insertBefore(block, anchor)
  } else {
    doc.body.prepend(block)
  }
}

/** Restore the body: drop the block and its stylesheet. */
export function clearSubjectBlock(doc: Document): void {
  removeSubjectNodes(doc)
  doc.getElementById(SUBJECT_STYLE_ID)?.remove()
}
