import { useMemo, useRef, useState } from "react"
import {
  Check,
  ChevronRight,
  Copy,
  Loader2,
  Trash2,
  Upload,
  X,
} from "lucide-react"
import { useTranslation } from "react-i18next"

import { AnimatedAlert, Button, rtlFlip } from "@/components/ui"
import { useLanguage } from "@/hooks/useLanguage"
import { useLanguageRegistry } from "@/hooks/useLanguageRegistry"
import { useCopyToClipboard } from "@/hooks/useCopyToClipboard"
import {
  BASE_LANG,
  LanguagePackError,
  type PackPreview,
  UndetectableCodeError,
  languageLabel,
  shareUrlForLang,
} from "@/i18n/customLocale"

type AccordionSectionId = "share" | "installed" | "install"

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
    commitPreview,
    removePack,
    packCoverages,
    packSources,
  } = useLanguage()
  const {
    offered,
    error: registryError,
    installAndActivate,
  } = useLanguageRegistry()

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
  const [shareCodeOverride, setShareCodeOverride] = useState<string | null>(
    null,
  )
  // Set while the active-language dropdown installs a not-yet-installed
  // registry pack, so the select can show it's working and stay disabled.
  const [installingSelected, setInstallingSelected] = useState(false)
  // Synchronous re-entry lock owned by runPrepare (see there for why).
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

  const runPrepare = async (prepare: () => Promise<PackPreview>) => {
    // Synchronous re-entry lock shared by the file and URL prepare entry points.
    // `busy` is async React state, so a fast second click or an overlapping
    // prepare would race two fetches over the shared preview and let the last to
    // resolve win — installing a pack the user didn't last choose. The ref flips
    // immediately.
    if (preparingRef.current) return
    preparingRef.current = true
    setError(null)
    setPreview(null)
    setBusy(true)
    try {
      setPreview(await prepare())
      // Keep the install section open so its preview card (rendered below all
      // sections) stays tied to its origin.
      setOpenSection("install")
    } catch (err) {
      showError(err)
      setOpenSection("install")
    } finally {
      setBusy(false)
      preparingRef.current = false
    }
  }

  const handleFile = async (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0]
    event.target.value = "" // allow re-selecting the same file
    if (!file) return
    await runPrepare(() => prepareFromFile(file, code.trim() || undefined))
  }

  const handleUrl = async () => {
    if (!url.trim()) {
      setError(t("language.errorUrlRequired"))
      return
    }
    await runPrepare(() => prepareFromUrl(url.trim(), code.trim() || undefined))
  }

  // Controlled accordion: driving native <details> via its toggle event fights
  // React's `open` prop (closed sections need two clicks), so we intercept the
  // summary click and set the open section ourselves.
  const toggleSection = (
    event: React.MouseEvent,
    section: AccordionSectionId,
  ) => {
    event.preventDefault()
    setOpenSection(openSection === section ? null : section)
  }

  // Selecting a language in the active dropdown: installed packs switch
  // instantly; a registry code that isn't installed yet is downloaded,
  // installed as a "registry" pack (so it auto-updates), then activated.
  const handleSelectLang = async (code: string) => {
    if (availableLangs.includes(code)) {
      await setLang(code)
      return
    }
    if (preparingRef.current) return
    preparingRef.current = true
    setInstallingSelected(true)
    setError(null)
    try {
      await installAndActivate(code)
    } catch (err) {
      showError(err)
    } finally {
      setInstallingSelected(false)
      preparingRef.current = false
    }
  }

  const handleConfirm = async () => {
    if (!preview) return
    setBusy(true)
    try {
      await commitPreview(preview)
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

  // One storage read for all installed packs, memoized so unrelated re-renders
  // (typing, accordion toggles, copy timer) don't re-parse the pack store.
  // installedLangs is a stable useSyncExternalStore snapshot — a reliable key.
  const coverages = useMemo(
    () => (installedLangs.length > 0 ? packCoverages() : {}),
    [installedLangs, packCoverages],
  )

  const sources = useMemo(
    () => (installedLangs.length > 0 ? packSources() : {}),
    [installedLangs, packSources],
  )

  // Options for the active-language dropdown: everything already available
  // (base + installed packs) plus registry languages not yet installed
  // (`offered`). The latter carry `install: true` so selecting one downloads
  // before switching.
  const langOptions = useMemo(
    () => [
      ...availableLangs.map((code) => ({ code, install: false })),
      ...offered.map((l) => ({ code: l.code, install: true })),
    ],
    [availableLangs, offered],
  )

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
          onChange={(e) => void handleSelectLang(e.target.value)}
          disabled={installingSelected}
        >
          {langOptions.map(({ code: c, install }) => (
            <option key={c} value={c}>
              {c === BASE_LANG
                ? t("language.baseName")
                : install
                  ? t("language.optionDownload", {
                      language: languageLabel(c, lang),
                    })
                  : languageLabel(c, lang)}
            </option>
          ))}
        </select>
        {installingSelected ? (
          <p className="flex items-center gap-2 text-xs text-base-content/70">
            <Loader2 className="size-3 animate-spin" aria-hidden="true" />
            {t("language.browseLoading")}
          </p>
        ) : (
          <p className="text-xs text-base-content/70">
            {t("language.activeHint")}
          </p>
        )}
        {registryError && (
          <p className="text-xs text-error">{t("language.errorRegistry")}</p>
        )}
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
              {langOptions.map(({ code: c }) => (
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
            <Button
              variant="primary"
              size="sm"
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
            </Button>
          </div>
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
            <Button
              variant="primary"
              size="sm"
              onClick={() => void handleUrl()}
              disabled={busy}
            >
              {t("language.fetch")}
            </Button>
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
              const source = sources[c]
              return (
                <li key={c}>
                  <div className="flex flex-row items-center justify-between">
                    <span className="flex items-center gap-2">
                      {languageLabel(c, lang)}
                      {source && (
                        <span
                          className={`badge badge-sm ${
                            source === "registry"
                              ? "badge-ghost"
                              : "badge-outline"
                          }`}
                        >
                          {source === "registry"
                            ? t("language.sourceRegistry")
                            : t("language.sourceUser")}
                        </span>
                      )}
                      {cov !== undefined && cov < 1 && (
                        <span className="badge badge-ghost badge-sm">
                          {Math.round(cov * 100)}%
                        </span>
                      )}
                    </span>
                    <Button
                      variant="ghost"
                      size="xs"
                      aria-label={t("language.removePack", { code: c })}
                      onClick={() => removePack(c)}
                    >
                      <Trash2 className="size-4" aria-hidden="true" />
                    </Button>
                  </div>
                </li>
              )
            })}
          </ul>
        </AccordionSection>
      )}

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
              <ul className="list-disc ps-5 text-sm text-base-content/80">
                {preview.sample.map((s, i) => (
                  <li key={i}>{s}</li>
                ))}
              </ul>
            </div>
          )}
          <div className="flex flex-row justify-end gap-2">
            <Button
              variant="ghost"
              size="sm"
              onClick={handleCancel}
              disabled={busy}
            >
              <X className="size-4" aria-hidden="true" />
              {t("language.previewCancel")}
            </Button>
            <Button
              variant="primary"
              size="sm"
              onClick={() => void handleConfirm()}
              disabled={busy}
            >
              {busy ? (
                <Loader2 className="size-4 animate-spin" aria-hidden="true" />
              ) : (
                <Check className="size-4" aria-hidden="true" />
              )}
              {t("language.previewConfirm", { code: preview.code })}
            </Button>
          </div>
        </div>
      )}

      <AnimatedAlert tone="error" show={!!error}>
        <span className="text-sm">{error}</span>
      </AnimatedAlert>
    </div>
  )
}

export default LanguageSwitcher

// Shared shell for collapsible sections: a controlled native <details> with a
// rotating chevron. `open` stays an explicit prop so a section can widen its
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
        className={`size-4 transition-transform ${rtlFlip} ${open ? "rotate-90" : ""}`}
        aria-hidden="true"
      />
      {title}
    </summary>
    <div className="collapse-content">{children}</div>
  </details>
)
