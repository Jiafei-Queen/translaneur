// User edits of specific translations, keyed by site/sender domain, target
// language, and the block's source payload (the same marked string the cache
// keys on). Consulted before the provider/cache so a hand-corrected translation
// survives re-translation, scroll rechecks, and cache eviction.
//
// Backed by storage.local (not the idb translation cache): edits are small and
// few, must outlive the 30-day cache eviction, and a per-key read keeps the
// translate hot path from loading a whole map. An in-memory mirror loaded once
// per background lifetime makes that read a map lookup.

const PREFIX = 'override:'

let mirror: Map<string, string> | null = null
let loading: Promise<Map<string, string>> | null = null

function keyOf(domain: string, targetLang: string, source: string): string {
  return JSON.stringify([domain, targetLang, source])
}

async function load(): Promise<Map<string, string>> {
  if (mirror) return mirror
  if (loading) return loading
  loading = (async () => {
    const map = new Map<string, string>()
    const all = await browser.storage.local.get(null)
    for (const [k, v] of Object.entries(all)) {
      if (k.startsWith(PREFIX) && typeof v === 'string') {
        map.set(k.slice(PREFIX.length), v)
      }
    }
    mirror = map
    return map
  })()
  return loading
}

export async function getOverride(
  domain: string,
  targetLang: string,
  source: string,
): Promise<string | undefined> {
  const map = await load()
  return map.get(keyOf(domain, targetLang, source))
}

// One storage write for a whole edit-mode session, rather than one per block.
export async function setOverrides(
  domain: string,
  targetLang: string,
  entries: Array<{ source: string; translated: string }>,
): Promise<void> {
  if (entries.length === 0) return
  const map = await load()
  const patch: Record<string, string> = {}
  for (const { source, translated } of entries) {
    const k = keyOf(domain, targetLang, source)
    map.set(k, translated)
    patch[PREFIX + k] = translated
  }
  await browser.storage.local.set(patch)
}
