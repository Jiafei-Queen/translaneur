import { test, expect } from './fixtures'
import type { Page } from '@playwright/test'
import { getCommands, stubBrowserShortcut, stubBrowserUpdate } from './helpers'

const TOGGLE = 'toggle-translate'
const RETRANSLATE = 'retranslate-page'

const field = (page: Page, command: string) =>
  page.locator(`[data-hotkey-command="${command}"]`)

// A command the manifest does not declare is never fired, and one without a
// suggested_key seeds no binding: both failures are silent, and both leave the
// options page showing a shortcut that nothing can trigger.
//
// The keypress itself cannot be exercised from here: extension commands are
// handled by the browser's accelerator table, and a CDP-injected key event goes
// straight to the renderer, so it never reaches the command handler. What is
// checkable is everything the handler depends on — that both commands exist
// with a binding — and the forced pass it invokes, which force-retranslate.spec.ts
// covers through the popup and which reaches the same startTranslationForTab.
test('manifest declares both commands with their default bindings', async ({
  context,
}) => {
  const commands = await getCommands(context)
  // Known issue: macOS reports shortcuts in symbol form ('⌥T'), so this
  // assertion matches on Linux CI only.
  expect(commands).toEqual(
    expect.arrayContaining([
      { name: TOGGLE, shortcut: 'Alt+T' },
      { name: RETRANSLATE, shortcut: 'Alt+R' },
    ]),
  )
})

test('options page shows the default re-translate shortcut', async ({
  context,
  extensionId,
}) => {
  const page = await context.newPage()
  await page.goto(`chrome-extension://${extensionId}/options.html`)

  await expect(page.locator('#retranslate-hotkey')).toContainText('Alt + R')
  await expect(page.locator('#retranslate-hotkey')).not.toContainText('Not set')
})

// Each field reads its own command's binding. Seeding no binding for one is the
// only way to tell the reads apart: were both fields fed the same command, the
// re-translate field would read "Not set" too.
test('one command without a binding leaves the other field alone', async ({
  context,
  extensionId,
}) => {
  await stubBrowserShortcut(context, '', TOGGLE)

  const page = await context.newPage()
  await page.goto(`chrome-extension://${extensionId}/options.html`)

  await expect(page.locator('#hotkey')).toContainText('Not set')
  await expect(page.locator('#retranslate-hotkey')).toContainText('Alt + R')
})

// The recorder's whole job: capture the keys, store them against the right
// command, and ask the browser to bind that same command. Chrome refuses all
// three, so stubbing update() in is what drives the Firefox path.
test('recording the re-translate shortcut leaves the toggle one alone', async ({
  context,
  extensionId,
}) => {
  const updates = await stubBrowserUpdate(context)
  const page = await context.newPage()
  await page.goto(`chrome-extension://${extensionId}/options.html`)

  await expect(page.locator('#hotkey')).toContainText('Alt + T')
  const retranslate = page.locator('#retranslate-hotkey')
  await expect(retranslate).toContainText('Alt + R')
  await expect(retranslate).toBeEnabled()

  await retranslate.click()
  await expect(retranslate).toContainText('Press keys')
  await page.keyboard.press('Alt+K')

  await expect(retranslate).toContainText('Alt + K')
  await expect(page.locator('#hotkey')).toContainText('Alt + T')
  // The command name is the half that fails silently: a shortcut bound to the
  // wrong command records fine and does nothing.
  expect(await updates()).toEqual([{ name: RETRANSLATE, shortcut: 'Alt+K' }])

  // Reloading reads storage rather than the page's own state, so this is what
  // proves the recorded value was persisted under retranslateHotkey.
  await page.reload()
  await expect(page.locator('#retranslate-hotkey')).toContainText('Alt + K')
  await expect(page.locator('#hotkey')).toContainText('Alt + T')
})

test('clearing a shortcut clears only its own command', async ({
  context,
  extensionId,
}) => {
  const updates = await stubBrowserUpdate(context)
  const page = await context.newPage()
  await page.goto(`chrome-extension://${extensionId}/options.html`)

  await field(page, RETRANSLATE).getByRole('button', { name: 'Clear' }).click()

  await expect(page.locator('#retranslate-hotkey')).toContainText('Not set')
  await expect(page.locator('#hotkey')).toContainText('Alt + T')
  expect(await updates()).toEqual([{ name: RETRANSLATE, shortcut: '' }])
})
