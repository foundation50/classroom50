import { useState } from "react"
import { Check, Loader2, Trash2, Upload, X } from "lucide-react"
import { useTranslation } from "react-i18next"

import { useLanguage } from "@/hooks/useLanguage"
import {
  BASE_LANG,
  LanguagePackError,
  type PackPreview,
  UndetectableCodeError,
  languageLabel,
} from "@/i18n/customLocale"

// Settings UI for language packs. Uploading/fetching only *prepares* a pack
// (parse + preview) — nothing is applied until the user confirms. The code is
// inferred from the file name / URL; the manual code field appears only when
// inference fails.
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
    setError(null)
    setPreview(null)
    setBusy(true)
    try {
      setPreview(await prepare())
    } catch (err) {
      showError(err)
    } finally {
      setBusy(false)
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

  const handleConfirm = async () => {
    if (!preview) return
    setBusy(true)
    try {
      await commitPack(preview.code, preview.bundle)
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

  // One storage read per render for all installed packs (vs. one per pack).
  const coverages = installedLangs.length > 0 ? packCoverages() : {}

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

      {installedLangs.length > 0 && (
        <div className="flex flex-col gap-1">
          <span className="label-text font-bold">
            {t("language.installedTitle")}
          </span>
          <ul className="menu bg-base-200 rounded-box w-full gap-1">
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
        </div>
      )}

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
