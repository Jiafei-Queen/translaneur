import { RESULT_CLASS, SPACER_CLASS, PROCESSED_ATTR, buildBlockSource, buildAttributeSource, trimmedRuns, swapTextNodes, type TranslatableBlock } from './dom'
import { buildMarkedSource, isPassthroughRun, splitTranslation, stripMarkers } from './align'
import type { RenderMode } from './storage'
import { LANGUAGES_SORTED } from './languages'

function hasVisibleText(node: Node): boolean {
  if (node.nodeType === Node.TEXT_NODE) return !!node.textContent?.trim()
  if (node.nodeType === Node.ELEMENT_NODE) {
    const el = node as HTMLElement
    if (el.offsetWidth <= 1 || el.offsetHeight <= 1) return false
    for (const child of node.childNodes) {
      if (hasVisibleText(child)) return true
    }
  }
  return false
}

function findInjectionPoint(element: HTMLElement): HTMLElement {
  let current = element
  while (true) {
    const children = Array.from(current.childNodes).filter((n) => {
      if (n.nodeType === Node.TEXT_NODE) return n.textContent?.trim()
      if (n.nodeType === Node.ELEMENT_NODE) {
        const el = n as Element
        if (el.classList.contains(RESULT_CLASS) || el.classList.contains(BR_CLASS)) return false
        if (el.classList.contains('notranslate') || el.getAttribute('translate') === 'no') return false
        return hasVisibleText(el)
      }
      return false
    })
    if (children.length === 1 && children[0].nodeType === Node.ELEMENT_NODE) {
      current = children[0] as HTMLElement
      continue
    }
    break
  }
  return current
}

const STYLE_ID = 'imp-translate-style'
const BR_CLASS = 'imp-translate-br'
const LOADING_CLASS = 'imp-translate-loading'
const ERROR_CLASS = 'imp-translate-error'
const RETRY_CLASS = 'imp-translate-retry'
const SHORT_TEXT_THRESHOLD = 40

// Whether a block's visible text is short enough to put the translation on the
// same line rather than pushing a <br>. Measured on the marker-free text: every
// block is now sent marked (lib/align.ts), and the run markers are an artefact
// of the request, not of the page, so they must not move the layout. A 3-run
// block of 32 visible characters is 47 chars marked and would wrongly get a
// line break.
function isShortBlock(blockText: string): boolean {
  return stripMarkers(blockText).length <= SHORT_TEXT_THRESHOLD
}

const STYLES_TEXT = `
    .${RESULT_CLASS} {
      font-style: normal;
      font-weight: inherit;
    }
    *:has(.${RESULT_CLASS}) {
      -webkit-line-clamp: unset !important;
    }
    .${LOADING_CLASS} {
      display: inline-block;
      font-size: 0.75em;
      opacity: 0.5;
      vertical-align: middle;
    }
    @keyframes imp-translate-spin {
      to { transform: rotate(360deg); }
    }
    .${LOADING_CLASS}::before {
      content: '';
      display: inline-block;
      width: 0.8em;
      height: 0.8em;
      border: 1.5px solid currentColor;
      border-top-color: transparent;
      border-radius: 50%;
      animation: imp-translate-spin 0.6s linear infinite;
      vertical-align: middle;
    }
    .${ERROR_CLASS} {
      font-size: 0.75em;
      opacity: 0.7;
    }
    .${RETRY_CLASS} {
      cursor: pointer;
      text-decoration: underline;
      color: inherit;
      background: none;
      border: none;
      font: inherit;
      font-size: inherit;
      padding: 0;
      opacity: 0.7;
    }
    .${RETRY_CLASS}:hover {
      opacity: 1;
    }
  `

let sharedSheet: CSSStyleSheet | null = null

function getSharedSheet(): CSSStyleSheet | null {
  if (typeof CSSStyleSheet === 'undefined') return null
  if (sharedSheet) return sharedSheet
  try {
    sharedSheet = new CSSStyleSheet()
    sharedSheet.replaceSync(STYLES_TEXT)
    return sharedSheet
  } catch {
    return null
  }
}

function ensureStyles() {
  if (document.getElementById(STYLE_ID)) return
  const style = document.createElement('style')
  style.id = STYLE_ID
  style.textContent = STYLES_TEXT
  document.head.appendChild(style)
}

export function ensureShadowStyles(root: ShadowRoot) {
  const sheet = getSharedSheet()
  if (sheet) {
    if (root.adoptedStyleSheets.includes(sheet)) return
    root.adoptedStyleSheets = [...root.adoptedStyleSheets, sheet]
    return
  }
  // Fallback for environments without constructable stylesheets
  if (root.querySelector(`#${STYLE_ID}`)) return
  const style = document.createElement('style')
  style.id = STYLE_ID
  style.textContent = STYLES_TEXT
  root.appendChild(style)
}

function hasLineClamp(el: HTMLElement): boolean {
  const style = getComputedStyle(el)
  return !!(style.webkitLineClamp && style.webkitLineClamp !== 'none')
}

function applyLineClampOverride(el: HTMLElement) {
  el.style.webkitLineClamp = 'unset'
  el.style.overflow = 'visible'
}

function hasOverflowClip(el: HTMLElement): boolean {
  const s = getComputedStyle(el)
  return s.overflow === 'hidden' || s.overflowY === 'hidden'
}

// If the last visible child of the target already creates a visual line break
// — its computed display is non-inline — then injecting a <br> before the
// translation produces a redundant blank line. This catches:
//   - flex-column / grid parents (children get blockified to computed `block`)
//   - block parents whose last meaningful child is itself a block element (p,
//     div, etc.)
// Inline last children (text nodes, <a>, <span> with default display) still
// need the <br> to push the translation onto its own line.
function lastVisibleChildIsBlockLike(target: HTMLElement, beforeRef?: Node | null): boolean {
  const children = target.childNodes
  let startIdx = children.length - 1
  if (beforeRef) {
    for (let i = 0; i < children.length; i++) {
      if (children[i] === beforeRef) { startIdx = i - 1; break }
    }
  }
  for (let i = startIdx; i >= 0; i--) {
    const n = children[i]
    if (n.nodeType === Node.TEXT_NODE) {
      if (!n.textContent?.trim()) continue
      return false
    }
    if (n.nodeType !== Node.ELEMENT_NODE) continue
    const el = n as HTMLElement
    // Skip our own injections so a re-injection doesn't read its previous br.
    if (el.classList.contains(BR_CLASS) || el.classList.contains(RESULT_CLASS)) continue
    const display = getComputedStyle(el).display
    if (display === 'none' || display === 'contents') continue
    return !display.startsWith('inline')
  }
  return false
}

function findTrailingNonTextRef(target: HTMLElement): Node | null {
  let ref: Node | null = null
  for (let i = target.childNodes.length - 1; i >= 0; i--) {
    const n = target.childNodes[i]
    if (n.nodeType === Node.ELEMENT_NODE) {
      const el = n as Element
      if (el.classList.contains(RESULT_CLASS) || el.classList.contains(BR_CLASS)) continue
    }
    if (n.textContent?.trim()) break
    ref = n
  }
  return ref
}

// The gap between a short block's source and the injected ring. A span, not a
// bare text node: only an element can carry SPACER_CLASS, and both the run
// collector and the teardown skip on class.
function createSpacer(): HTMLElement {
  const spacer = document.createElement('span')
  spacer.className = SPACER_CLASS
  spacer.textContent = ' '
  return spacer
}

export function injectLoading(blocks: TranslatableBlock[]) {
  ensureStyles()

  const plans: {
    target: HTMLElement
    element: HTMLElement
    isShort: boolean
    ref: Node | null
    needsBr: boolean
    clampElement: boolean
    clampTarget: boolean
    clipElement: boolean
    clipTarget: boolean
    clippingAncestors: { el: HTMLElement; hasMaxHeight: boolean }[]
  }[] = []

  const seen = new Set<HTMLElement>()
  for (const { element, text } of blocks) {
    if (seen.has(element)) continue
    seen.add(element)
    if (element.querySelector(`.${RESULT_CLASS}`)) continue
    if (element.parentElement?.closest(`[${PROCESSED_ATTR}]`)) continue

    const target = findInjectionPoint(element)
    const ref = findTrailingNonTextRef(target)
    const isShort = isShortBlock(text)
    const clampElement = hasLineClamp(element)
    const clampTarget = target !== element && hasLineClamp(target)
    const clipElement = !clampElement && hasOverflowClip(element)
    const clipTarget = target !== element && !clampTarget && hasOverflowClip(target)
    const needsBr = !isShort && !lastVisibleChildIsBlockLike(target, ref)

    const clippingAncestors: { el: HTMLElement; hasMaxHeight: boolean }[] = []
    if (clampElement || clampTarget || clipElement || clipTarget) {
      let anc = target.parentElement
      for (let i = 0; i < 3 && anc; i++) {
        const s = getComputedStyle(anc)
        if (s.overflow === 'hidden' || s.overflowY === 'hidden') {
          clippingAncestors.push({ el: anc, hasMaxHeight: s.maxHeight !== 'none' })
        }
        anc = anc.parentElement
      }
    }

    plans.push({ target, element, isShort, ref, needsBr, clampElement, clampTarget, clipElement, clipTarget, clippingAncestors })
  }

  for (const { target, element, isShort, ref, needsBr, clampElement, clampTarget, clipElement, clipTarget, clippingAncestors } of plans) {
    // Adopt our stylesheet into a shadow root only when a translation actually
    // lands inside it (see attachShadowObserver in inject.ts for why eager
    // injection into every shadow root is harmful).
    const root = target.getRootNode()
    if (root instanceof ShadowRoot) ensureShadowStyles(root)
    if (clampElement) applyLineClampOverride(element)
    if (clampTarget) applyLineClampOverride(target)
    if (clipElement) element.style.overflow = 'visible'
    if (clipTarget) target.style.overflow = 'visible'
    for (const { el, hasMaxHeight } of clippingAncestors) {
      el.style.overflow = 'visible'
      if (hasMaxHeight) el.style.maxHeight = 'none'
    }

    const wrapper = document.createElement('font')
    wrapper.className = `${RESULT_CLASS} ${LOADING_CLASS}`
    wrapper.setAttribute('translate', 'no')

    if (isShort) {
      target.insertBefore(createSpacer(), ref)
      target.insertBefore(wrapper, ref)
    } else if (needsBr) {
      const br = document.createElement('br')
      br.className = BR_CLASS
      target.insertBefore(br, ref)
      target.insertBefore(wrapper, ref)
    } else {
      target.insertBefore(wrapper, ref)
    }
  }
}

export function repositionTranslation(element: HTMLElement, expectedText: string): void {
  const wrapper = element.querySelector(`.${RESULT_CLASS}`) as HTMLElement | null
  if (!wrapper) return

  const correctTarget = findInjectionPoint(element)
  if (wrapper.parentElement === correctTarget) return

  const prev = wrapper.previousSibling
  wrapper.remove()
  if (
    prev?.nodeType === Node.ELEMENT_NODE &&
    ((prev as Element).classList.contains(BR_CLASS) || (prev as Element).classList.contains(SPACER_CLASS))
  ) {
    prev.parentElement?.removeChild(prev)
  } else if (prev?.nodeType === Node.TEXT_NODE && prev.textContent === ' ') {
    prev.parentElement?.removeChild(prev)
  }

  const isShort = isShortBlock(expectedText)
  const ref = findTrailingNonTextRef(correctTarget)
  if (isShort) {
    correctTarget.insertBefore(createSpacer(), ref)
  } else if (!lastVisibleChildIsBlockLike(correctTarget, ref)) {
    const br = document.createElement('br')
    br.className = BR_CLASS
    correctTarget.insertBefore(br, ref)
  }
  correctTarget.insertBefore(wrapper, ref)
}

export interface RenderOpts {
  renderMode?: RenderMode
  skipSelectors?: string[]
}

// Removes an injected wrapper plus the spacer (`<br>` or single space) put in
// front of it. The spacer is always our own node: trailing page whitespace
// sits after the wrapper, never before it (see findTrailingNonTextRef). The
// text-node arm predates the marked `<span>` and only matters for wrappers
// injected before that change.
function removeInjectedWrapper(wrapper: Element): void {
  const prev = wrapper.previousSibling
  if (
    prev?.nodeType === Node.ELEMENT_NODE &&
    ((prev as Element).classList.contains(BR_CLASS) || (prev as Element).classList.contains(SPACER_CLASS))
  ) {
    prev.remove()
  } else if (prev?.nodeType === Node.TEXT_NODE && prev.textContent === ' ') {
    prev.remove()
  }
  wrapper.remove()
}

// Tears down every wrapper we injected in this block, spacer included. Called
// on the paths that keep the source instead of writing a translation, so a ring
// is never left spinning with nothing behind it.
function clearInjectedWrappers(element: HTMLElement): void {
  element.querySelectorAll(`.${RESULT_CLASS}`).forEach(removeInjectedWrapper)
}

export function replaceWithTranslation(
  blocks: TranslatableBlock[],
  translations: string[],
  opts?: RenderOpts,
) {
  // Attribute hints have no runs to split the response into and no room for a
  // bilingual line: written through in both modes; text blocks continue below.
  const textBlocks: TranslatableBlock[] = []
  const textTranslations: string[] = []
  for (let i = 0; i < blocks.length; i++) {
    const block = blocks[i]!
    const attr = block.attribute
    if (attr) {
      const source = stripMarkers(block.text)
      const plain = (translations[i] ?? '').trim()
      if (!plain || plain.toLowerCase() === source.toLowerCase()) {
        // The page's own hint already says it; leave it untouched.
        block.element.setAttribute('data-imp-noop', '')
        continue
      }
      block.element.setAttribute(attr, plain)
      block.element.setAttribute(
        'data-imp-text',
        buildAttributeSource(block.element, attr),
      )
      continue
    }
    textBlocks.push(block)
    textTranslations.push(translations[i] ?? '')
  }
  blocks = textBlocks
  translations = textTranslations

  if (opts?.renderMode === 'translation-only') {
    for (let i = 0; i < blocks.length; i++) {
      const { element, text } = blocks[i]
      const translated = translations[i]
      const { nodes, texts, head, tail } = trimmedRuns(element, opts.skipSelectors)
      if (texts.length === 0) {
        // Nothing to write into; a ring here would spin with no text behind it.
        clearInjectedWrappers(element)
        continue
      }
      // Stale: the DOM moved under the in-flight request. The recheck pass
      // owns recovery via the token mismatch this leaves behind. The ring stays
      // up meanwhile — the block is still in flight as far as the user knows.
      if (buildMarkedSource(texts) !== text) continue
      if (!translated) {
        clearInjectedWrappers(element)
        continue
      }
      clearInjectedWrappers(element)
      const { pieces, exact } = splitTranslation(translated, texts)
      // Fallback cuts at offsets unrelated to the run boundaries, so a block
      // with any descendant element (link, inline styling) would get a link's
      // own text split in half. A missing translation beats a clickable link
      // leading somewhere meaningless.
      if (!exact && element.querySelector('*') !== null) continue
      // Pieces index the *tagged* runs, in the provider's output order, so
      // writing them into document-order slots rebuilds the sentence the
      // provider wrote. A passthrough run gets its own text back, which is what
      // swapTextNodes reads as "leave this node and its whitespace alone" — and
      // which is why head/tail are re-attached only where a node is written.
      let piece = 0
      const writes = nodes.map((node, k) =>
        isPassthroughRun(texts[k]!) ? node.data : (pieces[piece++] ?? node.data),
      )
      if (!isPassthroughRun(texts[0]!)) writes[0] = head + writes[0]!
      const lastRun = texts.length - 1
      if (!isPassthroughRun(texts[lastRun]!)) writes[lastRun] = writes[lastRun]! + tail
      swapTextNodes(nodes, writes)
      // Token must equal what currentBlockSource computes now that the runs
      // hold the translated text. Recomputed from the mutated DOM rather than
      // from `writes`, so a piece translating to empty cannot make them differ.
      element.setAttribute('data-imp-text', buildBlockSource(element, opts.skipSelectors))
    }
    return
  }

  for (let i = 0; i < blocks.length; i++) {
    const { element, text } = blocks[i]
    const translated = translations[i]
    const wrapper = element.querySelector(`.${RESULT_CLASS}`)
    if (!wrapper) continue

    // The run texts come from the DOM, not by re-parsing the markers: bilingual
    // never writes into the runs, so they still hold what the request was built
    // from — whereas parsing would misread a page's own `⟦1⟧` in a single-run
    // block as a marker and split the response into pieces that do not exist.
    const { texts: runTexts } = trimmedRuns(element, opts?.skipSelectors)
    // `pieces` is not usable here: it holds one entry per *written* run, so
    // joining it would drop a passthrough run's text — a separator, or a
    // digits-only run — from the block.
    const plain = translated ? splitTranslation(translated, runTexts).plain : ''

    // Compared against the marker-free source: `text` is marked, so comparing
    // against it never matches, and a provider's verbatim echo would be written
    // out with its markers intact.
    const source = stripMarkers(text)
    if (!plain || plain.toLowerCase() === source.toLowerCase()) {
      removeInjectedWrapper(wrapper)
      element.setAttribute('data-imp-noop', '')
      continue
    }

    wrapper.className = RESULT_CLASS
    wrapper.textContent = plain
  }
}

function collectAllErrorBlocks(): TranslatableBlock[] {
  const errorWrappers = document.querySelectorAll(`.${ERROR_CLASS}`)
  const blocks: TranslatableBlock[] = []
  for (const wrapper of errorWrappers) {
    const el = wrapper.closest('[data-imp-text]') as HTMLElement | null
    if (!el) continue
    const text = el.getAttribute('data-imp-text')
    if (!text) continue
    blocks.push({ element: el, text })
  }
  return blocks
}

function appendRetryButton(
  wrapper: HTMLElement,
  onRetry: (blocks: TranslatableBlock[]) => void,
) {
  const retryBtn = document.createElement('button')
  retryBtn.className = RETRY_CLASS
  retryBtn.textContent = '⟳ Retry'
  retryBtn.addEventListener('click', (e) => {
    e.stopPropagation()
    e.preventDefault()
    const allErrors = collectAllErrorBlocks()
    for (const { element: el } of allErrors) {
      const w = el.querySelector(`.${RESULT_CLASS}`)
      if (w) {
        w.className = `${RESULT_CLASS} ${LOADING_CLASS}`
        w.textContent = ''
      }
    }
    onRetry(allErrors)
  }, { once: true })
  wrapper.appendChild(retryBtn)
}

export function replaceWithError(
  blocks: TranslatableBlock[],
  onRetry: (blocks: TranslatableBlock[]) => void,
  opts?: RenderOpts,
) {
  for (const { element, text, attribute } of blocks) {
    // An attribute hint has no slot for an error chip and nothing a retry
    // could render into: keep the page's own hint and stay silent.
    if (attribute) continue
    if (opts?.renderMode === 'translation-only') {
      ensureStyles()
      let wrapper = element.querySelector(`.${RESULT_CLASS}`) as HTMLElement | null
      if (!wrapper) {
        // Fallback for a block that failed without ever passing through
        // injectLoading (extraction or filtering dropped it before the ring
        // was injected). Anchor the error chip at the block end using the same
        // geometry as injectLoading.
        const target = findInjectionPoint(element)
        const ref = findTrailingNonTextRef(target)
        if (isShortBlock(text)) {
          target.insertBefore(createSpacer(), ref)
        } else if (!lastVisibleChildIsBlockLike(target, ref)) {
          const br = document.createElement('br')
          br.className = BR_CLASS
          target.insertBefore(br, ref)
        }
        wrapper = document.createElement('font')
        wrapper.className = `${RESULT_CLASS} ${ERROR_CLASS}`
        wrapper.setAttribute('translate', 'no')
        target.insertBefore(wrapper, ref)
        const root = target.getRootNode()
        if (root instanceof ShadowRoot) ensureShadowStyles(root)
      } else {
        wrapper.className = `${RESULT_CLASS} ${ERROR_CLASS}`
        wrapper.textContent = ''
      }
      appendRetryButton(wrapper, onRetry)
      continue
    }

    const wrapper = element.querySelector(`.${RESULT_CLASS}`) as HTMLElement | null
    if (!wrapper) continue
    wrapper.className = `${RESULT_CLASS} ${ERROR_CLASS}`
    wrapper.textContent = ''
    appendRetryButton(wrapper, onRetry)
  }
}


export function removeStyles() {
  document.getElementById(STYLE_ID)?.remove()
}

const DEBUG_STYLE_ID = 'imp-translate-debug-style'

export function injectDebugStyles() {
  if (document.getElementById(DEBUG_STYLE_ID)) return
  const style = document.createElement('style')
  style.id = DEBUG_STYLE_ID
  style.textContent = `
    [data-imp-noop] {
      outline: 2px dashed rgba(255, 80, 80, 0.7) !important;
      outline-offset: -2px !important;
      position: relative !important;
    }
    [data-imp-noop]::after {
      content: 'no-op';
      position: absolute;
      top: 0;
      right: 0;
      padding: 1px 4px;
      font: 10px/1.2 system-ui, sans-serif;
      background: rgba(255, 80, 80, 0.9);
      color: white;
      border-radius: 0 0 0 3px;
      z-index: 2147483647;
      pointer-events: none;
    }
  `
  document.head.appendChild(style)
}

export function removeDebugStyles() {
  document.getElementById(DEBUG_STYLE_ID)?.remove()
}

const TOAST_ID = 'imp-translate-toast'
const TOAST_STYLE_ID = 'imp-translate-toast-style'

function ensureToastStyles() {
  if (document.getElementById(TOAST_STYLE_ID)) return
  const style = document.createElement('style')
  style.id = TOAST_STYLE_ID
  style.textContent = `
    @keyframes imp-toast-slide-in {
      from { transform: translateY(-100%); opacity: 0; }
      to { transform: translateY(0); opacity: 1; }
    }
    @keyframes imp-toast-slide-out {
      from { transform: translateY(0); opacity: 1; }
      to { transform: translateY(-100%); opacity: 0; }
    }
    #${TOAST_ID} {
      position: fixed;
      top: 0;
      left: 0;
      right: 0;
      z-index: 2147483647;
      display: flex;
      align-items: center;
      gap: 8px;
      padding: 10px 16px;
      font: 14px/1 system-ui, sans-serif;
      backdrop-filter: blur(12px);
      -webkit-backdrop-filter: blur(12px);
      background: rgba(255, 255, 255, 0.85);
      color: #333;
      border-bottom: 1px solid rgba(0, 0, 0, 0.1);
      box-shadow: 0 1px 4px rgba(0, 0, 0, 0.08);
      animation: imp-toast-slide-in 0.25s ease-out;
    }
    #${TOAST_ID}.imp-toast-out {
      animation: imp-toast-slide-out 0.2s ease-in forwards;
    }
    @media (prefers-color-scheme: dark) {
      #${TOAST_ID} {
        background: rgba(30, 30, 30, 0.85);
        color: #e0e0e0;
        border-bottom-color: rgba(255, 255, 255, 0.1);
        box-shadow: 0 1px 4px rgba(0, 0, 0, 0.3);
      }
      #${TOAST_ID} .imp-toast-restore { color: #6ea8fe !important; }
      #${TOAST_ID} .imp-toast-settings { color: #aaa !important; }
      #${TOAST_ID} .imp-toast-retranslate { color: #aaa !important; }
    }
    #${TOAST_ID} .imp-toast-text { flex: 1; }
    #${TOAST_ID} button {
      background: none;
      border: none;
      cursor: pointer;
      font: inherit;
      padding: 4px 8px;
      border-radius: 4px;
    }
    #${TOAST_ID} button:active { opacity: 0.7; }
    #${TOAST_ID} .imp-toast-restore { color: #2563eb; }
    #${TOAST_ID} .imp-toast-settings { color: #666; font-size: 16px; }
    #${TOAST_ID} .imp-toast-retranslate { color: #666; font-size: 16px; }
    #${TOAST_ID} .imp-toast-lang {
      appearance: none;
      -webkit-appearance: none;
      background: rgba(0, 0, 0, 0.06);
      border: 1px solid rgba(0, 0, 0, 0.1);
      border-radius: 4px;
      padding: 4px 20px 4px 8px;
      font: inherit;
      font-size: 13px;
      color: inherit;
      cursor: pointer;
      background-image: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='10' height='6'%3E%3Cpath d='M0 0l5 6 5-6z' fill='%23666'/%3E%3C/svg%3E");
      background-repeat: no-repeat;
      background-position: right 6px center;
      flex-shrink: 0;
    }
    #${TOAST_ID} .imp-toast-display {
      display: flex;
      gap: 2px;
      padding: 2px;
      border: 1px solid rgba(0, 0, 0, 0.1);
      border-radius: 6px;
      background: rgba(0, 0, 0, 0.06);
      flex-shrink: 0;
    }
    #${TOAST_ID} button.imp-toast-display-btn {
      padding: 3px 10px;
      border-radius: 4px;
      font-size: 13px;
      color: #555;
      white-space: nowrap;
      transition: background 0.15s, color 0.15s;
    }
    /* Only the unselected half responds: hovering must not dim the active
       one into looking unselected. */
    #${TOAST_ID} button.imp-toast-display-btn:not([aria-checked="true"]):hover {
      background: rgba(0, 0, 0, 0.08);
    }
    #${TOAST_ID} button.imp-toast-display-btn[aria-checked="true"] {
      background: #fff;
      color: #111;
      font-weight: 600;
      box-shadow: 0 1px 2px rgba(0, 0, 0, 0.12);
    }
    @media (prefers-color-scheme: dark) {
      #${TOAST_ID} .imp-toast-lang {
        background-color: rgba(255, 255, 255, 0.1);
        border-color: rgba(255, 255, 255, 0.15);
        background-image: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='10' height='6'%3E%3Cpath d='M0 0l5 6 5-6z' fill='%23aaa'/%3E%3C/svg%3E");
      }
      #${TOAST_ID} .imp-toast-display {
        background-color: rgba(255, 255, 255, 0.1);
        border-color: rgba(255, 255, 255, 0.15);
      }
      #${TOAST_ID} button.imp-toast-display-btn { color: #ccc; }
      /* Dark: the hover fill must sit between the track (0.1) and the
         selected half (0.18) so hovering reads as approaching the selected
         tone. 0.12 was nearly indistinguishable from the track, making the
         hover look broken; 0.14 stays clearly below the selected fill while
         remaining legible against the track. Unlike the popup/options
         control, this palette builds on white overlays, so "toward the
         selected half" necessarily means brightening, not darkening. */
      #${TOAST_ID} button.imp-toast-display-btn:not([aria-checked="true"]):hover {
        background: rgba(255, 255, 255, 0.14);
      }
      #${TOAST_ID} button.imp-toast-display-btn[aria-checked="true"] {
        background: rgba(255, 255, 255, 0.18);
        color: #fff;
      }
    }
  `
  document.head.appendChild(style)
}

export interface ToastBarOptions {
  currentLang: string
  // Whether the page is currently translated. Drives the primary button:
  // "Show Original" (stop) while translating, "Translate" (re-start)
  // once restored — see entrypoints/background.ts openPanelForActiveTab,
  // which stops translation and re-opens this panel in one mobile toolbar tap.
  translating: boolean
  onRestore: () => void
  onTranslate: () => void
  // Re-translate the page that is already translated, asking the provider
  // again instead of reading the cache. Only rendered while `translating` —
  // there is nothing to refresh on a restored page (that is what onTranslate
  // is for).
  onRetranslate: () => void
  onSettings: () => void
  onLangChange: (lang: string) => void
  currentRenderMode: RenderMode
  onRenderModeChange: (mode: RenderMode) => void
  onResetTimer?: (delayMs: number) => void
}

export function showToastBar(options: ToastBarOptions) {
  // Always rebuild rather than no-op on an existing bar: callers re-invoke
  // this whenever the translating/restored mode may have changed (e.g. the
  // mobile toolbar icon stopping translation and re-opening the panel), and
  // a stale bar would keep showing the wrong button/handler. Removing
  // synchronously (no exit animation) is safe even mid-dismiss — the old
  // node's pending `animationend` listener simply never fires once detached.
  document.getElementById(TOAST_ID)?.remove()
  ensureToastStyles()

  const bar = document.createElement('div')
  bar.id = TOAST_ID
  bar.setAttribute('translate', 'no')

  const langSelect = document.createElement('select')
  langSelect.className = 'imp-toast-lang'
  for (const [code, name] of LANGUAGES_SORTED) {
    const opt = document.createElement('option')
    opt.value = code
    opt.textContent = name
    if (code === options.currentLang) opt.selected = true
    langSelect.appendChild(opt)
  }
  let justChanged = false
  langSelect.addEventListener('change', () => {
    justChanged = true
    setTimeout(() => { justChanged = false }, 100)
    options.onLangChange(langSelect.value)
    options.onResetTimer?.(5000)
  })
  langSelect.addEventListener('focus', () => options.onResetTimer?.(15000))
  langSelect.addEventListener('click', () => {
    if (!justChanged) options.onResetTimer?.(15000)
  })

  // Both modes shown at once rather than a <select>. Class is
  // imp-toast-display only: e2e's LANG_SELECT targets .imp-toast-lang and
  // must stay unambiguous.
  const displayGroup = document.createElement('div')
  displayGroup.className = 'imp-toast-display'
  displayGroup.setAttribute('role', 'radiogroup')
  displayGroup.setAttribute('aria-label', 'Display')
  const displayButtons: HTMLButtonElement[] = []
  const markDisplay = (mode: RenderMode) => {
    for (const btn of displayButtons) {
      btn.setAttribute('aria-checked', String(btn.dataset.value === mode))
    }
  }
  for (const [value, label, title] of [
    ['bilingual', 'Bilingual', 'original + translation'],
    ['translation-only', 'Translation only', ''],
  ] as const) {
    const btn = document.createElement('button')
    btn.className = 'imp-toast-display-btn'
    btn.type = 'button'
    btn.setAttribute('role', 'radio')
    btn.dataset.value = value
    btn.textContent = label
    if (title) btn.title = title
    btn.addEventListener('click', () => {
      // Re-picking the active mode only pauses the timer, like opening a
      // dropdown and closing it unchanged; picking the other one restarts.
      if (btn.getAttribute('aria-checked') === 'true') {
        options.onResetTimer?.(15000)
        return
      }
      markDisplay(value as RenderMode)
      options.onRenderModeChange(value as RenderMode)
      options.onResetTimer?.(5000)
    })
    displayButtons.push(btn)
    displayGroup.appendChild(btn)
  }
  markDisplay(options.currentRenderMode)

  const spacer = document.createElement('span')
  spacer.className = 'imp-toast-text'

  const restoreBtn = document.createElement('button')
  restoreBtn.className = 'imp-toast-restore'
  restoreBtn.textContent = options.translating ? 'Show Original' : 'Translate'
  restoreBtn.addEventListener(
    'click',
    options.translating ? options.onRestore : options.onTranslate,
  )

  const settingsBtn = document.createElement('button')
  settingsBtn.className = 'imp-toast-settings'
  settingsBtn.textContent = '⚙'
  settingsBtn.addEventListener('click', options.onSettings)

  bar.append(langSelect, displayGroup, spacer)
  if (options.translating) {
    const retranslateBtn = document.createElement('button')
    retranslateBtn.className = 'imp-toast-retranslate'
    retranslateBtn.textContent = '↻'
    retranslateBtn.title = 'Re-translate'
    retranslateBtn.addEventListener('click', () => {
      options.onRetranslate()
      options.onResetTimer?.(5000)
    })
    bar.appendChild(retranslateBtn)
  }
  bar.append(restoreBtn, settingsBtn)
  document.body.appendChild(bar)
}

export function hideToastBar() {
  const bar = document.getElementById(TOAST_ID)
  if (!bar) return
  bar.classList.add('imp-toast-out')
  bar.addEventListener('animationend', () => {
    bar.remove()
    document.getElementById(TOAST_STYLE_ID)?.remove()
  }, { once: true })
}
