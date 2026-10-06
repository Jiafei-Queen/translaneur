import type { TranslatableBlock } from './dom'

function sig(el: Element): string {
  const cls = typeof el.className === 'string' ? el.className.trim() : ''
  const id = el.id ? `#${el.id}` : ''
  const c = cls ? `.${cls.split(/\s+/).join('.')}` : ''
  return `${el.tagName.toLowerCase()}${id}${c}`
}

function path(el: Element): string {
  const chain: string[] = []
  for (let n: Element | null = el; n && n.tagName.toLowerCase() !== 'body'; n = n.parentElement) {
    chain.unshift(sig(n))
  }
  return chain.join(' > ')
}

/**
 * One-shot, read-only description of what the extractor saw on a document.
 * Built to diagnose surfaces that yield zero blocks — above all Thunderbird's
 * mail shapes, where the body hides in a wrapper the walker skips. Never
 * mutates the DOM; safe to call after extractBlocks has already run.
 */
export function describeExtraction(root: Element, blocks: TranslatableBlock[]): string {
  const lines: string[] = []
  const has = (sel: string) => document.querySelector(sel) !== null

  lines.push(`href=${location.href}`)
  lines.push(`contentType=${document.contentType}`)
  lines.push(`readyState=${document.readyState}`)
  lines.push(
    `tb[plain=${has('.moz-text-plain')} html=${has('.moz-text-html')} ` +
      `flowed=${has('.moz-text-flowed')} quotePre=${has('pre.moz-quote-pre')} ` +
      `pre=${document.querySelectorAll('pre').length} ` +
      `blockquote=${document.querySelectorAll('blockquote[type=cite]').length}]`,
  )
  lines.push(`blocks=${blocks.length}`)
  blocks.slice(0, 10).forEach((b, i) => {
    lines.push(`  #${i} <${sig(b.element)}> len=${b.text.length} ${JSON.stringify(b.text.slice(0, 60))}`)
  })

  lines.push('pre elements:')
  document.querySelectorAll('pre').forEach((p) => {
    lines.push(
      `  <${sig(p)}> ws=${getComputedStyle(p).whiteSpace} len=${(p.textContent ?? '').length} ` +
        `path=${path(p)}`,
    )
  })

  // Where the text physically lives: elements that hold direct text, with the
  // computed white-space and box size a skip decision hinges on. A wrapper the
  // walker pruned shows up here even when the block list is empty.
  const holders: string[] = []
  const walk = (el: Element, depth: number) => {
    if (depth > 8 || holders.length > 40) return
    let direct = ''
    for (const n of el.childNodes) {
      if (n.nodeType === Node.TEXT_NODE) direct += n.textContent ?? ''
    }
    const text = direct.trim()
    if (text.length >= 16) {
      const cs = getComputedStyle(el)
      const r = el.getBoundingClientRect()
      holders.push(
        `  <${sig(el)}> ws=${cs.whiteSpace} ${Math.round(r.width)}x${Math.round(r.height)} ` +
          `len=${text.length} ${JSON.stringify(text.slice(0, 40))} path=${path(el)}`,
      )
    }
    for (const c of el.children) walk(c, depth + 1)
  }
  walk(root, 0)
  lines.push('text-holders:')
  lines.push(...holders)

  return lines.join('\n')
}
