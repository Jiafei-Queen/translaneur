import { afterEach, describe, expect, it, vi } from 'vitest'
import { createEditMode, type EditEntry } from './edit-mode'
import { EDIT_ATTR, PROCESSED_ATTR, RESULT_CLASS } from './dom'
import { injectLoading, replaceWithTranslation } from './render'
import { renderSubjectBlock, clearSubjectBlock, SUBJECT_BLOCK_ATTR } from './mail-subject'
import { showEditBar } from './overlay'

function makeWrapper(source: string, text: string): HTMLElement {
  const block = document.createElement('p')
  block.setAttribute(PROCESSED_ATTR, 'true')
  block.setAttribute('data-imp-text', source)
  block.textContent = 'source'
  const wrapper = document.createElement('font')
  wrapper.className = RESULT_CLASS
  wrapper.textContent = text
  block.appendChild(wrapper)
  document.body.appendChild(block)
  return wrapper
}

function makeController(onSave: (entries: EditEntry[]) => void, onFinish = vi.fn()) {
  return createEditMode({
    resolveSource: (wrapper) =>
      wrapper.closest('[data-imp-text]')?.getAttribute('data-imp-text') ?? null,
    onSave,
    onFinish,
  })
}

afterEach(() => {
  document.body.innerHTML = ''
})

describe('edit mode', () => {
  it('makes existing translations editable and cleans up', () => {
    const wrapper = makeWrapper('Hello', '你好')
    const mode = makeController(vi.fn())
    mode.enter()
    expect(wrapper.getAttribute('contenteditable')).toBe('true')
    expect(wrapper.hasAttribute(EDIT_ATTR)).toBe(true)

    mode.dispose()
    expect(wrapper.hasAttribute(EDIT_ATTR)).toBe(false)
    expect(wrapper.hasAttribute('contenteditable')).toBe(false)
  })

  it('saves only the blocks the user changed', async () => {
    const onSave = vi.fn()
    const onFinish = vi.fn()
    const wrapper = makeWrapper('Hello', '你好')
    const mode = makeController(onSave, onFinish)
    mode.enter()
    wrapper.textContent = '你好啊'
    await mode.save()

    expect(onSave).toHaveBeenCalledWith([{ source: 'Hello', translated: '你好啊' }])
    expect(onFinish).toHaveBeenCalledWith('save')
  })

  it('saves no entries when nothing changed', async () => {
    const onSave = vi.fn()
    const mode = makeController(onSave)
    mode.enter()
    await mode.save()
    expect(onSave).toHaveBeenCalledWith([])
  })

  it('cancel restores the original translation', () => {
    const wrapper = makeWrapper('Hello', '你好')
    const mode = makeController(vi.fn())
    mode.enter()
    wrapper.textContent = '改了'
    mode.cancel()
    expect(wrapper.textContent).toBe('你好')
    expect(wrapper.hasAttribute(EDIT_ATTR)).toBe(false)
  })

  it('decorates a translation that lands after edit mode started', () => {
    const mode = makeController(vi.fn())
    mode.enter()

    const block = document.createElement('p')
    block.textContent = 'Hello world'
    document.body.appendChild(block)
    const blocks = [{ element: block, text: 'Hello world' }]
    injectLoading(blocks)
    replaceWithTranslation(blocks, ['你好世界'])

    const wrapper = block.querySelector<HTMLElement>(`.${RESULT_CLASS}`)
    expect(wrapper?.getAttribute('contenteditable')).toBe('true')
    expect(wrapper?.hasAttribute(EDIT_ATTR)).toBe(true)
    mode.dispose()
  })

  it('makes translations inside links and buttons editable too', () => {
    const link = document.createElement('a')
    link.href = 'https://example.com'
    const button = document.createElement('button')
    for (const host of [link, button]) {
      const block = document.createElement('span')
      block.setAttribute(PROCESSED_ATTR, 'true')
      block.setAttribute('data-imp-text', 'Hello')
      const wrapper = document.createElement('font')
      wrapper.className = RESULT_CLASS
      wrapper.textContent = '你好'
      block.appendChild(wrapper)
      host.appendChild(block)
      document.body.appendChild(host)
    }
    const mode = makeController(vi.fn())
    mode.enter()

    for (const host of [link, button]) {
      const wrapper = host.querySelector<HTMLElement>(`.${RESULT_CLASS}`)
      expect(wrapper?.getAttribute('contenteditable')).toBe('true')
      expect(wrapper?.hasAttribute(EDIT_ATTR)).toBe(true)
    }
    mode.dispose()
  })

  it('a click on an editable wrapper does not activate its control', () => {
    const link = document.createElement('a')
    link.href = 'https://example.com'
    const wrapper = makeWrapper('Hello', '你好')
    link.appendChild(wrapper)
    document.body.appendChild(link)

    const mode = makeController(vi.fn())
    mode.enter()

    // A bubbling listener stands in for the control's own click handling.
    let activated = false
    link.addEventListener('click', () => {
      activated = true
    })
    const click = new MouseEvent('click', { bubbles: true, cancelable: true })
    wrapper.dispatchEvent(click)

    expect(click.defaultPrevented).toBe(true)
    expect(activated).toBe(false)

    mode.dispose()

    // Back out of edit mode, the control works as before.
    const after = new MouseEvent('click', { bubbles: true, cancelable: true })
    wrapper.dispatchEvent(after)
    expect(after.defaultPrevented).toBe(false)
  })

  it('quiets the page while editing: controls inert, wrappers reachable', () => {
    const link = document.createElement('a')
    link.href = 'https://example.com'
    const wrapper = makeWrapper('Hello', '你好')
    link.appendChild(wrapper)
    const plain = document.createElement('a')
    plain.href = 'https://example.com'
    const animated = document.createElement('div')
    document.body.append(link, plain, animated)

    const keyframes = document.createElement('style')
    keyframes.textContent = '@keyframes imp-test-wiggle { to { transform: none } }'
    document.head.appendChild(keyframes)
    animated.style.animation = 'imp-test-wiggle 1s infinite'

    const mode = makeController(vi.fn())
    mode.enter()

    expect(document.documentElement.classList.contains('imp-editing')).toBe(true)
    // Controls stop responding to the pointer; the editable translation
    // inside one stays hit-testable and selectable.
    expect(getComputedStyle(link).pointerEvents).toBe('none')
    expect(getComputedStyle(plain).pointerEvents).toBe('none')
    expect(getComputedStyle(wrapper).pointerEvents).toBe('auto')
    expect(getComputedStyle(wrapper).userSelect).toBe('text')
    expect(getComputedStyle(animated).animationPlayState).toBe('paused')

    // Pointer events on the wrapper are swallowed (no handler on the control
    // fires) but not cancelled — the caret placement default must survive.
    let sawMouseDown = false
    link.addEventListener('mousedown', () => {
      sawMouseDown = true
    })
    const down = new MouseEvent('mousedown', { bubbles: true, cancelable: true })
    wrapper.dispatchEvent(down)
    expect(down.defaultPrevented).toBe(false)
    expect(sawMouseDown).toBe(false)

    // A control outside any editable wrapper is fully inert.
    const stray = new MouseEvent('click', { bubbles: true, cancelable: true })
    plain.dispatchEvent(stray)
    expect(stray.defaultPrevented).toBe(true)

    mode.dispose()
    expect(document.documentElement.classList.contains('imp-editing')).toBe(false)
    expect(
      [...document.head.querySelectorAll('style')].some((s) =>
        s.textContent?.includes('imp-editing'),
      ),
    ).toBe(false)
    expect(getComputedStyle(link).pointerEvents).toBe('auto')
    expect(getComputedStyle(animated).animationPlayState).toBe('running')
    keyframes.remove()
  })

  it('keeps its own Save/Cancel bar clickable while everything else is inert', async () => {
    const onSave = vi.fn()
    const mode = makeController(onSave)
    const wrapper = makeWrapper('Hello', '你好')
    mode.enter()
    wrapper.textContent = '改'

    // The bar is our own shadow UI; its primary button must survive the guard.
    const host = document.getElementById('imp-menu-overlay-host')!
    const save = host.shadowRoot!.querySelector<HTMLButtonElement>(
      'button.primary',
    )!
    save.click()
    await vi.waitFor(() => expect(onSave).toHaveBeenCalled())
    mode.dispose()
  })

  it('edits the Thunderbird subject quote block like body text', async () => {
    // renderSubjectBlock targets Thunderbird display documents, but the block
    // itself is ordinary DOM: here it prepends to the test document's body.
    renderSubjectBlock(document, 'Use Langfuse', '使用 Langfuse 评估', 'zh')
    const block = document.querySelector(`[${SUBJECT_BLOCK_ATTR}]`)!
    const wrapper = block.querySelector<HTMLElement>(`.${RESULT_CLASS}`)!

    const onSave = vi.fn()
    const mode = makeController(onSave)
    mode.enter()
    expect(wrapper.getAttribute('contenteditable')).toBe('true')

    wrapper.textContent = '用 Langfuse 评估它'
    await mode.save()
    expect(onSave).toHaveBeenCalledWith([
      { source: 'Use Langfuse', translated: '用 Langfuse 评估它' },
    ])
    mode.dispose()
    clearSubjectBlock(document)
  })
})
