import { useState } from "react"
import { Loader2, Trash2, Upload } from "lucide-react"
import { useTranslation } from "react-i18next"

import { useLanguage } from "@/hooks/useLanguage"
import { BASE_LANG, LanguagePackError } from "@/i18n/customLocale"

// Settings UI for language packs: switch between installed languages, install a
// new pack via file upload or a pasted URL, and remove installed packs. All
// load failures (oversized, invalid JSON, CORS/network, bad scheme) surface in a
// single inline error without changing the active language.
export const LanguageSwitcher = () => {
  const { t } = useTranslation()
  const {
    lang,
    availableLangs,
    installedLangs,
    setLang,
    loadFromFile,
    loadFromUrl,
    removePack,
    packCoverage,
  } = useLanguage()

  const [code, setCode] = useState("")
  const [url, setUrl] = useState("")
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  const showError = (err: unknown) => {
    if (err instanceof LanguagePackError) setError(err.message)
    else setError(t("language.errorGeneric"))
  }

  const handleFile = async (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0]
    event.target.value = "" // allow re-selecting the same file
    if (!file) return
    if (!code.trim()) {
      setError(t("language.errorCodeFirst"))
      return
    }
    setError(null)
    setBusy(true)
    try {
      await loadFromFile(file, code.trim())
      setCode("")
    } catch (err) {
      showError(err)
    } finally {
      setBusy(false)
    }
  }

  const handleUrl = async () => {
    if (!code.trim()) {
      setError(t("language.errorCodeFirst"))
      return
    }
    if (!url.trim()) {
      setError(t("language.errorUrlRequired"))
      return
    }
    setError(null)
    setBusy(true)
    try {
      await loadFromUrl(url.trim(), code.trim())
      setCode("")
      setUrl("")
    } catch (err) {
      showError(err)
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="flex flex-col gap-4">
      <div>
        <label className="label" htmlFor="lang-select">
          <span className="label-text font-bold">{t("language.label")}</span>
        </label>
        <select
          id="lang-select"
          className="select select-bordered w-full max-w-xs"
          value={lang}
          onChange={(e) => void setLang(e.target.value)}
        >
          {availableLangs.map((c) => (
            <option key={c} value={c}>
              {c === BASE_LANG ? t("language.baseName") : c}
            </option>
          ))}
        </select>
      </div>

      {installedLangs.length > 0 && (
        <ul className="menu bg-base-200 rounded-box w-full max-w-xs">
          {installedLangs.map((c) => {
            const cov = packCoverage(c)
            return (
              <li
                key={c}
                className="flex flex-row items-center justify-between"
              >
                <span className="flex items-center gap-2">
                  {c}
                  {cov !== null && cov < 1 && (
                    <span className="badge badge-ghost badge-xs">
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
              </li>
            )
          })}
        </ul>
      )}

      <div className="flex flex-col gap-2 max-w-xs">
        <p className="text-xs text-base-content/70">
          {t("language.installHint")}
        </p>
        <input
          type="text"
          className="input input-bordered input-sm"
          placeholder={t("language.codePlaceholder")}
          value={code}
          onChange={(e) => setCode(e.target.value)}
          disabled={busy}
        />

        <label className="btn btn-sm btn-outline">
          {busy ? (
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
            className="input input-bordered input-sm flex-1"
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

      {error && (
        <div className="alert alert-error max-w-xs" role="alert">
          <span className="text-sm">{error}</span>
        </div>
      )}
    </div>
  )
}

export default LanguageSwitcher
