import { buildMarkedSource } from './align'

const INLINE_TAGS = new Set([
  '#text', 'a', 'abbr', 'acronym', 'b', 'bdi', 'bdo', 'big', 'br',
  'cite', 'code', 'del', 'dfn', 'em', 'font', 'i', 'input', 'ins', 'kbd',
  'label', 'mark', 'nobr', 'q', 'rp', 'rt', 'ruby', 's',
  'samp', 'small', 'span', 'strong', 'sub', 'sup', 'tt',
  'u', 'var', 'wbr', 'img',
])

const NO_LETTER_RE = /^\P{L}+$/u
const ASCII_SHORT_RE = /^[a-zA-Z0-9]{1,2}$/
// A blank line: two newlines separated only by intra-line whitespace. In
// white-space:pre-wrap contexts this is a rendered paragraph break.
const BLANK_LINE_RE = /\n[^\S\n]*\n/
// A full separator run: maximal whitespace stretch containing a blank line.
const SEP_RUN_RE = /\s*\n[^\S\n]*\n\s*/

const SKIP_TAGS = new Set([
  'script', 'style', 'textarea', 'svg', 'template', 'noscript',
  'iframe', 'math', 'select', 'option', 'video', 'audio', 'canvas',
  'pre', 'time',
])

const LEAF_BLOCK_TAGS = new Set([
  'p', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'li', 'td', 'th',
  'dd', 'dt', 'blockquote', 'figcaption', 'caption',
])

const CONTAINER_TAGS = new Set([
  'div', 'article', 'section', 'main', 'aside',
  'details', 'summary', 'legend',
])

// Page chrome — top bar, navigation, sidebar, footer. Under an include rule
// only in-scope elements are extracted (uBO isolate semantics), but chrome is
// navigation text the user expects translated: these semantic containers and
// their ARIA roles always count as in scope. Site excludes still win.
const CHROME_SELECTOR =
  'header, nav, footer, aside, [role="banner"], [role="navigation"], [role="contentinfo"], [role="complementary"]'

// Page-authored hint text that lives in an attribute, not a text node. Only
// `placeholder` qualifies: a submit input's `value` can be a payload the
// server reads, an `aria-label` value anchors selector-based site rules
// (rules.txt matches `div[aria-label="Grok"]`), and `title` only shows on hover.
const HINT_ATTR_TAGS = new Set(['input', 'textarea'])
export const HINT_ATTR = 'placeholder'

const EDITOR_SELECTOR = [
  '.RichEditor-root:has([contenteditable="true"])',
  '.DraftEditor-root:has([contenteditable="true"])',
  '[data-lexical-editor][contenteditable="true"]',
  '.ProseMirror[contenteditable="true"]',
  '[data-slate-editor][contenteditable="true"]',
  '.ql-editor[contenteditable="true"]',
  '.ck-editor:has([contenteditable="true"])',
  '.tox-editor-container:has([contenteditable="true"])',
  '.cm-editor',
  '.monaco-editor',
].join(',')

const RESULT_CLASS = 'imp-translate-result'
// Layout artefact injected next to the loading ring, never page text. Exported
// so render.ts tags the node it creates and the two modules cannot drift.
const SPACER_CLASS = 'imp-translate-spacer'
const PROCESSED_ATTR = 'data-imp-translated'
// Marks a translation wrapper the user is editing in-page (lib/edit-mode.ts).
// render.ts skips overwriting it, so a live re-translation cannot clobber the
// text under the caret.
const EDIT_ATTR = 'data-imp-editing'
const WRAP_ATTR = 'data-imp-wrap'
// Prior inline values of page styles the extension overwrote, as a JSON map of
// CSS property name → the value it had before. A property absent from the map
// had no inline value, so restoring means removing the declaration and letting
// the cascade show through. Lives in the DOM, like data-imp-attr-orig, so a stop
// restores it even if the content script was reinjected in between. Exported so
// render.ts writes the same list, and the two modules cannot drift.
const STYLE_ORIG_ATTR = 'data-imp-style-orig'
// `overflow` is a shorthand that sets both longhands. A page declaring only
// `overflow-y: hidden` inline has that longhand as its original, and it is not
// reachable by reading the shorthand back, so both are recorded separately.
const OVERRIDDEN_PROPS = [
  'overflow',
  'overflow-x',
  'overflow-y',
  'max-height',
  '-webkit-line-clamp',
] as const
const OVERSIZED_BLOCK_THRESHOLD = 8000

function isInlineish(node: Node): boolean {
  if (node.nodeType === Node.TEXT_NODE) return true
  if (node.nodeType !== Node.ELEMENT_NODE) return false
  const el = node as Element
  const tag = el.tagName.toLowerCase()
  if (SKIP_TAGS.has(tag)) return false
  if (hasBlockChild(el)) return false
  if (INLINE_TAGS.has(tag)) return isDisplayInline(el)
  if (isDisplayInline(el)) return true
  return false
}

function isWhitespaceText(node: Node): boolean {
  return (
    node.nodeType === Node.TEXT_NODE && !(node.textContent || '').trim()
  )
}

function isBr(node: Node): boolean {
  return (
    node.nodeType === Node.ELEMENT_NODE &&
    (node as Element).tagName.toLowerCase() === 'br'
  )
}

// Split a run of inline-ish siblings on "paragraph" boundaries. A boundary is
// a soft-node run (brs and whitespace text) containing either <br>{2,} — the
// fake-paragraph pattern App Store / old webmail / Discord embed emails use —
// or, when splitOnBlankLines is set (white-space:pre-wrap contexts, e.g. x.com
// long posts), a blank line: two newlines in the whitespace text. A single
// <br> or single \n is a soft line break and stays in the segment.
function segmentRunByBrBr(run: Node[], splitOnBlankLines = false): Node[][] {
  const segments: Node[][] = []
  let current: Node[] = []
  let i = 0
  const isSoft = (n: Node) => isBr(n) || isWhitespaceText(n)
  while (i < run.length) {
    if (!isSoft(run[i]) || (!isBr(run[i]) && !splitOnBlankLines)) {
      current.push(run[i])
      i++
      continue
    }
    let j = i
    let brCount = 0
    let wsText = ''
    while (j < run.length && isSoft(run[j])) {
      if (isBr(run[j])) brCount++
      else wsText += run[j].textContent ?? ''
      j++
    }
    const boundary = brCount >= 2 || (splitOnBlankLines && BLANK_LINE_RE.test(wsText))
    if (boundary) {
      if (current.length > 0) {
        segments.push(current)
        current = []
      }
      i = j
    } else {
      while (i < j) {
        current.push(run[i])
        i++
      }
    }
  }
  if (current.length > 0) segments.push(current)
  return segments
}

export interface TranslatableBlock {
  element: HTMLElement
  text: string
  /**
   * The block is this attribute's value (an input/textarea `placeholder`)
   * rather than the element's text nodes.
   */
  attribute?: string
}

export interface ExtractOptions {
  skipSelectors?: string[]
  // Un-skips elements the tag-level skips (SKIP_TAGS) would prune: markup
  // whose text legitimately hides in a skipped tag, e.g. Thunderbird's
  // text/plain body inside pre.moz-quote-pre. Site-rule and element-gate
  // skips still apply.
  allowSelectors?: string[]
  includeSelectors?: string[]
  onShadowRoot?: (root: ShadowRoot) => void
}

function hasShadowDescendant(el: Element): boolean {
  if (el.shadowRoot) return true
  const all = el.querySelectorAll('*')
  for (const desc of all) {
    if (desc.shadowRoot) return true
  }
  return false
}

function hasStatefulInteractive(el: Element): boolean {
  return el.matches('[aria-expanded]') || el.querySelector('[aria-expanded]') !== null
}

function closestThroughShadow(el: Element, selector: string): Element | null {
  let current: Element | null = el
  while (current) {
    const found = current.closest(selector)
    if (found) return found
    const root = current.getRootNode()
    if (root instanceof ShadowRoot) current = root.host
    else current = null
  }
  return null
}

// The include gate (uBO isolate semantics), widened for page chrome: in scope
// when an include selector or CHROME_SELECTOR owns the element or its subtree —
// the subtree clause only lets the walk descend into wrappers that lead to
// scoped content. True when there is no active include rule.
function inIncludeScope(el: Element, opts?: ExtractOptions): boolean {
  if (!opts?.includeSelectors || opts.includeSelectors.length === 0) return true
  if (closestThroughShadow(el, CHROME_SELECTOR)) return true
  if (opts.includeSelectors.some((s) => closestThroughShadow(el, s))) return true
  if (el.querySelector(CHROME_SELECTOR)) return true
  return opts.includeSelectors.some((s) => el.querySelector(s))
}

// Include/skip-selector gates, shared by walk decisions and attribute-hint
// extraction. The rest of shouldSkip is about the element's content (SKIP_TAGS,
// editors, our own nodes), which a placeholder hint bypasses.
function passesSkipRules(el: Element, opts?: ExtractOptions): boolean {
  if (!inIncludeScope(el, opts) && !hasShadowDescendant(el)) return false
  if (opts?.skipSelectors) {
    for (const s of opts.skipSelectors) {
      if (el.matches(s)) return false
    }
  }
  return true
}

// Tag-independent gates: not the page saying "don't translate", not an editor
// we must not write into, not ours, not already handled.
function passesElementGates(el: Element): boolean {
  if (el.classList.contains('notranslate')) return false
  if (el.getAttribute('translate') === 'no') return false
  if ((el as HTMLElement).isContentEditable) return false
  if (el.closest(EDITOR_SELECTOR)) return false
  if (el.classList.contains(RESULT_CLASS)) return false
  if (el.hasAttribute(PROCESSED_ATTR)) return false
  return true
}

function shouldSkip(el: Element, opts?: ExtractOptions): boolean {
  if (!passesSkipRules(el, opts)) return true
  if (SKIP_TAGS.has(el.tagName.toLowerCase())) {
    if (!opts?.allowSelectors?.some((s) => el.matches(s))) return true
  }
  return !passesElementGates(el)
}

function isHidden(el: HTMLElement): boolean {
  if (el.checkVisibility && !el.checkVisibility()) return true
  if (el.offsetWidth <= 1 || el.offsetHeight <= 1) return true
  return getComputedStyle(el).visibility === 'hidden'
}

interface CollectedText {
  /** The block's visible text — the same string getVisibleText always built. */
  text: string
  /** The text nodes it was built from, in document order. */
  runs: Text[]
}

// One traversal, two products: a node list's visible text and the text nodes it
// was built from. They are the same walk under the same skip rules, so fusing
// them keeps `runs.join('') === text` structurally true rather than true by two
// traversals happening to agree — and, more concretely, keeps the walk's layout
// reads at one per element. Every extracted block needs both now, and each
// isHidden in the run pass is a getComputedStyle; walking the subtree twice
// doubled the cost of extraction, which the npm fixture budget guards.
//
// `skipSpacer` distinguishes the callers: our injected spacer belongs to
// neither the page text nor the runs we may write into, but getVisibleText
// never saw one (a spacer is created only after a block is extracted, and torn
// down by clearTranslations), so it keeps its historical inclusive behaviour.
function collectText(
  nodes: ArrayLike<Node>,
  skipSelectors?: string[],
  skipSpacer = false,
): CollectedText {
  let text = ''
  const runs: Text[] = []
  function walk(node: Node): void {
    if (node.nodeType === Node.TEXT_NODE) {
      const data = node.textContent ?? ''
      text += data
      if (data) runs.push(node as Text)
      return
    }
    if (node.nodeType !== Node.ELEMENT_NODE) return
    const el = node as HTMLElement
    if (SKIP_TAGS.has(el.tagName.toLowerCase())) return
    if (el.classList.contains(RESULT_CLASS) || el.classList.contains('imp-translate-br')) return
    if (skipSpacer && el.classList.contains(SPACER_CLASS)) return
    if (el.classList.contains('notranslate')) return
    if (el.getAttribute('translate') === 'no') return
    if (el.isContentEditable) return
    if (isHidden(el)) return
    if (skipSelectors && skipSelectors.some((s) => el.matches(s))) return
    for (const child of el.childNodes) walk(child)
  }
  for (let i = 0; i < nodes.length; i++) walk(nodes[i]!)
  return { text, runs }
}

function getVisibleText(el: Element, skipSelectors?: string[]): string {
  return collectText(Array.from(el.childNodes), skipSelectors).text
}

function isBlockTag(tag: string): boolean {
  return !INLINE_TAGS.has(tag) && !SKIP_TAGS.has(tag)
}

function isDisplayInline(el: Element): boolean {
  const inlineDisplay = (el as HTMLElement).style?.display
  if (inlineDisplay) return inlineDisplay.startsWith('inline')
  // Consult computed style for ALL elements, including inline-default tags
  // (a, span, etc.). Flex/grid containers blockify their children — e.g.
  // shadcn's "On This Page" sidebar renders <a> links in a flex-col container,
  // so each <a> has computed display:block. Without this check, they all merge
  // into one translation block, destroying the outline structure.
  // Safe for the read/write split: this runs in the walk's read phase, before
  // any deferred write, so it never forces a post-mutation reflow.
  return getComputedStyle(el).display.startsWith('inline')
}

// Detect "fake paragraph" markup: 2+ <br>s in a row (possibly with whitespace
// text between them). Triggers walkMixed even on otherwise-leaf containers so
// br-br segmentation can run.
function hasBrBrSeparator(el: Element): boolean {
  let consecutiveBrs = 0
  for (const child of el.childNodes) {
    if (isBr(child)) {
      consecutiveBrs++
      if (consecutiveBrs >= 2) return true
    } else if (!isWhitespaceText(child)) {
      consecutiveBrs = 0
    }
  }
  return false
}

// x.com long-form posts (and other pre-wrap renderers) put an entire article
// into one flat element whose only structure is literal \n\n inside inline
// span text — no <p>, no <br>. Detect that shape so the walker can segment
// per paragraph instead of extracting one giant block.
function preservesNewlines(el: Element): boolean {
  const ws = getComputedStyle(el).whiteSpace
  return ws.startsWith('pre') || ws === 'break-spaces'
}

// Exported for the content script's recheck path: a translated element whose
// text later gains blank lines (x.com "Show more" on a tweet whose truncated
// text had none) must be re-segmented, not retranslated as one block.
export function needsBlankLineSplit(el: Element): boolean {
  return hasBlankLineSeparator(el)
}

function hasBlankLineSeparator(el: Element): boolean {
  // Style check first: getComputedStyle is cheap relative to textContent,
  // which allocates the full subtree text — only pay that on pre-wrap
  // elements, which are rare.
  if (!preservesNewlines(el)) return false
  const text = el.textContent
  if (!text || !BLANK_LINE_RE.test(text)) return false
  return !isHidden(el as HTMLElement)
}

// Split `t` so each separator run (whitespace containing a blank line)
// becomes its own standalone text node. Returns the separator nodes.
function splitTextAtBlankLines(t: Text): Text[] {
  const seps: Text[] = []
  let node = t
  for (;;) {
    const m = SEP_RUN_RE.exec(node.data)
    if (!m) break
    const sep = m.index > 0 ? node.splitText(m.index) : node
    const rest = m[0].length < sep.data.length ? sep.splitText(m[0].length) : null
    seps.push(sep)
    if (!rest) break
    node = rest
  }
  return seps
}

// Nodes produced by segmentPreservedNewlines for a given source element: the
// hoisted separator text nodes and the element clones holding the content
// after each separator. Frameworks that own the source element (React on
// x.com) don't know about them: when the page later replaces the source's
// text wholesale ("Show more" swaps the truncated text for the full post),
// the old clones stay behind as stale duplicates. Tracking them lets a later
// re-split drop the ones whose content now lives in the source again.
const splitDerivedNodes = new WeakMap<Element, { sep: Text; clone: Element | null }[]>()

function isStaleDerivedClone(clone: Element, sourceText: string): boolean {
  const probe = getVisibleText(clone).trim()
  if (!probe) return true
  // Compare on a prefix: the stale clone may end with content that the
  // fresh source no longer has (x.com appends the "Show more" t.co link to
  // the truncated tail), and the source may continue where the clone ended.
  const head = probe.slice(0, 32)
  if (head.length < 8) return sourceText.includes(probe)
  return sourceText.includes(head)
}

// Prepare a preserves-newlines element for run segmentation: split every
// blank-line separator out of its text node and hoist it up through inline
// ancestors until it is a direct child of `parent` (cloning the ancestor at
// each level, Text.splitText-style). Afterwards the direct-child run has the
// same shape as br-br markup — content nodes with whitespace separator nodes
// between them — and segmentRunByBrBr(run, true) applies unchanged. The
// separators stay in the DOM (never wrapped), so rendering is untouched.
//
// This mutates during the walk's read phase, unlike the deferred writes used
// elsewhere — acceptable because blank-line pre-wrap elements are rare (one
// per long post), so the extra reflow is bounded.
function segmentPreservedNewlines(parent: Element) {
  const doc = parent.ownerDocument!
  const walker = doc.createTreeWalker(parent, NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT, {
    acceptNode(node) {
      if (node.nodeType === Node.ELEMENT_NODE) {
        const el = node as Element
        // Block-level descendants segment themselves when the walk recurses
        // into them; splitting across their boundary would move rendered
        // whitespace between formatting contexts.
        if (!isInlineish(el)) return NodeFilter.FILTER_REJECT
        if (el.classList.contains(RESULT_CLASS)) return NodeFilter.FILTER_REJECT
        if (el.classList.contains('notranslate')) return NodeFilter.FILTER_REJECT
        if (el.getAttribute('translate') === 'no') return NodeFilter.FILTER_REJECT
        if ((el as HTMLElement).isContentEditable) return NodeFilter.FILTER_REJECT
        return NodeFilter.FILTER_SKIP
      }
      return BLANK_LINE_RE.test((node as Text).data)
        ? NodeFilter.FILTER_ACCEPT
        : NodeFilter.FILTER_SKIP
    },
  })
  const targets: Text[] = []
  let n: Node | null
  while ((n = walker.nextNode())) targets.push(n as Text)

  // Elements about to be split that were split before: their previous
  // derived nodes are stale if the source now contains that content again.
  const seenSources = new Set<Element>()
  const dropStaleDerived = (p: Element) => {
    if (seenSources.has(p)) return
    seenSources.add(p)
    const prev = splitDerivedNodes.get(p)
    if (!prev) return
    const sourceText = getVisibleText(p)
    const kept: { sep: Text; clone: Element | null }[] = []
    for (const d of prev) {
      const stale = d.clone
        ? d.clone.isConnected && isStaleDerivedClone(d.clone, sourceText)
        : false
      if (stale) {
        d.clone!.remove()
        if (d.sep.isConnected) d.sep.remove()
      } else if (d.sep.isConnected || d.clone?.isConnected) {
        kept.push(d)
      }
    }
    if (kept.length > 0) splitDerivedNodes.set(p, kept)
    else splitDerivedNodes.delete(p)
  }

  for (const t of targets) {
    for (const sep of splitTextAtBlankLines(t)) {
      let cur: Node = sep
      while (cur.parentNode && cur.parentNode !== parent) {
        const p = cur.parentNode as Element
        dropStaleDerived(p)
        const after = p.cloneNode(false) as Element
        after.removeAttribute('id')
        // The split element may already be translated (x.com "Show more"
        // grows a translated span into several paragraphs). The clone is new
        // content that must be walked and translated on its own, so it must
        // not inherit our translation state.
        after.removeAttribute(PROCESSED_ATTR)
        after.removeAttribute('data-imp-text')
        after.removeAttribute('data-imp-noop')
        while (cur.nextSibling) after.appendChild(cur.nextSibling)
        // Our own injected nodes (the translation result and its <br>) sit at
        // the tail of the element and would otherwise ride along into the last
        // clone. They belong to the original, whose mark and text they match.
        for (const n of Array.from(after.childNodes)) {
          if (isOurInjectedNode(n)) p.appendChild(n)
        }
        const gp = p.parentNode!
        gp.insertBefore(cur, p.nextSibling)
        const hasClone = after.childNodes.length > 0
        if (hasClone) gp.insertBefore(after, cur.nextSibling)
        const list = splitDerivedNodes.get(p) ?? []
        list.push({ sep, clone: hasClone ? after : null })
        splitDerivedNodes.set(p, list)
      }
    }
  }
}

function isOurInjectedNode(n: Node): boolean {
  if (n.nodeType !== Node.ELEMENT_NODE) return false
  const cl = (n as Element).classList
  return cl.contains(RESULT_CLASS) || cl.contains('imp-translate-br')
}

function hasBlockChild(el: Element): boolean {
  for (const child of el.children) {
    const tag = child.tagName.toLowerCase()
    if (isBlockTag(tag)) {
      if (tag.includes('-') && !child.textContent?.trim()) continue
      // A block-tag element with display:inline-* (e.g. Google's
      // overflow-x carousel uses an inline-block <div> wrapper above the
      // flex card row) is a transparent wrapper for layout purposes — its
      // descendants can still contain real blocks. Recurse instead of
      // skipping outright.
      if (isDisplayInline(child)) {
        if (hasBlockChild(child)) return true
        continue
      }
      return true
    }
    // Recurse through inline-tag wrappers so nested inline chains (e.g.
    // Quora's div > span > span > p) don't hide real block descendants
    // from a leaf-extraction decision. Bounded by inline-chain depth,
    // which is naturally small in real DOM.
    if (INLINE_TAGS.has(tag)) {
      if (hasBlockChild(child)) return true
    }
  }
  return false
}

function isLeafBlock(el: Element): boolean {
  const tag = el.tagName.toLowerCase()
  if (!LEAF_BLOCK_TAGS.has(tag)) return false
  if (hasBlockChild(el)) return false
  return true
}

export function extractBlocks(root: Element = document.body, opts?: ExtractOptions): TranslatableBlock[] {
  // Skip ancestors of root must be checked here, not per-element in shouldSkip:
  // walker descends from root, so any skip ancestor inside the subtree gets
  // visited and matched cheaply via matches(). Ancestors above root are outside
  // the walk and need a one-time closest() check at entry.
  if (opts?.skipSelectors) {
    for (const s of opts.skipSelectors) {
      if (closestThroughShadow(root, s)) return []
    }
  }
  const blocks: TranslatableBlock[] = []
  // Deferred writes. The walk is a pure read phase — every DOM mutation
  // (wrapper insertion, shadow-root style/observer setup) is collected here and
  // flushed in one write phase after the walk. Interleaving writes with the
  // walk's layout reads (getComputedStyle/checkVisibility/getBoundingClientRect)
  // would force a synchronous reflow per write — quadratic on large DOMs like
  // Reddit (~2s). Batching keeps reads cheap and coalesces reflow into one.
  const pendingWraps: {
    parent: Element
    wrapper: HTMLElement
    refNode: Node
    seg: Node[]
  }[] = []
  const pendingShadowRoots: ShadowRoot[] = []

  function tryExtract(node: Element): boolean {
    if (isHidden(node as HTMLElement)) return false
    if (!inIncludeScope(node, opts)) return false
    // One traversal yields both the visible text (for the eligibility filters)
    // and the runs (for the canonical payload). Walking twice would double the
    // getComputedStyle calls the extraction budget guards — see collectText.
    const { text, runs } = collectText(node.childNodes, opts?.skipSelectors)
    const source = text.trim()
    if (source && !NO_LETTER_RE.test(source) && !ASCII_SHORT_RE.test(source)) {
      if (import.meta.env.DEV && source.length > OVERSIZED_BLOCK_THRESHOLD) {
        console.warn(
          `[imp-translate] oversized block (${source.length} chars) — likely a walker bug. Element:`,
          node,
        )
      }
      blocks.push({ element: node as HTMLElement, text: buildMarkedSource(trimEdgeRuns(runs).texts) })
      return true
    }
    return false
  }

  // An input/textarea's hint text lives in `placeholder`: a single run with no
  // text nodes to write into. Same gates and eligibility filters as a text block.
  function tryExtractAttribute(node: Element): boolean {
    if (!HINT_ATTR_TAGS.has(node.tagName.toLowerCase())) return false
    if (!passesSkipRules(node, opts)) return false
    if (!passesElementGates(node)) return false
    if (isHidden(node as HTMLElement)) return false
    const hint = node.getAttribute(HINT_ATTR)?.trim()
    if (!hint || NO_LETTER_RE.test(hint) || ASCII_SHORT_RE.test(hint)) return false
    blocks.push({
      element: node as HTMLElement,
      text: buildAttributeSource(node, HINT_ATTR),
      attribute: HINT_ATTR,
    })
    return true
  }

  // Read-only counterpart of tryExtract for the multi-node wrapper case: decide
  // eligibility and compute the block text from the segment nodes *in place*,
  // create the <font> wrapper detached (cheap, no layout impact), and record the
  // actual insertion/child-move for the write phase. The include gate is checked
  // on `parent` rather than the wrapper — equivalent, since the wrapper is a
  // plain <font> directly under `parent` that never matches an include selector.
  function deferWrap(parent: Element, seg: Node[]) {
    if (!inIncludeScope(parent, opts)) {
      // The parent can sit outside the scope while a segment element carries
      // it — a wrapper whose own child matches an include selector.
      const inSeg = seg.some(
        (n) =>
          n.nodeType === Node.ELEMENT_NODE &&
          opts?.includeSelectors?.some(
            (s) => (n as Element).matches(s) || (n as Element).querySelector(s),
          ),
      )
      if (!inSeg) return
    }
    // The segment nodes move into the wrapper only in the write phase, so the
    // runs are collected from `seg` itself — reading them off the empty
    // detached wrapper would yield nothing.
    const { text, runs } = collectText(seg, opts?.skipSelectors)
    const source = text.trim()
    if (!source || NO_LETTER_RE.test(source) || ASCII_SHORT_RE.test(source)) return
    if (import.meta.env.DEV && source.length > OVERSIZED_BLOCK_THRESHOLD) {
      console.warn(
        `[imp-translate] oversized block (${source.length} chars) — likely a walker bug. Parent:`,
        parent,
      )
    }
    const wrapper = parent.ownerDocument!.createElement('font')
    wrapper.setAttribute(WRAP_ATTR, 'true')
    blocks.push({ element: wrapper, text: buildMarkedSource(trimEdgeRuns(runs).texts) })
    pendingWraps.push({ parent, wrapper, refNode: seg[0], seg })
  }

  function walkMixed(parent: Element, splitOnBlankLines = false) {
    const isCustomElement = parent.tagName.includes('-')
    const children = Array.from(parent.childNodes)
    let run: Node[] = []

    const flushSegment = (seg: Node[]) => {
      while (seg.length > 0 && (isWhitespaceText(seg[0]) || isBr(seg[0]))) {
        seg.shift()
      }
      while (
        seg.length > 0 &&
        (isWhitespaceText(seg[seg.length - 1]) || isBr(seg[seg.length - 1]))
      ) {
        seg.pop()
      }
      if (seg.length === 0) return

      if (seg.length === 1 && seg[0].nodeType === Node.ELEMENT_NODE) {
        walk(seg[0] as Element)
        return
      }

      if (isCustomElement) {
        // Wrapping breaks Web Component slot distribution: only direct children
        // of the host carry slot="..." semantics. Walk each element child
        // individually; loose text between them is unrendered without slotting.
        for (const n of seg) {
          if (n.nodeType === Node.ELEMENT_NODE) walk(n as Element)
        }
        return
      }

      // Reparenting framework-managed stateful nodes (e.g. spoilers, accordions)
      // breaks React reconciliation: when the framework later runs removeChild
      // on a node it expects under `parent`, our wrapper is in the way and
      // the call throws NotFoundError.
      const hasStateful = seg.some(
        (n) => n.nodeType === Node.ELEMENT_NODE && hasStatefulInteractive(n as Element),
      )
      if (hasStateful) {
        for (const n of seg) {
          if (n.nodeType === Node.ELEMENT_NODE) walk(n as Element)
        }
        return
      }

      // <font> over <span>: site CSS/JS targets `span` far more often than the
      // near-deprecated `<font>`, so a font wrapper is more transparent to the
      // host page. Same tag as our translation result element. Insertion is
      // deferred to the write phase (see deferWrap) to avoid layout thrash.
      deferWrap(parent, seg)
    }

    const flush = () => {
      if (run.length === 0) return
      const segments = segmentRunByBrBr(run, splitOnBlankLines)
      for (const seg of segments) {
        flushSegment(seg)
      }
      run = []
    }

    for (const child of children) {
      if (isInlineish(child)) {
        run.push(child)
      } else if (child.nodeType === Node.ELEMENT_NODE) {
        flush()
        walk(child as Element)
      }
    }
    flush()
  }

  function walk(node: Element) {
    // Before shouldSkip: that gate drops <textarea> wholesale (its inner text
    // is the user's draft), which must not take its placeholder with it.
    if (tryExtractAttribute(node)) {
      walkShadow(node)
      return
    }

    if (shouldSkip(node, opts)) return

    // Pre-wrap content whose paragraphs are literal blank lines in the text
    // (x.com long posts): normalize the separators to direct children, then
    // segment the run like br-br fake paragraphs. Checked before the leaf
    // paths so a leaf block or flat div with blank lines splits too.
    if (hasBlankLineSeparator(node)) {
      segmentPreservedNewlines(node)
      walkMixed(node, true)
      walkShadow(node)
      return
    }

    if (isLeafBlock(node)) {
      tryExtract(node)
      walkShadow(node)
      return
    }

    if (hasBlockChild(node) || hasBrBrSeparator(node)) {
      walkMixed(node)
      walkShadow(node)
      return
    }

    if (tryExtract(node)) {
      walkShadow(node)
      return
    }

    for (const child of node.children) {
      walk(child)
    }
    walkShadow(node)
  }

  function walkShadow(node: Element) {
    const root = node.shadowRoot
    if (!root) return
    // Defer the onShadowRoot callback (style injection + observer attach) — it
    // mutates the shadow root and would dirty layout mid-walk.
    pendingShadowRoots.push(root)
    for (const child of root.children) {
      walk(child)
    }
  }

  walk(root)
  if (root instanceof Element) walkShadow(root)

  // WRITE PHASE — every DOM mutation happens here, after all layout reads, so
  // the browser coalesces the work into a single reflow instead of one per node.
  for (const { parent, wrapper, refNode, seg } of pendingWraps) {
    parent.insertBefore(wrapper, refNode)
    for (const n of seg) wrapper.appendChild(n)
  }
  for (const root of pendingShadowRoots) opts?.onShadowRoot?.(root)

  return blocks
}

export function getVisibleBlocks(blocks: TranslatableBlock[]): TranslatableBlock[] {
  const viewportHeight = window.innerHeight
  return blocks.filter((block) => {
    const rect = block.element.getBoundingClientRect()
    return rect.bottom > 0 && rect.top < viewportHeight * 2
  })
}

export function markTranslated(el: HTMLElement) {
  el.setAttribute(PROCESSED_ATTR, 'true')
}

// Text-node runs of a block: the individual text nodes in document order,
// with the same inclusion rules as the visible-text walk so that
//   runs.map((r) => r.data).join('') === getVisibleText(element, skipSelectors).
// Both modes need them — translation-only writes into them, bilingual splits
// the response on their markers — so this is not a translation-only accessor.
export function getTranslatableRuns(element: HTMLElement, skipSelectors?: string[]): Text[] {
  return collectText(Array.from(element.childNodes), skipSelectors, true).runs
}

// A block's canonical translation payload: its runs, marked. The single source
// of the string that is extracted as `data-imp-text`, cached, and re-checked
// before a write-back, so all three agree by construction rather than by three
// callers remembering to agree.
export function buildBlockSource(element: HTMLElement, skipSelectors?: string[]): string {
  return buildMarkedSource(trimmedRuns(element, skipSelectors).texts)
}

/**
 * The canonical payload and staleness token for an attribute-hint block: the
 * attribute's current value, marked verbatim, so flushRecheck compares it
 * against the token exactly as it does for a text block.
 */
export function buildAttributeSource(element: Element, attr: string): string {
  return buildMarkedSource([element.getAttribute(attr)?.trim() ?? ''])
}

// A block's runs with edge whitespace removed, keeping which text node each
// surviving run belongs to. The renderers split a response against exactly the
// run list the request was built from, and translation-only writes the pieces
// back into those same nodes — so both need the pairing, not just the strings.
export interface TrimmedRuns {
  /** Text nodes surviving edge trimming, document order. */
  nodes: Text[]
  /** Their texts with block-edge whitespace stripped — payload and split keys. */
  texts: string[]
  /** Whitespace stripped off the front of `nodes[0]`; re-attach on write-back. */
  head: string
  /** Whitespace stripped off the end of the last node; re-attach on write-back. */
  tail: string
}

export function trimmedRuns(element: HTMLElement, skipSelectors?: string[]): TrimmedRuns {
  return trimEdgeRuns(getTranslatableRuns(element, skipSelectors))
}

// Drop whitespace at both ends of the run list, trimming the outermost runs' own
// text where that is where the whitespace sits. A `.trim()` on the marked string
// would be a no-op — the markers sit at the very edges — so `"  a"` and `"a"`
// would keep different cache keys for the same page text.
//
// Two cases a naive edge filter misses: a whitespace-only edge run
// (`<p>text <span translate="no">x</span></p>` leaves a trailing `" "` run) and
// indentation inside the first/last run — how `<a>` wrapped in newlines in a
// template literal reads.
//
// Only the edges move: interior whitespace separates segments, and
// translation-only writes runs back individually, so trimming it would reflow
// the page. A single surviving run is both first and last, so `head` comes off
// the original text before `trimStart`, and `tail` off what is left after it.
function trimEdgeRuns(runs: Text[]): TrimmedRuns {
  let start = 0
  let end = runs.length
  while (start < end && !runs[start]!.data.trim()) start++
  while (end > start && !runs[end - 1]!.data.trim()) end--
  const nodes = runs.slice(start, end)
  if (nodes.length === 0) return { nodes, texts: [], head: '', tail: '' }
  const texts = nodes.map((n) => n.data)
  const head = texts[0]!.slice(0, texts[0]!.length - texts[0]!.trimStart().length)
  texts[0] = texts[0]!.trimStart()
  const tail = texts[texts.length - 1]!.slice(texts[texts.length - 1]!.trimEnd().length)
  texts[texts.length - 1] = texts[texts.length - 1]!.trimEnd()
  return { nodes, texts, head, tail }
}

// Original text of runs written by swapTextNodes. Keyed per node so repeated
// swap cycles (mode/language switches) still restore the true original.
const runOriginals = new WeakMap<Text, { orig: string; written: string }>()

export function swapTextNodes(runs: Text[], pieces: string[]): void {
  runs.forEach((node, i) => {
    const piece = pieces[i]
    if (piece === undefined || piece === node.data) return
    const prior = runOriginals.get(node)
    // Unchanged since our last write → keep the first original; the page
    // rewrote it → the current content is the new baseline.
    const orig = prior && prior.written === node.data ? prior.orig : node.data
    runOriginals.set(node, { orig, written: piece })
    node.data = piece
  })
}

export function restoreTextNodes(root: ParentNode): void {
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT)
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    const text = node as Text
    const entry = runOriginals.get(text)
    if (!entry) continue
    // The page rewrote this node after our swap: its current content is the
    // new truth — never clobber it with a stale original.
    if (text.data === entry.written) text.data = entry.orig
    runOriginals.delete(text)
  }
  root.querySelectorAll('*').forEach((el) => {
    if (el.shadowRoot) restoreTextNodes(el.shadowRoot)
  })
}

// Undo a translated placeholder. The original rides in data-imp-attr-orig
// (the DOM, not a WeakMap) so a stop restores it even if the content script
// was reinjected between the write and the stop.
function restoreAttributeHint(el: Element) {
  const attr = el.getAttribute('data-imp-attr')
  const orig = el.getAttribute('data-imp-attr-orig')
  if (attr !== null && orig !== null) el.setAttribute(attr, orig)
  el.removeAttribute('data-imp-attr')
  el.removeAttribute('data-imp-attr-orig')
}

// Undo the inline style overrides render.ts wrote. A property that had no
// inline value before is removed outright rather than reset to a value, so the
// page's own stylesheet rule (e.g. `overflow: hidden`) shows through again.
//
// The record is a DOM attribute, so a page can overwrite it with anything. A
// throw here would abort the rest of clearTranslations and leave the page
// half-cleared, so an unreadable record is dropped: the element keeps its
// inline style, the one case needing a reload, rather than wedging teardown.
function restoreInlineStyles(el: Element) {
  const raw = el.getAttribute(STYLE_ORIG_ATTR)
  if (raw === null) return
  el.removeAttribute(STYLE_ORIG_ATTR)
  let prior: Record<string, string>
  try {
    prior = JSON.parse(raw) as Record<string, string>
  } catch {
    return
  }
  if (typeof prior !== 'object' || prior === null) return
  const style = (el as HTMLElement).style
  for (const prop of OVERRIDDEN_PROPS) {
    const value = prior[prop]
    if (typeof value === 'string') style.setProperty(prop, value)
    else style.removeProperty(prop)
  }
}

export function clearTranslations(root: Element = document.body) {
  function clearScope(scope: ParentNode) {
    restoreTextNodes(scope)
    scope.querySelectorAll(`.${RESULT_CLASS}`).forEach((el) => el.remove())
    scope.querySelectorAll('.imp-translate-br').forEach((el) => el.remove())
    scope.querySelectorAll(`.${SPACER_CLASS}`).forEach((el) => el.remove())
    scope.querySelectorAll(`[${STYLE_ORIG_ATTR}]`).forEach(restoreInlineStyles)
    scope.querySelectorAll(`[${PROCESSED_ATTR}]`).forEach((el) => {
      restoreAttributeHint(el)
      el.removeAttribute(PROCESSED_ATTR)
      el.removeAttribute('data-imp-text')
      el.removeAttribute('data-imp-noop')
    })
    scope.querySelectorAll(`[${WRAP_ATTR}]`).forEach((wrapper) => {
      const parent = wrapper.parentNode
      if (!parent) return
      while (wrapper.firstChild) {
        parent.insertBefore(wrapper.firstChild, wrapper)
      }
      parent.removeChild(wrapper)
    })
    scope.querySelectorAll('*').forEach((el) => {
      if (el.shadowRoot) clearScope(el.shadowRoot)
    })
  }

  clearScope(root)
  restoreAttributeHint(root)
  restoreInlineStyles(root)
  root.removeAttribute(PROCESSED_ATTR)
  root.removeAttribute('data-imp-text')
  root.removeAttribute('data-imp-noop')
}

export { RESULT_CLASS, SPACER_CLASS, PROCESSED_ATTR, EDIT_ATTR, STYLE_ORIG_ATTR, OVERRIDDEN_PROPS, getVisibleText }
