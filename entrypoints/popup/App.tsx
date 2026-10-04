import { useState, useEffect } from 'react'
import {
  queryOptions,
  useQuery,
  useMutation,
  useQueryClient,
} from '@tanstack/react-query'
import { Button } from '@/components/ui/button'
import { messager } from '@/lib/message'
import { getSettings, saveSettings, type RenderMode } from '@/lib/storage'
import { LANGUAGES_SORTED } from '@/lib/languages'
import { isPdfUrl } from '@/lib/utils'
import { RotateCw, SettingsIcon } from 'lucide-react'
import { BrandIcon } from '@/components/ui/brand-icon'
import {
  SegmentedControl,
  type SegmentedOption,
} from '@/components/ui/segmented'

const DISPLAY_OPTIONS: readonly SegmentedOption<RenderMode>[] = [
  { value: 'bilingual', label: 'Bilingual', title: 'original + translation' },
  { value: 'translation-only', label: 'Translation only' },
]

type TabMeta = { id: number; isPdf: boolean }

// Defined once and reused by useQuery, fetchQuery and invalidateQueries, so a
// key shape or queryFn can't drift between the render path and the action path.
const settingsQuery = queryOptions({
  queryKey: ['settings'] as const,
  queryFn: getSettings,
})

// Exported so main.tsx's storage.onChanged listener can invalidate every
// tabState query (the ['tabState'] prefix) without duplicating the key shape.
export const TAB_STATE_QUERY_KEY = 'tabState' as const

export const tabStateQuery = (tab: TabMeta | null) =>
  queryOptions({
    queryKey: [TAB_STATE_QUERY_KEY, tab?.id] as const,
    // `enabled` only gates useQuery — fetchQuery runs the queryFn regardless,
    // so every fetchQuery call below sits behind a resolved, non-PDF tab.
    queryFn: () => messager.sendMessage('getTabState', { tabId: tab!.id }),
    enabled: tab !== null && !tab.isPdf,
  })

export function App() {
  const queryClient = useQueryClient()
  const [tabMeta, setTabMeta] = useState<TabMeta | null>(null)

  // Capture the active tab once when popup opens (it's tied to this tab)
  useEffect(() => {
    browser.tabs.query({ active: true, currentWindow: true }).then(([tab]) => {
      if (!tab?.id) return
      setTabMeta({ id: tab.id, isPdf: isPdfUrl(tab.url) })
    })
  }, [])

  // Settings — always fresh, no stale closure issues
  const { data: settings } = useQuery(settingsQuery)

  // Tab translation state — the query is disabled until tabMeta resolves
  const { data: tabLang } = useQuery(tabStateQuery(tabMeta))

  // `!= null`, not `!== null`: while the query is still in flight `data` is
  // undefined, and treating that as "translated" made the popup flash "Show
  // Original" — and render the Re-translate control — on a page that was never
  // translated. Only a language string means translated.
  const isTranslated = tabLang != null

  // Toggle translate / restore — reads latest state via queryClient, not closure
  const toggleMutation = useMutation({
    mutationFn: async () => {
      const tabId = tabMeta!.id
      const currentLang = await queryClient.fetchQuery(tabStateQuery(tabMeta))
      if (currentLang) {
        await messager.sendMessage('stopTab', { tabId })
      } else {
        const lang = (await queryClient.fetchQuery(settingsQuery)).targetLang
        await messager.sendMessage('startTab', { tabId, targetLang: lang })
      }
    },
    onSuccess: () => {
      if (tabMeta) {
        queryClient.invalidateQueries({ queryKey: tabStateQuery(tabMeta).queryKey })
      }
    },
  })

  // Language change — always reads fresh state before deciding what to do
  const langChangeMutation = useMutation({
    mutationFn: async (newLang: string) => {
      const updated = await saveSettings({ targetLang: newLang })
      if (tabMeta && !tabMeta.isPdf) {
        const currentLang = await queryClient.fetchQuery(tabStateQuery(tabMeta))
        if (currentLang) {
          await messager.sendMessage('stopTab', { tabId: tabMeta.id })
          await messager.sendMessage('startTab', { tabId: tabMeta.id, targetLang: newLang })
        }
      }
      return updated
    },
    onSuccess: (updated) => {
      queryClient.setQueryData(settingsQuery.queryKey, updated)
      if (tabMeta) {
        queryClient.invalidateQueries({ queryKey: tabStateQuery(tabMeta).queryKey })
      }
    },
  })

  // Display-mode change — same restart semantics as langChangeMutation:
  // persist, then re-translate an already-translated tab with the fresh
  // targetLang (never the closed-over one).
  const renderModeChangeMutation = useMutation({
    mutationFn: async (mode: RenderMode) => {
      const updated = await saveSettings({ renderMode: mode })
      if (tabMeta && !tabMeta.isPdf) {
        const currentLang = await queryClient.fetchQuery(tabStateQuery(tabMeta))
        if (currentLang) {
          const lang = (await queryClient.fetchQuery(settingsQuery)).targetLang
          await messager.sendMessage('stopTab', { tabId: tabMeta.id })
          await messager.sendMessage('startTab', { tabId: tabMeta.id, targetLang: lang })
        }
      }
      return updated
    },
    onSuccess: (updated) => {
      queryClient.setQueryData(settingsQuery.queryKey, updated)
      if (tabMeta) {
        queryClient.invalidateQueries({ queryKey: tabStateQuery(tabMeta).queryKey })
      }
    },
  })

  function openOptions() {
    browser.runtime.openOptionsPage()
  }

  // Forced re-translate: ask the provider again for every block on the page
  // instead of reading the cache. Only reachable while the tab is translated
  // (the button is hidden otherwise). Single message, not stop-then-start:
  // the content script restarts itself in place, so closing the popup midway
  // cannot leave the page restored and untranslated.
  const retranslateMutation = useMutation({
    mutationFn: async () => {
      const tabId = tabMeta!.id
      const lang = (await queryClient.fetchQuery(settingsQuery)).targetLang
      await messager.sendMessage('startTab', { tabId, targetLang: lang, force: true })
    },
    onSuccess: () => {
      if (tabMeta) {
        queryClient.invalidateQueries({ queryKey: tabStateQuery(tabMeta).queryKey })
      }
    },
  })

  if (!settings || !tabMeta) return null

  return (
    <div className="min-w-72 p-4 space-y-3">
      <div className="flex items-center justify-between">
        <h1 className="text-base font-semibold flex items-center gap-1.5">
          <BrandIcon className="w-5 h-5" />
          Translaneur
        </h1>
        <Button
          id="imp-settings"
          variant="ghost"
          size="icon"
          className="h-7 w-7"
          onClick={openOptions}
        >
          <SettingsIcon className="w-4 h-4" />
        </Button>
      </div>

      <div className="space-y-2">
        <label className="text-sm text-muted-foreground">Target Language</label>
        <select
          id="imp-lang"
          className="w-full rounded-md border border-input bg-background px-3 py-1.5 text-sm"
          value={settings.targetLang}
          onChange={(e) => langChangeMutation.mutate(e.target.value)}
        >
          {LANGUAGES_SORTED.map(([code, name]) => (
            <option key={code} value={code}>
              {name}
            </option>
          ))}
        </select>
      </div>

      <div className="space-y-2">
        <label className="text-sm text-muted-foreground">Display</label>
        <SegmentedControl
          id="imp-display"
          ariaLabel="Display"
          size="compact"
          value={settings.renderMode}
          onChange={(v) => renderModeChangeMutation.mutate(v)}
          options={DISPLAY_OPTIONS}
          disabled={renderModeChangeMutation.isPending}
        />
      </div>

      {tabMeta.isPdf ? (
        <p className="text-sm text-muted-foreground text-center py-1">
          PDF pages cannot be translated
        </p>
      ) : (
        <div className="space-y-2">
          <Button
            className="w-full"
            onClick={() => toggleMutation.mutate()}
            disabled={
              toggleMutation.isPending ||
              langChangeMutation.isPending ||
              renderModeChangeMutation.isPending
            }
          >
            {toggleMutation.isPending
              ? 'Translating...'
              : isTranslated
                ? 'Show Original'
                : 'Translate Page'}
          </Button>
          {isTranslated && (
            <Button
              variant="outline"
              className="w-full"
              onClick={() => retranslateMutation.mutate()}
              disabled={retranslateMutation.isPending || toggleMutation.isPending}
            >
              <RotateCw />
              {retranslateMutation.isPending ? 'Re-translating...' : 'Re-translate'}
            </Button>
          )}
        </div>
      )}
    </div>
  )
}
