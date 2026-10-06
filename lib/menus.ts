// Context-menu access, normalised across browsers.
//
// Gecko (Firefox, Thunderbird) exposes `menus`; Chromium and Safari expose
// `contextMenus`. Thunderbird deliberately has **no** `contextMenus` alias
// (webextension-api.thunderbird.net/en/mv3/menus.html), and Chromium has no
// `menus`, so the two names are mutually exclusive per platform and the call
// site must feature-detect rather than branch on a build target. The manifest
// permission follows the same split: `menus` for Gecko, `contextMenus`
// elsewhere (see wxt.config.ts).

export interface MenuClickInfo {
  menuItemId: string | number
  selectionText?: string
}

export interface MenuTargetTab {
  id?: number
  type?: string
  url?: string
}

export interface CreateMenuProps {
  id?: string
  title?: string
  contexts?: string[]
}

export interface MenusApi {
  create(props: CreateMenuProps): unknown
  onClicked: {
    addListener(listener: (info: MenuClickInfo, tab?: MenuTargetTab) => void): void
  }
}

export function menusApi(): MenusApi | undefined {
  const b = browser as unknown as { menus?: MenusApi; contextMenus?: MenusApi }
  const api = b.menus ?? b.contextMenus
  return api && typeof api.create === 'function' && api.onClicked ? api : undefined
}

export const MENU_TRANSLATE_PAGE = 'imp-translate-page'
export const MENU_TRANSLATE_SELECTION = 'imp-translate-selection'
export const MENU_EDIT_TRANSLATION = 'imp-translate-edit'
