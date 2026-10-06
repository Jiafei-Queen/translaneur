import { defineConfig, UserManifest } from 'wxt'
import tailwindcss from '@tailwindcss/vite'
import { PublicPath } from 'wxt/browser'

export default defineConfig({
  modules: ['@wxt-dev/module-react', '@extport/wxt'],
  extport: {
    safari: {
      appCategory: 'public.app-category.productivity',
      bundleIdentifier: 'com.jiafei.translaneur',
    },
    // No store registration and no analytics: the extension id inlined here
    // would have to be one issued to *this* project, and every ping is a
    // report to extport's operator. `developmentTeam` is likewise omitted
    // until there is an Apple team of our own to sign with.
    analytics: false,
  },
  vite: () => ({
    plugins: [tailwindcss()],
    resolve: {
      tsconfigPaths: true,
    },
  }),
  manifestVersion: 3,
  manifest: (env) => {
    // Shared Firefox/Thunderbird extension id (computed form in the original
    // firefox branch: lowercase name + '@jiafei.dev').
    const geckoId = 'translaneur@jiafei.dev'
    const manifest: UserManifest = {
      name: 'Translaneur',
      description:
        'Bilingual page translation shown below the original. AI translation with no API key, or bring your own provider.',
      permissions: ['storage', 'scripting', 'webNavigation', 'alarms'],
      host_permissions: ['<all_urls>'],
      author: {
        email: 'cxkctrl1303@hotmail.com',
      },
      action: {
        default_icon: {
          '16': 'icon/16.png',
          '32': 'icon/32.png',
          '48': 'icon/48.png',
          '96': 'icon/96.png',
          '128': 'icon/128.png',
        },
        default_popup: 'popup.html',
      },
      web_accessible_resources: [
        {
          resources: ['/inject.js'] as PublicPath[],
          matches: ['<all_urls>'],
        },
      ],
      homepage_url: 'https://github.com/Jiafei-Queen/translaneur',
      commands: {
        'toggle-translate': {
          suggested_key: {
            default: 'Alt+T',
          },
          description: 'Toggle page translation',
        },
        'retranslate-page': {
          suggested_key: {
            default: 'Alt+R',
          },
          description: 'Re-translate the page',
        },
      },
    }
    if (env.browser === 'firefox') {
      manifest.browser_specific_settings = {
        gecko: {
          id: geckoId,
        },
      }
      // https://developer.mozilla.org/en-US/docs/Mozilla/Add-ons/WebExtensions/manifest.json/author
      // @ts-expect-error
      manifest.author = 'Jiafei'
    }
    if (env.browser === 'thunderbird') {
      manifest.browser_specific_settings = {
        gecko: {
          id: geckoId,
          // ESR floor: scripting.messageDisplay is 128+, but 140 is the
          // current ESR the port docs target.
          strict_min_version: '140.0',
        },
      }
      // @ts-expect-error
      manifest.author = 'Jiafei'
      // Spike-verified (docs/thunderbird/spike.md): message display injection
      // needs messagesRead + scripting; messagesModify is not required.
      // webNavigation serves only content tabs and mail display is not a
      // navigation — drop it (minimal permissions for a future ATN listing);
      // background.ts feature-detects the namespace before listening.
      manifest.permissions = [
        ...(manifest.permissions ?? []).filter((p) => p !== 'webNavigation'),
        'messagesRead',
      ]
      // inject.js reaches message documents via registerScripts, which needs
      // no web_accessible_resources; the browser builds keep their existing
      // declaration.
      delete manifest.web_accessible_resources
      // Thunderbird-only toolbar keys: show the button in the mail space of
      // the unified toolbar and in stand-alone message windows.
      manifest.action = {
        ...manifest.action,
        allowed_spaces: ['mail'],
        default_windows: ['normal', 'messageDisplay'],
      } as typeof manifest.action
    }
    return manifest
  },
  hooks: {
    // WXT only knows the "firefox" name for Gecko manifests: for any other
    // browser it emits an MV3 `background.service_worker`, which Thunderbird
    // does not support (it needs the event-page `background.scripts` form).
    // The hook runs before stripKeys, so the rewrite sticks.
    'build:manifestGenerated': (_wxt, manifest) => {
      if (_wxt.config.browser !== 'thunderbird') return
      const worker = (manifest.background as { service_worker?: string })?.service_worker
      if (worker) manifest.background = { scripts: [worker] } as typeof manifest.background
    },
  },
  webExt: {
    disabled: true,
    chromiumProfile: '.tmp/chrome-profile',
    keepProfileChanges: true,
    chromiumArgs: ['--remote-debugging-port=9222'],
  },
})
