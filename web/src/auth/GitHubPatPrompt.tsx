import { useState } from "react"
import { useTranslation } from "react-i18next"
import { AlertTriangle, ExternalLink } from "lucide-react"

import { REQUIRED_SCOPES } from "./scopes"
import {
  FINE_GRAINED_SIGNIN_PERMISSION_LABELS,
  buildFineGrainedSigninUrl,
} from "./fineGrainedSigninUrl"
import type { PatTokenType } from "./types"
import { Alert, Button, HelpTooltip, Input } from "@/components/ui"

// The classic-PAT scopes to request, derived from REQUIRED_SCOPES (the same
// source missingScopes() validates against) so the tooltip list and the
// pre-checked token URL can't drift from DEFAULT_GITHUB_SCOPE. We request the
// full OAuth scope set verbatim (including read:org, even though admin:org
// implies it) so a token created via this link grants exactly what the OAuth
// flow would. Ordered to match GitHub's token page; scopes without an explicit
// rank sort to the end so a newly added required scope still appears.
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

// The token variant is chosen upstream (two entries under "other sign-in
// methods"), so the prompt renders one variant's guidance, no in-prompt toggle.
export function GitHubPatPrompt({
  tokenType,
  onSubmit,
  onCancel,
  isValidating,
  error,
}: {
  tokenType: PatTokenType
  onSubmit: (token: string) => void
  onCancel: () => void
  isValidating: boolean
  error: string | null
}) {
  const { t } = useTranslation()
  const [token, setToken] = useState("")
  const [org, setOrg] = useState("")
  const trimmed = token.trim()
  const trimmedOrg = org.trim()
  const isFineGrained = tokenType === "fine-grained"

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
        <div className="flex items-center gap-1.5">
          <h2 className="text-sm font-semibold">
            {isFineGrained
              ? t("auth.patTitleFineGrained")
              : t("auth.patTitleClassic")}
          </h2>
          <HelpTooltip
            position="bottom"
            help={
              isFineGrained
                ? `${t("auth.patPermissionsHelp")} ${FINE_GRAINED_SIGNIN_PERMISSION_LABELS.join(
                    ", ",
                  )}.`
                : `${t("auth.patScopesHelp")} ${REQUIRED_PAT_SCOPES.join(", ")}.`
            }
          />
        </div>

        {isFineGrained ? (
          <>
            <p className="text-xs leading-relaxed text-base-content/70">
              {t("auth.patFineGrainedIntro")}
            </p>
            <label className="flex w-full flex-col gap-1.5">
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
            <Alert tone="warning" className="items-start text-xs">
              <AlertTriangle aria-hidden="true" className="size-4 shrink-0" />
              <span>{t("auth.patFineGrainedWarning")}</span>
            </Alert>

            <Button
              as="a"
              variant="outline"
              className="w-full"
              href={
                trimmedOrg ? buildFineGrainedSigninUrl(trimmedOrg) : undefined
              }
              disabled={!trimmedOrg}
              target="_blank"
              rel="noopener noreferrer"
            >
              <ExternalLink aria-hidden="true" className="size-4" />
              {t("auth.patFineGrainedLink")}
            </Button>
            {trimmedOrg ? null : (
              <p className="text-xs leading-relaxed text-base-content/50">
                {t("auth.patFineGrainedNeedsOrg")}
              </p>
            )}
          </>
        ) : (
          <>
            <p className="text-xs leading-relaxed text-base-content/70">
              {t("auth.patClassicIntro")}
            </p>
            <Button
              as="a"
              variant="outline"
              className="w-full"
              href={CREATE_TOKEN_URL}
              target="_blank"
              rel="noopener noreferrer"
            >
              <ExternalLink aria-hidden="true" className="size-4" />
              {t("auth.patCreateTokenLink")}
            </Button>
          </>
        )}
      </div>

      <label className="flex w-full flex-col gap-1.5">
        <span className="label-text text-xs leading-relaxed text-base-content/70">
          {t("auth.patPasteInstruction")}
        </span>
        <Input
          className="font-mono text-sm"
          type="password"
          autoComplete="off"
          spellCheck={false}
          placeholder={isFineGrained ? "github_pat_…" : "ghp_…"}
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
