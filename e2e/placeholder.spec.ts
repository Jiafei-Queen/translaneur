import { test, expect } from './fixtures'
import {
  startTranslation,
  stopTranslation,
  configureMockProvider,
} from './helpers'

test('translates input placeholders and restores them on stop', async ({ context, baseURL }) => {
  const page = await context.newPage()
  await page.goto(baseURL)
  await page.waitForLoadState('domcontentloaded')
  await page.evaluate(() => {
    document.body.insertAdjacentHTML(
      'afterbegin',
      `
      <form>
        <input id="search" placeholder="Search the docs">
        <textarea id="composer" placeholder="Ask a question"></textarea>
      </form>
    `,
    )
  })

  await configureMockProvider(page, baseURL)
  await startTranslation(page)

  await expect(page.locator('#search')).toHaveAttribute('placeholder', /\[翻译\]/, {
    timeout: 15000,
  })
  await expect(page.locator('#composer')).toHaveAttribute('placeholder', /\[翻译\]/, {
    timeout: 15000,
  })

  await stopTranslation(page)
  await expect(page.locator('#search')).toHaveAttribute('placeholder', 'Search the docs')
  await expect(page.locator('#composer')).toHaveAttribute('placeholder', 'Ask a question')
})

test('picks up a placeholder set after translation starts', async ({ context, baseURL }) => {
  const page = await context.newPage()
  await page.goto(baseURL)
  await page.waitForLoadState('domcontentloaded')
  await page.evaluate(() => {
    // Exists before the walk with no hint: only an attribute mutation can
    // bring it to the extractor's attention.
    const input = document.createElement('input')
    input.id = 'late-hint'
    document.body.appendChild(input)
  })

  await configureMockProvider(page, baseURL)
  await startTranslation(page)
  await expect(page.locator('.imp-translate-result:not(.imp-translate-loading)').first()).toBeVisible({
    timeout: 15000,
  })

  await page.evaluate(() => {
    document.getElementById('late-hint')!.placeholder = 'Subscribe to the newsletter'
  })

  await expect(page.locator('#late-hint')).toHaveAttribute('placeholder', /\[翻译\]/, {
    timeout: 15000,
  })
})
