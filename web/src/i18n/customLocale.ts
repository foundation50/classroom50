import i18n from "i18next"
import { z } from "zod"

import en from "@/locales/en.json"

// Sideloadable language packs: English is the bundled base; users install extra
// languages at runtime (file/URL) and switch between them. Stored packs are
// untrusted user JSON, so every entry point enforces a size cap, shape/key-count
// check, and re-validation on rehydration.

export const LANG_STORAGE_KEY = "classroom50:lang"
export const PACKS_STORAGE_KEY = "classroom50:custom-locales"

export const BASE_LANG = "en"

export const NAMESPACE = "translation"

// Guardrails against oversized input freezing the tab or blowing the ~5MB
// localStorage origin budget (shared across all installed packs).
export const MAX_PACK_BYTES = 512 * 1024
export const MAX_PACK_KEYS = 5000

// Registry of machine-generated + human-reviewed packs, served from the
// classroom50-language-packs repo via GitHub Pages. Base URL is overridable for
// forks; it hosts one `<code>.json` per language plus an `index.json` manifest.
export const LANGUAGE_REGISTRY_BASE_URL = (
  import.meta.env.VITE_LANGUAGE_REGISTRY_URL ||
  "https://fifty.foundation/classroom50-language-packs"
).replace(/\/+$/, "")

const REGISTRY_INDEX_URL = `${LANGUAGE_REGISTRY_BASE_URL}/index.json`

// The manifest is a small JSON list; anything larger is suspect.
const MAX_REGISTRY_BYTES = 64 * 1024

// Dotted keys to translated strings, e.g. { "notFound.title": "..." }. Nested
// JSON is accepted on input and flattened before validation.
export type FlatBundle = Record<string, string>

// Where an installed pack came from. Only "registry" packs auto-refresh; a
// user's hand-loaded pack is never touched, even if its code is in the
// registry. Legacy packs (no source field) read as "user", so never clobbered.
export type PackSource = "registry" | "user"

// Provenance + registry update markers carried alongside a pack: from loader to
// preview to install. Defaults to user-sourced when the source is omitted.
export type PackMeta = { source?: PackSource; version?: string; hash?: string }

export type LanguagePack = {
  code: string
  bundle: FlatBundle
  // Origin; defaults to "user" on read for legacy stored packs.
  source: PackSource
  // Registry-pack update markers captured at install: skip a re-download when
  // unchanged. Absent for user packs.
  version?: string
  hash?: string
  // Unknown fields written by a newer release are preserved on read-modify-write
  // (packSchema is .loose()), so an older release never drops forward-compat data.
  [extra: string]: unknown
}

// BCP-47-ish tag: 2-3 letter primary subtag plus optional `-` subtags. Rejects
// codes like "123" that pass a looser check but make Intl throw a RangeError.
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

const packSchema = z
  .object({
    code: langCodeSchema,
    bundle: flatBundleSchema,
    // Legacy packs (stored before this field) parse as "user" via the default, so
    // an existing pack is never mistaken for a registry pack and auto-overwritten.
    source: z.enum(["registry", "user"]).default("user"),
    version: z.string().max(200).optional(),
    hash: z.string().max(200).optional(),
  })
  // Preserve unknown keys so a field added by a newer release survives an older
  // release's read-modify-write (installPack/removePack rewrite the whole store).
  .loose()

const storedPacksSchema = z.record(z.string(), packSchema)

// Shape of the registry's index.json: { "languages": [{ "code": "ja" }, ...] }.
// Unknown/invalid entries are tolerated per-item so one bad row doesn't sink
// the whole list. `version`/`hash` are optional update markers.
const registryEntrySchema = z.object({
  code: langCodeSchema,
  version: z.string().max(200).optional(),
  hash: z.string().max(200).optional(),
})
const registrySchema = z.object({
  languages: z.array(z.unknown()),
})

export type RegistryLanguage = {
  code: string
  version?: string
  hash?: string
}

export class LanguagePackError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "LanguagePackError"
  }
}

// Thrown when no code was supplied and none could be inferred. The UI catches
// this specifically to reveal the code input.
export class UndetectableCodeError extends LanguagePackError {
  constructor(message = "Couldn't detect the language code — enter it below.") {
    super(message)
    this.name = "UndetectableCodeError"
  }
}

// Flatten nested JSON into dotted keys. Rejects non-string leaves so a pack
// can't inject objects/arrays where i18next expects a string.
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

// react-i18next's <Trans> parses translated strings as HTML and merges any
// attributes found on a marker tag onto the mapped component — with the
// pack's attributes winning. A hostile pack value like
// `<repoLink href="https://evil.example">` would repoint a trusted link
// (phishing; React blocks javascript: hrefs, so scripts are not reachable).
// Our own locale contract is bare markers only (<repo>, </repo>, <hint/>;
// see verify_locale.py).
//
// Validate with an allowlist, not a denylist: extract every angle-bracket tag
// and require each to be a bare marker. A denylist keyed on `name\s+attr` let
// `<repoLink/ href="…">` slip through — html-parse-stringify (the parser
// <Trans> uses) treats `/` as an attribute separator too, so it still
// extracted a clean `href`. Matching only the exact bare-marker shape rejects
// any tag carrying anything beyond an optional self-closing slash, closing
// that and any future tokenizer-shape gap by construction. `<owner>/<repo>`
// (two bare tags) and non-tag text like "< 1 day" pass; "<a href=…>",
// "<a/href=…>", and newline/tab-bearing tags are rejected.
const TAG_RE = /<[^>]*>/g
const BARE_MARKER_RE = /^<\/?[a-zA-Z][\w-]*\s*\/?>$/

function hasAttributeMarker(value: string): boolean {
  const tags = value.match(TAG_RE)
  return tags !== null && tags.some((tag) => !BARE_MARKER_RE.test(tag))
}

// Parse + validate raw JSON. Enforces the byte cap before parsing so an
// oversized string never reaches JSON.parse.
export function parseBundle(text: string): FlatBundle {
  if (byteLength(text) > MAX_PACK_BYTES) {
    throw tooLargeError()
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
    throw new LanguagePackError(
      result.error.issues[0]?.message ?? "Invalid language pack",
    )
  }
  for (const [key, value] of Object.entries(result.data)) {
    if (hasAttributeMarker(value)) {
      throw new LanguagePackError(
        `Value at "${key}" contains a markup tag with attributes — ` +
          `only bare tags like <name>…</name> are allowed`,
      )
    }
  }
  return result.data
}

export function normalizeLangCode(code: string): string {
  const result = langCodeSchema.safeParse(code)
  if (!result.success) {
    throw new LanguagePackError(
      result.error.issues[0]?.message ?? "Invalid language code",
    )
  }
  return result.data
}

// Label for a language code, e.g. "Japanese (ja)". Falls back to the bare code
// when Intl.DisplayNames is unavailable or can't resolve the tag.
export function languageLabel(code: string, uiLocale?: string): string {
  const name = languageName(code, uiLocale)
  return name ? `${name} (${code})` : code
}

// Common name for a language code (localized to uiLocale, defaulting to the
// active language), or null when it can't be resolved.
function languageName(code: string, uiLocale?: string): string | null {
  if (typeof Intl === "undefined" || typeof Intl.DisplayNames !== "function") {
    return null
  }
  try {
    const locale = uiLocale || i18n.language || BASE_LANG
    const display = new Intl.DisplayNames([locale], { type: "language" })
    const name = display.of(code)
    // DisplayNames returns the input unchanged when it can't resolve the tag.
    return name && name !== code ? name : null
  } catch {
    return null
  }
}

// Infer a language code from a file name / URL: the last path segment minus a
// `.json` extension, if it's a valid code. `de.json` -> "de", `zh-CN.json` ->
// "zh-CN", `translation.json` -> null.
export function inferLangCode(source: string): string | null {
  if (!source) return null
  const withoutQuery = source.split(/[?#]/)[0] ?? ""
  const segment = withoutQuery.split("/").pop() ?? ""
  const base = segment.replace(/\.json$/i, "").trim()
  if (!base) return null
  const result = langCodeSchema.safeParse(base)
  return result.success ? result.data : null
}

function byteLength(text: string): number {
  if (typeof TextEncoder !== "undefined") {
    return new TextEncoder().encode(text).length
  }
  // Node fallback for the test environment.
  return Buffer.byteLength(text, "utf8")
}

function tooLargeError(subject = "Language pack"): LanguagePackError {
  return new LanguagePackError(
    `${subject} is too large (max ${Math.round(MAX_PACK_BYTES / 1024)}KB)`,
  )
}

// ---- Storage ----------------------------------------------------------------

function getStorage(): Storage | null {
  try {
    return typeof window !== "undefined" ? window.localStorage : null
  } catch {
    return null
  }
}

// Read + re-validate all persisted packs; untrusted storage is not trusted, so
// anything failing validation is dropped rather than registered.
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

// The language that will actually activate at startup: the stored choice only
// counts if its pack is still installed (packs can be removed between visits,
// or rejected on rehydration). Must stay the same predicate as the startup
// changeLanguage guard in i18n/index.ts — document direction is seeded from
// this BEFORE that chain runs, and a mismatch would flash or strand the wrong
// direction.
export function resolveStartupLang(
  stored: string,
  installed: readonly string[],
): string {
  return stored !== BASE_LANG && installed.includes(stored) ? stored : BASE_LANG
}

// ---- Registration -----------------------------------------------------------

// Stable-identity snapshots so useSyncExternalStore doesn't loop: a new array
// is created only when the set of installed packs actually changes.
let installedSnapshot: string[] = []
let availableSnapshot: string[] = [BASE_LANG]
const listeners = new Set<() => void>()

// Callers that already read storage pass their codes to avoid a second
// JSON.parse + re-validation pass.
function refreshSnapshot(codes = Object.keys(readStoredPacks())): void {
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

// Register stored packs with i18next, dropping bundles whose pack is gone (e.g.
// removed in another tab). Runs at startup and on cross-tab storage events.
export function hydratePacks(): string[] {
  const packs = readStoredPacks()
  const codes = Object.keys(packs)
  for (const code of installedSnapshot) {
    if (!(code in packs)) {
      i18n.removeResourceBundle(code, NAMESPACE)
    }
  }
  for (const pack of Object.values(packs)) {
    registerPack(pack)
  }
  refreshSnapshot(codes)
  return codes
}

// Install (or replace) a pack: register it and persist. Returns the code.
// `meta` records provenance + registry update markers; defaults to user-sourced.
export function installPack(
  codeInput: string,
  bundle: FlatBundle,
  meta?: PackMeta,
): string {
  const code = normalizeLangCode(codeInput)
  if (code === BASE_LANG) {
    throw new LanguagePackError(
      `"${BASE_LANG}" is the built-in base language and can't be replaced.`,
    )
  }
  const pack: LanguagePack = {
    code,
    bundle,
    source: meta?.source ?? "user",
    ...(meta?.version ? { version: meta.version } : {}),
    ...(meta?.hash ? { hash: meta.hash } : {}),
  }
  // Re-read before writing so a concurrent install in another tab isn't
  // clobbered by a stale snapshot (lost update on read-modify-write).
  const packs = readStoredPacks()
  packs[code] = pack
  writeStoredPacks(packs)
  registerPack(pack)
  refreshSnapshot(Object.keys(packs))
  return code
}

export function removePack(code: string): void {
  const packs = readStoredPacks()
  if (!(code in packs)) return
  delete packs[code]
  writeStoredPacks(packs)
  i18n.removeResourceBundle(code, NAMESPACE)
  refreshSnapshot(Object.keys(packs))
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

// Base keys that a pack should translate. Missing keys fall back to English at
// runtime, so this is a completeness signal, not an error.
export function missingKeys(bundle: FlatBundle): string[] {
  return baseKeys.filter((key) => !(key in bundle))
}

// Fraction of base keys a pack covers, 0..1.
export function coverage(bundle: FlatBundle): number {
  if (baseKeys.length === 0) return 1
  const translated = baseKeys.length - missingKeys(bundle).length
  return translated / baseKeys.length
}

// Coverage for every installed pack, keyed by code. Reads storage once so a UI
// listing N packs doesn't re-parse + re-validate the whole store N times.
export function packCoverages(): Record<string, number> {
  const packs = readStoredPacks()
  const out: Record<string, number> = {}
  for (const [code, pack] of Object.entries(packs)) {
    out[code] = coverage(pack.bundle)
  }
  return out
}

// Origin of each installed pack, so the UI can distinguish ready-made registry
// packs from ones the user hand-loaded (file/URL).
export function packSources(): Record<string, PackSource> {
  const packs = readStoredPacks()
  const out: Record<string, PackSource> = {}
  for (const [code, pack] of Object.entries(packs)) {
    out[code] = pack.source
  }
  return out
}

// Switch the active language and persist the choice.
export async function selectLang(code: string): Promise<void> {
  const next = code === BASE_LANG ? BASE_LANG : normalizeLangCode(code)
  setStoredLang(next)
  await i18n.changeLanguage(next)
}

// ---- Loaders ----------------------------------------------------------------

// A parsed-but-not-yet-installed pack. Lets the UI preview and confirm before
// anything touches localStorage or i18next.
export type PackPreview = {
  code: string
  bundle: FlatBundle
  coverage: number
  keyCount: number
  sample: string[]
  // Provenance + update markers carried from loader to commit time.
  source: PackSource
  version?: string
  // Manifest hash when available, else a computed content hash — always set.
  hash: string
}

// Sample keys shown in the preview so the user sees real translated text before
// applying (core classroom vocabulary plus a common action).
const SAMPLE_KEYS = [
  "nav.roleTeacher",
  "nav.roleStudent",
  "nav.myClasses",
  "nav.assignment",
  "common.save",
] as const

// Order-independent content hash of a flat bundle (FNV-1a over sorted
// key=value pairs). The fallback update signal when the manifest has no hash.
export function hashBundle(bundle: FlatBundle): string {
  const serialized = Object.keys(bundle)
    .sort()
    .map((key) => `${key}=${bundle[key]}`)
    .join("\u0000")
  let h = 0x811c9dc5
  for (let i = 0; i < serialized.length; i++) {
    h ^= serialized.charCodeAt(i)
    h = Math.imul(h, 0x01000193)
  }
  return (h >>> 0).toString(16)
}

function buildPreview(
  code: string,
  bundle: FlatBundle,
  meta?: PackMeta,
): PackPreview {
  const sample = SAMPLE_KEYS.map((key) => bundle[key]).filter(
    (value): value is string => typeof value === "string",
  )
  return {
    code,
    bundle,
    coverage: coverage(bundle),
    keyCount: Object.keys(bundle).length,
    sample,
    source: meta?.source ?? "user",
    ...(meta?.version ? { version: meta.version } : {}),
    // Manifest hash if supplied, else the computed content hash.
    hash: meta?.hash ?? hashBundle(bundle),
  }
}

// Resolve the code from an explicit value or by inferring it from the source.
// Throws when neither yields a valid code.
function resolveCode(explicit: string | undefined, source: string): string {
  const typed = explicit?.trim()
  if (typed) return normalizeLangCode(typed)
  const inferred = inferLangCode(source)
  if (inferred) return inferred
  throw new UndetectableCodeError()
}

// Parse a file into a preview without persisting or switching. Code is inferred
// from the file name when omitted.
export async function prepareFromFile(
  file: File,
  code?: string,
): Promise<PackPreview> {
  if (file.size > MAX_PACK_BYTES) {
    throw tooLargeError("File")
  }
  const resolved = resolveCode(code, file.name)
  const text = await file.text()
  const bundle = parseBundle(text)
  return buildPreview(resolved, bundle)
}

const FETCH_TIMEOUT_MS = 10_000

// Fetch a pack from a URL into a preview. Requires http/https, bounds the
// response size, times out, and maps every failure to a LanguagePackError. Code
// is inferred from the URL's last path segment when omitted. `requireHttps`
// rejects cleartext http (used by the unattended auto-refresh path).
export async function prepareFromUrl(
  url: string,
  code?: string,
  options?: { requireHttps?: boolean },
): Promise<PackPreview> {
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    throw new LanguagePackError("Enter a valid URL.")
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new LanguagePackError("Only http(s) URLs are supported.")
  }
  if (options?.requireHttps && parsed.protocol !== "https:") {
    throw new LanguagePackError("Only https URLs are supported here.")
  }

  const resolved = resolveCode(code, parsed.pathname)

  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS)
  try {
    let res: Response
    try {
      res = await fetch(parsed.toString(), { signal: controller.signal })
    } catch {
      throw new LanguagePackError(
        "Couldn't fetch (CORS/network) — download the file and upload it instead.",
      )
    }

    if (!res.ok) {
      throw new LanguagePackError(
        `Couldn't fetch (HTTP ${res.status}) — download the file and upload it instead.`,
      )
    }

    // A chunked response omits Content-Length (Number(null) === 0 passes a
    // header-only check), so also enforce the cap while streaming (below).
    const declared = Number(res.headers.get("content-length"))
    if (Number.isFinite(declared) && declared > MAX_PACK_BYTES) {
      controller.abort()
      throw tooLargeError()
    }

    // Keep the timeout armed across the body read: clearing it once headers
    // arrive would leave a slow-drip response (bytes trickled under the cap)
    // with no deadline, hanging the stream read indefinitely.
    const text = await readCappedText(res, controller)
    const bundle = parseBundle(text)
    return buildPreview(resolved, bundle)
  } finally {
    clearTimeout(timeout)
  }
}

// ---- Built-in registry ------------------------------------------------------

// Short-lived memoization of the manifest fetch: startup refresh and the Browse
// dialog both hit index.json. Only successful results cache (a failure must not
// poison later calls); an in-flight promise dedupes concurrent callers.
const REGISTRY_CACHE_TTL_MS = 30_000
let registryCache: { at: number; langs: RegistryLanguage[] } | null = null
let registryInFlight: Promise<RegistryLanguage[]> | null = null

// Test-only: clear the memo so a per-test fetch mock isn't shadowed by a cached
// result (vitest doesn't isolate tests within a file). Call in beforeEach.
export function resetRegistryCache(): void {
  registryCache = null
  registryInFlight = null
}

// Fetch the manifest and return the offered language codes, memoized. Invalid
// entries are skipped; a fetch/parse failure throws LanguagePackError for the
// UI to show.
export function fetchRegistry(): Promise<RegistryLanguage[]> {
  if (registryInFlight) return registryInFlight
  if (registryCache && Date.now() - registryCache.at < REGISTRY_CACHE_TTL_MS) {
    return Promise.resolve(registryCache.langs)
  }
  const request = fetchRegistryUncached()
    .then((langs) => {
      registryCache = { at: Date.now(), langs }
      return langs
    })
    .finally(() => {
      registryInFlight = null
    })
  registryInFlight = request
  return request
}

// Fetch the manifest and return the offered language codes. Invalid entries are
// skipped; a fetch/parse failure throws LanguagePackError for the UI to show.
async function fetchRegistryUncached(): Promise<RegistryLanguage[]> {
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS)
  try {
    let res: Response
    try {
      res = await fetch(REGISTRY_INDEX_URL, { signal: controller.signal })
    } catch {
      throw new LanguagePackError(
        "Couldn't reach the language registry — check your connection or try again.",
      )
    }

    if (!res.ok) {
      throw new LanguagePackError(
        `Couldn't load the language registry (HTTP ${res.status}).`,
      )
    }

    const declared = Number(res.headers.get("content-length"))
    if (Number.isFinite(declared) && declared > MAX_REGISTRY_BYTES) {
      controller.abort()
      throw new LanguagePackError("Language registry manifest is too large.")
    }

    // Keep the timeout armed across the streaming read (see prepareFromUrl).
    let text: string
    try {
      text = await readCappedText(res, controller, MAX_REGISTRY_BYTES)
    } catch {
      throw new LanguagePackError("Language registry manifest is too large.")
    }

    let json: unknown
    try {
      json = JSON.parse(text)
    } catch {
      throw new LanguagePackError(
        "Language registry manifest is not valid JSON.",
      )
    }

    const parsed = registrySchema.safeParse(json)
    if (!parsed.success) {
      throw new LanguagePackError("Language registry manifest is malformed.")
    }

    // Keep well-formed entries, drop the base language, dedupe.
    const seen = new Set<string>()
    const langs: RegistryLanguage[] = []
    for (const entry of parsed.data.languages) {
      const one = registryEntrySchema.safeParse(entry)
      if (!one.success) continue
      const { code, version, hash } = one.data
      if (code === BASE_LANG || seen.has(code)) continue
      seen.add(code)
      langs.push({ code, version, hash })
    }
    return langs
  } finally {
    clearTimeout(timeout)
  }
}

// Build the registry URL for a language pack.
function packUrl(code: string): string {
  return `${LANGUAGE_REGISTRY_BASE_URL}/${code}.json`
}

// Languages offered for install: exactly what the registry manifest lists. The
// publish workflow builds index.json from the packs it actually deploys, so a
// listed code always resolves — no per-pack probe needed (an earlier HEAD-probe
// pass silently dropped languages when a cross-origin HEAD hiccuped).
export async function availableBuiltInLangs(): Promise<RegistryLanguage[]> {
  return fetchRegistry()
}

// Preview a registry language by reusing the URL loader (same size/timeout/
// validation guardrails). Pass `requireHttps` for the silent auto-refresh path,
// and `entry` (the manifest row) to stamp the registry source + version/hash.
export async function prepareFromBuiltIn(
  code: string,
  options?: { requireHttps?: boolean; entry?: RegistryLanguage },
): Promise<PackPreview> {
  const resolved = normalizeLangCode(code)
  const preview = await prepareFromUrl(packUrl(resolved), resolved, {
    requireHttps: options?.requireHttps,
  })
  const version = options?.entry?.version
  const manifestHash = options?.entry?.hash
  return {
    ...preview,
    source: "registry",
    ...(version ? { version } : {}),
    // Manifest hash if present, else the computed content hash.
    hash: manifestHash ?? preview.hash,
  }
}

// Install and activate a previewed pack — the only step that mutates
// localStorage and i18next. Pass the preview's provenance/markers.
export async function commitPack(
  code: string,
  bundle: FlatBundle,
  meta?: PackMeta,
): Promise<string> {
  const installed = installPack(code, bundle, meta)
  await selectLang(installed)
  return installed
}

// Commit a previewed pack, carrying its provenance/markers. The one owner of
// PackPreview -> commitPack, so callers don't re-spread source/version/hash.
export async function commitPreview(preview: PackPreview): Promise<string> {
  return commitPack(preview.code, preview.bundle, {
    source: preview.source,
    version: preview.version,
    hash: preview.hash,
  })
}

// ---- Auto-refresh + update notifications ------------------------------------

// Listeners for codes updated by refreshInstalledPacks. Bridges the non-React
// startup refresh to a toast: startup runs before mount, so codes updated then
// are buffered and flushed to the first subscriber.
const updateListeners = new Set<(codes: string[]) => void>()
let pendingUpdatedCodes: string[] = []

function emitPackUpdates(codes: string[]): void {
  if (codes.length === 0) return
  if (updateListeners.size === 0) {
    // No subscriber yet (startup before mount) — buffer for the first one.
    pendingUpdatedCodes = [...pendingUpdatedCodes, ...codes]
    return
  }
  for (const listener of updateListeners) listener(codes)
}

// Subscribe to auto-update events, immediately flushing any buffered codes.
// Returns an unsubscribe fn.
export function subscribeToPackUpdates(
  onUpdate: (codes: string[]) => void,
): () => void {
  updateListeners.add(onUpdate)
  if (pendingUpdatedCodes.length > 0) {
    const buffered = pendingUpdatedCodes
    pendingUpdatedCodes = []
    onUpdate(buffered)
  }
  return () => {
    updateListeners.delete(onUpdate)
  }
}

// Whether the registry copy warrants refetching the pack. Compare markers
// (version, else hash) so an unchanged pack costs no download; with neither
// marker, fall through to fetch (the post-download bundlesEqual check still
// prevents a needless overwrite).
function registryPackChanged(
  installed: LanguagePack,
  entry: RegistryLanguage,
): boolean {
  if (entry.version && installed.version) {
    return entry.version !== installed.version
  }
  if (entry.hash && installed.hash) {
    return entry.hash !== installed.hash
  }
  return true
}

// Silent background refresh: re-fetch each installed registry pack whose marker
// changed and overwrite in place. Only source==="registry" packs are eligible.
// Every failure is swallowed so a flaky network never wipes a working pack.
// Returns (and emits) the updated codes. Never changes the active language;
// installPack -> addResourceBundle live-updates the active pack's strings.
export async function refreshInstalledPacks(): Promise<string[]> {
  const packs = readStoredPacks()
  const registryPacks = Object.values(packs).filter(
    (p) => p.source === "registry",
  )
  if (registryPacks.length === 0) return []

  let offered: RegistryLanguage[]
  try {
    offered = await fetchRegistry()
  } catch {
    // Offline / registry unreachable — keep everything as-is.
    return []
  }
  const byCode = new Map(offered.map((l) => [l.code, l]))

  const updated: string[] = []
  for (const pack of registryPacks) {
    const entry = byCode.get(pack.code)
    if (!entry) continue // no longer offered — leave the installed copy.
    if (!registryPackChanged(pack, entry)) continue // cheap skip, no fetch.
    try {
      const preview = await prepareFromBuiltIn(pack.code, {
        requireHttps: true,
        entry,
      })
      // The per-pack fetch above is an await window in which another tab may
      // have removed this pack. Re-read storage and skip if it's gone, so we
      // don't resurrect a pack the user just deleted elsewhere (installPack
      // does its own read-modify-write and would otherwise re-add the code).
      if (!(pack.code in readStoredPacks())) continue
      // Content identical despite a changed marker: refresh the stored marker
      // quietly (stop refetching) but don't toast.
      if (bundlesEqual(preview.bundle, pack.bundle)) {
        installPack(pack.code, pack.bundle, {
          source: "registry",
          version: preview.version,
          hash: preview.hash,
        })
        continue
      }
      installPack(pack.code, preview.bundle, {
        source: "registry",
        version: preview.version,
        hash: preview.hash,
      })
      updated.push(pack.code)
    } catch {
      // One pack failing must not abort the rest or wipe the existing pack.
    }
  }

  emitPackUpdates(updated)
  return updated
}

// Order-independent equality of two flat bundles: same keys, same values.
function bundlesEqual(a: FlatBundle, b: FlatBundle): boolean {
  const aKeys = Object.keys(a)
  if (aKeys.length !== Object.keys(b).length) return false
  for (const key of aKeys) {
    if (a[key] !== b[key]) return false
  }
  return true
}

// ---- Deep-link (?lang=) -----------------------------------------------------

export const LANG_QUERY_PARAM = "lang"

// Build a shareable URL that deep-links a language: current origin + path with
// `?lang=<code>` set. Opening it applies that language (see applyLangFromQuery).
export function shareUrlForLang(code: string): string | null {
  if (typeof window === "undefined") return null
  try {
    const url = new URL(window.location.href)
    // Clean landing URL: keep origin + path, set only the language.
    url.search = ""
    url.hash = ""
    url.searchParams.set(LANG_QUERY_PARAM, normalizeLangCode(code))
    return url.toString()
  } catch {
    return null
  }
}

// Apply a `?lang=<code>` deep link so a shared URL lands the visitor in that
// language and makes it their new active language: `en` and already-installed
// codes just switch; otherwise the code must be offered by the registry, then
// its pack is fetched, installed, and activated. The chosen language is
// persisted (via selectLang -> setStoredLang), so it sticks across reloads —
// this is a durable switch, not a one-visit override. The param is stripped
// afterward (win or fail) so a reload doesn't re-fire it. Errors are swallowed
// — a shared link must never break the app. No-op when the param is absent.
export async function applyLangFromQuery(): Promise<void> {
  if (typeof window === "undefined") return

  let requested: string | null
  try {
    requested = new URL(window.location.href).searchParams.get(LANG_QUERY_PARAM)
  } catch {
    return
  }
  if (!requested) return

  const stripParam = () => {
    try {
      const url = new URL(window.location.href)
      url.searchParams.delete(LANG_QUERY_PARAM)
      window.history.replaceState(
        window.history.state,
        "",
        url.pathname + url.search + url.hash,
      )
    } catch {
      // A stale param is harmless beyond re-running this once.
    }
  }

  try {
    const parsed = langCodeSchema.safeParse(requested.trim())
    if (!parsed.success) return
    const code = parsed.data

    if (code === BASE_LANG) {
      await selectLang(BASE_LANG)
      return
    }

    // Already installed — switch without a network call.
    if (installedSnapshot.includes(code) || code in readStoredPacks()) {
      await selectLang(code)
      return
    }

    // Only honor codes the registry offers, then fetch + install + activate.
    const offered = await fetchRegistry()
    const entry = offered.find((l) => l.code === code)
    if (!entry) return
    const preview = await prepareFromBuiltIn(code, { entry })
    await commitPreview(preview)
  } catch {
    // Invalid code, unavailable pack, or network failure — stay put.
  } finally {
    stripParam()
  }
}

// Read a response body, aborting if the running byte total exceeds the cap.
// Falls back to res.text() when the body isn't a readable stream (test mocks).
async function readCappedText(
  res: Response,
  controller: AbortController,
  cap: number = MAX_PACK_BYTES,
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
        if (total > cap) {
          controller.abort()
          throw tooLargeError()
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
// storage events). Returns an unsubscribe function.
export function subscribeToPackChanges(onChange: () => void): () => void {
  listeners.add(onChange)

  let removeStorage: () => void = () => {}
  if (typeof window !== "undefined") {
    const handler = (event: StorageEvent) => {
      if (event.key !== PACKS_STORAGE_KEY && event.key !== LANG_STORAGE_KEY)
        return
      // Reconcile with another tab's change. If the active language's pack was
      // removed elsewhere, fall back to base so we never render a missing pack.
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
