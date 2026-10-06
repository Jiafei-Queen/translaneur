// Page-wide edit mode for translations, entered from the right-click menu.
//
// Every bilingual translation wrapper becomes a contenteditable area — inside
// links and buttons too. While editing, the page goes quiet: a stylesheet
// pauses CSS animations/transitions and makes controls (links, buttons,
// inputs, ARIA-styled controls) hit-test inert, and a capture-phase guard
// stops the control's own handlers from reacting to pointer events on an
// editable wrapper. A floating bar saves the changed translations as per-site
// overrides (or cancels, restoring the originals). New wrappers produced while
// edit mode is on (lazy scroll, a language change) are decorated too, via the
// decorator seam in render.ts, so "all translations are editable" stays true.
//
// The renderer skips overwriting a wrapper carrying EDIT_ATTR, so a live
// re-translation cannot clobber the text under the caret.

import { RESULT_CLASS, EDIT_ATTR } from './dom'
import { setResultDecorator } from './render'
import { showEditBar, insideOverlayUi, type EditBarHandle } from './overlay'

// Everything that behaves as a control and must not react while the user is
// editing. The editable wrappers re-enable themselves in the stylesheet, so a
// translation inside any of these stays reachable.
const NEUTRALIZE_SELECTOR = [
  'a',
  'button',
  'input',
  'select',
  'textarea',
  'label',
  'summary',
  '[role="button"]',
  '[role="link"]',
  '[onclick]',
].join(', ')

// Pointer events that a control or its delegated handlers could act on. Within
// an editable wrapper they are swallowed (stopping propagation is enough: the
// caret is placed by mousedown's default action, which stopping does not
// cancel); on controls outside a wrapper they are fully cancelled.
const SWALLOWED_EVENTS = [
  'mousedown',
  'pointerdown',
  'mouseup',
  'pointerup',
  'click',
  'dblclick',
]

const NEUTRALIZE_CSS = `
  html.imp-editing *, html.imp-editing *::before, html.imp-editing *::after {
    animation-play-state: paused !important;
    transition: none !important;
    scroll-behavior: auto !important;
  }
  html.imp-editing ${NEUTRALIZE_SELECTOR.replaceAll(',', ', html.imp-editing ')} {
    pointer-events: none !important;
  }
  html.imp-editing [${EDIT_ATTR}],
  html.imp-editing [${EDIT_ATTR}] * {
    pointer-events: auto !important;
    user-select: text !important;
  }
`

export interface EditEntry {
  source: string
  translated: string
}

export interface EditModeOptions {
  // The block's canonical source payload for a wrapper (its `data-imp-text`).
  resolveSource: (wrapper: HTMLElement) => string | null
  // Persist the entries the user actually changed.
  onSave: (entries: EditEntry[]) => void | Promise<void>
  // Cleanup is done; the caller restores the previous translation state/mode.
  onFinish: (action: 'save' | 'cancel') => void
}

export interface EditModeController {
  isActive(): boolean
  enter(): void
  save(): Promise<void>
  cancel(): void
  // Forced exit without restoring or saving (e.g. translation stopped).
  dispose(): void
}

// Every wrapper in the document, including those inside shadow roots.
function collectWrappers(root: ParentNode): HTMLElement[] {
  const out: HTMLElement[] = []
  const visit = (scope: ParentNode) => {
    scope.querySelectorAll<HTMLElement>(`.${RESULT_CLASS}`).forEach((el) => out.push(el))
    scope.querySelectorAll('*').forEach((el) => {
      if (el.shadowRoot) visit(el.shadowRoot)
    })
  }
  visit(root)
  return out
}

// Replaces the current selection with plain text, so a paste cannot smuggle
// markup into a translation the user is correcting.
function insertPlainText(text: string) {
  const selection = window.getSelection()
  if (!selection || selection.rangeCount === 0) return
  const range = selection.getRangeAt(0)
  range.deleteContents()
  range.insertNode(document.createTextNode(text))
  range.collapse(false)
}

export function createEditMode(opts: EditModeOptions): EditModeController {
  const snapshots = new WeakMap<HTMLElement, string>()
  let active = false
  let bar: EditBarHandle | null = null
  let style: HTMLStyleElement | null = null

  function onPaste(e: Event) {
    const ev = e as ClipboardEvent
    ev.preventDefault()
    insertPlainText(ev.clipboardData?.getData('text/plain') ?? '')
  }

  // Pointer events must reach the text, not the link or button the editable
  // wrapper sits in. Stopping propagation keeps page handlers (including
  // delegated ones) out while the event's default action — caret placement on
  // mousedown — still runs; only a click is cancelled outright, because its
  // default action would navigate or submit.
  function guard(e: Event) {
    // Our own bar/panels (shadow DOM) are never neutralized — their buttons
    // match the control selector and must keep working.
    if (insideOverlayUi(e)) return
    const target = e.target as Element | null
    if (!target?.closest) return
    if (target.closest(`[${EDIT_ATTR}]`)) {
      e.stopPropagation()
      if (e.type === 'click') e.preventDefault()
      return
    }
    // Controls outside an editable wrapper stay inert for pointer events too —
    // the stylesheet already hides them from hit-testing; this covers the
    // stragglers (e.g. keyboard-focused elements).
    if (e.type !== 'click') return
    if (target.closest(NEUTRALIZE_SELECTOR)) {
      e.preventDefault()
      e.stopPropagation()
    }
  }

  function decorate(wrapper: HTMLElement) {
    if (!active || wrapper.hasAttribute(EDIT_ATTR)) return
    wrapper.setAttribute(EDIT_ATTR, '')
    wrapper.setAttribute('contenteditable', 'true')
    wrapper.setAttribute('spellcheck', 'false')
    snapshots.set(wrapper, wrapper.textContent ?? '')
    wrapper.addEventListener('paste', onPaste)
  }

  function changedWrappers(): HTMLElement[] {
    return collectWrappers(document).filter((wrapper) => {
      const before = snapshots.get(wrapper)
      return before !== undefined && wrapper.textContent !== before
    })
  }

  function recount() {
    bar?.setChangedCount(changedWrappers().length)
  }

  function cleanup() {
    active = false
    setResultDecorator(null)
    document.removeEventListener('input', recount, true)
    for (const type of SWALLOWED_EVENTS) {
      document.removeEventListener(type, guard, true)
    }
    document.documentElement.classList.remove('imp-editing')
    style?.remove()
    style = null
    for (const wrapper of collectWrappers(document)) {
      wrapper.removeAttribute(EDIT_ATTR)
      wrapper.removeAttribute('contenteditable')
      wrapper.removeAttribute('spellcheck')
      wrapper.removeEventListener('paste', onPaste)
    }
    bar?.close()
    bar = null
  }

  const controller: EditModeController = {
    isActive: () => active,
    enter() {
      if (active) return
      active = true
      // A focused control could still be triggered from the keyboard (Enter on
      // a button); editing starts from a click, so nothing needs the focus.
      ;(document.activeElement as HTMLElement | null)?.blur?.()
      document.documentElement.classList.add('imp-editing')
      style = document.createElement('style')
      style.textContent = NEUTRALIZE_CSS
      document.head.appendChild(style)
      setResultDecorator(decorate)
      for (const wrapper of collectWrappers(document)) decorate(wrapper)
      document.addEventListener('input', recount, true)
      for (const type of SWALLOWED_EVENTS) {
        document.addEventListener(type, guard, true)
      }
      bar = showEditBar({
        onSave: () => {
          void controller.save()
        },
        onCancel: () => controller.cancel(),
      })
    },
    async save() {
      if (!active) return
      const entries: EditEntry[] = []
      for (const wrapper of changedWrappers()) {
        const source = opts.resolveSource(wrapper)
        const translated = (wrapper.textContent ?? '').trim()
        if (source && translated) entries.push({ source, translated })
      }
      cleanup()
      await opts.onSave(entries)
      opts.onFinish('save')
    },
    cancel() {
      if (!active) return
      for (const wrapper of changedWrappers()) {
        const before = snapshots.get(wrapper)
        if (before !== undefined) wrapper.textContent = before
      }
      cleanup()
      opts.onFinish('cancel')
    },
    dispose() {
      cleanup()
    },
  }

  return controller
}
