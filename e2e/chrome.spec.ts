import { test, expect } from './fixtures'
import { startTranslation, configureMockProvider } from './helpers'

test('top bar, nav, sidebar and footer get translated', async ({ context, baseURL }) => {
  const page = await context.newPage()
  await page.goto(baseURL)
  await page.waitForLoadState('domcontentloaded')
  await page.evaluate(() => {
    document.body.insertAdjacentHTML(
      'afterbegin',
      `
      <header id="top"><p>Top bar text</p></header>
      <nav id="nav"><a href="#">Menu item</a></nav>
      <aside id="side"><p>Sidebar text</p></aside>
      <footer id="foot"><p>Footer copyright</p></footer>
    `,
    )
  })

  await configureMockProvider(page, baseURL)
  await startTranslation(page)

  for (const id of ['top', 'nav', 'side', 'foot']) {
    await expect(
      page.locator(`#${id} .imp-translate-result:not(.imp-translate-loading)`).first(),
    ).toBeVisible({ timeout: 15000 })
  }
})
