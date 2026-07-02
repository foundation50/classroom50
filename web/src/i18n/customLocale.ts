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

// Language code: a BCP-47-ish token (letters, digits, hyphen). Deliberately
// permissive but bounded so a pasted code can't smuggle in odd characters.
const langCodeSchema = z
  .string()
  .trim()
  .min(2)
  .max(35)
  .regex(/^[A-Za-z0-9-]+$/, "Language code may only contain letters, digits, and hyphens")

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

// Register every valid stored pack with i18next. Called at startup and on
// cross-tab storage events.
export function hydratePacks(): string[] {
  const packs = readStoredPacks()
  for (const pack of Object.values(packs)) {
    registerPack(pack)
  }
  refreshSnapshot()
  return Object.keys(packs)
}

// Install (or replace) a pack: register it and persist. Returns the code.
export function installPack(codeInput: string, bundle: FlatBundle): string {
  const code = normalizeLangCode(codeInput)
  if (code === BASE_LANG) {
    throw new LanguagePackError(`"${BASE_LANG}" is the built-in base language and can't be replaced.`)
  }
  const pack: LanguagePack = { code, bundle }
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

  const declared = Number(res.headers.get("content-length"))
  if (Number.isFinite(declared) && declared > MAX_PACK_BYTES) {
    throw new LanguagePackError(
      `Language pack is too large (max ${Math.round(MAX_PACK_BYTES / 1024)}KB)`,
    )
  }

  const text = await res.text()
  const bundle = parseBundle(text)
  const installed = installPack(code, bundle)
  await selectLang(installed)
  return installed
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
      hydratePacks()
      refreshSnapshot()
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
