// In-page UI for the context-menu features: a selection-translation bubble and
// the page-wide edit bar. Both live in one shadow-DOM host so page CSS cannot
// reach them and `clearTranslations` (which only walks the light DOM) never
// tears them down with the translation wrappers. See docs/menus.md.

const HOST_ID = 'imp-menu-overlay-host'
const HIDDEN_CLASS = 'imp-hidden'

const CSS = `
  :host { all: initial; }
  .panel {
    position: fixed;
    z-index: 2147483647;
    max-width: min(420px, 92vw);
    box-sizing: border-box;
    padding: 10px 12px;
    border: 1px solid rgba(0, 0, 0, 0.12);
    border-radius: 10px;
    background: rgba(255, 255, 255, 0.98);
    color: #1a1a1a;
    box-shadow: 0 6px 24px rgba(0, 0, 0, 0.18);
    font: 14px/1.45 system-ui, -apple-system, sans-serif;
  }
  /* Hide without display:none: the box stays laid out, so re-anchoring reads
     the real size and the bubble can keep a spot while it is off screen. */
  .panel.imp-hidden { visibility: hidden; }
  .panel.bar {
    display: flex;
    align-items: center;
    gap: 8px;
    left: 50%;
    top: 12px;
    transform: translateX(-50%);
    padding: 8px 10px;
  }
  .label {
    font-size: 11px;
    letter-spacing: 0.02em;
    text-transform: uppercase;
    color: #6b7280;
    margin-bottom: 4px;
  }
  .bar .label { margin: 0; }
  .count { font-size: 12px; color: #6b7280; white-space: nowrap; }
  .translated {
    white-space: pre-wrap;
    word-break: break-word;
    margin-bottom: 8px;
  }
  .row { display: flex; gap: 6px; justify-content: flex-end; align-items: center; }
  .grow { flex: 1; }
  button {
    font: inherit;
    font-size: 13px;
    padding: 4px 10px;
    border-radius: 6px;
    border: 1px solid transparent;
    background: none;
    cursor: pointer;
    color: #4b5563;
    white-space: nowrap;
  }
  button:hover { background: rgba(0, 0, 0, 0.06); }
  button.primary { background: #2563eb; color: #fff; }
  button.primary:hover { background: #1d4ed8; }
  @media (prefers-color-scheme: dark) {
    .panel { background: rgba(30, 30, 30, 0.98); color: #e5e7eb; border-color: rgba(255,255,255,0.14); }
    .label, .source, .count { color: #9ca3af; }
    button { color: #d1d5db; }
    button:hover { background: rgba(255, 255, 255, 0.1); }
    button.primary { background: #3b82f6; color: #fff; }
  }
`

let cleanups: Array<() => void> = []

function hostElement(): HTMLElement | null {
  return document.getElementById(HOST_ID)
}

function ensureHost(): ShadowRoot {
  const existing = hostElement()
  if (existing?.shadowRoot) return existing.shadowRoot
  const host = document.createElement('div')
  host.id = HOST_ID
  host.setAttribute('translate', 'no')
  const root = host.attachShadow({ mode: 'open' })
  const style = document.createElement('style')
  style.textContent = CSS
  root.appendChild(style)
  document.documentElement.appendChild(host)
  return root
}

// Remove the current panel and every listener it installed.
function teardown() {
  hostElement()?.shadowRoot?.querySelector('.panel')?.remove()
  const pending = cleanups
  cleanups = []
  for (const fn of pending) fn()
}

// Whether the event happened inside our own overlay UI (bubble, edit bar,
// notice). Callers outside this module (edit mode's event guard) need it too:
// the bar's Save/Cancel buttons are `button` elements in a shadow root and
// would otherwise be neutralized.
export function insideOverlayUi(e: Event): boolean {
  const host = hostElement()
  return !!host && e.composedPath().includes(host)
}

function clamp(value: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(value, hi))
}

function place(panel: HTMLElement, rect: DOMRect) {
  const margin = 8
  const box = panel.getBoundingClientRect()
  let top = rect.bottom + margin
  if (top + box.height > window.innerHeight - margin) {
    top = rect.top - box.height - margin
  }
  const left = clamp(rect.left, margin, window.innerWidth - box.width - margin)
  top = clamp(top, margin, window.innerHeight - box.height - margin)
  panel.style.left = `${left}px`
  panel.style.top = `${top}px`
  panel.style.transform = ''
}

function centerTop(panel: HTMLElement) {
  panel.style.left = '50%'
  panel.style.top = '64px'
  panel.style.transform = 'translateX(-50%)'
}

// Lets the user grab the bubble and move it anywhere, so it never has to sit on
// top of what they are reading. How the move sticks is up to the caller: with
// follow on, onDragEnd converts the new spot into the relative offset the
// bubble keeps from the selection; with follow off the bubble simply stays
// where it was dropped.
function makeDraggable(
  panel: HTMLElement,
  onDragStart: () => void,
  onDragEnd: () => void,
): () => void {
  panel.style.cursor = 'grab'
  panel.style.userSelect = 'none'
  panel.style.touchAction = 'none'
  let dragging = false
  let startX = 0
  let startY = 0
  let originLeft = 0
  let originTop = 0

  const onPointerDown = (e: PointerEvent) => {
    if (e.button !== 0) return
    if ((e.target as HTMLElement).closest('button')) return
    dragging = true
    onDragStart()
    const rect = panel.getBoundingClientRect()
    panel.style.transform = ''
    originLeft = rect.left
    originTop = rect.top
    startX = e.clientX
    startY = e.clientY
    panel.style.cursor = 'grabbing'
    panel.setPointerCapture(e.pointerId)
    e.preventDefault()
  }
  const onPointerMove = (e: PointerEvent) => {
    if (!dragging) return
    const margin = 4
    const left = clamp(
      originLeft + (e.clientX - startX),
      margin,
      window.innerWidth - panel.offsetWidth - margin,
    )
    const top = clamp(
      originTop + (e.clientY - startY),
      margin,
      window.innerHeight - panel.offsetHeight - margin,
    )
    panel.style.left = `${left}px`
    panel.style.top = `${top}px`
  }
  const stop = (e: PointerEvent) => {
    if (!dragging) return
    dragging = false
    panel.style.cursor = 'grab'
    onDragEnd()
    try {
      panel.releasePointerCapture(e.pointerId)
    } catch {
      /* pointer already released */
    }
  }
  panel.addEventListener('pointerdown', onPointerDown)
  panel.addEventListener('pointermove', onPointerMove)
  panel.addEventListener('pointerup', stop)
  panel.addEventListener('pointercancel', stop)
  return () => {
    panel.removeEventListener('pointerdown', onPointerDown)
    panel.removeEventListener('pointermove', onPointerMove)
    panel.removeEventListener('pointerup', stop)
    panel.removeEventListener('pointercancel', stop)
  }
}

function button(label: string, className?: string): HTMLButtonElement {
  const b = document.createElement('button')
  b.type = 'button'
  if (className) b.className = className
  b.textContent = label
  return b
}

function intersectsViewport(rect: DOMRect): boolean {
  return (
    rect.left < window.innerWidth &&
    rect.right > 0 &&
    rect.top < window.innerHeight &&
    rect.bottom > 0
  )
}

export interface SelectionPanelOptions {
  translated: string
  // Whether the bubble tracks the selection as the page scrolls. When on it
  // keeps a fixed relative offset to the selection (even through drags) and
  // hides when its own anchored position leaves the viewport; when off it is
  // placed once.
  follow: boolean
  // Live anchor: queried on open, then again on scroll/resize. With follow
  // off it is only used for the initial placement.
  getRect?: () => DOMRect | null
}

export function showSelectionPanel(opts: SelectionPanelOptions) {
  const root = ensureHost()
  teardown()

  const panel = document.createElement('div')
  panel.className = 'panel'

  const translated = document.createElement('div')
  translated.className = 'translated'
  translated.textContent = opts.translated

  const row = document.createElement('div')
  row.className = 'row'
  const spacer = document.createElement('span')
  spacer.className = 'grow'
  const copy = button('Copy')
  copy.addEventListener('click', () => {
    navigator.clipboard?.writeText(opts.translated).catch(() => {})
  })
  const close = button('Close')
  close.addEventListener('click', () => teardown())
  row.append(spacer, copy, close)

  panel.append(translated, row)
  root.appendChild(panel)

  // The bubble's offset from the selection's top-left corner, frozen while the
  // page is still or the user drags it. Null until the first anchor exists.
  let offset: { x: number; y: number } | null = null
  let dragging = false

  function recordOffset() {
    const rect = opts.getRect?.()
    if (!rect || !(rect.width || rect.height)) return
    const box = panel.getBoundingClientRect()
    offset = { x: box.left - rect.left, y: box.top - rect.top }
  }

  // Follow mode: glue the bubble to the selection at its relative offset —
  // no viewport clamping, so bubble and selection move together 1:1. Whether
  // it is shown is decided by the bubble alone: it hides when its anchored
  // position is fully outside the viewport and returns as soon as any part of
  // it is back, regardless of where the selection is (the user may have parked
  // it far from the selection, or the selection may sit off screen).
  function applyPlace() {
    if (!opts.follow || dragging) return
    const rect = opts.getRect?.()
    if (!rect || !(rect.width || rect.height)) return
    if (offset) {
      const box = panel.getBoundingClientRect()
      const left = rect.left + offset.x
      const top = rect.top + offset.y
      const fullyOffScreen =
        left >= window.innerWidth ||
        left + box.width <= 0 ||
        top >= window.innerHeight ||
        top + box.height <= 0
      if (fullyOffScreen) {
        panel.classList.add(HIDDEN_CLASS)
        return
      }
      panel.classList.remove(HIDDEN_CLASS)
      panel.style.left = `${left}px`
      panel.style.top = `${top}px`
      panel.style.transform = ''
    } else {
      // No anchor yet: show it neutrally (the selection may sit off screen),
      // and adopt the smart below/above placement once it is on screen,
      // freezing that as the relative offset so it does not flip as the page
      // crosses folds.
      panel.classList.remove(HIDDEN_CLASS)
      if (!intersectsViewport(rect)) {
        centerTop(panel)
        return
      }
      place(panel, rect)
      recordOffset()
    }
  }

  if (opts.follow) {
    applyPlace()
  } else {
    const initial = opts.getRect?.()
    if (initial && (initial.width || initial.height)) place(panel, initial)
    else centerTop(panel)
  }

  const stopDrag = makeDraggable(
    panel,
    () => {
      // Keep the re-anchor off while the user is mid-drag (pointer capture
      // already moves the bubble); only the dropped spot becomes the offset.
      dragging = true
    },
    () => {
      dragging = false
      if (!opts.follow) return
      offset = null
      recordOffset()
      applyPlace()
    },
  )

  const reposition = () => {
    if (opts.follow) applyPlace()
  }
  window.addEventListener('scroll', reposition, true)
  window.addEventListener('resize', reposition)

  const onKey = (e: KeyboardEvent) => {
    if (e.key === 'Escape') teardown()
  }
  const onDown = (e: PointerEvent) => {
    if (!insideOverlayUi(e)) teardown()
  }
  // Arm dismissal after the click that opened the menu finishes, so it does not
  // immediately close the panel.
  const arm = setTimeout(() => {
    document.addEventListener('keydown', onKey, true)
    document.addEventListener('pointerdown', onDown, true)
  }, 0)

  cleanups.push(() => {
    clearTimeout(arm)
    stopDrag()
    window.removeEventListener('scroll', reposition, true)
    window.removeEventListener('resize', reposition)
    document.removeEventListener('keydown', onKey, true)
    document.removeEventListener('pointerdown', onDown, true)
  })
}

export interface EditBarHandle {
  setChangedCount(n: number): void
  close(): void
}

export function showEditBar(opts: {
  onSave: () => void
  onCancel: () => void
}): EditBarHandle {
  const root = ensureHost()
  teardown()

  const panel = document.createElement('div')
  panel.className = 'panel bar'

  const label = document.createElement('span')
  label.className = 'label'
  label.textContent = 'Editing translations'

  const count = document.createElement('span')
  count.className = 'count'

  const spacer = document.createElement('span')
  spacer.className = 'grow'

  const cancel = button('Cancel')
  cancel.addEventListener('click', () => opts.onCancel())
  const save = button('Save', 'primary')
  save.addEventListener('click', () => opts.onSave())

  panel.append(label, count, spacer, cancel, save)
  root.appendChild(panel)

  const onKey = (e: KeyboardEvent) => {
    if (e.key === 'Escape') opts.onCancel()
  }
  document.addEventListener('keydown', onKey, true)
  cleanups.push(() => document.removeEventListener('keydown', onKey, true))

  return {
    setChangedCount(n: number) {
      count.textContent = n > 0 ? `${n} changed` : ''
    },
    close: teardown,
  }
}

export function showNotice(message: string) {
  const root = ensureHost()
  teardown()
  const panel = document.createElement('div')
  panel.className = 'panel'
  panel.textContent = message
  root.appendChild(panel)
  centerTop(panel)
  const timer = setTimeout(teardown, 3000)
  cleanups.push(() => clearTimeout(timer))
}
