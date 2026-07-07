import { useState } from "react"
import { useTranslation } from "react-i18next"
import { AlertTriangle, ExternalLink, KeyRound } from "lucide-react"

// The classic-PAT checkboxes to tick, in the order GitHub's token page lists
// them. read:org is omitted because admin:org already implies it (see
// SCOPE_IMPLICATIONS in scopes.ts) — it isn't a box the user ticks separately.
// Kept in sync with DEFAULT_GITHUB_SCOPE, which drives actual validation.
const REQUIRED_PAT_SCOPES = [
  "repo",
  "workflow",
  "admin:org",
  "read:user",
  "delete_repo",
] as const

// Classic-token page with the required scopes pre-checked. Built with
// URLSearchParams (matching buildGithubAuthorizeUrl) so the scope list's
// reserved characters (e.g. the ":" in admin:org) are encoded correctly.
const CREATE_TOKEN_URL = `https://github.com/settings/tokens/new?${new URLSearchParams(
  {
    description: "Classroom 50",
    scopes: REQUIRED_PAT_SCOPES.join(","),
  },
).toString()}`

export function GitHubPatPrompt({
  onSubmit,
  onCancel,
  isValidating,
  error,
}: {
  onSubmit: (token: string) => void
  onCancel: () => void
  isValidating: boolean
  error: string | null
}) {
  const { t } = useTranslation()
  const [token, setToken] = useState("")
  const trimmed = token.trim()

  return (
    <form
      className="space-y-5"
      onSubmit={(event) => {
        event.preventDefault()
        if (!trimmed || isValidating) return
        onSubmit(trimmed)
      }}
    >
      {error ? (
        <div className="alert alert-error items-start text-sm">
          <AlertTriangle aria-hidden="true" className="size-4 shrink-0" />
          <span>{error}</span>
        </div>
      ) : null}

      <div className="space-y-2">
        <h2 className="text-sm font-semibold">{t("auth.patTitle")}</h2>
        <p className="text-xs leading-relaxed text-base-content/70">
          {t("auth.patInstructions")}
        </p>
        <ul className="grid gap-1 rounded-lg border border-base-300 bg-base-200 px-4 py-3 font-mono text-xs">
          {REQUIRED_PAT_SCOPES.map((scope) => (
            <li key={scope}>{scope}</li>
          ))}
        </ul>
        <a
          className="link link-info link-hover inline-flex items-center gap-1 text-xs"
          href={CREATE_TOKEN_URL}
          target="_blank"
          rel="noopener noreferrer"
        >
          <ExternalLink aria-hidden="true" className="size-3" />
          {t("auth.patCreateTokenLink")}
        </a>
        <p className="text-xs leading-relaxed text-base-content/60">
          {t("auth.patFineGrainedNote")}
        </p>
      </div>

      <label className="form-control w-full">
        <span className="label-text sr-only">{t("auth.patTokenLabel")}</span>
        <input
          className="input input-bordered w-full font-mono text-sm"
          type="password"
          autoComplete="off"
          spellCheck={false}
          placeholder="ghp_…"
          value={token}
          onChange={(event) => setToken(event.target.value)}
          disabled={isValidating}
          aria-label={t("auth.patTokenLabel")}
        />
      </label>

      <p className="text-xs leading-relaxed text-base-content/70">
        {t("auth.patStorageNote")}
      </p>

      <div className="space-y-3">
        <button
          className="btn btn-primary w-full"
          type="submit"
          disabled={!trimmed || isValidating}
        >
          {isValidating ? (
            <span
              className="loading loading-spinner loading-sm"
              aria-hidden="true"
            />
          ) : (
            <KeyRound aria-hidden="true" className="size-4" />
          )}
          {t("auth.patSubmit")}
        </button>

        <button
          className="btn btn-outline w-full"
          type="button"
          onClick={onCancel}
          disabled={isValidating}
        >
          {t("auth.patCancel")}
        </button>
      </div>
    </form>
  )
}
