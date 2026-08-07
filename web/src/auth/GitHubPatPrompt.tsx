import { useState } from "react"
import { useTranslation } from "react-i18next"
import { AlertTriangle, ExternalLink } from "lucide-react"

import { REQUIRED_SCOPES } from "./scopes"
import {
  FINE_GRAINED_SIGNIN_PERMISSION_LABELS,
  buildFineGrainedSigninUrl,
} from "./fineGrainedSigninUrl"
import { Alert, Button, Input } from "@/components/ui"

// The classic-PAT checkboxes to tick, derived from REQUIRED_SCOPES (the same
// source missingScopes() validates against) so the on-screen list and the
// pre-checked token URL can't drift from DEFAULT_GITHUB_SCOPE. We request the
// full OAuth scope set verbatim — including read:org, even though admin:org
// implies it — so a token created via this link grants exactly what the OAuth
// flow would. Displayed in GitHub's token-page order; scopes without an
// explicit rank sort to the end so a newly added required scope still appears
// (just not perfectly ordered) instead of silently vanishing.
const PAT_SCOPE_ORDER = [
  "repo",
  "workflow",
  "admin:org",
  "read:org",
  "read:user",
  "delete_repo",
]
const REQUIRED_PAT_SCOPES = [...REQUIRED_SCOPES].sort((a, b) => {
  const ai = PAT_SCOPE_ORDER.indexOf(a)
  const bi = PAT_SCOPE_ORDER.indexOf(b)
  return (ai === -1 ? Infinity : ai) - (bi === -1 ? Infinity : bi)
})

// Classic-token page with the required scopes pre-checked. Built with
// URLSearchParams (matching buildGithubAuthorizeUrl) so the scope list's
// reserved characters (e.g., the ":" in admin:org) are encoded correctly.
const CREATE_TOKEN_URL = `https://github.com/settings/tokens/new?${new URLSearchParams(
  {
    description: "Classroom 50",
    scopes: REQUIRED_PAT_SCOPES.join(","),
  },
).toString()}`

type TokenType = "classic" | "fine-grained"

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
  // Classic is the default: it spans every org the teacher owns, so it's the
  // right choice for the multi-org norm. Fine-grained is the single-org option.
  const [tokenType, setTokenType] = useState<TokenType>("classic")
  const [org, setOrg] = useState("")
  const trimmed = token.trim()
  const trimmedOrg = org.trim()

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
        <Alert tone="error" className="items-start text-sm">
          <AlertTriangle aria-hidden="true" className="size-4 shrink-0" />
          <span>{error}</span>
        </Alert>
      ) : null}

      <div className="space-y-3">
        <h2 className="text-sm font-semibold">{t("auth.patTitle")}</h2>
        <p className="text-xs leading-relaxed text-base-content/70">
          {t("auth.patInstructions")}
        </p>

        <div className="join w-full" role="tablist">
          <Button
            type="button"
            variant={tokenType === "classic" ? "primary" : "outline"}
            className="join-item flex-1"
            role="tab"
            aria-selected={tokenType === "classic"}
            onClick={() => setTokenType("classic")}
          >
            {t("auth.patTypeClassicRecommended")}
          </Button>
          <Button
            type="button"
            variant={tokenType === "fine-grained" ? "primary" : "outline"}
            className="join-item flex-1"
            role="tab"
            aria-selected={tokenType === "fine-grained"}
            onClick={() => setTokenType("fine-grained")}
          >
            {t("auth.patTypeFineGrained")}
          </Button>
        </div>

        {tokenType === "classic" ? (
          <div className="space-y-2">
            <p className="text-xs leading-relaxed text-base-content/70">
              {t("auth.patClassicIntro")}
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
          </div>
        ) : (
          <div className="space-y-2">
            <p className="text-xs leading-relaxed text-base-content/70">
              {t("auth.patFineGrainedIntro")}
            </p>
            <label className="form-control w-full">
              <span className="label-text text-xs">
                {t("auth.patFineGrainedOrgLabel")}
              </span>
              <Input
                className="text-sm"
                inputSize="sm"
                autoComplete="off"
                spellCheck={false}
                placeholder={t("auth.patFineGrainedOrgPlaceholder")}
                value={org}
                onChange={(event) => setOrg(event.target.value)}
                disabled={isValidating}
              />
            </label>
            <p className="text-xs leading-relaxed text-base-content/60">
              {t("auth.patFineGrainedPermissionsIntro")}
            </p>
            <ul className="grid gap-1 rounded-lg border border-base-300 bg-base-200 px-4 py-3 text-xs">
              {FINE_GRAINED_SIGNIN_PERMISSION_LABELS.map((label) => (
                <li key={label}>{label}</li>
              ))}
            </ul>
            {trimmedOrg ? (
              <a
                className="link link-info link-hover inline-flex items-center gap-1 text-xs"
                href={buildFineGrainedSigninUrl(trimmedOrg)}
                target="_blank"
                rel="noopener noreferrer"
              >
                <ExternalLink aria-hidden="true" className="size-3" />
                {t("auth.patFineGrainedLink")}
              </a>
            ) : (
              <p className="text-xs leading-relaxed text-base-content/50">
                {t("auth.patFineGrainedNeedsOrg")}
              </p>
            )}
          </div>
        )}
      </div>

      <label className="form-control w-full">
        <span className="label-text sr-only">{t("auth.patTokenLabel")}</span>
        <Input
          className="font-mono text-sm"
          type="password"
          autoComplete="off"
          spellCheck={false}
          placeholder="ghp_… or github_pat_…"
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
        <Button
          variant="primary"
          className="w-full"
          type="submit"
          loading={isValidating}
          disabled={!trimmed || isValidating}
        >
          {t("auth.patSubmit")}
        </Button>

        <Button
          variant="outline"
          className="w-full"
          type="button"
          onClick={onCancel}
          disabled={isValidating}
        >
          {t("auth.patCancel")}
        </Button>
      </div>
    </form>
  )
}
