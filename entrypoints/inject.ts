import { messager, type TabWakeup, TAB_WAKEUP_PREFIX } from '@/lib/message'
import { ContentScriptContext } from 'wxt/utils/content-script-context'
import { selectorsForPath, type SiteRule } from '@/lib/rules'
import { showSelectionPanel, showNotice } from '@/lib/overlay'
import { createEditMode, type EditModeController } from '@/lib/edit-mode'
import {
  extractBlocks,
  clearTranslations,
  markTranslated,
  getVisibleBlocks,
  type TranslatableBlock,
  type ExtractOptions,
  PROCESSED_ATTR,
  RESULT_CLASS,
  EDIT_ATTR,
  SPACER_CLASS,
  HINT_ATTR,
  buildBlockSource,
  buildAttributeSource,
  needsBlankLineSplit,
} from '@/lib/dom'
import {
  injectLoading,
  replaceWithTranslation,
  replaceWithError,
  repositionTranslation,
  removeStyles,
  injectDebugStyles,
  removeDebugStyles,
  showToastBar,
  hideToastBar,
} from '@/lib/render'
import { getSettings, saveSettings, type RenderMode } from '@/lib/storage'
import { isUrlOnly, debugTime } from '@/lib/utils'
import { describeExtraction } from '@/lib/diag'
import {
  shouldTranslateTitle,
  composeTitle,
  decomposeTitle,
} from '@/lib/title'
import {
  isMailDisplayDocument,
  extractSubject,
  renderSubjectBlock,
  clearSubjectBlock,
  SUBJECT_SKIP_SELECTOR,
} from '@/lib/mail-subject'

export default defineUnlistedScript(() => {
  const w = window as unknown as Record<string, unknown>
  if (w.__imp_injected) return
  w.__imp_injected = true
  // Thunderbird can deliver this script twice into one document — the
  // registered message-display script and the background's executeScript
  // fallback run in different JS worlds (spike probe 4), so a window global
  // cannot dedupe them. The DOM is shared across worlds and this check-and-set
  // is synchronous, so exactly one pipeline runs per document.
  if (document.documentElement.hasAttribute('data-imp-script')) return
  document.documentElement.setAttribute('data-imp-script', '')

  if (window.self !== window.top && (window.innerWidth < 100 || window.innerHeight < 40)) return

  const ctx = new ContentScriptContext('inject')

  // Host-matched rules (each carries its own pathPattern). Path filtering
  // happens lazily when the walker reads opts.skipSelectors / includeSelectors,
  // so SPA route changes resolve to the right selector set without an IPC
  // round-trip — and without the race against MutationObserver that would
  // appear if pathname-active selectors arrived asynchronously.
  let hostRules: SiteRule[] = []
  let cachedPathname: string | null = null
  let cachedSelectors = { skipSelectors: [] as string[], includeSelectors: [] as string[] }

  function getActiveSelectors() {
    const p = location.pathname
    if (p !== cachedPathname) {
      cachedPathname = p
      cachedSelectors = selectorsForPath(hostRules, p)
    }
    return cachedSelectors
  }

  // TB-1/TB-2: Thunderbird hides a mail's body inside a <pre> the walker's
  // code-block skip would prune. Two shapes: text/plain renders as
  // div.moz-text-plain > pre.moz-quote-pre (TB-1), and some HTML mails ship
  // their whole body as a bare div.moz-text-html > pre (TB-2). Both selectors
  // are Thunderbird-only, so on web pages this stays inert.
  const tbMailPreAllow = (() => {
    const allow: string[] = []
    if (document.querySelector('pre.moz-quote-pre')) allow.push('pre.moz-quote-pre')
    if (document.querySelector('div.moz-text-html > pre')) {
      allow.push('div.moz-text-html > pre')
    }
    return allow.length > 0 ? allow : undefined
  })()

  // Thunderbird's own header chrome (avatar / from / to tables) sits in the
  // display document's body (spike probe 1) and would otherwise translate as
  // page text — on the web, chrome is excluded, so the header is too.
  const tbHeaderSkip = isMailDisplayDocument(document)
    ? ['table.moz-main-header']
    : undefined

  const extractOpts: ExtractOptions = {
    get skipSelectors() {
      const rules = getActiveSelectors().skipSelectors
      // Keep our own subject quote block out of the walk (lib/mail-subject.ts).
      return tbHeaderSkip
        ? [...rules, ...tbHeaderSkip, SUBJECT_SKIP_SELECTOR]
        : [...rules, SUBJECT_SKIP_SELECTOR]
    },
    get includeSelectors() {
      return getActiveSelectors().includeSelectors
    },
    allowSelectors: tbMailPreAllow,
    onShadowRoot: (r) => attachShadowObserver(r),
  }

  let isTranslating = false
  let targetLang = ''
  let renderMode: RenderMode = 'bilingual'
  // Elements belonging to the extraction a forced re-translate started on.
  // Scoped by element rather than by run: the observer reveals these blocks
  // long after the walk (scroll), while SPA navigation and rescans re-extract
  // without a new startTranslation, so a run-scoped flag would force-bill every
  // route the user moved to afterwards. Blocks outside this set take the cache.
  let forceBlocks: WeakSet<Element> | null = null
  let observer: MutationObserver | null = null
  const shadowObservers = new Map<ShadowRoot, MutationObserver>()
  let clickRescanTimer: ReturnType<typeof setTimeout> | null = null
  let visibilityObserver: IntersectionObserver | null = null
  const blockMap = new Map<Element, TranslatableBlock>()
  let downBatch: TranslatableBlock[] = []
  let downTimer: ReturnType<typeof setTimeout> | null = null
  let upBatch: TranslatableBlock[] = []
  let upTimer: ReturnType<typeof setTimeout> | null = null

  // --- Title translation (lib/title.ts) ----------------------------------
  // The <title> lives in document.head, outside the body walker and its
  // observer, so it carries its own pipeline: the page's part of the current
  // title is tracked as originalTitle, translated through the same `translate`
  // message, and written back. Composed output is identified by
  // lastAppliedTitle, so the page's own updates and our own writes are told
  // apart without racing the observer.
  let titleActive = false
  let titleObserver: MutationObserver | null = null
  let originalTitle = ''
  let lastAppliedTitle: string | null = null
  // Whether the title on screen is our composition. Only then does part of
  // the string belong to us and decomposeTitle apply — a page's own title is
  // free to contain the separator, and blindly splitting those would
  // translate a fragment ("GitHub — Where software…" → "Where software…").
  let titleIsComposed = false
  let titleTimer: ReturnType<typeof setTimeout> | null = null
  // The request in flight when a newer one supersedes it (a page rewrote the
  // title twice in a row). Only the newest request may write the title, and it
  // may only do so if the page's part has not changed again meanwhile.
  let titleRequestSeq = 0

  function translateTitleNow(force: boolean) {
    const t = debugTime('translateTitleNow')
    // Every path that reaches this function sees the page's own title —
    // a fresh start, or a page rewrite that passed the lastAppliedTitle
    // check in onTitleMutation. The split below is the safety net for a
    // composed title still on screen, e.g. our write landed after the page
    // queued its own rewrite.
    const pagePart = titleIsComposed
      ? decomposeTitle(document.title, renderMode)
      : null
    const source = (pagePart ?? document.title).trim()
    t(`source="${source.slice(0, 40)}"`)
    if (!shouldTranslateTitle(source)) return
    const seq = ++titleRequestSeq
    requestTranslate(source, force)
      .then((translated) => {
        if (!isTranslating || seq !== titleRequestSeq) return
        // A second page write may have landed while this request was in
        // flight — recompute what the page owns rather than trusting the
        // snapshot this request started from.
        const currentPart = titleIsComposed
          ? decomposeTitle(document.title, renderMode)
          : null
        if ((currentPart ?? document.title).trim() !== source) return
        const composed = composeTitle(translated, source, renderMode)
        lastAppliedTitle = composed
        titleIsComposed = true
        document.title = composed
        discardTitleSelfMutation()
        t('applied')
      })
      .catch((err) => {
        console.error('[imp-translate] title translation error:', err)
      })
  }

  function onTitleMutation() {
    if (!isTranslating) return
    const current = document.title
    // Our own write echoes back through this observer; nothing to do.
    if (current === lastAppliedTitle) return
    lastAppliedTitle = null
    titleIsComposed = false
    // A genuine page rewrite: the whole title is the page's again. Track it,
    // debounce, then re-translate — SPA pages rewrite the title on every
    // route change, and each rewrite is one cache-backed request.
    originalTitle = current
    if (titleTimer) clearTimeout(titleTimer)
    titleTimer = setTimeout(() => {
      titleTimer = null
      if (!isTranslating) return
      translateTitleNow(false)
    }, 100)
  }

  function discardTitleSelfMutation() {
    titleObserver?.takeRecords()
  }

  function startTitleTranslation(force: boolean) {
    // Titles are per-document and per-tab: sub-frames have none, and writing
    // one from an iframe is ignored by the browser anyway.
    if (window.self !== window.top) return
    titleActive = true
    originalTitle = document.title
    lastAppliedTitle = null
    titleIsComposed = false
    titleObserver = new MutationObserver(onTitleMutation)
    titleObserver.observe(document.head, {
      childList: true,
      subtree: true,
      characterData: true,
    })
    translateTitleNow(force)
  }

  function stopTitleTranslation() {
    // Never started here (setting off, or a sub-frame): nothing was captured,
    // so restoring would write '' over the page's real title.
    if (!titleActive) return
    titleActive = false
    if (titleTimer) {
      clearTimeout(titleTimer)
      titleTimer = null
    }
    titleRequestSeq++
    if (titleObserver) {
      titleObserver.disconnect()
      titleObserver = null
    }
    // Restore what the page last showed, not the snapshot from start time —
    // a page that renamed itself mid-translation must not time-travel. The
    // assignment is a no-op whenever the title is already the page's own.
    document.title = originalTitle
    lastAppliedTitle = null
    titleIsComposed = false
    originalTitle = ''
  }

  // --- Mail subject translation (lib/mail-subject.ts) ------------------
  // Thunderbird's visible subject line sits in a privileged header document
  // content scripts cannot reach, so the translation becomes a quote block at
  // the top of the message body instead. The subject is static per message
  // document (each message rewrites it), so this is read-once — no
  // title-style mutation tracking.
  let subjectActive = false
  let subjectRequestSeq = 0

  function startSubjectTranslation(force: boolean) {
    if (window.self !== window.top) return
    if (!isMailDisplayDocument(document)) return
    const source = extractSubject(document)
    if (!source) return
    subjectActive = true
    const seq = ++subjectRequestSeq
    requestTranslate(source, force)
      .then((translated) => {
        if (!isTranslating || !subjectActive || seq !== subjectRequestSeq) return
        renderSubjectBlock(document, source, translated, targetLang)
      })
      .catch((err) => {
        console.error('[imp-translate] subject translation error:', err)
      })
  }

  function stopSubjectTranslation() {
    subjectActive = false
    subjectRequestSeq++
    clearSubjectBlock(document)
  }

  function discardSelfMutations() {
    observer?.takeRecords()
    for (const obs of shadowObservers.values()) obs.takeRecords()
  }

  // The element's data-imp-text is the ownership token for in-flight
  // requests: a recheck may retranslate an element with newer text while an
  // older request is still pending (streaming pages), and responses can
  // arrive out of order. A response may only be applied if its source text
  // still matches the element's current data-imp-text.
  function isStale(block: TranslatableBlock): boolean {
    return block.element.getAttribute('data-imp-text') !== block.text
  }

  // The block's source text as the pipeline sees it: its runs, marked. This is
  // what extractBlocks put in block.text, what the cache keys on, and what
  // data-imp-text stores after a swap — so flushRecheck never mistakes our own
  // written translation for changed page text.
  //
  // Mode-independent on purpose. The two modes must derive the same string for
  // the same DOM, or a mode switch re-requests the whole page; and in
  // translation-only the runs hold translated text after a swap, so the token
  // has to be recomputed the same way it was seeded or recheck loops.
  function currentBlockSource(el: HTMLElement): string {
    const attr = el.getAttribute('data-imp-attr')
    if (attr) return buildAttributeSource(el, attr)
    return buildBlockSource(el, extractOpts.skipSelectors)
  }

  function translateBatch(batch: TranslatableBlock[]) {
    const t = debugTime(`translateBatch(n=${batch.length})`)
    for (const block of batch) {
      // Per block, because one batch can mix blocks from the forced extraction
      // with ones a later rescan found. A forced block is re-fetched (and its
      // cache entry overwritten); everything else is read-through.
      const force = forceBlocks?.has(block.element) ?? false
      requestTranslate(block.text, force)
        .then((translated) => {
          if (!isTranslating || isStale(block)) return
          replaceWithTranslation([block], [translated], {
            renderMode,
            skipSelectors: extractOpts.skipSelectors,
          })
          discardSelfMutations()
        })
        .catch((err) => {
          console.error('[imp-translate] translation error:', err)
          if (!isTranslating || isStale(block)) return
          replaceWithError([block], (retryBlocks) => {
            translateBatch(retryBlocks)
          }, { renderMode, skipSelectors: extractOpts.skipSelectors })
          discardSelfMutations()
        })
    }
    t(`sent ${batch.length} translate messages`)
  }

  async function filterByLanguage(
    blocks: TranslatableBlock[],
  ): Promise<TranslatableBlock[]> {
    if (blocks.length === 0) return blocks
    const results = await messager.sendMessage('detectLanguageBatch', {
      texts: blocks.map((b) => b.text),
    })
    return blocks.filter((_, i) => results[i] !== targetLang)
  }

  async function translateBlocks(blocks: TranslatableBlock[]) {
    if (blocks.length === 0) return

    blocks = blocks.filter((b) => !isUrlOnly(b.text))
    if (blocks.length === 0) return

    const seen = new Set<Element>()
    blocks = blocks.filter((b) => {
      if (b.element.hasAttribute(PROCESSED_ATTR)) return false
      // An already-translated ancestor owns this text — its translation
      // covers it, and a nested mark would race it for the result element.
      // An attribute hint competes for no text nodes and gets no result
      // element, so an ancestor's translation neither covers it nor races it.
      if (!b.attribute && b.element.parentElement?.closest(`[${PROCESSED_ATTR}]`)) return false
      if (seen.has(b.element)) return false
      seen.add(b.element)
      return true
    })
    // Streaming re-renders can queue both an element and a descendant added
    // later (e.g. React swapping the inner span of a pending <li>). Keep the
    // outermost block; its text includes the descendant's.
    blocks = blocks.filter(
      (b) =>
        b.attribute ||
        !blocks.some((o) => o !== b && o.element.contains(b.element)),
    )
    if (blocks.length === 0) return

    for (const block of blocks) {
      if (block.attribute) {
        // A hint the page removed while the block queued is dropped unmarked,
        // so a later rescan can pick it up again if it comes back.
        const current = buildAttributeSource(block.element, block.attribute)
        if (!current) continue
        if (current !== block.text) block.text = current
        markTranslated(block.element)
        block.element.setAttribute('data-imp-attr', block.attribute)
        block.element.setAttribute(
          'data-imp-attr-orig',
          block.element.getAttribute(block.attribute) ?? '',
        )
        block.element.setAttribute('data-imp-text', block.text)
        continue
      }
      // The text was captured at extraction time; on streaming pages it may
      // have grown while the block waited in the visibility/batch queues.
      // Translate what is in the DOM now, not the stale snapshot — without
      // this, the growth mutation predates the mark, so a recheck would
      // never repair the truncated translation.
      const current = currentBlockSource(block.element)
      if (current && current !== block.text) block.text = current
      markTranslated(block.element)
      block.element.setAttribute('data-imp-text', block.text)
    }

    blocks = await filterByLanguage(blocks)
    if (blocks.length === 0) return

    // Both modes share the ring: translation-only keeps the source visible
    // underneath it, so the wrapper is purely additive and costs no layout
    // shift when the translation lands in place. Attribute hints have nowhere
    // to put a ring — a form control renders its value, not its children.
    injectLoading(blocks.filter((b) => !b.attribute))
    discardSelfMutations()
    translateBatch(blocks)
  }

  function flushDownBatch() {
    downTimer = null
    if (!isTranslating || downBatch.length === 0) return
    const batch = downBatch.filter((b) => !b.element.hasAttribute(PROCESSED_ATTR))
    downBatch = []
    if (batch.length > 0) translateBlocks(batch)
  }

  function flushUpBatch() {
    upTimer = null
    if (!isTranslating || upBatch.length === 0) return
    const batch = upBatch.filter((b) => !b.element.hasAttribute(PROCESSED_ATTR))
    upBatch = []
    if (batch.length > 0) translateBlocks(batch)
  }

  const lastScrollTops = new WeakMap<EventTarget, number>()
  let scrollDirection: 'up' | 'down' = 'down'
  let lastUpTime = 0
  const UP_COOLDOWN = 200
  function updateScrollDirection(actualDir: 'up' | 'down') {
    if (actualDir === 'up') {
      scrollDirection = 'up'
      lastUpTime = performance.now()
    } else if (performance.now() - lastUpTime > UP_COOLDOWN) {
      scrollDirection = 'down'
    }
  }
  function onScroll(e: Event) {
    const target = e.target
    if (target === document || target === document.documentElement) {
      const y = window.scrollY
      const prev = lastScrollTops.get(document) ?? y
      if (y < prev) updateScrollDirection('up')
      else if (y > prev) updateScrollDirection('down')
      lastScrollTops.set(document, y)
    } else if (target instanceof Element) {
      const y = target.scrollTop
      const prev = lastScrollTops.get(target)
      if (prev !== undefined) {
        if (y < prev) updateScrollDirection('up')
        else if (y > prev) updateScrollDirection('down')
      }
      lastScrollTops.set(target, y)
    }
    if (scrollDirection === 'up' && upBatch.length > 0 && upTimer) {
      clearTimeout(upTimer)
      upTimer = setTimeout(() => {
        const t = debugTime('content:flushUpBatch')
        flushUpBatch()
        t('done')
      }, 300)
    }
  }

  function onIntersection(entries: IntersectionObserverEntry[]) {
    if (!isTranslating) return
    for (const entry of entries) {
      if (!entry.isIntersecting) continue
      const el = entry.target
      if (el.hasAttribute(PROCESSED_ATTR)) {
        visibilityObserver?.unobserve(el)
        blockMap.delete(el)
        continue
      }
      const block = blockMap.get(el)
      if (block) {
        if (scrollDirection === 'up') {
          upBatch.push(block)
        } else {
          downBatch.push(block)
        }
        visibilityObserver?.unobserve(el)
        blockMap.delete(el)
      }
    }
    if (downBatch.length > 0 && !downTimer) {
      downTimer = setTimeout(() => {
        const t = debugTime('content:flushDownBatch')
        flushDownBatch()
        t('done')
      }, 50)
    }
    if (upBatch.length > 0) {
      if (upTimer) clearTimeout(upTimer)
      upTimer = setTimeout(() => {
        const t = debugTime('content:flushUpBatch')
        flushUpBatch()
        t('done')
      }, 300)
    }
  }

  function observeBlocks(blocks: TranslatableBlock[]) {
    if (!visibilityObserver) return
    for (const block of blocks) {
      if (block.element.hasAttribute(PROCESSED_ATTR)) continue
      if (blockMap.has(block.element)) continue
      blockMap.set(block.element, block)
      visibilityObserver.observe(block.element)
    }
  }

  function onToggle(e: Event) {
    if (!isTranslating) return
    const details = e.target as HTMLDetailsElement
    if (!details.open) return
    setTimeout(() => {
      if (!isTranslating) return
      const newBlocks = extractBlocks(details, extractOpts)
      discardSelfMutations()
      observeBlocks(newBlocks)
    }, 100)
  }

  // Catches click-to-expand patterns where the toggle is a CSS class change
  // (e.g. TV Tropes' .folderlabel.is-open ~ p { display: block }) — no DOM
  // mutation, no <details> toggle event, so the regular observer can't see
  // the newly-visible content. Debounced; rescan is idempotent against
  // already-translated subtrees via PROCESSED_ATTR.
  function onClick() {
    if (!isTranslating) return
    if (clickRescanTimer) clearTimeout(clickRescanTimer)
    clickRescanTimer = setTimeout(() => {
      clickRescanTimer = null
      rescanBlocks()
    }, 200)
  }

  let recheckTimer: ReturnType<typeof setTimeout> | null = null
  const pendingRecheck = new Set<Element>()

  async function retranslateElement(el: Element, newText: string) {
    // Under edit mode the user's text is authoritative; a recheck must not
    // rewrite the block they are correcting.
    if (el.querySelector(`[${EDIT_ATTR}]`)) return
    // An attribute hint changed under our translation: retranslate the value
    // in the DOM now and write it back — a placeholder is a single string.
    const attr = el.getAttribute('data-imp-attr')
    if (attr) {
      if (!newText) return
      el.setAttribute('data-imp-text', newText)
      const block: TranslatableBlock = {
        element: el as HTMLElement,
        text: newText,
        attribute: attr,
      }
      const filtered = await filterByLanguage([block])
      if (filtered.length === 0) return
      try {
        const translated = await requestTranslate(newText)
        if (!isTranslating) return
        // A newer recheck may have superseded this one while awaiting.
        if (el.getAttribute('data-imp-text') !== newText) return
        replaceWithTranslation([block], [translated], {
          renderMode,
          skipSelectors: extractOpts.skipSelectors,
        })
        discardSelfMutations()
      } catch {
        // keep the current hint on error (matches the text-block behavior)
      }
      return
    }
    // The element was translated as one block, but its new text has blank-line
    // paragraph breaks in a pre-wrap context (x.com "Show more" on a tweet
    // whose truncated text had none). The walker would have segmented it, so
    // re-walk it instead of retranslating the whole thing as a single block —
    // clearing the mark first, otherwise shouldSkip hides it from the walk.
    if (needsBlankLineSplit(el)) {
      clearTranslations(el)
      const newBlocks = extractBlocks(el, extractOpts)
      discardSelfMutations()
      observeBlocks(newBlocks)
      return
    }
    if (renderMode === 'translation-only') {
      el.setAttribute('data-imp-text', newText)
      discardSelfMutations()
      const block: TranslatableBlock = { element: el as HTMLElement, text: newText }
      const filtered = await filterByLanguage([block])
      if (filtered.length === 0) return
      try {
        const translated = await requestTranslate(newText)
        if (!isTranslating) return
        // A newer recheck may have superseded this one while awaiting.
        if (el.getAttribute('data-imp-text') !== newText) return
        replaceWithTranslation([block], [translated], {
          renderMode,
          skipSelectors: extractOpts.skipSelectors,
        })
        discardSelfMutations()
      } catch {
        // keep current text on error (matches the bilingual behavior)
      }
      return
    }
    const wrapper = el.querySelector(`.${RESULT_CLASS}`)
    if (!wrapper) {
      el.removeAttribute(PROCESSED_ATTR)
      el.removeAttribute('data-imp-text')
      const newBlocks = extractBlocks(el, extractOpts)
      discardSelfMutations()
      observeBlocks(newBlocks)
      return
    }
    repositionTranslation(el as HTMLElement, newText)
    el.setAttribute('data-imp-text', newText)
    discardSelfMutations()
    const block: TranslatableBlock = { element: el as HTMLElement, text: newText }
    const filtered = await filterByLanguage([block])
    if (filtered.length === 0) return
    try {
      const translated = await messager.sendMessage('translate', {
        text: newText,
        targetLang,
      })
      if (!isTranslating) return
      // A newer recheck may have superseded this one while awaiting.
      if (el.getAttribute('data-imp-text') !== newText) return
      if (wrapper.parentElement) {
        // Reset to the plain result class: the original request for this
        // element may have been dropped as stale while the wrapper was still
        // in its loading state, so the spinner class must be cleared here.
        ;(wrapper as HTMLElement).className = RESULT_CLASS
        wrapper.textContent = translated
        discardSelfMutations()
      }
    } catch {
      // keep old translation on error
    }
  }

  function flushRecheck() {
    recheckTimer = null
    if (!isTranslating) return
    for (const el of pendingRecheck) {
      if (!el.hasAttribute(PROCESSED_ATTR)) continue
      const storedText = el.getAttribute('data-imp-text')
      if (!storedText) continue
      const currentText = currentBlockSource(el as HTMLElement)
      if (storedText === currentText) continue
      retranslateElement(el, currentText)
    }
    pendingRecheck.clear()
  }

  let delayedRescanTimer: ReturnType<typeof setTimeout> | null = null

  function handleMutations(mutations: MutationRecord[]) {
    if (!isTranslating) return
    let needsDelayedRescan = false
    const newBlocks: TranslatableBlock[] = []
    for (const mutation of mutations) {
      const target = mutation.target
      if (target instanceof Element && target.closest(`.${RESULT_CLASS}`)) continue
      const el = target instanceof Element ? target : target.parentElement
      const translated = el?.closest(`[${PROCESSED_ATTR}]`)
      if (translated) {
        pendingRecheck.add(translated as Element)
      }
      if (mutation.type === 'attributes' && target instanceof Element) {
        // A placeholder set after the walk. Already-translated elements are
        // queued for recheck above; extraction behind PROCESSED_ATTR is a no-op.
        const extracted = extractBlocks(target, extractOpts)
        if (extracted.length > 0) newBlocks.push(...extracted)
        continue
      }
      for (const node of mutation.addedNodes) {
        if (node.nodeType !== Node.ELEMENT_NODE) continue
        const addedEl = node as Element
        if (addedEl.classList?.contains(RESULT_CLASS)) continue
        if (addedEl.classList?.contains('imp-translate-br')) continue
        if (addedEl.classList?.contains(SPACER_CLASS)) continue
        if (addedEl.hasAttribute('data-imp-wrap')) continue
        if (addedEl.hasAttribute(PROCESSED_ATTR)) continue
        if (addedEl.closest(`[${PROCESSED_ATTR}]`)) continue
        const extracted = extractBlocks(addedEl, extractOpts)
        if (extracted.length > 0) {
          newBlocks.push(...extracted)
        } else {
          const tag = addedEl.tagName.toLowerCase()
          if (!tag.includes('loader') && tag !== 'script' && tag !== 'style') {
            const text = addedEl.textContent?.trim()
            if (text && text.length > 20) {
              needsDelayedRescan = true
            }
          }
        }
      }
    }
    if (pendingRecheck.size > 0) {
      if (recheckTimer) clearTimeout(recheckTimer)
      recheckTimer = setTimeout(flushRecheck, 300)
    }
    if (needsDelayedRescan) {
      if (delayedRescanTimer) clearTimeout(delayedRescanTimer)
      delayedRescanTimer = setTimeout(rescanBlocks, 500)
    }
    discardSelfMutations()
    if (newBlocks.length > 0) observeBlocks(newBlocks)
  }

  // Only observe here — do NOT push our stylesheet into the shadow root.
  // Styles are adopted lazily in injectLoading, for the roots that actually
  // receive a translation. Touching adoptedStyleSheets on every shadow root
  // the walker visits (~200 on a GitHub discussion: hidden <tool-tip>s and
  // <include-fragment>s) makes Dark Reader's per-root adopted-sheet watcher
  // re-render + re-match CSS variables ~200 times in one frame — tens of
  // seconds of main-thread time on an iPhone, seen as a white, unresponsive
  // page after translate + scroll.
  function attachShadowObserver(root: ShadowRoot) {
    if (shadowObservers.has(root)) return
    if (!isTranslating) return
    const obs = new MutationObserver(handleMutations)
    // attributes: a placeholder set after the walk carries no childList
    // mutation. Filtered to HINT_ATTR so attribute churn never reaches this
    // handler; our own writes are dropped by discardSelfMutations.
    obs.observe(root, {
      childList: true,
      subtree: true,
      characterData: true,
      attributes: true,
      attributeFilter: [HINT_ATTR],
    })
    shadowObservers.set(root, obs)
  }

  function startObserver() {
    observer = new MutationObserver(handleMutations)
    observer.observe(document.body, {
      childList: true,
      subtree: true,
      characterData: true,
      attributes: true,
      attributeFilter: [HINT_ATTR],
    })
  }

  function startUrlWatcher() {
    // wxt:locationchange fires on history.pushState / replaceState / popstate.
    // The active selector set updates lazily in getActiveSelectors via
    // location.pathname, so this handler only triggers a re-walk to pick up
    // elements that changed eligibility under the new pathname.
    ctx.addEventListener(window, 'wxt:locationchange', () => {
      if (!isTranslating) return
      onUrlChange()
    })
  }

  function rescanBlocks() {
    if (!isTranslating) return
    const newBlocks = extractBlocks(document.body, extractOpts)
    discardSelfMutations()
    observeBlocks(newBlocks)
  }

  function onUrlChange() {
    if (!isTranslating) return
    visibilityObserver?.disconnect()
    blockMap.clear()
    const blocks = extractBlocks(document.body, extractOpts)
    discardSelfMutations()
    observeBlocks(blocks)
    setTimeout(rescanBlocks, 1000)
  }

  let toastTimer: ReturnType<typeof setTimeout> | null = null

  function dismissToast() {
    if (toastTimer) {
      clearTimeout(toastTimer)
      toastTimer = null
    }
    hideToastBar()
  }

  // Shared by the local re-translate paths (language change, "Translate", and
  // the toast's re-translate): stop (harmless even if already restored — see
  // onTranslate below), tell the background this tab is translating again,
  // then restart locally with the retained host rules. `showToast` controls
  // whether startTranslation rebuilds the bar via maybeShowToast: "Translate"
  // needs that to flip it into "translating" mode, while a language change
  // keeps the bar it already has (rebuilding would replay the slide-in while
  // the user is still on the select).
  async function restartTranslation(lang: string, showToast: boolean, force = false) {
    const rules = hostRules
    stopTranslation(true)
    messager.sendMessage('startSelfTab', { targetLang: lang })
    await startTranslation(lang, showToast, rules, force)
  }

  async function maybeShowToast() {
    // Only the top frame shows the toast bar. startTranslation is broadcast
    // to every frame (so iframe content gets translated too); without this
    // guard each large iframe would render its own toast inside itself.
    if (window.self !== window.top) return
    const mobile = await messager.sendMessage('isMobile')
    if (!mobile) return
    showToastBar({
      currentLang: targetLang,
      translating: isTranslating,
      onRestore: () => {
        dismissToast()
        stopTranslation()
        messager.sendMessage('stopSelfTab')
      },
      // Forced pass: the page is already translated, so this is the one way to
      // ask the provider again. Keeps the bar (the walk refills it) and skips
      // the slide-in, same as a language change.
      onRetranslate: () => {
        restartTranslation(targetLang, false, true)
      },
      // Calling stopTranslation(true) inside restartTranslation on an
      // already-restored page is harmless, so no idle/translating branch
      // is needed here.
      onTranslate: () => {
        restartTranslation(targetLang, true)
      },
      onSettings: () => {
        dismissToast()
        messager.sendMessage('openOptionsPage')
      },
      onLangChange: async (lang) => {
        await saveSettings({ targetLang: lang })
        await restartTranslation(lang, false)
      },
      currentRenderMode: renderMode,
      onRenderModeChange: async (mode) => {
        await saveSettings({ renderMode: mode })
        await restartTranslation(targetLang, false)
      },
      onResetTimer: (delayMs) => {
        if (toastTimer) {
          clearTimeout(toastTimer)
        }
        toastTimer = setTimeout(dismissToast, delayMs)
      },
    })
    // Restart the countdown so a re-summoned bar doesn't vanish immediately.
    if (toastTimer) clearTimeout(toastTimer)
    toastTimer = setTimeout(dismissToast, 5000)
  }

  function waitForDOMReady(): Promise<void> {
    if (document.readyState !== 'loading') return Promise.resolve()
    return new Promise((resolve) => {
      document.addEventListener('DOMContentLoaded', () => resolve(), { once: true })
    })
  }

  let debugMode = false
  let translateTitleEnabled = false

  async function loadDeveloperSettings() {
    try {
      // getSettings merges the defaults in, so a setting the user never
      // touched follows the shipped default instead of reading as off.
      const settings = await getSettings()
      debugMode = settings.debugMode === true
      renderMode = settings.renderMode === 'translation-only' ? 'translation-only' : 'bilingual'
      translateTitleEnabled = settings.translateTitle === true
    } catch {}
  }

  async function startTranslation(
    lang: string,
    showToast = false,
    rules: SiteRule[] = [],
    force = false,
  ) {
    const t = debugTime('content:startTranslation')
    if (isTranslating) {
      // A start on a translating page is normally a no-op (the background may
      // deliver it twice, and auto-init can race it). A forced re-translate
      // arrives here with the tab already translating, so clear what is on
      // screen and walk again in place: the background has already set the tab
      // state and the active icon, and a full stop would only flip them back.
      if (!force) {
        t('skipped — already translating')
        return
      }
      t('force — restarting the existing run')
      stopTranslation(true)
    }
    isTranslating = true
    targetLang = lang
    hostRules = rules
    cachedPathname = null
    t('state set')
    await loadDeveloperSettings()
    t('loadDeveloperSettings done')
    if (debugMode) injectDebugStyles()
    await waitForDOMReady()
    t('waitForDOMReady done')
    if (!isTranslating) { t('stopped mid-init'); return }
    if (translateTitleEnabled) {
      // One pipeline per surface: a mail display document's "title" is the
      // Subject header, translated as the quote block (lib/mail-subject.ts).
      // Running the tab-title pipeline there too would translate the same
      // text twice and rewrite the <title> the subject is read from. Web
      // pages keep their tab-title translation via lib/title.ts.
      if (isMailDisplayDocument(document)) {
        startSubjectTranslation(force)
        t('startSubjectTranslation called')
      } else {
        startTitleTranslation(force)
        t('startTitleTranslation called')
      }
    }
    if (showToast) { maybeShowToast(); t('maybeShowToast called') }
    visibilityObserver = new IntersectionObserver(onIntersection, {
      rootMargin: '0px 0px 100% 0px',
    })
    t('observer created')
    const blocks = extractBlocks(document.body, extractOpts)
    t(`extractBlocks done — ${blocks.length} blocks`)
    // Thunderbird diagnostics: with Debug Mode on, report what the extractor
    // saw on this message/page; the background logs it as [imp-diag]. See
    // lib/diag.ts.
    if (debugMode) {
      void messager
        .sendMessage('diag', describeExtraction(document.body, blocks))
        .catch(() => {})
    }
    // The forced extraction: these elements, and only these, skip the cache
    // read. The blocks the IntersectionObserver reveals later come from this
    // same extraction, so a forced pass covers the page as the user scrolls it.
    if (force) forceBlocks = new WeakSet(blocks.map((b) => b.element))
    document.addEventListener('toggle', onToggle, { capture: true })
    document.addEventListener('click', onClick, { passive: true, capture: true })
    document.addEventListener('scroll', onScroll, { passive: true, capture: true })
    startObserver()
    startUrlWatcher()
    observeBlocks(blocks)
    t('observeBlocks done — waiting for IntersectionObserver')

    // Immediately translate visible blocks instead of waiting for
    // IntersectionObserver + 50ms batch timer. The observer callback
    // correctly skips already-processed elements via PROCESSED_ATTR.
    const visibleBlocks = getVisibleBlocks(blocks)
    if (visibleBlocks.length > 0) {
      t(`translating ${visibleBlocks.length} visible blocks immediately`)
      translateBlocks(visibleBlocks)
    }

    // SPA frameworks (React, Reddit's Lit-based UI, etc.) hydrate
    // progressively — elements may exist in the DOM but have zero layout
    // dimensions when the initial extractBlocks runs, so isHidden()
    // filters them out. A delayed rescan catches them once rendering
    // settles, without requiring the user to toggle translation off/on.
    // Not a forced pass: this re-extracts the whole body, so it would sweep in
    // content the user never asked to re-fetch (see forceBlocks).
    delayedRescanTimer = setTimeout(rescanBlocks, 1000)
  }

  function stopTranslation(keepToast = false) {
    isTranslating = false
    // Drop edit mode with the translations it was editing (no save/restore
    // loop); the wrappers are about to be torn down anyway.
    if (editController?.isActive()) editController.dispose()
    forceBlocks = null
    if (observer) {
      observer.disconnect()
      observer = null
    }
    for (const obs of shadowObservers.values()) {
      obs.disconnect()
    }
    shadowObservers.clear()
    if (visibilityObserver) {
      visibilityObserver.disconnect()
      visibilityObserver = null
    }
    blockMap.clear()
    downBatch = []
    upBatch = []
    if (downTimer) {
      clearTimeout(downTimer)
      downTimer = null
    }
    if (upTimer) {
      clearTimeout(upTimer)
      upTimer = null
    }
    if (recheckTimer) {
      clearTimeout(recheckTimer)
      recheckTimer = null
    }
    if (delayedRescanTimer) {
      clearTimeout(delayedRescanTimer)
      delayedRescanTimer = null
    }
    if (clickRescanTimer) {
      clearTimeout(clickRescanTimer)
      clickRescanTimer = null
    }
    pendingRecheck.clear()
    document.removeEventListener('toggle', onToggle, { capture: true })
    document.removeEventListener('click', onClick, { capture: true })
    document.removeEventListener('scroll', onScroll, { capture: true })
    stopTitleTranslation()
    stopSubjectTranslation()
    clearTranslations(document.body)
    removeStyles()
    removeDebugStyles()
    debugMode = false
    if (!keepToast) dismissToast()
  }

  // Registered synchronously during injection (this is an unlisted script
  // driven by scripting.executeScript), so the background's post-inject
  // startTranslation can't outrun the listener. Handlers deliberately do not
  // return or await the work: the background only needs the message delivered,
  // not the translation to finish, and waiting here would keep the sender's
  // response channel (and the SW) busy for the whole first scan.
  //
  // One remote command can arrive twice — as the storage wake-up below and as
  // this direct message — and a forced start re-walks the page, so a double
  // apply would walk (and bill) it twice. Commands carry a revision; one
  // revision applies once, a command without one always applies.
  let myTabId: number | null = null
  let lastCommandRev = -1

  async function applyCommand(cmd: TabWakeup & { rules?: SiteRule[] }) {
    if (cmd.rev !== undefined) {
      if (cmd.rev === lastCommandRev) return
      lastCommandRev = cmd.rev
    }
    // Context-menu commands share the channel but mean nothing to the page
    // translation state machine.
    if (cmd.kind === 'selection') {
      const { selectionBubbleFollow } = await getSettings()
      showSelectionPanel({
        translated: cmd.translated,
        follow: selectionBubbleFollow,
        getRect: selectionRect,
      })
      return
    }
    if (cmd.kind === 'edit') {
      void enterEditMode()
      return
    }
    if (!cmd.lang) {
      if (isTranslating) {
        stopTranslation()
        maybeShowToast()
      }
      return
    }
    if (isTranslating && !cmd.force) return
    const rules =
      cmd.rules ??
      (await messager.sendMessage('getMatchedRulesForHostname', {
        hostname: location.hostname,
      }))
    void startTranslation(cmd.lang, cmd.showToast ?? false, rules, cmd.force ?? false)
  }

  // --- Context menu plumbing ---------------------------------------------
  // The page's last selection, captured on contextmenu (which fires before the
  // menu opens) so a later menuCommand can anchor its UI without a round trip.
  // A cloned Range stays bound to its nodes even after the selection collapses,
  // so the bubble can be re-anchored on scroll.
  let lastSelectionRange: Range | null = null

  function captureSelectionRange(): Range | null {
    const selection = window.getSelection()
    if (!selection || selection.rangeCount === 0 || !selection.toString().trim()) {
      return null
    }
    return selection.getRangeAt(0).cloneRange()
  }

  function onContextMenu() {
    lastSelectionRange = captureSelectionRange()
  }
  document.addEventListener('contextmenu', onContextMenu, true)

  // The live anchor for the selection bubble: the captured range first, then
  // the current selection (right-click usually preserves it).
  function selectionRect(): DOMRect | null {
    const fromRange = lastSelectionRange?.getBoundingClientRect() ?? null
    if (fromRange && (fromRange.width > 0 || fromRange.height > 0)) return fromRange
    const selection = window.getSelection()
    if (selection && selection.rangeCount > 0 && selection.toString().trim()) {
      const rect = selection.getRangeAt(0).getBoundingClientRect()
      if (rect.width > 0 || rect.height > 0) return rect
    }
    return fromRange
  }

  // closest() stops at a shadow boundary; walk up through hosts so a translated
  // block inside a shadow root is still found from a light-DOM event target.
  function composedClosest(el: Element | null, selector: string): Element | null {
    let current: Element | null = el
    while (current) {
      const found = current.closest(selector)
      if (found) return found
      const root = current.getRootNode()
      current = root instanceof ShadowRoot ? root.host : null
    }
    return null
  }

  // --- Page-wide edit mode -----------------------------------------------
  let editController: EditModeController | null = null
  let editPreviousMode: RenderMode = 'bilingual'
  let editWasTranslating = false

  function resolveEditSource(wrapper: HTMLElement): string | null {
    const block = composedClosest(wrapper, `[data-imp-text]`)
    return block?.getAttribute('data-imp-text') ?? null
  }

  function getOrCreateEditController(): EditModeController {
    if (!editController) {
      editController = createEditMode({
        resolveSource: resolveEditSource,
        onSave: async (entries) => {
          if (entries.length === 0) return
          try {
            await messager.sendMessage('saveTranslationOverrides', { targetLang, entries })
            showNotice('Translations saved')
          } catch {
            showNotice('Could not save translations')
          }
        },
        onFinish: () => {
          void restoreAfterEdit()
        },
      })
    }
    return editController
  }

  // Enter edit mode: switch to bilingual (truthful inline editing is only
  // possible there), translating the page first if needed, then make every
  // translation editable. The render decorator seam catches wrappers as they
  // land, so there is nothing to await here.
  async function enterEditMode() {
    const controller = getOrCreateEditController()
    if (controller.isActive()) return
    const settings = await getSettings()
    editWasTranslating = isTranslating
    editPreviousMode = renderMode
    if (!isTranslating) targetLang = settings.targetLang
    if (renderMode !== 'bilingual') {
      await saveSettings({ renderMode: 'bilingual' })
    }
    if (!isTranslating || editPreviousMode !== 'bilingual') {
      await restartTranslation(targetLang, false)
    }
    controller.enter()
  }

  // Put the page back the way it was before edit mode: the previous render mode
  // if it was translating, or fully restored if it was not.
  async function restoreAfterEdit() {
    if (!editWasTranslating) {
      stopTranslation()
      void messager.sendMessage('stopSelfTab')
      return
    }
    if (editPreviousMode !== 'bilingual') {
      await saveSettings({ renderMode: editPreviousMode })
      await restartTranslation(targetLang, false)
    }
  }

  // Site/sender-domain key for this document, resolved once and stamped on
  // every translate request so the background can apply a saved override.
  let siteKey: string | null | undefined
  async function getSiteKey(): Promise<string | null> {
    if (siteKey !== undefined) return siteKey
    try {
      siteKey = await messager.sendMessage('getSiteKey')
    } catch {
      siteKey = null
    }
    return siteKey
  }

  async function requestTranslate(text: string, force = false): Promise<string> {
    const site = await getSiteKey()
    return messager.sendMessage('translate', {
      text,
      targetLang,
      force,
      site: site ?? undefined,
    })
  }

  messager.onMessage('menuCommand', ({ data }) => {
    // One overlay per tab: the wake-up path is top-frame only, so the direct
    // message must match or an iframe would render a second panel.
    if (window.self !== window.top) return
    void applyCommand(data)
  })

  messager.onMessage('startTranslation', ({ data }) => {
    void applyCommand({
      lang: data.targetLang,
      rules: data.rules,
      force: data.force,
      showToast: data.showToast,
      rev: data.rev,
    })
  })
  messager.onMessage('stopTranslation', () => {
    void applyCommand({ lang: null })
  })
  messager.onMessage('getState', () => isTranslating)

  // The storage wake-up channel (background ringTabWakeup) — the start/stop
  // delivery that reaches a Thunderbird displayed message, whose script
  // background→content messaging may not. Keyed per tab; this document's tab
  // id arrives over the content→background direction the spike verified, and
  // a wake-up that beats it is covered by the direct message or auto-init.
  // Top frame only, like auto-init: sub-frames are driven per frame by the
  // background's webNavigation handlers.
  void messager
    .sendMessage('getSelfTabId')
    .then((id) => {
      myTabId = id
    })
    .catch(() => {})
  browser.storage.onChanged.addListener((changes, areaName) => {
    if (areaName !== 'local') return
    if (window.self !== window.top) return
    if (myTabId === null) return
    const next = changes[`${TAB_WAKEUP_PREFIX}${myTabId}`]?.newValue as TabWakeup | undefined
    if (!next) return
    void applyCommand(next)
  })

  window.addEventListener('pageshow', async (e) => {
    if (!e.persisted) return
    const lang = await messager.sendMessage('getSelfTabState')
    if (!lang && isTranslating) {
      stopTranslation()
      return
    }
    // BFCache restore race: on a refresh (F5), Chrome may fire pageshow
    // on the preserved page BEFORE onDOMContentLoaded clears the session
    // key. Wait a frame and re-check so the reload-triggered key clear
    // has time to propagate. True back/forward navigation keeps the key
    // set, so the re-check is a no-op.
    if (lang && isTranslating) {
      await new Promise((r) => setTimeout(r, 100))
      const lang2 = await messager.sendMessage('getSelfTabState')
      if (!lang2 && isTranslating) {
        stopTranslation()
      }
    }
  })

  // Auto-init: when inject.js is loaded into a document, check whether this
  // tab should be translating. Covers two things: the race where the
  // startTranslation message arrives before this script's listener is
  // registered, and Thunderbird's per-message document rewrite — switching
  // mail keeps translating, and each fresh document picks the same session
  // key up here and translates the new message.
  //
  // Only the top frame auto-inits. Sub-frames are driven explicitly by the
  // background's webNavigation handlers (which send a per-frame
  // startTranslation), so they never self-start from a session key that may
  // still be stale during a reload. The listener above is registered
  // synchronously, so the background's post-inject startTranslation can't outrace it.
  ;(async () => {
    if (window.self !== window.top) return
    await waitForDOMReady()
    const lang = await messager.sendMessage('getSelfTabState')
    if (!lang) return
    if (isTranslating) return
    const rules = await messager.sendMessage('getMatchedRulesForHostname', {
      hostname: location.hostname,
    })
    startTranslation(lang, false, rules)
  })()
})
