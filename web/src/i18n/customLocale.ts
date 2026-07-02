import i18n from "i18next"
import { z } from "zod"

import en from "@/locales/en.json"

// Sideloadable language packs. English is the bundled base; users install extra
// languages at runtime (file upload or remote URL) and switch between them. The
// stored payload is arbitrary user-supplied JSON, so every entry point enforces
// a size cap, a shape/key-count check, and re-validation on rehydration. Mirrors
// the useTheme localStorage + cross-tab `storage` listener mechanics.

export const LANG_STORAGE_KEY = "classroom50:lang"
export const PACKS_STORAGE_KEY = "classroom50:custom-locales"

export const BASE_LANG = "en"

// i18next groups resources under a namespace; we use the default single one.
export const NAMESPACE = "translation"

// Guardrails against oversized input freezing the tab or blowing the ~5MB
// localStorage origin budget (shared across all installed packs).
export const MAX_PACK_BYTES = 512 * 1024
export const MAX_PACK_KEYS = 5000

// A flat map of dotted keys to translated strings, e.g. { "notFound.title": "..." }.
// Nested JSON is accepted on input and flattened before validation/registration.
export type FlatBundle = Record<string, string>

export type LanguagePack = {
  code: string
  bundle: FlatBundle
}

// Language code: a BCP-47-ish tag. Must start with a 2-3 letter primary
// language subtag, optionally followed by `-`-separated alphanumeric subtags
// (region/script/variant). This rejects codes like "123" or "12-34" that pass a
// looser check but make `Intl.DateTimeFormat` throw a RangeError downstream.
const langCodeSchema = z
  .string()
  .trim()
  .min(2)
  .max(35)
  .regex(
    /^[A-Za-z]{2,3}(-[A-Za-z0-9]{1,8})*$/,
    "Language code must be a valid BCP-47 tag (e.g. de, pt-BR)",
  )

const flatBundleSchema = z
  .record(z.string(), z.string())
  .refine((obj) => Object.keys(obj).length > 0, {
    message: "Language pack is empty",
  })
  .refine((obj) => Object.keys(obj).length <= MAX_PACK_KEYS, {
    message: `Language pack has too many keys (max ${MAX_PACK_KEYS})`,
  })

const packSchema = z.object({
  code: langCodeSchema,
  bundle: flatBundleSchema,
})

const storedPacksSchema = z.record(z.string(), packSchema)

export class LanguagePackError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "LanguagePackError"
  }
}

// Flatten nested translation JSON ({ notFound: { title } }) into dotted keys
// ({ "notFound.title" }). Rejects non-string leaves so a pack can't inject
// objects/arrays where i18next expects a string.
export function flattenBundle(input: unknown, prefix = ""): FlatBundle {
  if (input === null || typeof input !== "object" || Array.isArray(input)) {
    throw new LanguagePackError("Language pack must be a JSON object")
  }
  const out: FlatBundle = {}
  for (const [key, value] of Object.entries(input as Record<string, unknown>)) {
    const path = prefix ? `${prefix}.${key}` : key
    if (typeof value === "string") {
      out[path] = value
    } else if (value && typeof value === "object" && !Array.isArray(value)) {
      Object.assign(out, flattenBundle(value, path))
    } else {
      throw new LanguagePackError(
        `Value at "${path}" must be a string or nested object`,
      )
    }
  }
  return out
}

// Parse + validate raw JSON text into a FlatBundle. Enforces the byte cap before
// parsing so an oversized string never reaches JSON.parse.
export function parseBundle(text: string): FlatBundle {
  if (byteLength(text) > MAX_PACK_BYTES) {
    throw new LanguagePackError(
      `Language pack is too large (max ${Math.round(MAX_PACK_BYTES / 1024)}KB)`,
    )
  }
  let json: unknown
  try {
    json = JSON.parse(text)
  } catch {
    throw new LanguagePackError("Language pack is not valid JSON")
  }
  const flat = flattenBundle(json)
  const result = flatBundleSchema.safeParse(flat)
  if (!result.success) {
    throw new LanguagePackError(result.error.issues[0]?.message ?? "Invalid language pack")
  }
  return result.data
}

export function normalizeLangCode(code: string): string {
  const result = langCodeSchema.safeParse(code)
  if (!result.success) {
    throw new LanguagePackError(result.error.issues[0]?.message ?? "Invalid language code")
  }
  return result.data
}

function byteLength(text: string): number {
  if (typeof TextEncoder !== "undefined") {
    return new TextEncoder().encode(text).length
  }
  // Node fallback for the test environment.
  return Buffer.byteLength(text, "utf8")
}

// ---- Storage ----------------------------------------------------------------

function getStorage(): Storage | null {
  try {
    return typeof window !== "undefined" ? window.localStorage : null
  } catch {
    return null
  }
}

// Read + re-validate all persisted packs. A tampered or corrupt localStorage
// value is not trusted: anything that fails validation is dropped rather than
// registered. Returns only the packs that pass.
export function readStoredPacks(): Record<string, LanguagePack> {
  const storage = getStorage()
  if (!storage) return {}
  const raw = storage.getItem(PACKS_STORAGE_KEY)
  if (!raw) return {}
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return {}
  }
  const result = storedPacksSchema.safeParse(parsed)
  if (!result.success) {
    // Keep only individually valid entries rather than discarding everything.
    const salvaged: Record<string, LanguagePack> = {}
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      for (const [code, entry] of Object.entries(parsed)) {
        const one = packSchema.safeParse(entry)
        if (one.success && one.data.code === code) {
          salvaged[code] = one.data
        }
      }
    }
    return salvaged
  }
  return result.data
}

function writeStoredPacks(packs: Record<string, LanguagePack>): void {
  const storage = getStorage()
  if (!storage) return
  try {
    storage.setItem(PACKS_STORAGE_KEY, JSON.stringify(packs))
  } catch (err) {
    if (isQuotaError(err)) {
      throw new LanguagePackError(
        "Storage is full — remove an installed language pack and try again.",
      )
    }
    throw err
  }
}

function isQuotaError(err: unknown): boolean {
  return (
    err instanceof DOMException &&
    (err.name === "QuotaExceededError" ||
      err.name === "NS_ERROR_DOM_QUOTA_REACHED")
  )
}

export function getStoredLang(): string {
  const storage = getStorage()
  const stored = storage?.getItem(LANG_STORAGE_KEY)
  if (!stored) return BASE_LANG
  const result = langCodeSchema.safeParse(stored)
  return result.success ? result.data : BASE_LANG
}

function setStoredLang(code: string): void {
  getStorage()?.setItem(LANG_STORAGE_KEY, code)
}

// ---- Registration -----------------------------------------------------------

// Cached, stable-identity snapshots so useSyncExternalStore doesn't loop: a new
// array is created only when the set of installed packs actually changes.
let installedSnapshot: string[] = []
let availableSnapshot: string[] = [BASE_LANG]
const listeners = new Set<() => void>()

function refreshSnapshot(): void {
  const codes = Object.keys(readStoredPacks())
  const sameInstalled =
    codes.length === installedSnapshot.length &&
    codes.every((c, i) => c === installedSnapshot[i])
  if (sameInstalled) return
  installedSnapshot = codes
  availableSnapshot = [BASE_LANG, ...codes]
  for (const listener of listeners) listener()
}

function registerPack(pack: LanguagePack): void {
  // `deep: true, overwrite: true` so re-registering a pack replaces its keys.
  i18n.addResourceBundle(pack.code, NAMESPACE, pack.bundle, true, true)
}

// Register the stored packs with i18next, reconciling against what was
// previously registered: add survivors and drop any bundle whose pack is gone
// (e.g. removed in another tab). Called at startup and on cross-tab storage
// events. Returns the currently-installed codes.
export function hydratePacks(): string[] {
  const packs = readStoredPacks()
  const codes = Object.keys(packs)
  // Drop bundles for packs that no longer exist (cross-tab removal). Without
  // this, a pack removed in another tab stays registered here until reload.
  for (const code of installedSnapshot) {
    if (!(code in packs)) {
      i18n.removeResourceBundle(code, NAMESPACE)
    }
  }
  for (const pack of Object.values(packs)) {
    registerPack(pack)
  }
  refreshSnapshot()
  return codes
}

// Install (or replace) a pack: register it and persist. Returns the code.
export function installPack(codeInput: string, bundle: FlatBundle): string {
  const code = normalizeLangCode(codeInput)
  if (code === BASE_LANG) {
    throw new LanguagePackError(`"${BASE_LANG}" is the built-in base language and can't be replaced.`)
  }
  const pack: LanguagePack = { code, bundle }
  // Re-read immediately before writing so a concurrent install in another tab
  // (which shares this origin's localStorage) is merged in rather than clobbered
  // by a stale snapshot — the classic lost-update on a read-modify-write.
  const packs = readStoredPacks()
  packs[code] = pack
  writeStoredPacks(packs)
  registerPack(pack)
  refreshSnapshot()
  return code
}

export function removePack(code: string): void {
  const packs = readStoredPacks()
  if (!(code in packs)) return
  delete packs[code]
  writeStoredPacks(packs)
  i18n.removeResourceBundle(code, NAMESPACE)
  refreshSnapshot()
  if (getStoredLang() === code) {
    void selectLang(BASE_LANG)
  }
}

export function installedCodes(): string[] {
  return installedSnapshot
}

export function availableLangs(): string[] {
  return availableSnapshot
}

// The base English keys, flattened once, as the source of truth for coverage.
const baseKeys = Object.keys(flattenBundle(en))

// Report which base keys a pack does NOT translate. Missing keys fall back to
// English at runtime (i18next fallbackLng), so this is a completeness signal a
// caller can surface (e.g. "translates 412/540 strings") — not an error.
export function missingKeys(bundle: FlatBundle): string[] {
  return baseKeys.filter((key) => !(key in bundle))
}

// Fraction of base keys a pack covers, 0..1. Useful for a "78% translated"
// badge in the language switcher.
export function coverage(bundle: FlatBundle): number {
  if (baseKeys.length === 0) return 1
  const translated = baseKeys.length - missingKeys(bundle).length
  return translated / baseKeys.length
}

// Coverage for an installed pack by code (0..1), or null if not installed.
export function packCoverage(code: string): number | null {
  const pack = readStoredPacks()[code]
  return pack ? coverage(pack.bundle) : null
}

// Switch the active language and persist the choice.
export async function selectLang(code: string): Promise<void> {
  const next = code === BASE_LANG ? BASE_LANG : normalizeLangCode(code)
  setStoredLang(next)
  await i18n.changeLanguage(next)
}

// ---- Loaders ----------------------------------------------------------------

export async function loadFromFile(file: File, code: string): Promise<string> {
  if (file.size > MAX_PACK_BYTES) {
    throw new LanguagePackError(
      `File is too large (max ${Math.round(MAX_PACK_BYTES / 1024)}KB)`,
    )
  }
  const text = await file.text()
  const bundle = parseBundle(text)
  const installed = installPack(code, bundle)
  await selectLang(installed)
  return installed
}

const FETCH_TIMEOUT_MS = 10_000

// Fetch a pack from a user-pasted URL. Requires http/https, bounds the response
// size, times out, and translates every failure into a LanguagePackError with a
// message the UI can show. Never changes the active language on failure — the
// caller only calls selectLang after a successful install.
export async function loadFromUrl(url: string, code: string): Promise<string> {
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    throw new LanguagePackError("Enter a valid URL.")
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new LanguagePackError("Only http(s) URLs are supported.")
  }

  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS)
  let res: Response
  try {
    res = await fetch(parsed.toString(), { signal: controller.signal })
  } catch {
    throw new LanguagePackError(
      "Couldn't fetch (CORS/network) — download the file and upload it instead.",
    )
  } finally {
    clearTimeout(timeout)
  }

  if (!res.ok) {
    throw new LanguagePackError(
      `Couldn't fetch (HTTP ${res.status}) — download the file and upload it instead.`,
    )
  }

  // Enforce the size cap during download, not just from the declared header:
  // a chunked response omits Content-Length (Number(null) === 0, which would
  // pass a header-only check), so stream the body and abort once we exceed the
  // cap rather than buffering an arbitrarily large body into memory.
  const declared = Number(res.headers.get("content-length"))
  if (Number.isFinite(declared) && declared > MAX_PACK_BYTES) {
    controller.abort()
    throw new LanguagePackError(
      `Language pack is too large (max ${Math.round(MAX_PACK_BYTES / 1024)}KB)`,
    )
  }

  const text = await readCappedText(res, controller)
  const bundle = parseBundle(text)
  const installed = installPack(code, bundle)
  await selectLang(installed)
  return installed
}

// Read a response body, aborting if the running byte total exceeds the cap.
// Falls back to res.text() when the body isn't a readable stream (older
// environments / test mocks), where parseBundle's own byte check still applies.
async function readCappedText(
  res: Response,
  controller: AbortController,
): Promise<string> {
  const body = res.body
  if (!body || typeof body.getReader !== "function") {
    return res.text()
  }
  const reader = body.getReader()
  const chunks: Uint8Array[] = []
  let total = 0
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      if (value) {
        total += value.byteLength
        if (total > MAX_PACK_BYTES) {
          controller.abort()
          throw new LanguagePackError(
            `Language pack is too large (max ${Math.round(MAX_PACK_BYTES / 1024)}KB)`,
          )
        }
        chunks.push(value)
      }
    }
  } finally {
    reader.releaseLock()
  }
  const merged = new Uint8Array(total)
  let offset = 0
  for (const chunk of chunks) {
    merged.set(chunk, offset)
    offset += chunk.byteLength
  }
  return new TextDecoder().decode(merged)
}

// Subscribe to installed-pack changes (same-tab installs/removes and cross-tab
// storage events). Returns an unsubscribe function. Mirrors useTheme's storage
// listener, extended with same-tab notification for useSyncExternalStore.
export function subscribeToPackChanges(onChange: () => void): () => void {
  listeners.add(onChange)

  let removeStorage: () => void = () => {}
  if (typeof window !== "undefined") {
    const handler = (event: StorageEvent) => {
      if (event.key !== PACKS_STORAGE_KEY && event.key !== LANG_STORAGE_KEY) return
      // Reconcile this tab's i18next instance with the change another tab made:
      // add/remove bundles (hydratePacks) and apply the (possibly new) active
      // language. If the active language's pack was removed, fall back to the
      // base language so we never render a pack that's no longer installed.
      const installed = hydratePacks()
      const stored = getStoredLang()
      const target =
        stored !== BASE_LANG && !installed.includes(stored) ? BASE_LANG : stored
      if (target !== i18n.language) {
        void i18n.changeLanguage(target)
      }
    }
    window.addEventListener("storage", handler)
    removeStorage = () => window.removeEventListener("storage", handler)
  }

  return () => {
    listeners.delete(onChange)
    removeStorage()
  }
}

export { en as baseBundle }
