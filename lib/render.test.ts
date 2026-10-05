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
import { buildBlockSource, clearTranslations, extractBlocks, getTranslatableRuns, markTranslated, type TranslatableBlock } from './dom'
import { buildMarkedSource, stripMarkers } from './align'

describe('render', () => {
  // Whether a translation is actually on screen. A clipped node keeps a
  // non-zero box, so geometry alone cannot tell visible from cut off —
  // hit-testing the bottom of the settled text can. The loading ring is
  // excluded because it sits inside the source box and would pass either way.
  const translationIsPainted = (container: HTMLElement): boolean => {
    const result = container.querySelector('.imp-translate-result:not(.imp-translate-loading)')
    if (!result) return false
    const range = document.createRange()
    range.selectNodeContents(result)
    const box = range.getBoundingClientRect()
    if (box.height === 0 || box.width === 0) return false
    const hit = document.elementFromPoint(box.left + box.width / 2, box.bottom - 1)
    return hit === result || result.contains(hit)
  }

  // Reaches the settled state, which is the one a clip can hide.
  const injectAndSettle = (block: TranslatableBlock) => {
    injectLoading([block])
    replaceWithTranslation([block], ['翻译文本'])
  }

  // A stylesheet a test appends is only removed by its own last statement, so
  // a failing assertion leaves it live for every test after it — a rule on
  // `html` would clip the page out from under unrelated geometry checks.
  const addedStyles: HTMLStyleElement[] = []
  afterEach(() => {
    for (const el of addedStyles) el.remove()
    addedStyles.length = 0
  })
  const addStyle = (css: string): void => {
    const el = document.createElement('style')
    el.textContent = css
    document.head.appendChild(el)
    addedStyles.push(el)
  }

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

  it('writes an attribute-hint translation into the placeholder in both modes', () => {
    document.body.innerHTML = `<input placeholder="Search the docs">`
    const input = document.querySelector('input')!
    const blocks: TranslatableBlock[] = [
      {
        element: input as HTMLElement,
        text: 'Search the docs',
        attribute: 'placeholder',
      },
    ]
    for (const renderMode of ['bilingual', 'translation-only'] as const) {
      input.setAttribute('placeholder', 'Search the docs')
      replaceWithTranslation(blocks, ['搜索文档'], { renderMode })

      expect(input.getAttribute('placeholder')).toBe('搜索文档')
      // The token follows the attribute, so flushRecheck sees no drift.
      expect(input.getAttribute('data-imp-text')).toBe('搜索文档')
      // No ring: a form control renders its value, not its children.
      expect(input.querySelector('font')).toBeNull()
      expect(input.hasAttribute('data-imp-noop')).toBe(false)
    }
  })

  it('keeps the page hint and marks a no-op when a placeholder translation echoes it', () => {
    document.body.innerHTML = `<input placeholder="Search the docs">`
    const input = document.querySelector('input')!
    const blocks: TranslatableBlock[] = [
      {
        element: input as HTMLElement,
        text: 'Search the docs',
        attribute: 'placeholder',
      },
    ]
    replaceWithTranslation(blocks, ['search the docs'])

    expect(input.getAttribute('placeholder')).toBe('Search the docs')
    expect(input.hasAttribute('data-imp-noop')).toBe(true)
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

  it('should override a constraining clip on element without line-clamp', () => {
    // The max-height is what makes this clip worth lifting: a clip on a box
    // that already fits its content only hides things the page parked there.
    document.body.innerHTML = `
      <div id="msg" style="overflow: hidden; max-height: 20px;">
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

  // spring.io's `.button.is-spring` shape: a hover fill in a ::before parked at
  // translateX(-101%), hidden by the button's own clip. Lifting that clip
  // rendered the fill as a stray block; the button grows to fit the
  // translation, so its clip was never in the way.
  it('keeps a clip that is not constraining content, so a parked ::before stays hidden', () => {
    addStyle(`.spring-clip {
      display: inline-block; overflow: hidden; padding: 15px 30px; position: relative;
      white-space: nowrap; box-sizing: content-box; height: auto;
    }
    .spring-clip:before {
      content: ''; position: absolute; left: 0; right: 0; top: 0; bottom: 0;
      background: #191e1e; transform: translateX(-101%); z-index: -1;
    }`)
    document.body.innerHTML = `<p><a href="/sub" class="spring-clip" id="btn">Subscribe</a></p>`
    const btn = document.getElementById('btn')! as HTMLElement
    injectLoading([{ element: btn, text: 'Subscribe' }])

    expect(btn.style.overflow).toBe('')
    expect(btn.hasAttribute('data-imp-style-orig')).toBe(false)
  })

  it('lifts a fixed-height clip that would cut the translation off', () => {
    // A box with a written height cannot grow when the translation is
    // appended, so the clip must go or the translation is truncated. The
    // narrow width is what makes the text wrap past that height.
    document.body.innerHTML = `
      <div id="fixed" style="overflow: hidden; height: 40px; width: 150px;">
        A reasonably long sentence that will certainly exceed the available width of this clipped box.
      </div>
    `
    const div = document.getElementById('fixed')! as HTMLElement
    injectAndSettle({ element: div, text: div.textContent ?? '' })

    expect(div.style.overflow).toBe('visible')
    expect(translationIsPainted(div)).toBe(true)
  })

  it('lifts a fixed-height clip whose content still fits', () => {
    // The case a bare "does the content already overflow" check misses: the
    // box is height-pinned, so its content fits today, but the translation
    // appended below lands outside the box and is clipped away entirely.
    document.body.innerHTML = `
      <div id="pinned" style="overflow: hidden; height: 40px; width: 400px;">
        Short text here.
      </div>
    `
    const div = document.getElementById('pinned')! as HTMLElement
    injectAndSettle({ element: div, text: 'Short text here.' })

    expect(div.style.overflow).toBe('visible')
    expect(translationIsPainted(div)).toBe(true)
  })

  it('clearTranslations restores a clip that came from a stylesheet', () => {
    addStyle('#sourced { overflow: hidden; height: 20px; }')
    document.body.innerHTML = `
      <div id="parent" style="overflow: hidden; max-height: 20px;">
        <div id="sourced" style="width: 150px;">This is a long paragraph that exceeds the short text threshold limit.</div>
      </div>
    `
    const div = document.getElementById('sourced')! as HTMLElement
    const parent = document.getElementById('parent')! as HTMLElement
    const blocks: TranslatableBlock[] = [
      { element: div, text: 'This is a long paragraph that exceeds the short text threshold limit.' },
    ]
    injectLoading(blocks)
    expect(getComputedStyle(div).overflow).toBe('visible')
    expect(getComputedStyle(parent).maxHeight).toBe('none')

    clearTranslations(document.body)

    expect(div.style.overflow).toBe('')
    expect(div.hasAttribute('data-imp-style-orig')).toBe(false)
    expect(getComputedStyle(div).overflow).toBe('hidden')
    // The parent's max-height was inline, so the restore puts the original
    // declaration back rather than dropping it.
    expect(parent.style.maxHeight).toBe('20px')
    expect(parent.style.overflow).toBe('hidden')
    expect(parent.hasAttribute('data-imp-style-orig')).toBe(false)
  })

  it('clearTranslations restores an inline overflow-y longhand', () => {
    // `overflow` is written as a shorthand, so lifting it sets both
    // longhands. A page that declared only `overflow-y: hidden` inline has
    // that as its original, and reading the shorthand back would not find it.
    document.body.innerHTML = `
      <div id="longhand" style="overflow-y: hidden; max-height: 30px; width: 400px;">
        <div style="width: 300px;">This is a long paragraph that exceeds the short text threshold limit.</div>
      </div>
    `
    const div = document.getElementById('longhand')! as HTMLElement
    injectLoading([{ element: div, text: div.textContent ?? '' }])
    expect(getComputedStyle(div).overflowY).toBe('visible')

    clearTranslations(document.body)

    expect(div.style.overflowY).toBe('hidden')
    expect(getComputedStyle(div).overflowY).toBe('hidden')
    expect(div.hasAttribute('data-imp-style-orig')).toBe(false)
  })

  it('leaves a non-constraining clipping ancestor alone', () => {
    // The ancestor clips, but it has room for what it holds — same shape as
    // the spring.io button, one level up. The inner box is height-pinned, so
    // the walk is entered and does lift it; the ancestor must be rejected by
    // the same predicate rather than swept up with it.
    document.body.innerHTML = `
      <div id="ancestor" style="overflow: hidden; padding: 4px;">
        <div id="inner" style="overflow: hidden; max-height: 20px;">
          This is a long paragraph that exceeds the short text threshold limit.
        </div>
      </div>
    `
    const ancestor = document.getElementById('ancestor')! as HTMLElement
    const inner = document.getElementById('inner')! as HTMLElement
    injectLoading([{ element: inner, text: inner.textContent ?? '' }])

    // The inner lift happened, so the loop really ran.
    expect(inner.style.overflow).toBe('visible')
    // Still the page's own inline `hidden` — a lift would read 'visible'.
    expect(ancestor.style.overflow).toBe('hidden')
    expect(ancestor.hasAttribute('data-imp-style-orig')).toBe(false)
  })

  it('never unclips <html>, whose lift would outlive a stop', () => {
    // clearTranslations runs on document.body, so a write to <html> sits
    // outside every cleanup scope: the document scroller would stay unclipped
    // after the user turned translation off, until reload. <html> with
    // overflow:hidden plus a tall document satisfies clipActuallyConstrains,
    // so the ancestor walk would otherwise reach and lift it.
    addStyle(
      'html { overflow: hidden; } html, body { margin: 0; padding: 0; } ' +
        '#tall { height: 4000px; } #host { overflow: hidden; max-height: 20px; }',
    )
    document.body.innerHTML = `
      <div id="tall"></div>
      <div id="host">This is a long paragraph that exceeds the short text threshold limit.</div>
    `
    const html = document.documentElement
    const host = document.getElementById('host')! as HTMLElement
    injectLoading([{ element: host, text: host.textContent ?? '' }])

    expect(host.style.overflow).toBe('visible')
    expect(html.style.overflow).toBe('')

    clearTranslations(document.body)
    expect(getComputedStyle(html).overflow).toBe('hidden')
    expect(getComputedStyle(host).overflow).toBe('hidden')
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

  it('clearTranslations restores an inline line-clamp', () => {
    // A clamp is not gated on clipActuallyConstrains — it is content overflow
    // by definition — but its override is written like any other, so it has
    // to come back with the rest. A page clamped to 2 lines would otherwise
    // stay unclamped after translation stopped.
    document.body.innerHTML = `
      <div id="clamped" style="display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden;">
        This is a long paragraph that exceeds the short text threshold limit
        and wraps over more than two lines of text in a narrow column.
      </div>
    `
    const div = document.getElementById('clamped')! as HTMLElement
    injectLoading([{ element: div, text: div.textContent ?? '' }])
    expect(div.style.webkitLineClamp).toBe('unset')

    clearTranslations(document.body)

    expect(div.style.webkitLineClamp).toBe('2')
    expect(div.style.overflow).toBe('hidden')
    expect(div.hasAttribute('data-imp-style-orig')).toBe(false)
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

  it('writes a wrapped markup response into the runs', () => {
    const { p, blocks } = runsFixture()
    replaceWithTranslation(
      blocks,
      ['<i id="1">点击</i><i id="2">这里</i><i id="3">立刻</i>'],
      { renderMode: 'translation-only' },
    )
    const a = p.querySelector('a')!
    expect(a.textContent).toBe('这里')
    expect(a.getAttribute('href')).toBe('/x')
    expect(p.textContent).toBe('点击这里立刻')
  })

  it('writes reordered runs in output order, drifting the inline boundary', () => {
    // The provider put run 3 ahead of run 2, which is the target language's word
    // order and therefore the correct sentence — so the pieces are written in
    // that order instead of refused. The runs are fixed slots, so the link now
    // carries its neighbour's words; its href is untouched, and this drift is
    // the accepted cost of output-order write-back.
    const { p, blocks } = runsFixture()
    replaceWithTranslation(
      blocks,
      ['<i id="1">点击</i><i id="3">立刻</i><i id="2">这里</i>'],
      { renderMode: 'translation-only' },
    )
    const a = p.querySelector('a')!
    expect(a.textContent).toBe('立刻')
    expect(a.getAttribute('href')).toBe('/x')
    expect(p.textContent).toBe('点击立刻这里')
    expect(p.querySelector('.imp-translate-loading')).toBeNull()
    // Token matches what the pipeline recomputes from the mutated DOM, so
    // recheck does not see a stale block.
    expect(p.getAttribute('data-imp-text')).toBe(buildBlockSource(p))
  })

  it('leaves a passthrough run untouched on the page', () => {
    // The whitespace between the two <b>s was sent untagged — it has no words of
    // its own — so no piece is written into it, and the space it supplies is
    // what separates the two runs on the page even though the provider's
    // response dropped it.
    document.body.innerHTML = '<p>这是 <b>第一</b> <b>部分</b></p>'
    const p = document.querySelector('p') as HTMLElement
    const blocks = [
      { element: p, text: buildMarkedSource(['这是 ', '第一', ' ', '部分']) },
    ] as TranslatableBlock[]

    injectLoading(blocks)
    replaceWithTranslation(
      blocks,
      ['<i id="1">This is </i><i id="2">the first</i><i id="4">part</i>'],
      { renderMode: 'translation-only' },
    )

    expect(Array.from(p.querySelectorAll('b')).map((b) => b.textContent)).toEqual([
      'the first',
      'part',
    ])
    expect(
      Array.from(p.childNodes)
        .filter((n): n is Text => n.nodeType === Node.TEXT_NODE)
        .map((n) => n.data),
    ).toEqual(['This is ', ' '])
    expect(p.textContent).toBe('This is the first part')
  })

  it('writes a comment-separated block in provider output order', () => {
    // No descendant element, so the alignment guard does not apply either way —
    // the two runs are separate text nodes and the pieces land in the order the
    // provider wrote them.
    document.body.innerHTML = '<p>abc<!-- split -->def</p>'
    const p = document.querySelector('p') as HTMLElement
    const blocks = [{ element: p, text: buildMarkedSource(['abc', 'def']) }] as TranslatableBlock[]
    replaceWithTranslation(blocks, ['⟦2⟧乙⟦1⟧甲'], { renderMode: 'translation-only' })
    expect(p.textContent).toBe('乙甲')
    expect(p.getAttribute('data-imp-text')).toBe(buildBlockSource(p))
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
    const a = p.querySelector('a')!
    expect(a.textContent).toBe('here')
    expect(a.getAttribute('href')).toBe('/x')
    // Untouched, so recheck sees an unchanged block rather than retrying.
    expect(p.getAttribute('data-imp-text')).toBe(blocks[0]!.text)
  })

  it('preserves block-edge whitespace while trimming it from the payload', () => {
    // GitHub markdown and Wikipedia markup put indentation and newlines at a
    // block's edges. They must not be sent to the provider — they would be
    // "translated" — but they must survive the swap, or the page reflows.
    document.body.innerHTML = '<p>\n  Click <a href="/x">here</a> now\n</p>'
    const p = document.querySelector('p') as HTMLElement
    const blocks = [
      { element: p, text: buildMarkedSource(['Click ', 'here', ' now']) },
    ] as TranslatableBlock[]

    injectLoading(blocks)
    replaceWithTranslation(blocks, ['⟦1⟧点击⟦2⟧这里⟦3⟧立刻'], { renderMode: 'translation-only' })

    expect(p.querySelector('a')!.textContent).toBe('这里')
    expect(p.querySelector('a')!.getAttribute('href')).toBe('/x')
    expect(
      Array.from(p.childNodes)
        .filter((n): n is Text => n.nodeType === Node.TEXT_NODE)
        .map((n) => n.data),
    ).toEqual(['\n  点击', '立刻\n'])
    expect(p.querySelector('.imp-translate-loading')).toBeNull()
  })

  it('writes pieces into the surviving runs, not the raw run list', () => {
    // A whitespace-only leading run is dropped from the payload, leaving 2
    // runs where getTranslatableRuns reports 3. Indexing the raw list would
    // hand the link the trailing piece and leave the tail untranslated.
    document.body.innerHTML = '<p> <a href="/x">text</a> more</p>'
    const p = document.querySelector('p') as HTMLElement
    const blocks = [
      { element: p, text: buildMarkedSource(['text', ' more']) },
    ] as TranslatableBlock[]

    replaceWithTranslation(blocks, ['⟦1⟧文本⟦2⟧ 更多'], { renderMode: 'translation-only' })

    expect((p.firstChild as Text).data).toBe(' ')
    expect(p.querySelector('a')!.textContent).toBe('文本')
    expect((p.lastChild as Text).data).toBe(' 更多')
  })

  it('aligns a multi-link block whose separator runs are whitespace-only', () => {
    // The Wikipedia "Recently featured" shape: adjacent links, an indented head,
    // and whitespace-only runs between and after them. Separators carry no
    // words, so they are untagged and their ids are missing from the response —
    // hence the links' sparse ids rather than a renumbering.
    document.body.innerHTML =
      '<p>\n  Recently featured: <a href="/a">"Blindfold Me"</a> <a href="/b">Kaiser-class battleship</a> <a href="/c">Independence Day (Nigeria)</a>\n</p>'
    const p = document.querySelector('p') as HTMLElement
    const blocks = [
      {
        element: p,
        text: buildMarkedSource([
          'Recently featured: ',
          '"Blindfold Me"',
          ' ',
          'Kaiser-class battleship',
          ' ',
          'Independence Day (Nigeria)',
        ]),
      },
    ] as TranslatableBlock[]

    injectLoading(blocks)
    replaceWithTranslation(
      blocks,
      ['⟦1⟧最近精选：⟦2⟧“盲目” ⟦4⟧皇帝级战列舰 ⟦6⟧尼日利亚独立日'],
      { renderMode: 'translation-only' },
    )

    const links = Array.from(p.querySelectorAll('a'))
    expect(links.map((a) => a.textContent)).toEqual(['“盲目” ', '皇帝级战列舰 ', '尼日利亚独立日'])
    expect(links.map((a) => a.getAttribute('href'))).toEqual(['/a', '/b', '/c'])
    // The head is re-attached on write; the two separators and the trailing
    // newline were never tagged, so they are untouched.
    expect(
      Array.from(p.childNodes)
        .filter((n): n is Text => n.nodeType === Node.TEXT_NODE)
        .map((n) => n.data),
    ).toEqual(['\n  最近精选：', ' ', ' ', '\n'])
    expect(p.querySelector('.imp-translate-loading')).toBeNull()
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

  // The response carries the target language's word order, so the block shows
  // the provider's own sentence: `plain` is the response with its markers
  // removed, in that order, with nothing dropped.
  it('shows the response text in the provider output order', () => {
    const { p, blocks } = linkFixture()
    injectLoading(blocks)
    replaceWithTranslation(blocks, ['⟦3⟧立刻⟦1⟧点击⟦2⟧这里'])

    const wrapper = p.querySelector('font.imp-translate-result')!
    expect(wrapper.textContent).toBe('立刻点击这里')
  })

  it('keeps the text of a run with no words of its own', () => {
    // Bilingual shows one string for the whole block, so nothing may be
    // dropped — including the piece for a digits-only run, which is content.
    document.body.innerHTML = '<p>Total: <b>123</b> items</p>'
    const p = document.querySelector('p') as HTMLElement
    const blocks = extractBlocks(document.body) as TranslatableBlock[]
    injectLoading(blocks)
    replaceWithTranslation(blocks, ['⟦1⟧总计：⟦2⟧123⟦3⟧ 项'])

    const wrapper = p.querySelector('font.imp-translate-result')!
    expect(wrapper.textContent).toBe('总计：123 项')
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
