/**
 * Body keys the extension owns. `model` and `messages` come from dedicated
 * settings fields, and `stream: true` would break the non-streaming
 * `resp.json()` read in translator.ts.
 */
export const RESERVED_BODY_KEYS = ['model', 'messages', 'stream'] as const

export type ExtraBodyParseResult =
  | { ok: true; value: Record<string, unknown> }
  | { ok: false; error: string }

/** Parses the options-page textarea into a request-body fragment. */
export function parseExtraBodyParams(text: string): ExtraBodyParseResult {
  const trimmed = text.trim()
  if (trimmed === '') return { ok: true, value: {} }

  let parsed: unknown
  try {
    parsed = JSON.parse(trimmed)
  } catch (err) {
    return {
      ok: false,
      error: `Invalid JSON: ${err instanceof Error ? err.message : String(err)}`,
    }
  }

  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return { ok: false, error: 'Must be a JSON object' }
  }

  for (const key of RESERVED_BODY_KEYS) {
    if (key in parsed) {
      return {
        ok: false,
        error: `Cannot override "${key}" — the extension manages that field`,
      }
    }
  }
  return { ok: true, value: parsed as Record<string, unknown> }
}

/** Coerces a number input to a non-negative integer; anything unusable is 0. */
export function parseNonNegativeInt(raw: string): number {
  const n = Number(raw.trim())
  return Number.isInteger(n) && n > 0 ? n : 0
}

/**
 * Writes user-supplied body params last so an explicit value beats the
 * hostname-guessing interceptors. Reserved keys are skipped as a second line of
 * defence — settings can be written directly to storage, bypassing the parser.
 */
export function applyCustomParams(
  body: Record<string, any>,
  extra: Record<string, unknown>,
): void {
  for (const [key, value] of Object.entries(extra)) {
    if ((RESERVED_BODY_KEYS as readonly string[]).includes(key)) {
      console.warn(`[translaneur] ignoring reserved body param: ${key}`)
      continue
    }
    body[key] = value
  }
}