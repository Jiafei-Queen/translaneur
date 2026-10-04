import { useState, useEffect, type ReactNode } from 'react'
import { ChevronDownIcon } from 'lucide-react'
import { cn } from '@/lib/utils'
import {
  getSettings,
  saveSettings,
  type RenderMode,
  type Settings,
  type TranslationProvider,
} from '@/lib/storage'
import { chatCompletionsUrl, translate } from '@/lib/translator'
import { messager } from '@/lib/message'
import { IMP_CONNECT_URL } from '@/lib/imp'
import {
  RETRANSLATE_COMMAND,
  TOGGLE_COMMAND,
  hotkeyFromEvent,
} from '@/lib/hotkey'
import { HotkeyField, type HotkeyCapability } from './HotkeyField'
import { browser } from 'wxt/browser'
import {
  parseExtraBodyParams,
  parseNonNegativeInt,
} from '@/lib/openai-params'
import { parseGlossary } from '@/lib/glossary'
import {
  SegmentedControl,
  type SegmentedOption,
} from '@/components/ui/segmented'
import { LANGUAGES_SORTED } from '@/lib/languages'
import { Input } from '@/components/ui/input'
import { Textarea } from '@/components/ui/textarea'
import { Checkbox } from '@/components/ui/checkbox'
import { Button } from '@/components/ui/button'
import { RadioGroup, RadioGroupItem } from '@/components/ui/radio-group'
import { Label } from '@/components/ui/label'
import { BrandIcon } from '@/components/ui/brand-icon'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from '@/components/ui/collapsible'
import { DEFAULT_SYSTEM_PROMPT } from '@/lib/prompt'

function humanizeOpenAIError(raw: string): string {
  if (raw.includes('401')) return 'Invalid API key.'
  if (raw.includes('403')) return 'Forbidden — check your API key permissions.'
  if (raw.includes('429')) return 'Rate limited — try again in a moment.'
  if (raw.includes('404'))
    return 'Model or URL not found — verify the base URL and model name.'
  if (raw.includes('400'))
    return `Bad request — likely the model is not supported by this provider, or required fields are missing. Some newer models (e.g. gpt-5 family) only work via OpenAI's Responses API, which this extension doesn't support. Raw: ${raw}`
  if (raw.match(/\b5\d\d\b/)) return 'Provider error — try again later.'
  if (raw.toLowerCase().includes('failed to fetch'))
    return 'Cannot reach the server — check the base URL and your network.'
  return raw
}

const PROVIDERS: {
  value: TranslationProvider
  label: string
  description: string
}[] = [
  {
    value: 'google',
    label: 'Google Translate',
    description: 'Free, no API key required',
  },
  {
    value: 'microsoft',
    label: 'Microsoft Translator',
    description: 'Free, no API key required',
  },
  {
    value: 'imp',
    label: 'Imp Credits',
    description: 'Hosted, metered translation — connect your Imp account',
  },
  {
    value: 'openai',
    label: 'OpenAI Compatible',
    description: 'Requires API key',
  },
]

const DISPLAY_OPTIONS: readonly SegmentedOption<RenderMode>[] = [
  { value: 'bilingual', label: 'Bilingual', title: 'original + translation' },
  { value: 'translation-only', label: 'Translation only' },
]

/**
 * A settings field collapsed until asked for, with a one-line summary of what
 * it holds so the value is readable without opening it.
 */
function CollapsibleField({
  label,
  summary,
  summaryClassName,
  open,
  onOpenChange,
  children,
}: {
  label: string
  summary: ReactNode
  /** Overrides the muted default, for a summary that reports a problem. */
  summaryClassName?: string
  open: boolean
  onOpenChange: (open: boolean) => void
  children: ReactNode
}) {
  return (
    <Collapsible open={open} onOpenChange={onOpenChange}>
      <CollapsibleTrigger asChild>
        <Button
          variant="ghost"
          className="group h-auto w-full justify-between px-1 py-1.5"
        >
          <span className="flex min-w-0 flex-col items-start gap-1">
            <span className="text-sm leading-none font-medium">{label}</span>
            <span
              className={cn(
                'max-w-full truncate text-xs font-normal text-muted-foreground',
                summaryClassName,
              )}
            >
              {summary}
            </span>
          </span>
          <ChevronDownIcon className="size-4 shrink-0 transition-transform group-data-[state=closed]:-rotate-90" />
        </Button>
      </CollapsibleTrigger>
      <CollapsibleContent className="space-y-1.5">{children}</CollapsibleContent>
    </Collapsible>
  )
}

// Every command the shortcuts section records. The binding reads run over it,
// so a field added to the section is wired here too.
const HOTKEY_COMMANDS = [TOGGLE_COMMAND, RETRANSLATE_COMMAND]

type SettingsSection = 'general' | 'provider'

const SECTION_OPTIONS: readonly SegmentedOption<SettingsSection>[] = [
  { value: 'general', label: 'General' },
  { value: 'provider', label: 'Provider' },
]

export function App() {
  const [settings, setSettings] = useState<Settings | null>(null)
  const [section, setSection] = useState<SettingsSection>('general')
  // null means "show what is stored"; a string means the user is mid-edit.
  const [extraBodyDraft, setExtraBodyDraft] = useState<string | null>(null)
  // View-only, like the section switcher: not persisted.
  const [promptOpen, setPromptOpen] = useState(false)
  const [extraBodyOpen, setExtraBodyOpen] = useState(false)
  const [testing, setTesting] = useState(false)
  const [testResult, setTestResult] = useState<{
    ok: boolean
    msg: string
  } | null>(null)
  const [refreshingRules, setRefreshingRules] = useState(false)
  // The command being recorded, or null. A command name rather than a boolean
  // because there are two recorders and only one may capture keys at a time.
  const [recording, setRecording] = useState<string | null>(null)
  const [recordingHint, setRecordingHint] = useState<string | null>(null)
  const [hotkeyStates, setHotkeyStates] = useState<
    Record<string, { active: string; canApply: boolean }>
  >({})
  // Tri-state on purpose. A plain boolean starting at `false` would paint an
  // enabled recorder until getHotkeyState answers, and a click landing in
  // that window starts recording on a browser that cannot bind anything —
  // leaving a disabled button stuck on "Press keys…". Unknown stays disabled.
  // 'error' is separate from 'read-only' so the note can admit the query
  // failed instead of blaming Chrome for it.
  const [hotkeyCapability, setHotkeyCapability] = useState<HotkeyCapability>(
    'unknown',
  )
  const [refreshResult, setRefreshResult] = useState<{
    ok: boolean
    msg: string
  } | null>(null)

  const [connStatus, setConnStatus] = useState<
    'idle' | 'checking' | 'connected' | 'disconnected' | 'unknown'
  >('idle')
  const impConnected =
    settings?.provider === 'imp' && !!settings?.imp?.apiKey

  useEffect(() => {
    getSettings().then(setSettings)

    // The connect flow finishes in a DIFFERENT tab and writes `settings`
    // directly to storage, so this page has to pick that up via
    // storage.onChanged rather than only reading on mount.
    const listener = (
      changes: Record<string, { newValue?: unknown }>,
      areaName: string,
    ) => {
      if (areaName !== 'local' || !changes.settings) return
      getSettings().then(setSettings)
    }
    browser.storage.onChanged.addListener(listener)
    return () => browser.storage.onChanged.removeListener(listener)
  }, [])

  // The browser's real binding is not ours: it lives in browser prefs and
  // changes at chrome://extensions/shortcuts, which no storage event this page
  // can observe. Re-read on mount and on every return to the tab, since that is
  // how a Chrome user changes it. canApply also decides whether this page may
  // record a shortcut at all.
  function refreshHotkeyState() {
    Promise.all(
      HOTKEY_COMMANDS.map(async (command) => {
        const state = await messager.sendMessage('getHotkeyState', { command })
        return [command, state] as const
      }),
    )
      .then((entries) => {
        setHotkeyStates(Object.fromEntries(entries))
        // canApply is a property of the browser, not of a command, so any
        // answer decides for both fields.
        setHotkeyCapability(entries[0][1].canApply ? 'apply' : 'read-only')
      })
      // Stay disabled on failure: a shortcut we could not verify is not one
      // we should offer to change, and the note below says which it was.
      .catch(() => setHotkeyCapability('error'))
  }

  useEffect(() => {
    refreshHotkeyState()

    // visibilitychange also fires while hidden; re-reading then would be a
    // round-trip for a page nobody is looking at.
    const onVisible = () => {
      if (document.visibilityState === 'visible') refreshHotkeyState()
    }
    document.addEventListener('visibilitychange', onVisible)
    window.addEventListener('focus', refreshHotkeyState)
    return () => {
      document.removeEventListener('visibilitychange', onVisible)
      window.removeEventListener('focus', refreshHotkeyState)
    }
  }, [])

  // Auto-verify the stored Imp key when the options page opens (and whenever
  // the key changes) so the "Connected" badge reflects whether the key is
  // still valid rather than just "we have a stored key". Never calls the
  // model — see background.ts's checkConnection handler.
  useEffect(() => {
    const imp = settings?.imp
    if (!impConnected || !imp) {
      setConnStatus('idle')
      return
    }
    let cancelled = false
    setConnStatus('checking')
    void (async () => {
      let next: 'connected' | 'disconnected' | 'unknown'
      try {
        const result = await messager.sendMessage('checkConnection', {
          baseUrl: imp.baseUrl,
          apiKey: imp.apiKey,
        })
        next = result.ok ? 'connected' : 'disconnected'
      } catch {
        next = 'unknown'
      }
      if (!cancelled) setConnStatus(next)
    })()
    return () => {
      cancelled = true
    }
  }, [impConnected, settings?.imp?.apiKey, settings?.imp?.baseUrl])

  // Persists the preference and asks the background to bind it where the
  // browser allows. Reachable only on canApply browsers — a canApply:false
  // browser renders this control read-only, so no caller here ever observes
  // a failed apply.
  function commitHotkey(command: string, hotkey: string) {
    update(
      command === TOGGLE_COMMAND
        ? { toggleHotkey: hotkey }
        : { retranslateHotkey: hotkey },
    )
    void (async () => {
      try {
        await messager.sendMessage('setHotkey', { command, hotkey })
        const state = await messager.sendMessage('getHotkeyState', { command })
        setHotkeyStates((prev) => ({ ...prev, [command]: state }))
      } catch {}
    })()
  }

  // Recording listens on window rather than on the button, so it survives
  // focus moving elsewhere mid-recording. The effect re-runs whenever a stored
  // shortcut changes, so commitHotkey works from the latest settings rather
  // than capturing a stale closure.
  useEffect(() => {
    if (!recording) return
    const onKeyDown = (e: KeyboardEvent) => {
      e.preventDefault()
      e.stopPropagation()
      if (e.key === 'Escape') {
        setRecording(null)
        setRecordingHint(null)
        return
      }
      if (e.key === 'Backspace' || e.key === 'Delete') {
        setRecording(null)
        setRecordingHint(null)
        commitHotkey(recording, '')
        return
      }
      const next = hotkeyFromEvent(e)
      if (!next) {
        // Stay in recording mode: an invalid combination must not silently
        // end the interaction, or the user gets no feedback at all.
        setRecordingHint('Use Alt or Ctrl plus one key. Ctrl+Alt is not allowed.')
        return
      }
      setRecording(null)
      setRecordingHint(null)
      commitHotkey(recording, next)
    }
    window.addEventListener('keydown', onKeyDown, { capture: true })
    return () => window.removeEventListener('keydown', onKeyDown, { capture: true })
  }, [recording, settings?.toggleHotkey, settings?.retranslateHotkey])

  function connectImp() {
    browser.tabs.create({ url: IMP_CONNECT_URL })
  }

  function disconnectImp() {
    update({ provider: 'openai' })
  }

  if (!settings) return null

  const extraBodyText =
    extraBodyDraft ?? JSON.stringify(settings.openai.extraBody, null, 2)
  const extraBodyStatus = parseExtraBodyParams(extraBodyText)
  const glossaryStatus = parseGlossary(settings.glossary)
  // First line only — the whole prompt is too long for a collapsed row.
  const systemPromptSummary =
    settings.openai.systemPrompt.trim() === ''
      ? 'Empty'
      : settings.openai.systemPrompt === DEFAULT_SYSTEM_PROMPT
        ? 'Default prompt'
        : settings.openai.systemPrompt.trim().split('\n')[0]

  function update(patch: Partial<Settings>) {
    // Functional: a recorder's window-level keydown handler holds the closure
    // from the render that started recording, so spreading the render-time
    // `settings` there would rebase a stale object over anything changed since.
    setSettings((prev) => ({ ...prev!, ...patch }))
    saveSettings(patch)
  }

  function updateOpenAI(patch: Partial<Settings['openai']>) {
    const openai = { ...settings!.openai, ...patch }
    setSettings({ ...settings!, openai })
    saveSettings({ openai })
    setTestResult(null)
  }

  function commitExtraBody(text: string) {
    setExtraBodyDraft(text)
    const parsed = parseExtraBodyParams(text)
    // While the draft is unparseable the stored value keeps its last good
    // state, so a half-typed object never reaches the request path.
    if (parsed.ok) updateOpenAI({ extraBody: parsed.value })
  }

  async function testOpenAIConnection() {
    if (!settings) return
    setTesting(true)
    setTestResult(null)
    try {
      const result = await translate(['Hello'], settings.targetLang, settings)
      setTestResult({
        ok: true,
        msg: `Connected. Translated "Hello" → "${result.texts[0]}".`,
      })
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      setTestResult({ ok: false, msg: humanizeOpenAIError(message) })
    } finally {
      setTesting(false)
    }
  }

  return (
    <div className="max-w-2xl mx-auto p-4 sm:p-6 space-y-6">
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <BrandIcon className="size-8 -mt-1" />
          <h1 className="text-2xl font-bold">Translaneur</h1>
        </div>
      </div>

      <SegmentedControl
        ariaLabel="Settings section"
        value={section}
        onChange={setSection}
        options={SECTION_OPTIONS}
      />

      {section === 'general' ? (
        <>
          <section className="space-y-4">
            <div className="space-y-1.5">
              <Label>Target Language</Label>
              <Select
                value={settings.targetLang}
                onValueChange={(v) => update({ targetLang: v })}
              >
                <SelectTrigger className="w-full" id="imp-lang">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent position="popper" className="max-h-60">
                  {LANGUAGES_SORTED.map(([code, name]) => (
                    <SelectItem key={code} value={code}>
                      {name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            <div className="space-y-1.5">
              <Label>Display</Label>
              <SegmentedControl
                id="imp-display"
                ariaLabel="Display"
                value={settings.renderMode}
                onChange={(v) => update({ renderMode: v })}
                options={DISPLAY_OPTIONS}
              />
            </div>
          </section>

          <section className="space-y-4">
            <div>
              <h2 className="font-semibold">Shortcuts</h2>
              <p className="text-sm text-muted-foreground">
                Keyboard shortcuts for the current page.
              </p>
            </div>

            <div className="space-y-4">
              <div className="space-y-2">
                <Label>Toggle translation</Label>
                <HotkeyField
                  id="hotkey"
                  label="Toggle shortcut"
                  command={TOGGLE_COMMAND}
                  value={settings.toggleHotkey}
                  active={hotkeyStates[TOGGLE_COMMAND]?.active ?? ''}
                  capability={hotkeyCapability}
                  recording={recording === TOGGLE_COMMAND}
                  hint={recordingHint}
                  onRecord={() => {
                    setRecordingHint(null)
                    setRecording(TOGGLE_COMMAND)
                  }}
                  onClear={() => commitHotkey(TOGGLE_COMMAND, '')}
                />
              </div>
              <div className="space-y-2">
                <Label>Re-translate from scratch</Label>
                <HotkeyField
                  id="retranslate-hotkey"
                  label="Re-translate shortcut"
                  command={RETRANSLATE_COMMAND}
                  value={settings.retranslateHotkey}
                  active={hotkeyStates[RETRANSLATE_COMMAND]?.active ?? ''}
                  capability={hotkeyCapability}
                  recording={recording === RETRANSLATE_COMMAND}
                  hint={recordingHint}
                  onRecord={() => {
                    setRecordingHint(null)
                    setRecording(RETRANSLATE_COMMAND)
                  }}
                  onClear={() => commitHotkey(RETRANSLATE_COMMAND, '')}
                />
              </div>
            </div>

            {hotkeyCapability === 'apply' && (
              <p className="text-xs text-muted-foreground">
                Click a field, then press a combination. Backspace clears it,
                Escape cancels.
              </p>
            )}
            {hotkeyCapability === 'error' && (
              <p className="text-xs text-muted-foreground">
                Could not read the browser's shortcut settings, so the fields
                above are read-only here. Reload to try again.
              </p>
            )}
            {hotkeyCapability === 'read-only' && (
              <div className="space-y-1">
                <p className="text-xs text-muted-foreground">
                  Chrome does not let extensions assign shortcuts. The fields
                  above are read-only here, so finish each binding in the
                  browser's shortcut settings.
                </p>
                <Button
                  variant="link"
                  size="sm"
                  className="h-auto p-0"
                  onClick={() => {
                    // Chrome blocks navigation to some chrome:// URLs;
                    // failing quietly beats an unhandled rejection in the
                    // console.
                    void browser.tabs
                      .create({ url: 'chrome://extensions/shortcuts' })
                      .catch(() => {})
                  }}
                >
                  Open browser shortcut settings
                </Button>
              </div>
            )}
          </section>

          <section className="space-y-4">
            <div className="space-y-1.5">
              <Label>Glossary</Label>
              <Textarea
                value={settings.glossary}
                onChange={(e) => update({ glossary: e.target.value })}
                placeholder={
                  '! One term per line\nTransformer = 变换器\nKubernetes = 库伯内特斯'
                }
                className="min-h-32 font-mono text-xs"
              />
              {glossaryStatus.ok ? (
                <p className="text-xs text-muted-foreground">
                  {glossaryStatus.value.length} term
                  {glossaryStatus.value.length === 1 ? '' : 's'} — applied to
                  every translation, overriding what the provider would pick.
                </p>
              ) : (
                <p className="text-xs text-destructive">{glossaryStatus.error}</p>
              )}
              <p className="text-xs text-muted-foreground">
                Fixes the rendering of a term everywhere it appears, which is
                what keeps proper nouns from drifting between blocks. Lines
                starting with {'!'} are comments. Used by Google Translate and
                the OpenAI-compatible provider; Microsoft and Imp Credits cannot
                apply it.
              </p>
            </div>

            <div className="flex items-start gap-2">
              <Checkbox
                id="developer-mode"
                checked={settings.developerMode}
                onCheckedChange={(checked) =>
                  update({ developerMode: checked === true })
                }
              />
              <div className="grid gap-0.5 leading-none">
                <Label htmlFor="developer-mode" className="cursor-pointer">
                  Developer Mode
                </Label>
                <p className="text-xs text-muted-foreground">
                  Enables access to features suitable for technical users.
                </p>
              </div>
            </div>

            {settings.developerMode && (
              <>
                <div className="space-y-1.5">
                  <Label>Custom Skip Rules</Label>
                  <Textarea
                    value={settings.customRules}
                    onChange={(e) => update({ customRules: e.target.value })}
                    placeholder={
                      '! Example: skip element on a specific site\n! reddit.com##[id="expand-search-button"]'
                    }
                    className="min-h-32 font-mono text-xs"
                  />
                  <p className="text-xs text-muted-foreground">
                    Syntax:{' '}
                    <code className="bg-muted px-1 rounded">domain##selector</code>{' '}
                    — elements matching the CSS selector will not be
                    translated.
                  </p>
                </div>

                <div className="flex items-start gap-2">
                  <Checkbox
                    id="debug-mode"
                    checked={settings.debugMode}
                    onCheckedChange={(checked) =>
                      update({ debugMode: checked === true })
                    }
                  />
                  <div className="grid gap-0.5 leading-none">
                    <Label htmlFor="debug-mode" className="cursor-pointer">
                      Debug Mode
                    </Label>
                    <p className="text-xs text-muted-foreground">
                      Outline blocks whose translation matched the original
                      (likely false positives) so you can write skip rules for
                      them.
                    </p>
                  </div>
                </div>

                <div className="space-y-2">
                  <Button
                    variant="outline"
                    onClick={async () => {
                      setRefreshingRules(true)
                      try {
                        await messager.sendMessage(
                          'refreshRemoteRules',
                          undefined,
                        )
                        setRefreshResult({
                          ok: true,
                          msg: 'Remote rules refreshed.',
                        })
                      } catch (err) {
                        const message =
                          err instanceof Error ? err.message : String(err)
                        setRefreshResult({
                          ok: false,
                          msg: `Failed to refresh: ${message}`,
                        })
                      } finally {
                        setRefreshingRules(false)
                      }
                    }}
                    disabled={refreshingRules}
                  >
                    {refreshingRules ? 'Refreshing...' : 'Refresh Remote Rules'}
                  </Button>
                  {refreshResult && (
                    <p
                      className={`text-sm ${
                        refreshResult.ok ? 'text-green-600' : 'text-red-600'
                      }`}
                    >
                      {refreshResult.msg}
                    </p>
                  )}
                </div>
              </>
            )}
          </section>
        </>
      ) : (
        <>
          <section className="space-y-4">
            <div className="space-y-1.5">
              <Label>Translation Provider</Label>
              <RadioGroup
                value={settings.provider}
                onValueChange={(v) =>
                  update({ provider: v as TranslationProvider })
                }
              >
                {PROVIDERS.map((p) => (
                  <label
                    key={p.value}
                    className={`flex items-start gap-3 p-3 rounded-lg border cursor-pointer transition-colors ${
                      settings.provider === p.value
                        ? 'border-primary bg-primary/5'
                        : 'border-border hover:border-primary/50'
                    }`}
                  >
                    <RadioGroupItem value={p.value} className="mt-0.5" />
                    <div>
                      <div className="text-sm font-medium">{p.label}</div>
                      <div className="text-xs text-muted-foreground">
                        {p.description}
                      </div>
                    </div>
                  </label>
                ))}
              </RadioGroup>
            </div>
          </section>

          {settings.provider === 'imp' && (
            <section className="space-y-4">
              <div>
                <h2 className="font-semibold">Imp Credits</h2>
                <p className="text-sm text-muted-foreground">
                  Hosted, metered translation. Connect an Imp account to use it
                  without your own API key.
                </p>
              </div>

              {impConnected ? (
                <div className="flex flex-col gap-2 rounded-lg border p-3 sm:flex-row sm:items-center sm:justify-between">
                  <div className="flex min-w-0 items-center gap-2 text-sm">
                    <span
                      className={`size-2 shrink-0 rounded-full ${
                        connStatus === 'connected'
                          ? 'bg-green-500'
                          : connStatus === 'checking'
                            ? 'bg-muted animate-pulse'
                            : 'bg-red-500'
                      }`}
                    />
                    <span className="truncate">
                      {connStatus === 'connected'
                        ? `Connected · ${settings.imp?.model ?? 'imp-standard'}`
                        : connStatus === 'checking'
                          ? 'Checking connection…'
                          : 'Connection lost — reconnect'}
                    </span>
                  </div>
                  <div className="flex flex-wrap items-center gap-2">
                    <Button variant="ghost" size="sm" onClick={disconnectImp}>
                      Use another provider
                    </Button>
                    <Button variant="secondary" size="sm" onClick={connectImp}>
                      Reconnect
                    </Button>
                  </div>
                </div>
              ) : (
                <Button className="w-full" onClick={connectImp}>
                  Connect Imp Account
                </Button>
              )}
            </section>
          )}

          {settings.provider === 'openai' && (
            <section className="space-y-4">
              <div>
                <h2 className="font-semibold">OpenAI Compatible API</h2>
                <p className="text-sm text-muted-foreground">
                  Works with OpenAI, DeepSeek, Gemini, and any other
                  OpenAI-compatible API
                </p>
              </div>

              <div className="space-y-1.5">
                <Label>Base URL</Label>
                <Input
                  type="url"
                  value={settings.openai.baseUrl}
                  onChange={(e) => updateOpenAI({ baseUrl: e.target.value })}
                  placeholder="https://api.openai.com/v1"
                />
                {settings.openai.baseUrl && (
                  <p className="text-xs text-muted-foreground break-all">
                    Requests will be sent to:{' '}
                    {chatCompletionsUrl(settings.openai.baseUrl)}
                  </p>
                )}
              </div>

              <div className="space-y-1.5">
                <Label>API Key</Label>
                <Input
                  type="password"
                  value={settings.openai.apiKey}
                  onChange={(e) => updateOpenAI({ apiKey: e.target.value })}
                  placeholder="sk-..."
                />
              </div>

              <div className="space-y-1.5">
                <Label>Model</Label>
                <Input
                  value={settings.openai.model}
                  onChange={(e) => updateOpenAI({ model: e.target.value })}
                  placeholder="gpt-6-luna"
                />
              </div>

              <CollapsibleField
                label="System Prompt"
                summary={systemPromptSummary}
                open={promptOpen}
                onOpenChange={setPromptOpen}
              >
                <Textarea
                  value={settings.openai.systemPrompt}
                  onChange={(e) =>
                    updateOpenAI({ systemPrompt: e.target.value })
                  }
                  placeholder="You are a translator..."
                />
                <p className="text-xs text-muted-foreground">
                  Use {'{{targetLang}}'} (or {'{{to}}'}) as the target-language
                  placeholder. Any other {'{{placeholder}}'} is removed before
                  the prompt is sent.
                </p>
              </CollapsibleField>

              <CollapsibleField
                label="Extra Request Parameters"
                summary={
                  extraBodyStatus.ok
                    ? `Sent with every request: ${
                        Object.keys(extraBodyStatus.value).join(', ') || 'none'
                      }`
                    : extraBodyStatus.error
                }
                summaryClassName={extraBodyStatus.ok ? undefined : 'text-destructive'}
                open={extraBodyOpen}
                onOpenChange={setExtraBodyOpen}
              >
                <div className="flex justify-end">
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => setExtraBodyDraft(null)}
                  >
                    Reset
                  </Button>
                </div>
                <Textarea
                  value={extraBodyText}
                  onChange={(e) => commitExtraBody(e.target.value)}
                  placeholder='{ "temperature": 0 }'
                  className="min-h-32 font-mono text-xs"
                />
                <p className="text-xs text-muted-foreground">
                  Merged into the request body after the built-in defaults, so
                  these win. Parameter names and shapes are provider-specific:
                  check your provider's documentation for what it accepts.
                  model, messages and stream are managed by the extension.
                </p>
              </CollapsibleField>

              <div className="space-y-1.5">
                <Label>Max requests per second</Label>
                <Input
                  type="number"
                  min={0}
                  value={settings.openai.maxRequestsPerSecond}
                  onChange={(e) =>
                    updateOpenAI({
                      maxRequestsPerSecond: parseNonNegativeInt(e.target.value),
                    })
                  }
                />
                <p className="text-xs text-muted-foreground">
                  0 removes the client-side cap entirely.
                </p>
              </div>

              <div className="space-y-1.5">
                <Label>Max characters per request</Label>
                <Input
                  type="number"
                  min={0}
                  value={settings.openai.maxCharsPerRequest}
                  onChange={(e) =>
                    updateOpenAI({
                      maxCharsPerRequest: parseNonNegativeInt(e.target.value),
                    })
                  }
                />
                <p className="text-xs text-muted-foreground">
                  0 uses the provider default (4096).
                </p>
              </div>

              <div className="space-y-1.5">
                <Label>Max texts per request</Label>
                <Input
                  type="number"
                  min={0}
                  value={settings.openai.maxTextsPerRequest}
                  onChange={(e) =>
                    updateOpenAI({
                      maxTextsPerRequest: parseNonNegativeInt(e.target.value),
                    })
                  }
                />
                <p className="text-xs text-muted-foreground">
                  0 uses the provider default (8).
                </p>
              </div>

              <div className="space-y-2">
                <Button
                  variant="outline"
                  onClick={testOpenAIConnection}
                  disabled={testing || !settings.openai.apiKey}
                >
                  {testing ? 'Testing...' : 'Test connection'}
                </Button>
                {testResult && (
                  <p
                    className={`text-sm ${
                      testResult.ok ? 'text-green-600' : 'text-red-600'
                    }`}
                  >
                    {testResult.msg}
                  </p>
                )}
              </div>
            </section>
          )}
        </>
      )}
    </div>
  )
}
