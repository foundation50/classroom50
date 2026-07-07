import { useState } from "react"
import { useTranslation } from "react-i18next"
import { AlertTriangle, ExternalLink, KeyRound } from "lucide-react"

import { REQUIRED_SCOPES } from "./scopes"

// The classic-PAT checkboxes to tick, derived from REQUIRED_SCOPES (the same
// source missingScopes() validates against) so the on-screen list and the
// pre-checked token URL can't drift from DEFAULT_GITHUB_SCOPE. read:org is
// dropped because admin:org already implies it (SCOPE_IMPLICATIONS in
// scopes.ts) — it isn't a box the user ticks separately. Displayed in GitHub's
// token-page order; scopes without an explicit rank sort to the end so a newly
// added required scope still appears (just not perfectly ordered) instead of
// silently vanishing.
const IMPLIED_PAT_SCOPES = new Set(["read:org"])
const PAT_SCOPE_ORDER = [
  "repo",
  "workflow",
  "admin:org",
  "read:user",
  "delete_repo",
]
const REQUIRED_PAT_SCOPES = REQUIRED_SCOPES.filter(
  (scope) => !IMPLIED_PAT_SCOPES.has(scope),
).sort((a, b) => {
  const ai = PAT_SCOPE_ORDER.indexOf(a)
  const bi = PAT_SCOPE_ORDER.indexOf(b)
  return (ai === -1 ? Infinity : ai) - (bi === -1 ? Infinity : bi)
})

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
