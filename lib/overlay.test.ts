import { afterEach, describe, expect, it } from 'vitest'
import { showSelectionPanel } from './overlay'

const HOST_ID = 'imp-menu-overlay-host'

function panel(): HTMLElement {
  const el = document.getElementById(HOST_ID)?.shadowRoot?.querySelector('.panel')
  if (!el) throw new Error('selection panel not shown')
  return el as HTMLElement
}

// The bubble anchors wherever the stub says; moving the fixture and firing a
// scroll stands in for the page moving under a real selection.
let rect: DOMRect | null = null

function visibleRect(): DOMRect {
  return new DOMRect(100, 300, 200, 40)
}

afterEach(() => {
  // Escape arms only after a macrotask, so removing the host directly is the
  // reliable teardown; it also drops every panel the next open would replace.
  document.getElementById(HOST_ID)?.remove()
  rect = null
})

describe('selection panel', () => {
  it('follows the selection and hides while it is out of view', () => {
    rect = visibleRect()
    showSelectionPanel({ translated: '你好', follow: true, getRect: () => rect })
    expect(panel().classList.contains('imp-hidden')).toBe(false)

    // Scrolled far below the viewport: the bubble disappears rather than
    // pinning to an edge.
    rect = new DOMRect(100, 5000, 200, 40)
    window.dispatchEvent(new Event('scroll'))
    expect(panel().classList.contains('imp-hidden')).toBe(true)

    // Scrolled back: it returns, re-anchored to the selection.
    rect = visibleRect()
    window.dispatchEvent(new Event('scroll'))
    expect(panel().classList.contains('imp-hidden')).toBe(false)
  })

  it('shows the bubble even when the selection sits off screen', () => {
    // Before the first anchor exists there is no relative spot to judge, so
    // the bubble parks neutrally instead of hiding.
    rect = new DOMRect(100, -300, 200, 40)
    showSelectionPanel({ translated: '你好', follow: true, getRect: () => rect })
    expect(panel().classList.contains('imp-hidden')).toBe(false)
    expect(panel().style.top).toBe('64px')
  })

  it('with follow off it stays put and never hides', () => {
    rect = visibleRect()
    showSelectionPanel({ translated: '你好', follow: false, getRect: () => rect })
    const before = panel().style.top
    expect(panel().classList.contains('imp-hidden')).toBe(false)

    rect = new DOMRect(100, 5000, 200, 40)
    window.dispatchEvent(new Event('scroll'))
    expect(panel().style.top).toBe(before)
    expect(panel().classList.contains('imp-hidden')).toBe(false)
  })

  it('re-anchors to the selection when it moves back into view', () => {
    rect = visibleRect()
    showSelectionPanel({ translated: '你好', follow: true, getRect: () => rect })
    const firstTop = parseFloat(panel().style.top)

    rect = new DOMRect(100, 100, 200, 40)
    window.dispatchEvent(new Event('scroll'))
    const secondTop = parseFloat(panel().style.top)
    expect(secondTop).not.toBe(firstTop)
    // Below the short selection, offset by the placement margin.
    expect(secondTop).toBeGreaterThan(rect.bottom)
  })

  it('tracks the selection rigidly instead of clamping at the boundary', () => {
    rect = new DOMRect(100, 300, 200, 40)
    showSelectionPanel({ translated: '你好', follow: true, getRect: () => rect })
    const firstTop = parseFloat(panel().style.top)
    expect(firstTop).toBe(348)

    // Scrolled so the anchored spot runs past the bottom edge: the bubble
    // keeps the exact relative position (partially clipped) rather than
    // pinning to the boundary.
    rect = new DOMRect(100, 640, 200, 40)
    window.dispatchEvent(new Event('scroll'))
    expect(panel().classList.contains('imp-hidden')).toBe(false)
    expect(parseFloat(panel().style.top)).toBe(firstTop + 340)
  })
})
