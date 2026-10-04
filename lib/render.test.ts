import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  hideToastBar,
  injectLoading,
  replaceWithError,
  replaceWithTranslation,
  repositionTranslation,
  showToastBar,
  type ToastBarOptions,
} from './render'
import { clearTranslations, extractBlocks, getTranslatableRuns, markTranslated, type TranslatableBlock } from './dom'
import { buildMarkedSource, stripMarkers } from './align'

describe('render', () => {
  it('should inject inside innermost inline element', () => {
    document.body.innerHTML = `
      <ul>
        <li><b><a href="/wiki/test">Archive</a></b></li>
      </ul>
    `
    const li = document.querySelector('li')!
    const blocks: TranslatableBlock[] = [
      { element: li as HTMLElement, text: 'Archive' },
    ]
    injectLoading(blocks)
    replaceWithTranslation(blocks, ['档案'])

    const a = li.querySelector('a')!
    const font = a.querySelector('font.imp-translate-result')
    expect(font).not.toBeNull()
    expect(font!.textContent).toBe('档案')
  })

  it('should inject directly in block element when multiple children', () => {
    document.body.innerHTML = `<p>Hello <strong>world</strong></p>`
    const p = document.querySelector('p')!
    const blocks: TranslatableBlock[] = [
      { element: p as HTMLElement, text: 'Hello world' },
    ]
    injectLoading(blocks)
    replaceWithTranslation(blocks, ['你好世界'])

    const font = p.querySelector(':scope > font.imp-translate-result')
    expect(font).not.toBeNull()
    expect(font!.textContent).toBe('你好世界')
  })

  it('should use inline space for short text instead of br', () => {
    document.body.innerHTML = `<li><a href="#">Archive</a></li>`
    const li = document.querySelector('li')!
    const blocks: TranslatableBlock[] = [
      { element: li as HTMLElement, text: 'Archive' },
    ]
    injectLoading(blocks)
    replaceWithTranslation(blocks, ['档案'])

    const br = li.querySelector('br.imp-translate-br')
    expect(br).toBeNull()
  })

  it('should use br for long text', () => {
    document.body.innerHTML = `<p>This is a long paragraph that exceeds the short text threshold limit.</p>`
    const p = document.querySelector('p')!
    const blocks: TranslatableBlock[] = [
      { element: p as HTMLElement, text: 'This is a long paragraph that exceeds the short text threshold limit.' },
    ]
    injectLoading(blocks)
    replaceWithTranslation(blocks, ['这是一段很长的文本，超过了短文本的阈值限制。'])

    const br = p.querySelector('br.imp-translate-br')
    expect(br).not.toBeNull()
  })

  it('should skip br when last visible child is block-like (flex-column blockifies span)', () => {
    document.body.innerHTML = `<div id="t" style="display: flex; flex-direction: column;"><span>This is a long paragraph that exceeds the short text threshold limit.</span><span>aside</span></div>`
    const div = document.querySelector('#t') as HTMLElement
    const blocks: TranslatableBlock[] = [
      { element: div, text: 'This is a long paragraph that exceeds the short text threshold limit.' },
    ]
    injectLoading(blocks)
    replaceWithTranslation(blocks, ['这是一段很长的文本，超过了短文本的阈值限制。'])

    expect(div.querySelector('br.imp-translate-br')).toBeNull()
    const font = div.querySelector('font.imp-translate-result')
    expect(font?.textContent).toBe('这是一段很长的文本，超过了短文本的阈值限制。')
  })

  it('should skip br when last visible child is a block element (p inside block parent)', () => {
    document.body.innerHTML = `<div id="t">leading text <p>This is a long paragraph that exceeds the short text threshold limit.</p></div>`
    const div = document.querySelector('#t') as HTMLElement
    const blocks: TranslatableBlock[] = [
      { element: div, text: 'This is a long paragraph that exceeds the short text threshold limit.' },
    ]
    injectLoading(blocks)
    replaceWithTranslation(blocks, ['这是一段很长的文本，超过了短文本的阈值限制。'])

    expect(div.querySelector('br.imp-translate-br')).toBeNull()
  })

  it('should skip empty icon elements and inject into text-containing child', () => {
    document.body.innerHTML = `
      <div class="scrimba">
        <span class="play-button"><span class="play-icon"></span></span>
        <a href="#">Watch an interactive lesson</a>
      </div>
    `
    const div = document.querySelector('.scrimba')!
    const blocks: TranslatableBlock[] = [
      { element: div as HTMLElement, text: 'Watch an interactive lesson' },
    ]
    injectLoading(blocks)
    replaceWithTranslation(blocks, ['观看互动课程'])

    const a = div.querySelector('a')!
    const font = a.querySelector('font.imp-translate-result')
    expect(font).not.toBeNull()
    expect(font!.textContent).toBe('观看互动课程')
  })

  it('should drill through block elements to find text-containing child', () => {
    document.body.innerHTML = `
      <div class="channel">
        <a href="/channel/general">
          <div class="link-top">
            <div class="name">general</div>
          </div>
        </a>
      </div>
    `
    const div = document.querySelector('.channel')!
    const blocks: TranslatableBlock[] = [
      { element: div as HTMLElement, text: 'general' },
    ]
    injectLoading(blocks)
    replaceWithTranslation(blocks, ['概述'])

    const nameDiv = div.querySelector('.name')!
    const font = nameDiv.querySelector('font.imp-translate-result')
    expect(font).not.toBeNull()
    expect(font!.textContent).toBe('概述')
  })

  it('should clear line-clamp on injected elements', () => {
    document.body.innerHTML = `
      <div class="snippet" style="display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden;">
        This is a search result snippet that gets clamped to two lines.
      </div>
    `
    const div = document.querySelector('.snippet')! as HTMLElement
    const blocks: TranslatableBlock[] = [
      { element: div, text: 'This is a search result snippet that gets clamped to two lines.' },
    ]
    injectLoading(blocks)

    expect(div.style.webkitLineClamp).toBe('unset')
    expect(div.style.overflow).toBe('visible')
  })

  it('should remove translation when result matches original text (case-insensitive)', () => {
    document.body.innerHTML = `<p>src</p>`
    const p = document.querySelector('p')!
    const blocks: TranslatableBlock[] = [
      { element: p as HTMLElement, text: 'src' },
    ]
    injectLoading(blocks)
    replaceWithTranslation(blocks, ['SRC'])

    const font = p.querySelector('font.imp-translate-result')
    expect(font).toBeNull()
    expect(p.hasAttribute('data-imp-noop')).toBe(true)
  })

  it('should not mark data-imp-noop when translation differs from source', () => {
    document.body.innerHTML = `<p>hello</p>`
    const p = document.querySelector('p')!
    const blocks: TranslatableBlock[] = [
      { element: p as HTMLElement, text: 'hello' },
    ]
    injectLoading(blocks)
    replaceWithTranslation(blocks, ['你好'])

    expect(p.hasAttribute('data-imp-noop')).toBe(false)
  })

  it('should remove translation and separator when translation is empty', () => {
    document.body.innerHTML = `<p>Hello world</p>`
    const p = document.querySelector('p')!
    const blocks: TranslatableBlock[] = [
      { element: p as HTMLElement, text: 'Hello world' },
    ]
    injectLoading(blocks)
    replaceWithTranslation(blocks, [''])

    const font = p.querySelector('font.imp-translate-result')
    expect(font).toBeNull()
    const br = p.querySelector('br.imp-translate-br')
    expect(br).toBeNull()
  })

  // Twitter timeline: tweet initially has one <span> child, so findInjectionPoint
  // drills into it and the <font> ends up inside the span. When "Show more" later
  // appends a sibling div (e.g. an @mention link), the translation gets stuck
  // before the new sibling instead of after it. repositionTranslation must move
  // the wrapper to the parent so the original text comes first, translation last.
  // Example: https://x.com/MarioNawfal/status/2049040672083345418
  it('moves wrapper to block element when a new sibling is added after translation', () => {
    document.body.innerHTML = `
      <div id="block"><span id="text">This is a long sentence that triggers translation injection.</span></div>
    `
    const block = document.getElementById('block')! as HTMLElement
    const text = 'This is a long sentence that triggers translation injection.'

    injectLoading([{ element: block, text }])
    replaceWithTranslation([{ element: block, text }], ['翻译'])

    const fontBefore = block.querySelector('font.imp-translate-result')!
    expect(fontBefore.parentElement?.id).toBe('text')

    // Simulate "Show more" appending a sibling
    const sibling = document.createElement('div')
    sibling.id = 'mention'
    sibling.innerHTML = '<a href="#">@user</a>'
    block.appendChild(sibling)

    repositionTranslation(block, text + ' @user')

    const fontAfter = block.querySelector('font.imp-translate-result')!
    expect(fontAfter).toBe(fontBefore)
    expect(fontAfter.parentElement).toBe(block)
    // <font> must come after the new sibling. The previous element is the
    // mention div itself (block-displayed) — no <br> needed because the div
    // already pushes the translation onto a new line.
    expect(fontAfter.previousElementSibling?.id).toBe('mention')
    expect(block.querySelector('br.imp-translate-br')).toBeNull()
    // No leftover separator inside the original span
    expect(document.getElementById('text')!.querySelector('br.imp-translate-br')).toBeNull()
  })

  it('is a no-op when injection point has not changed', () => {
    document.body.innerHTML = `<p>Hello world this is long enough to trigger br separator.</p>`
    const p = document.querySelector('p')!
    const text = 'Hello world this is long enough to trigger br separator.'

    injectLoading([{ element: p as HTMLElement, text }])
    replaceWithTranslation([{ element: p as HTMLElement, text }], ['你好世界'])

    const fontBefore = p.querySelector('font.imp-translate-result')!
    const parentBefore = fontBefore.parentElement
    const brBefore = p.querySelector('br.imp-translate-br')!

    repositionTranslation(p as HTMLElement, text)

    const fontAfter = p.querySelector('font.imp-translate-result')!
    expect(fontAfter).toBe(fontBefore)
    expect(fontAfter.parentElement).toBe(parentBefore)
    // Did not create a duplicate separator
    expect(p.querySelectorAll('br.imp-translate-br')).toHaveLength(1)
    expect(p.querySelector('br.imp-translate-br')).toBe(brBefore)
  })

  it('clicking any retry button retries all currently-errored blocks globally', () => {
    document.body.innerHTML = `
      <p id="a">Hello world this is long enough to trigger br separator.</p>
      <p id="b">Goodbye world this is also long enough.</p>
      <p id="c">Foo bar baz qux this needs translating.</p>
    `
    const a = document.getElementById('a') as HTMLElement
    const b = document.getElementById('b') as HTMLElement
    const c = document.getElementById('c') as HTMLElement

    const blocks: TranslatableBlock[] = [
      { element: a, text: 'Hello world this is long enough to trigger br separator.' },
      { element: b, text: 'Goodbye world this is also long enough.' },
      { element: c, text: 'Foo bar baz qux this needs translating.' },
    ]
    for (const blk of blocks) {
      blk.element.setAttribute('data-imp-text', blk.text)
    }

    injectLoading(blocks)

    const onRetry = vi.fn()
    // simulate two separate failed flushes attaching errors at different times
    replaceWithError([blocks[0], blocks[1]], onRetry)
    replaceWithError([blocks[2]], onRetry)

    expect(document.querySelectorAll('.imp-translate-retry')).toHaveLength(3)
    expect(document.querySelectorAll('.imp-translate-error')).toHaveLength(3)

    const firstBtn = document.querySelector<HTMLButtonElement>('.imp-translate-retry')!
    firstBtn.click()

    expect(onRetry).toHaveBeenCalledOnce()
    const retried = onRetry.mock.calls[0][0] as TranslatableBlock[]
    expect(retried).toHaveLength(3)
    expect(retried.map((blk) => blk.text).sort()).toEqual([
      'Foo bar baz qux this needs translating.',
      'Goodbye world this is also long enough.',
      'Hello world this is long enough to trigger br separator.',
    ])

    expect(document.querySelectorAll('.imp-translate-error')).toHaveLength(0)
    expect(document.querySelectorAll('.imp-translate-retry')).toHaveLength(0)
    expect(document.querySelectorAll('.imp-translate-loading')).toHaveLength(3)
  })

  it('uses inline space separator when moved text is short', () => {
    document.body.innerHTML = `<div id="block"><span id="text">Hi</span></div>`
    const block = document.getElementById('block')! as HTMLElement

    injectLoading([{ element: block, text: 'Hi' }])
    replaceWithTranslation([{ element: block, text: 'Hi' }], ['你好'])

    // Initial injection used a space (short text)
    expect(block.querySelector('br.imp-translate-br')).toBeNull()

    const sibling = document.createElement('a')
    sibling.id = 'link'
    sibling.textContent = '@user'
    block.appendChild(sibling)

    repositionTranslation(block, 'Hi @user')

    const font = block.querySelector('font.imp-translate-result')!
    expect(font.parentElement).toBe(block)
    // Still short text → still uses a space, not a br. The separator is a
    // tagged span, not a bare text node, so that it is identifiable as ours.
    expect(block.querySelector('br.imp-translate-br')).toBeNull()
    expect(font.previousSibling?.textContent).toBe(' ')
    expect((font.previousSibling as Element).classList).toContain('imp-translate-spacer')
  })

  it('should inject translation before trailing image, not after it (short text)', () => {
    document.body.innerHTML = `<p>there we go<br><a href="#"><img src="test.png" width="368" height="188"></a></p>`
    const p = document.querySelector('p')!
    const blocks: TranslatableBlock[] = [
      { element: p as HTMLElement, text: 'there we go' },
    ]
    injectLoading(blocks)
    replaceWithTranslation(blocks, ['开始吧'])

    const font = p.querySelector('font.imp-translate-result')!
    expect(font).not.toBeNull()
    expect(font.textContent).toBe('开始吧')
    const a = p.querySelector('a')!
    const fontIndex = Array.from(p.childNodes).indexOf(font)
    const aIndex = Array.from(p.childNodes).indexOf(a)
    expect(fontIndex).toBeLessThan(aIndex)
  })

  it('should inject translation before trailing image (long text)', () => {
    document.body.innerHTML = `<p>This is a long paragraph that exceeds the short text threshold limit.<br><a href="#"><img src="test.png"></a></p>`
    const p = document.querySelector('p')!
    const blocks: TranslatableBlock[] = [
      { element: p as HTMLElement, text: 'This is a long paragraph that exceeds the short text threshold limit.' },
    ]
    injectLoading(blocks)
    replaceWithTranslation(blocks, ['这是一段很长的文本，超过了短文本的阈值限制。'])

    const font = p.querySelector('font.imp-translate-result')!
    expect(font).not.toBeNull()
    const a = p.querySelector('a')!
    const br = p.querySelector('br.imp-translate-br')!
    expect(br).not.toBeNull()
    const fontIndex = Array.from(p.childNodes).indexOf(font)
    const aIndex = Array.from(p.childNodes).indexOf(a)
    expect(fontIndex).toBeLessThan(aIndex)
  })

  it('should still append at end when no trailing non-text nodes', () => {
    document.body.innerHTML = `<p>Hello <strong>world</strong> and more</p>`
    const p = document.querySelector('p')!
    const blocks: TranslatableBlock[] = [
      { element: p as HTMLElement, text: 'Hello world and more' },
    ]
    injectLoading(blocks)
    replaceWithTranslation(blocks, ['你好世界还有更多'])

    const font = p.querySelector('font.imp-translate-result')!
    expect(font).toBe(p.lastElementChild)
  })

  it('injectLoading avoids layout thrashing with many blocks', () => {
    const style = document.createElement('style')
    style.textContent = `
      .perf-clamp {
        display: -webkit-box;
        -webkit-line-clamp: 2;
        -webkit-box-orient: vertical;
        overflow: hidden;
      }
    `
    document.head.appendChild(style)

    // Each block needs nested child elements so that findInjectionPoint
    // calls hasVisibleText → offsetWidth/offsetHeight, which are the
    // layout reads that cause thrashing when interleaved with DOM writes.
    // Deeply nested flex containers amplify reflow cost per read.
    const container = document.createElement('div')
    container.style.cssText = 'width:800px;position:absolute;top:0;left:0'
    const count = 2000
    for (let i = 0; i < count; i++) {
      const div = document.createElement('div')
      div.className = 'perf-clamp'
      div.style.cssText = 'display:flex;flex-direction:column;gap:4px'
      div.innerHTML = `
        <div style="display:flex;gap:8px">
          <span style="flex:1">This is a long paragraph that exceeds the short text threshold.</span>
          <span style="width:60px">Block ${i}.</span>
        </div>
        <div style="display:flex;gap:8px">
          <a href="#"><span>Link text here</span></a>
          <em>Secondary info</em>
        </div>
      `
      container.appendChild(div)
    }
    document.body.appendChild(container)

    const blocks: TranslatableBlock[] = Array.from(
      container.querySelectorAll('.perf-clamp'),
    ).map((el) => ({
      element: el as HTMLElement,
      text: el.textContent!,
    }))

    const start = performance.now()
    injectLoading(blocks)
    const elapsed = performance.now() - start

    style.remove()
    container.remove()

    const loadingEls = container.querySelectorAll('.imp-translate-loading')
    expect(loadingEls.length).toBe(count)
    // Interleaved read/write (regression): ~1000ms for 2000 blocks
    // Read/write split (correct): ~90ms for 2000 blocks
    // Threshold sits well above shared-CI-runner noise (saw 517ms on a slow
    // runner with the correct implementation) but below the regression.
    expect(elapsed).toBeLessThan(800)
  })

  it('should override overflow:hidden on element without line-clamp', () => {
    document.body.innerHTML = `
      <div id="msg" style="overflow: hidden;">
        This is a long paragraph that exceeds the short text threshold limit.
      </div>
    `
    const div = document.getElementById('msg')! as HTMLElement
    const blocks: TranslatableBlock[] = [
      { element: div, text: 'This is a long paragraph that exceeds the short text threshold limit.' },
    ]
    injectLoading(blocks)

    expect(div.style.overflow).toBe('visible')
  })

  it('should override clipping ancestor when child has line-clamp', () => {
    document.body.innerHTML = `
      <div id="parent" style="overflow: hidden; max-height: 20px;">
        <div id="child" style="display: -webkit-box; -webkit-line-clamp: 1; -webkit-box-orient: vertical; overflow: hidden;">
          This is a long paragraph that exceeds the short text threshold limit.
        </div>
      </div>
    `
    const child = document.getElementById('child')! as HTMLElement
    const parent = document.getElementById('parent')! as HTMLElement
    const blocks: TranslatableBlock[] = [
      { element: child, text: 'This is a long paragraph that exceeds the short text threshold limit.' },
    ]
    injectLoading(blocks)

    expect(child.style.overflow).toBe('visible')
    expect(parent.style.overflow).toBe('visible')
    expect(parent.style.maxHeight).toBe('none')
  })

  it('should not inject duplicate loadings when same element appears twice in batch', () => {
    document.body.innerHTML = `<p>Hello world</p>`
    const p = document.querySelector('p')! as HTMLElement
    const blocks: TranslatableBlock[] = [
      { element: p, text: 'Hello world' },
      { element: p, text: 'Hello world' },
    ]
    injectLoading(blocks)
    const loadings = p.querySelectorAll('.imp-translate-loading')
    expect(loadings).toHaveLength(1)
  })

  it('should not produce duplicate translations when parent and child are both extracted', () => {
    // Simulates: parent <span> and child <strong> both added in the same
    // mutation batch (e.g. Google search re-render), causing extractBlocks
    // to return both as separate blocks before markTranslated runs.
    document.body.innerHTML = `
      <div>
        <span class="desc"><strong>Enable Popup Persistence</strong>:</span>
      </div>
    `
    const span = document.querySelector('span.desc')! as HTMLElement
    const strong = span.querySelector('strong')! as HTMLElement

    const blocks: TranslatableBlock[] = [
      { element: span, text: 'Enable Popup Persistence:' },
      { element: strong, text: 'Enable Popup Persistence' },
    ]

    // translateBlocks marks all blocks before calling injectLoading
    for (const b of blocks) {
      markTranslated(b.element)
      b.element.setAttribute('data-imp-text', b.text)
    }

    injectLoading(blocks)

    // Only the parent should get a loading indicator, not the nested child
    const results = span.querySelectorAll('font.imp-translate-result')
    expect(results).toHaveLength(1)
    expect(results[0].parentElement).toBe(span)
  })

  it('injectLoading adopts styles only into the shadow root that receives a translation', () => {
    document.body.innerHTML = `
      <div id="host-a"></div>
      <div id="host-b"></div>
      <p id="light">Light DOM paragraph with enough text to be a block.</p>
    `
    const hostA = document.getElementById('host-a')!
    const hostB = document.getElementById('host-b')!
    const rootA = hostA.attachShadow({ mode: 'open' })
    const rootB = hostB.attachShadow({ mode: 'open' })
    rootA.innerHTML = '<p id="a">Shadow paragraph A with enough text to be a block.</p>'
    rootB.innerHTML = '<p id="b">Shadow paragraph B with enough text to be a block.</p>'

    const hasOurStyles = (root: ShadowRoot) =>
      root.adoptedStyleSheets.length > 0 || root.querySelector('#imp-translate-style') !== null

    // Only the root that gets a translation injected receives the styles.
    // (The eager per-shadow-root injection that used to live in the content
    // script's onShadowRoot callback is covered by e2e/content.spec.ts.)
    const pA = rootA.getElementById('a') as HTMLElement
    injectLoading([{ element: pA, text: pA.textContent!.trim() }])
    expect(hasOurStyles(rootA)).toBe(true)
    expect(hasOurStyles(rootB)).toBe(false)

    // Light-DOM injection never touches shadow roots.
    const light = document.getElementById('light') as HTMLElement
    injectLoading([{ element: light, text: light.textContent!.trim() }])
    expect(hasOurStyles(rootB)).toBe(false)
    expect(document.getElementById('imp-translate-style')).not.toBeNull()
  })
})

describe('toast bar', () => {
  afterEach(() => {
    document.getElementById('imp-translate-toast')?.remove()
    document.getElementById('imp-translate-toast-style')?.remove()
  })

  function baseOptions(overrides: Partial<ToastBarOptions> = {}): ToastBarOptions {
    return {
      currentLang: 'zh',
      translating: true,
      onRestore: vi.fn(),
      onTranslate: vi.fn(),
      onRetranslate: vi.fn(),
      onSettings: vi.fn(),
      onLangChange: vi.fn(),
      currentRenderMode: 'bilingual',
      onRenderModeChange: vi.fn(),
      ...overrides,
    }
  }

  it('shows "Show Original" and calls onRestore while translating', () => {
    const onRestore = vi.fn()
    const onTranslate = vi.fn()
    showToastBar(baseOptions({ translating: true, onRestore, onTranslate }))

    const btn = document.querySelector<HTMLButtonElement>('.imp-toast-restore')!
    expect(btn.textContent).toBe('Show Original')
    btn.click()
    expect(onRestore).toHaveBeenCalledOnce()
    expect(onTranslate).not.toHaveBeenCalled()
  })

  // The mobile toolbar icon now stops translation before re-opening the
  // panel (see openPanelForActiveTab in entrypoints/background.ts). The
  // restored panel must still offer a way back in ("Translate") and
  // keep the settings/language controls — it must not just be a bare
  // "translation was restored" notice.
  it('shows "Translate" and calls onTranslate once restored', () => {
    const onRestore = vi.fn()
    const onTranslate = vi.fn()
    showToastBar(baseOptions({ translating: false, onRestore, onTranslate }))

    const btn = document.querySelector<HTMLButtonElement>('.imp-toast-restore')!
    expect(btn.textContent).toBe('Translate')
    btn.click()
    expect(onTranslate).toHaveBeenCalledOnce()
    expect(onRestore).not.toHaveBeenCalled()
  })

  it('offers re-translate only while translating', () => {
    const onRetranslate = vi.fn()
    showToastBar(baseOptions({ translating: true, onRetranslate }))

    const btn = document.querySelector<HTMLButtonElement>('.imp-toast-retranslate')!
    expect(btn.title).toBe('Re-translate')
    btn.click()
    expect(onRetranslate).toHaveBeenCalledOnce()

    // Restored: nothing is on screen to refresh, so the control is gone
    // rather than present-and-inert.
    showToastBar(baseOptions({ translating: false, onRetranslate }))
    expect(document.querySelector('.imp-toast-retranslate')).toBeNull()
  })

  it('keeps the language select and settings button in the restored state', () => {
    showToastBar(baseOptions({ translating: false, currentLang: 'ja' }))

    const select = document.querySelector<HTMLSelectElement>('.imp-toast-lang')!
    expect(select.value).toBe('ja')
    expect(document.querySelector('.imp-toast-settings')).not.toBeNull()
  })

  // showToastBar is re-invoked whenever the panel's mode may have changed
  // (translating → restored, or vice versa). It must rebuild in place rather
  // than no-op on an already-mounted bar, or the stale button/handler from
  // the previous mode would stick around.
  it('rebuilds in place when called again with a different mode', () => {
    showToastBar(baseOptions({ translating: true }))
    expect(document.querySelectorAll('#imp-translate-toast')).toHaveLength(1)
    expect(document.querySelector('.imp-toast-restore')!.textContent).toBe('Show Original')

    showToastBar(baseOptions({ translating: false }))
    expect(document.querySelectorAll('#imp-translate-toast')).toHaveLength(1)
    expect(document.querySelector('.imp-toast-restore')!.textContent).toBe('Translate')
  })

  it('rebuilds in place even mid dismiss-animation (no stale bar left behind)', () => {
    showToastBar(baseOptions({ translating: true }))
    hideToastBar()
    // The exit animation is async (fires on `animationend`), so right after
    // calling hideToastBar the old bar is still in the DOM, mid-animation.
    expect(document.getElementById('imp-translate-toast')).not.toBeNull()

    showToastBar(baseOptions({ translating: false }))
    expect(document.querySelectorAll('#imp-translate-toast')).toHaveLength(1)
    expect(document.querySelector('.imp-toast-restore')!.textContent).toBe('Translate')
  })
})

describe('translation-only rendering', () => {
  function runsFixture() {
    document.body.innerHTML = '<p>Click <a href="/x">here</a> now</p>'
    const p = document.querySelector('p') as HTMLElement
    const text = buildMarkedSource(['Click ', 'here', ' now'])
    return { p, blocks: [{ element: p, text }] as TranslatableBlock[] }
  }

  it('swaps translated pieces into the text nodes in place', () => {
    const { p, blocks } = runsFixture()
    replaceWithTranslation(blocks, ['⟦1⟧点击⟦2⟧这里⟦3⟧立刻'], { renderMode: 'translation-only' })
    const a = p.querySelector('a')!
    expect(a.textContent).toBe('这里')
    expect(a.getAttribute('href')).toBe('/x')
    expect(p.textContent).toBe('点击这里立刻')
    // Element tree untouched: no wrapper nodes of any kind.
    expect(p.querySelector('font')).toBeNull()
    // Token is the post-write marked source (flushRecheck symmetry).
    expect(p.getAttribute('data-imp-text')).toBe('⟦1⟧点击⟦2⟧这里⟦3⟧立刻')
  })

  it('falls back to proportional splitting without markers, losing no text', () => {
    // No descendant elements: the run boundaries are invisible, so a cut at a
    // proportional offset is harmless.
    document.body.innerHTML = '<p>abc</p>'
    const p = document.querySelector('p') as HTMLElement
    p.append(document.createTextNode('def'))
    const blocks = [{ element: p, text: buildMarkedSource(['abc', 'def']) }] as TranslatableBlock[]
    replaceWithTranslation(blocks, ['一二三四五六'], { renderMode: 'translation-only' })
    expect(p.textContent).toBe('一二三四五六')
    expect(p.querySelector('font')).toBeNull()
  })

  it('keeps the source when alignment fails inside a block with inline elements', () => {
    // Proportional offsets cut the link's own text in half ("免"|"费百"). The
    // source stays and the token is left as the pipeline seeded it, so recheck
    // sees an unchanged block instead of retrying forever.
    const { p, blocks } = runsFixture()
    p.setAttribute('data-imp-text', blocks[0]!.text)
    replaceWithTranslation(blocks, ['一二三四五六'], { renderMode: 'translation-only' })
    const a = p.querySelector('a')!
    expect(p.textContent).toBe('Click here now')
    expect(a.textContent).toBe('here')
    expect(a.getAttribute('href')).toBe('/x')
    expect(p.querySelector('font')).toBeNull()
    expect(p.getAttribute('data-imp-text')).toBe(blocks[0]!.text)
  })

  it('aligns by marker id when the provider returns markup markers', () => {
    const { p, blocks } = runsFixture()
    replaceWithTranslation(
      blocks,
      ['<x id="1"></x>点击<x id="2"></x>这里<x id="3"></x>立刻'],
      { renderMode: 'translation-only' },
    )
    const a = p.querySelector('a')!
    expect(a.textContent).toBe('这里')
    expect(a.getAttribute('href')).toBe('/x')
    expect(p.textContent).toBe('点击这里立刻')
  })

  it('skips stale blocks whose DOM changed under the request', () => {
    const { p, blocks } = runsFixture()
    ;(p.firstChild as Text).data = 'Moved '
    replaceWithTranslation(blocks, ['⟦1⟧点击⟦2⟧这里⟦3⟧立刻'], { renderMode: 'translation-only' })
    expect(p.textContent).toBe('Moved here now')
  })

  it('shows a loading ring without treating the spacer as page text', () => {
    // Short block: injectLoading injects a spacer to separate the ring from
    // the source. The spacer is a layout artefact, so it must never enter the
    // run list — otherwise the staleness gate rejects the write, the ring never
    // clears, and the translation is dropped.
    document.body.innerHTML = '<p>Hi</p>'
    const p = document.querySelector('p') as HTMLElement
    const text = buildMarkedSource(['Hi'])
    const blocks = [{ element: p, text }] as TranslatableBlock[]

    injectLoading(blocks)
    expect(p.querySelector('font.imp-translate-result.imp-translate-loading')).not.toBeNull()
    // The source stays readable behind the ring.
    expect(p.textContent).toContain('Hi')
    expect(getTranslatableRuns(p).map((r) => r.data)).toEqual(['Hi'])

    replaceWithTranslation(blocks, ['你好'], { renderMode: 'translation-only' })
    expect(p.textContent).toBe('你好')
    expect(p.querySelector('font')).toBeNull()
  })

  it('shows a loading ring on a long block without losing the translation', () => {
    // Past SHORT_TEXT_THRESHOLD the <br> branch runs instead of the spacer;
    // this guards the spacer change against regressing it.
    const long = 'A'.repeat(60)
    document.body.innerHTML = `<p>${long}</p>`
    const p = document.querySelector('p') as HTMLElement
    const blocks = [{ element: p, text: buildMarkedSource([long]) }] as TranslatableBlock[]

    injectLoading(blocks)
    expect(p.querySelector('font.imp-translate-result.imp-translate-loading')).not.toBeNull()

    replaceWithTranslation(blocks, ['长'.repeat(60)], { renderMode: 'translation-only' })
    expect(p.textContent).toBe('长'.repeat(60))
    expect(p.querySelector('font')).toBeNull()
  })

  it('clears the ring when the translation comes back empty', () => {
    // `!translated` early-continues before the wrapper removal; the ring would
    // otherwise spin forever.
    document.body.innerHTML = '<p>Hi</p>'
    const p = document.querySelector('p') as HTMLElement
    const blocks = [{ element: p, text: buildMarkedSource(['Hi']) }] as TranslatableBlock[]
    injectLoading(blocks)

    replaceWithTranslation(blocks, [''], { renderMode: 'translation-only' })
    expect(p.querySelector('.imp-translate-loading')).toBeNull()
    expect(p.textContent).toContain('Hi')
  })

  it('clears the ring when alignment fails inside a block with inline elements', () => {
    // The `!exact && element.querySelector('*')` skip keeps the source; the
    // ring must still be torn down.
    const { p, blocks } = runsFixture()
    p.setAttribute('data-imp-text', blocks[0]!.text)
    injectLoading(blocks)
    expect(p.querySelector('.imp-translate-loading')).not.toBeNull()

    replaceWithTranslation(blocks, ['一二三四五六'], { renderMode: 'translation-only' })
    expect(p.querySelector('.imp-translate-loading')).toBeNull()
    expect(p.textContent).toContain('Click here now')
  })

  it('leaves the block exactly as it was when translations are cleared', () => {
    // Stopping mid-flight removes the ring and its spacer; nothing may survive
    // as stray page text.
    document.body.innerHTML = '<p>Hi</p>'
    const p = document.querySelector('p') as HTMLElement
    const childCount = p.childNodes.length
    injectLoading([{ element: p, text: buildMarkedSource(['Hi']) }] as TranslatableBlock[])

    clearTranslations(document.body)
    expect(p.textContent).toBe('Hi')
    expect(p.childNodes.length).toBe(childCount)
  })

  it('keeps the source and inserts an error chip with retry on failure', () => {
    const { p, blocks } = runsFixture()
    p.setAttribute('data-imp-text', blocks[0]!.text)
    const onRetry = vi.fn()
    replaceWithError(blocks, onRetry, { renderMode: 'translation-only' })
    const chip = p.querySelector('font.imp-translate-error') as HTMLElement
    expect(chip).not.toBeNull()
    expect(chip.textContent).toBe('⟳ Retry')
    expect(p.textContent).toContain('Click here now')
    chip.querySelector('button')!.click()
    expect(chip.className).toContain('imp-translate-loading')
    expect(onRetry).toHaveBeenCalledTimes(1)
    expect(onRetry.mock.calls[0]![0]).toHaveLength(1)
  })
})

// Every block is sent marked so both display modes derive one cache key (see
// lib/align.ts). These cover the bilingual side of that bargain: the markers
// must not reach the page, and the noop check must still recognise a provider
// that echoed the source back.
describe('bilingual rendering with a marked payload', () => {
  function linkFixture() {
    document.body.innerHTML = '<p>Click <a href="/x">here</a> now</p>'
    const p = document.querySelector('p') as HTMLElement
    return { p, blocks: extractBlocks(document.body) as TranslatableBlock[] }
  }

  it('writes the joined runs, with no marker left in the DOM', () => {
    const { p, blocks } = linkFixture()
    expect(blocks[0]!.text).toBe('⟦1⟧Click ⟦2⟧here⟦3⟧ now')
    injectLoading(blocks)
    replaceWithTranslation(blocks, ['⟦1⟧点击⟦2⟧这里⟦3⟧立刻'])

    const wrapper = p.querySelector('font.imp-translate-result')!
    expect(wrapper.textContent).toBe('点击这里立刻')
    expect(p.textContent).not.toMatch(/[⟦⟧]/)
  })

  // Markers carry run ids, so a plain strip would leave the response in the
  // order the provider returned it. The exact split path is what undoes a
  // reorder, and bilingual has to use it just as translation-only does.
  it('rejoins reordered pieces in run order', () => {
    const { p, blocks } = linkFixture()
    injectLoading(blocks)
    replaceWithTranslation(blocks, ['⟦3⟧立刻⟦1⟧点击⟦2⟧这里'])

    const wrapper = p.querySelector('font.imp-translate-result')!
    expect(wrapper.textContent).toBe('点击这里立刻')
  })

  // The noop comparison used to be against `block.text`, which is now marked,
  // so it would never match and an echoed source would be written out with its
  // markers showing. It has to compare the marker-free text.
  it('treats a verbatim echo of a marked block as a no-op', () => {
    const { p, blocks } = linkFixture()
    injectLoading(blocks)
    replaceWithTranslation(blocks, ['⟦1⟧Click ⟦2⟧here⟦3⟧ now'])

    expect(p.querySelector('font.imp-translate-result')).toBeNull()
    expect(p.hasAttribute('data-imp-noop')).toBe(true)
  })

  it('still treats a verbatim echo of a single-run block as a no-op', () => {
    document.body.innerHTML = '<p>Hello world</p>'
    const p = document.querySelector('p') as HTMLElement
    const blocks = extractBlocks(document.body) as TranslatableBlock[]
    injectLoading(blocks)
    replaceWithTranslation(blocks, ['Hello world'])

    expect(p.querySelector('font.imp-translate-result')).toBeNull()
    expect(p.hasAttribute('data-imp-noop')).toBe(true)
  })

  // A page may legitimately write ⟦1⟧ itself, and single-run blocks keep their
  // text verbatim now. Re-parsing the marked string would read that as a marker
  // and split a one-run response into two bogus pieces.
  it('does not treat a page-authored bracket as a marker', () => {
    document.body.innerHTML = '<p>The interval is denoted ⟦1⟧ here.</p>'
    const p = document.querySelector('p') as HTMLElement
    const blocks = extractBlocks(document.body) as TranslatableBlock[]
    expect(blocks[0]!.text).toBe('The interval is denoted ⟦1⟧ here.')
    injectLoading(blocks)
    replaceWithTranslation(blocks, ['这里用 ⟦1⟧ 表示区间。'])

    const wrapper = p.querySelector('font.imp-translate-result')!
    expect(wrapper.textContent).toBe('这里用 ⟦1⟧ 表示区间。')
  })

  // Layout, not billing: the markers are an artefact of the request and must not
  // push a block onto its own line. The fixture straddles the threshold — 39
  // visible chars across two runs, 45 marked — so a length check on the raw
  // payload would take the `<br>` branch and break the line.
  it('keeps a marked block under the short-text threshold inline', () => {
    document.body.innerHTML = '<p><b>Short</b> block that stays inline here.</p>'
    const p = document.querySelector('p') as HTMLElement
    const blocks = extractBlocks(document.body) as TranslatableBlock[]
    expect(stripMarkers(blocks[0]!.text).length).toBeLessThanOrEqual(40)
    expect(blocks[0]!.text.length).toBeGreaterThan(40)

    injectLoading(blocks)
    expect(p.querySelector('br.imp-translate-br')).toBeNull()
    expect(p.querySelector('.imp-translate-spacer')).not.toBeNull()
  })
})
