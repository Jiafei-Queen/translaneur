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
          id:
            manifest.name!.toLowerCase().replaceAll(/[^a-z0-9]/g, '-') +
            '@jiafei.dev',
        },
      }
      // https://developer.mozilla.org/en-US/docs/Mozilla/Add-ons/WebExtensions/manifest.json/author
      // @ts-expect-error
      manifest.author = 'Jiafei'
    }
    return manifest
  },
  webExt: {
    disabled: true,
    chromiumProfile: '.tmp/chrome-profile',
    keepProfileChanges: true,
    chromiumArgs: ['--remote-debugging-port=9222'],
  },
})
