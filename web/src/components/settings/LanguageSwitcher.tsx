import { useMemo, useRef, useState } from "react"
import {
  Check,
  ChevronRight,
  Copy,
  Download,
  Loader2,
  Trash2,
  Upload,
  X,
} from "lucide-react"
import { useTranslation } from "react-i18next"

import { useLanguage } from "@/hooks/useLanguage"
import { useCopyToClipboard } from "@/hooks/useCopyToClipboard"
import {
  BASE_LANG,
  LanguagePackError,
  type PackPreview,
  type RegistryLanguage,
  UndetectableCodeError,
  languageLabel,
  shareUrlForLang,
} from "@/i18n/customLocale"

type AccordionSectionId = "share" | "installed" | "add" | "install"

// Settings UI for language packs. Uploading/fetching only *prepares* a pack
// (parse + preview); nothing applies until the user confirms.
export const LanguageSwitcher = ({
  onApplied,
}: {
  onApplied?: () => void
} = {}) => {
  const { t } = useTranslation()
  const {
    lang,
    availableLangs,
    installedLangs,
    setLang,
    prepareFromFile,
    prepareFromUrl,
    prepareFromBuiltIn,
    availableBuiltInLangs,
    commitPack,
    removePack,
    packCoverages,
  } = useLanguage()

  const [code, setCode] = useState("")
  const [url, setUrl] = useState("")
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [needsCode, setNeedsCode] = useState(false)
  const [preview, setPreview] = useState<PackPreview | null>(null)
  // Accordion: at most one section open at a time so the modal stays bounded.
  const [openSection, setOpenSection] = useState<AccordionSectionId | null>(
    null,
  )
  const [registry, setRegistry] = useState<RegistryLanguage[] | null>(null)
  const [registryBusy, setRegistryBusy] = useState(false)
  const [registryError, setRegistryError] = useState<string | null>(null)
  const [preparingCode, setPreparingCode] = useState<string | null>(null)
  const [shareCodeOverride, setShareCodeOverride] = useState<string | null>(
    null,
  )
  // Synchronous re-entry lock shared by all prepare entry points (file, URL,
  // built-in): `busy` is async React state, so a fast second click can fire
  // before it re-renders. A ref flips immediately. Owned by runPrepare.
  const preparingRef = useRef(false)

  const showError = (err: unknown) => {
    if (err instanceof UndetectableCodeError) {
      setNeedsCode(true)
      setError(t("language.errorCodeUndetectable"))
    } else if (err instanceof LanguagePackError) {
      setError(err.message)
    } else {
      setError(t("language.errorGeneric"))
    }
  }

  const runPrepare = async (
    prepare: () => Promise<PackPreview>,
    // The accordion section this prepare belongs to. On preview/error we keep it
    // open so the resulting preview/error card stays visually tied to its origin
    // (the cards render below all sections; a detached preview is confusing).
    section: "add" | "install",
  ) => {
    // Synchronous re-entry lock shared by all prepare entry points (file, URL,
    // built-in). `busy` is async React state, so a fast second click or an
    // overlapping URL/file prepare would otherwise race two fetches over the
    // shared preview and let the last fetch to resolve win — installing a pack
    // that isn't the one the user last chose. The ref flips immediately.
    if (preparingRef.current) return
    preparingRef.current = true
    setError(null)
    setPreview(null)
    setBusy(true)
    try {
      setPreview(await prepare())
      setOpenSection(section)
    } catch (err) {
      showError(err)
      setOpenSection(section)
    } finally {
      setBusy(false)
      preparingRef.current = false
    }
  }

  const handleFile = async (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0]
    event.target.value = "" // allow re-selecting the same file
    if (!file) return
    await runPrepare(
      () => prepareFromFile(file, code.trim() || undefined),
      "install",
    )
  }

  const handleUrl = async () => {
    if (!url.trim()) {
      setError(t("language.errorUrlRequired"))
      return
    }
    await runPrepare(
      () => prepareFromUrl(url.trim(), code.trim() || undefined),
      "install",
    )
  }

  // Lazily load the registry when Browse first opens; every language the
  // manifest lists is offered (the publish workflow only lists deployed packs).
  const loadRegistry = async () => {
    if (registry || registryBusy) return
    setRegistryBusy(true)
    setRegistryError(null)
    try {
      setRegistry(await availableBuiltInLangs())
    } catch (err) {
      setRegistryError(
        err instanceof LanguagePackError
          ? err.message
          : t("language.errorRegistry"),
      )
    } finally {
      setRegistryBusy(false)
    }
  }

  // Controlled accordion: driving the native <details> via its own toggle event
  // fights React's `open` prop (a closed section needs two clicks to open), so
  // we intercept the summary click and set the open section ourselves.
  const toggleSection = (
    event: React.MouseEvent,
    section: AccordionSectionId,
  ) => {
    event.preventDefault()
    const next = openSection === section ? null : section
    setOpenSection(next)
    if (next === "add") void loadRegistry()
  }

  const handleBuiltIn = async (builtInCode: string) => {
    // The re-entry lock now lives in runPrepare (shared across all entry
    // points), so a second concurrent click is a no-op there. Set preparingCode
    // for the per-row spinner; runPrepare's guard prevents the racing install.
    if (preparingRef.current) return
    setPreparingCode(builtInCode)
    try {
      await runPrepare(() => prepareFromBuiltIn(builtInCode), "add")
    } finally {
      setPreparingCode(null)
    }
  }

  const handleConfirm = async () => {
    if (!preview) return
    setBusy(true)
    try {
      await commitPack(preview.code, preview.bundle, {
        source: preview.source,
        version: preview.version,
        hash: preview.hash,
      })
      setPreview(null)
      setCode("")
      setUrl("")
      setNeedsCode(false)
      setError(null)
      onApplied?.()
    } catch (err) {
      showError(err)
    } finally {
      setBusy(false)
    }
  }

  const handleCancel = () => {
    setPreview(null)
    setError(null)
  }

  // Language to share: explicit pick, else the active language.
  const shareCode = shareCodeOverride ?? lang ?? BASE_LANG
  const shareUrl = shareUrlForLang(shareCode)

  const {
    copied: shareCopied,
    copy: copyShareUrl,
    reset: resetShareCopied,
  } = useCopyToClipboard(shareUrl ?? "")

  // One storage read for all installed packs (vs. one per pack), memoized so
  // unrelated re-renders (typing, accordion toggles, copy timer) don't re-parse
  // the whole localStorage pack store. installedLangs is a stable-identity
  // useSyncExternalStore snapshot, so it's a reliable memo key.
  const coverages = useMemo(
    () => (installedLangs.length > 0 ? packCoverages() : {}),
    [installedLangs, packCoverages],
  )

  // Registry languages not already installed — the ones worth offering.
  const offered = useMemo(() => {
    const installedSet = new Set(installedLangs)
    return (registry ?? []).filter((l) => !installedSet.has(l.code))
  }, [installedLangs, registry])

  return (
    <div className="flex flex-col gap-5">
      <div className="flex flex-col gap-1">
        <label className="label py-0" htmlFor="lang-select">
          <span className="label-text font-bold">
            {t("language.activeLabel")}
          </span>
        </label>
        <select
          id="lang-select"
          className="select select-bordered w-full"
          value={lang}
          onChange={(e) => void setLang(e.target.value)}
        >
          {availableLangs.map((c) => (
            <option key={c} value={c}>
              {c === BASE_LANG
                ? t("language.baseName")
                : languageLabel(c, lang)}
            </option>
          ))}
        </select>
      </div>

      <AccordionSection
        section="share"
        title={t("language.shareTitle")}
        open={openSection === "share"}
        onToggle={toggleSection}
      >
        <div className="flex flex-col gap-3">
          <p className="text-xs text-base-content/70">
            {t("language.shareHint")}
          </p>

          <div className="flex flex-col gap-1">
            <label className="label py-0" htmlFor="lang-share-select">
              <span className="label-text text-xs">
                {t("language.shareLanguageLabel")}
              </span>
            </label>
            <select
              id="lang-share-select"
              className="select select-bordered select-sm w-full"
              value={shareCode}
              onChange={(e) => {
                setShareCodeOverride(e.target.value)
                resetShareCopied()
              }}
            >
              {availableLangs.map((c) => (
                <option key={c} value={c}>
                  {c === BASE_LANG
                    ? t("language.baseName")
                    : languageLabel(c, lang)}
                </option>
              ))}
            </select>
          </div>

          <div className="flex flex-row gap-2">
            <input
              type="text"
              readOnly
              className="input input-bordered input-sm flex-1 min-w-0"
              value={shareUrl ?? ""}
              aria-label={t("language.shareUrlLabel")}
              onFocus={(e) => e.currentTarget.select()}
            />
            <button
              type="button"
              className="btn btn-sm btn-primary"
              onClick={() => void copyShareUrl()}
              disabled={!shareUrl}
            >
              {shareCopied ? (
                <Check className="size-4" aria-hidden="true" />
              ) : (
                <Copy className="size-4" aria-hidden="true" />
              )}
              {shareCopied
                ? t("language.shareCopied")
                : t("language.shareCopy")}
            </button>
          </div>
        </div>
      </AccordionSection>

      {installedLangs.length > 0 && (
        <AccordionSection
          section="installed"
          title={t("language.installedTitle")}
          open={openSection === "installed"}
          onToggle={toggleSection}
        >
          <ul className="menu bg-base-200 rounded-box max-h-56 w-full flex-nowrap gap-1 overflow-y-auto">
            {installedLangs.map((c) => {
              const cov = coverages[c]
              return (
                <li key={c}>
                  <div className="flex flex-row items-center justify-between">
                    <span className="flex items-center gap-2">
                      {languageLabel(c, lang)}
                      {cov !== undefined && cov < 1 && (
                        <span className="badge badge-ghost badge-sm">
                          {Math.round(cov * 100)}%
                        </span>
                      )}
                    </span>
                    <button
                      type="button"
                      className="btn btn-ghost btn-xs"
                      aria-label={t("language.removePack", { code: c })}
                      onClick={() => removePack(c)}
                    >
                      <Trash2 className="size-4" aria-hidden="true" />
                    </button>
                  </div>
                </li>
              )
            })}
          </ul>
        </AccordionSection>
      )}

      <AccordionSection
        section="add"
        title={t("language.browseTitle")}
        open={openSection === "add"}
        onToggle={toggleSection}
      >
        <div className="flex flex-col gap-3">
          <p className="text-xs text-base-content/70">
            {t("language.browseHint")}
          </p>

          {registryBusy && (
            <div className="flex items-center gap-2 text-sm text-base-content/70">
              <Loader2 className="size-4 animate-spin" aria-hidden="true" />
              {t("language.browseLoading")}
            </div>
          )}

          {registryError && (
            <div className="alert alert-error" role="alert">
              <span className="text-sm">{registryError}</span>
            </div>
          )}

          {!registryBusy &&
            !registryError &&
            registry !== null &&
            offered.length === 0 && (
              <p className="text-sm text-base-content/70">
                {t("language.browseEmpty")}
              </p>
            )}

          {offered.length > 0 && (
            <ul className="menu bg-base-200 rounded-box max-h-56 w-full flex-nowrap gap-1 overflow-y-auto">
              {offered.map((l) => (
                <li key={l.code}>
                  <button
                    type="button"
                    className="flex flex-row items-center justify-between"
                    onClick={() => void handleBuiltIn(l.code)}
                    disabled={busy}
                  >
                    <span>{languageLabel(l.code, lang)}</span>
                    {busy && preparingCode === l.code ? (
                      <Loader2
                        className="size-4 animate-spin"
                        aria-hidden="true"
                      />
                    ) : (
                      <Download className="size-4" aria-hidden="true" />
                    )}
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      </AccordionSection>

      <AccordionSection
        section="install"
        title={t("language.installTitle")}
        open={openSection === "install" || needsCode}
        onToggle={toggleSection}
      >
        <div className="flex flex-col gap-3">
          <p className="text-xs text-base-content/70">
            {t("language.installHint")}
          </p>

          {needsCode && (
            <div className="flex flex-col gap-1">
              <label className="label py-0" htmlFor="lang-code">
                <span className="label-text text-xs">
                  {t("language.codeOptionalLabel")}
                </span>
              </label>
              <input
                id="lang-code"
                type="text"
                className="input input-bordered input-sm w-full"
                placeholder={t("language.codePlaceholder")}
                value={code}
                onChange={(e) => setCode(e.target.value)}
                disabled={busy}
              />
            </div>
          )}

          <label className="btn btn-sm btn-outline w-full">
            {busy && !preview ? (
              <Loader2 className="size-4 animate-spin" aria-hidden="true" />
            ) : (
              <Upload className="size-4" aria-hidden="true" />
            )}
            {t("language.uploadFile")}
            <input
              type="file"
              accept="application/json,.json"
              className="hidden"
              onChange={(e) => void handleFile(e)}
              disabled={busy}
            />
          </label>

          <div className="flex flex-row gap-2">
            <input
              type="url"
              className="input input-bordered input-sm flex-1 min-w-0"
              placeholder={t("language.urlPlaceholder")}
              value={url}
              onChange={(e) => setUrl(e.target.value)}
              disabled={busy}
            />
            <button
              type="button"
              className="btn btn-sm btn-primary"
              onClick={() => void handleUrl()}
              disabled={busy}
            >
              {t("language.fetch")}
            </button>
          </div>
        </div>
      </AccordionSection>

      {preview && (
        <div className="flex flex-col gap-3 rounded-box border border-base-300 bg-base-100 p-4">
          <div className="flex items-center justify-between">
            <span className="font-bold">
              {t("language.previewTitle", {
                code: languageLabel(preview.code, lang),
              })}
            </span>
            <span className="badge badge-ghost badge-sm">
              {t("language.previewCoverage", {
                percent: Math.round(preview.coverage * 100),
                keys: preview.keyCount,
              })}
            </span>
          </div>
          {preview.sample.length > 0 && (
            <div className="flex flex-col gap-1">
              <span className="text-xs font-semibold text-base-content/70">
                {t("language.previewSampleLabel")}
              </span>
              <ul className="list-disc pl-5 text-sm text-base-content/80">
                {preview.sample.map((s, i) => (
                  <li key={i}>{s}</li>
                ))}
              </ul>
            </div>
          )}
          <div className="flex flex-row justify-end gap-2">
            <button
              type="button"
              className="btn btn-sm btn-ghost"
              onClick={handleCancel}
              disabled={busy}
            >
              <X className="size-4" aria-hidden="true" />
              {t("language.previewCancel")}
            </button>
            <button
              type="button"
              className="btn btn-sm btn-primary"
              onClick={() => void handleConfirm()}
              disabled={busy}
            >
              {busy ? (
                <Loader2 className="size-4 animate-spin" aria-hidden="true" />
              ) : (
                <Check className="size-4" aria-hidden="true" />
              )}
              {t("language.previewConfirm", { code: preview.code })}
            </button>
          </div>
        </div>
      )}

      {error && (
        <div className="alert alert-error" role="alert">
          <span className="text-sm">{error}</span>
        </div>
      )}
    </div>
  )
}

export default LanguageSwitcher

// Shared shell for the collapsible sections: a controlled native <details> with
// a rotating chevron. `open` stays an explicit prop so a section can widen its
// open condition (e.g. install also opens when a code is needed).
const AccordionSection = ({
  section,
  title,
  open,
  onToggle,
  children,
}: {
  section: AccordionSectionId
  title: string
  open: boolean
  onToggle: (event: React.MouseEvent, section: AccordionSectionId) => void
  children: React.ReactNode
}) => (
  <details
    className="collapse border border-base-300 rounded-box bg-base-100"
    open={open}
  >
    <summary
      className="collapse-title flex items-center gap-2 text-sm font-bold [&::-webkit-details-marker]:hidden"
      onClick={(e) => onToggle(e, section)}
    >
      <ChevronRight
        className={`size-4 transition-transform ${open ? "rotate-90" : ""}`}
        aria-hidden="true"
      />
      {title}
    </summary>
    <div className="collapse-content">{children}</div>
  </details>
)
