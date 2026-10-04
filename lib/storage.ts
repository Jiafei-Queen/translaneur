import { DEFAULT_HOTKEY } from './hotkey'
import { DEFAULT_SYSTEM_PROMPT } from './prompt'

export type TranslationProvider = 'microsoft' | 'google' | 'openai' | 'imp'

export type RenderMode = 'bilingual' | 'translation-only'

export interface ImpProvider {
  apiKey: string
  baseUrl: string
  model: string
}

export interface OpenAIConfig {
  apiKey: string
  baseUrl: string
  model: string
  systemPrompt: string
  /**
   * Merged into the chat/completions request body verbatim. The shape of any
   * key here is provider-specific - check the endpoint's own docs.
   */
  extraBody: Record<string, unknown>
  /** Requests per second this client may issue. 0 = no client-side cap. */
  maxRequestsPerSecond: number
  /** Texts per request. 0 falls back to the provider's built-in batch cap. */
  maxTextsPerRequest: number
  /** Characters per request. 0 falls back to the provider's built-in cap. */
  maxCharsPerRequest: number
}


export interface Settings {
  provider: TranslationProvider
  targetLang: string
  renderMode: RenderMode
  openai: OpenAIConfig
  imp?: ImpProvider // filled in automatically by the connect flow
  developerMode: boolean
  customRules: string
  debugMode: boolean
  // WebExtension shortcut string for the toggle command ('Alt+T'), or ''
  // meaning "off". This is the extension's record of intent; the browser's
  // real binding is read from browser.commands.getAll() and can differ on
  // Chrome, which refuses to let extensions assign shortcuts.
  hotkey: string
  // Source→target term pairs, one "source = target" per line, `!` comments.
  // Stored as text rather than a parsed list so the options page can hold a
  // half-typed line and keep the user's caret position; see lib/glossary.ts.
  // OpenAI reads it as prompt instructions, Google as sentinels in the text;
  // Microsoft and Imp Credits cannot use it. See docs/glossary.md.
  glossary: string
}

const DEFAULT_SETTINGS: Settings = {
  provider: 'google',
  targetLang: navigator.language.split('-')[0] || 'zh',
  renderMode: 'bilingual',
  developerMode: false,
  debugMode: false,
  customRules: '',
  hotkey: DEFAULT_HOTKEY,
  glossary: '',
  openai: {
    apiKey: '',
    baseUrl: 'https://api.openai.com/v1',
    model: 'gpt-6-luna',
    systemPrompt: DEFAULT_SYSTEM_PROMPT,
    extraBody: { temperature: 0, reasoning: { effort: 'none' } },
    maxRequestsPerSecond: 5,
    maxTextsPerRequest: 8,
    maxCharsPerRequest: 4096,
  },
}

// Versions ≤0.0.51 stored a full URL (".../v1/chat/completions") under
// openai.endpoint; baseUrl replaced it and /chat/completions is now appended
// at request time. Returns the input object unchanged when no legacy key.
function migrateLegacyEndpoint(raw: Partial<Settings>): Partial<Settings> {
  const openai = raw.openai as
    | (OpenAIConfig & { endpoint?: string })
    | undefined
  if (!openai || openai.endpoint === undefined) return raw
  const { endpoint, ...rest } = openai
  const baseUrl =
    rest.baseUrl ??
    endpoint.replace(/\/chat\/completions\/?$/, '').replace(/\/+$/, '')
  return { ...raw, openai: { ...rest, baseUrl } }
}

// A shallow spread would let a stored `openai` object replace the default one
// wholesale, leaving every field it predates undefined. Nested merge is what
// makes adding a field to OpenAIConfig safe.
function mergeWithDefaults(raw: Partial<Settings>): Settings {
  return {
    ...DEFAULT_SETTINGS,
    ...raw,
    openai: { ...DEFAULT_SETTINGS.openai, ...(raw.openai ?? {}) },
  }
}

let cachedSettings: Settings | null = null

/**
 * Synchronous read of the last settings seen by getSettings/saveSettings.
 * Batching needs the limits without awaiting storage. Never mutate the result.
 */
export function peekSettings(): Settings {
  return (
    cachedSettings ?? {
      ...DEFAULT_SETTINGS,
      openai: { ...DEFAULT_SETTINGS.openai },
    }
  )
}


export async function getSettings(): Promise<Settings> {
  const stored = await browser.storage.local.get('settings')
  if (!stored.settings) return (cachedSettings = mergeWithDefaults({}))
  const raw = stored.settings as Partial<Settings>
  const migrated = migrateLegacyEndpoint(raw)
  if (migrated !== raw) await browser.storage.local.set({ settings: migrated })
  return (cachedSettings = mergeWithDefaults(migrated))
}

export async function saveSettings(
  settings: Partial<Settings>,
): Promise<Settings> {
  const stored = await browser.storage.local.get('settings')
  const raw = migrateLegacyEndpoint((stored.settings ?? {}) as Partial<Settings>)
  const merged = { ...raw, ...settings }
  await browser.storage.local.set({ settings: merged })
  return (cachedSettings = mergeWithDefaults(merged))
}
