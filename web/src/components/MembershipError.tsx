import { AlertTriangle, Check, ClipboardCopy, UserPlus } from "lucide-react"
import { useTranslation } from "react-i18next"
import { GitHubAPIError } from "@/hooks/github/errors"
import { useCopyToClipboard } from "@/hooks/useCopyToClipboard"

// The distinct membership-failure causes the student flow (onboarding + accept)
// can hit. Each maps to a specific title/body and at least one recovery action.
//   - ssoWithUrl:  403 + X-GitHub-SSO carrying a usable authorization URL.
//   - ssoUrlless:  403 + X-GitHub-SSO but no parseable url (enterprise
//                  `partial-results` shape). Same screen minus the button.
//   - notAMember:  404 / the accept genuinely failed — no membership record.
//   - generic:     anything else (transient, unexpected). Absorbs the widest
//                  range, so it must not be a dead end — always offers Retry.
export type MembershipErrorCause =
  "ssoWithUrl" | "ssoUrlless" | "notAMember" | "generic"

export type MembershipErrorInfo = {
  cause: MembershipErrorCause
  // Present only for `ssoWithUrl`; a validated https://github.com SSO URL.
  ssoUrl: string | null
  // Data-minimized diagnostics for the copyable "for your instructor" block.
  // Deliberately NOT the raw response body or the raw X-GitHub-SSO header (that
  // header carries an authorization_request token) — only an allow-listed,
  // non-sensitive subset leaves the client.
  details: {
    org?: string
    username?: string
    endpoint?: string
    httpStatus?: number
    ssoRequired: boolean
    membershipState?: string
  }
}

// Classify a caught error (plus context) into one of the membership causes.
// Keeps the branching in one place so onboarding and accept can't diverge.
export function classifyMembershipError(
  error: unknown,
  context: { org?: string; username?: string; membershipState?: string },
): MembershipErrorInfo {
  const base = {
    org: context.org,
    username: context.username,
    ssoRequired: false,
    membershipState: context.membershipState,
  }

  if (error instanceof GitHubAPIError) {
    const details = {
      ...base,
      endpoint: error.url,
      httpStatus: error.status,
      ssoRequired: error.isSsoRequired,
    }
    if (error.isSsoRequired) {
      const ssoUrl = error.ssoAuthorizationUrl
      return ssoUrl
        ? { cause: "ssoWithUrl", ssoUrl, details }
        : { cause: "ssoUrlless", ssoUrl: null, details }
    }
    if (error.isNotFound) {
      return { cause: "notAMember", ssoUrl: null, details }
    }
    return { cause: "generic", ssoUrl: null, details }
  }

  return { cause: "generic", ssoUrl: null, details: base }
}

const CopyableDetails = ({
  details,
}: {
  details: MembershipErrorInfo["details"]
}) => {
  const { t } = useTranslation()
  // Build the allow-listed, human-readable diagnostics block. Never includes
  // the raw response body or the raw X-GitHub-SSO header value.
  const lines = [
    details.org ? `${t("membership.details.org")}: ${details.org}` : null,
    details.username
      ? `${t("membership.details.username")}: ${details.username}`
      : null,
    details.endpoint
      ? `${t("membership.details.endpoint")}: ${details.endpoint}`
      : null,
    details.httpStatus !== undefined
      ? `${t("membership.details.httpStatus")}: ${details.httpStatus}`
      : null,
    `${t("membership.details.ssoRequired")}: ${
      details.ssoRequired ? t("common.yes") : t("common.no")
    }`,
    details.membershipState
      ? `${t("membership.details.membershipState")}: ${details.membershipState}`
      : null,
    `${t("membership.details.timestamp")}: ${new Date().toISOString()}`,
  ].filter((line): line is string => line !== null)
  const text = lines.join("\n")
  const { copied, copy } = useCopyToClipboard(text)

  return (
    <details className="mt-4 rounded-xl border border-base-300 bg-base-200/40 p-4 text-sm">
      <summary className="cursor-pointer font-medium text-base-content">
        {t("membership.showDetails")}
      </summary>
      <div className="mt-3 space-y-3">
        <pre className="overflow-x-auto rounded-lg bg-base-100 p-3 text-xs whitespace-pre-wrap">
          {text}
        </pre>
        <button
          type="button"
          className="btn btn-outline btn-sm"
          onClick={() => void copy()}
        >
          {copied ? (
            <Check aria-hidden="true" className="size-4" />
          ) : (
            <ClipboardCopy aria-hidden="true" className="size-4" />
          )}
          {copied ? t("membership.copied") : t("membership.copyDetails")}
        </button>
        <span aria-live="polite" className="sr-only">
          {copied ? t("membership.copied") : ""}
        </span>
      </div>
    </details>
  )
}

// A shared, cause-specific membership error card used by both the onboarding
// and accept pages. Renders a specific title/body per cause, at least one
// recovery action (never a dead end), and a collapsed, data-minimized copyable
// diagnostics block for the student's instructor. `onRetry` (when provided)
// backs the generic Retry action; SSO/not-a-member causes point elsewhere.
export const MembershipError = ({
  info,
  org,
  onRetry,
}: {
  info: MembershipErrorInfo
  org?: string
  onRetry?: () => void
}) => {
  const { t } = useTranslation()
  const { cause, ssoUrl, details } = info

  const titleKey = {
    ssoWithUrl: "membership.ssoRequired.title",
    ssoUrlless: "membership.ssoRequired.title",
    notAMember: "membership.notAMember.title",
    generic: "membership.generic.title",
  }[cause]

  const badgeTone = {
    ssoWithUrl: "badge-warning",
    ssoUrlless: "badge-warning",
    notAMember: "badge-error",
    generic: "badge-error",
  }[cause]

  return (
    <div className="card-body gap-6">
      <div>
        <span className={`badge ${badgeTone} badge-soft gap-2`}>
          <AlertTriangle aria-hidden="true" className="size-4" />
          {t("membership.badge")}
        </span>
        <h1 className="mt-6 text-2xl font-bold">{t(titleKey)}</h1>
        <p className="mt-2 text-base text-base-content/70">
          {cause === "ssoWithUrl" || cause === "ssoUrlless" ? (
            <>
              {t("membership.ssoRequired.body_prefix")}{" "}
              <span className="font-bold">{org}</span>{" "}
              {t("membership.ssoRequired.body_suffix")}
            </>
          ) : cause === "notAMember" ? (
            <>
              {t("membership.notAMember.body_prefix")}{" "}
              <span className="font-bold">{org}</span>{" "}
              {t("membership.notAMember.body_suffix")}
            </>
          ) : (
            t("membership.generic.body")
          )}
        </p>
      </div>

      <div className="rounded-2xl border border-info/20 bg-info/5 p-5">
        <div className="flex gap-3">
          <div className="flex size-10 shrink-0 items-center justify-center rounded-xl bg-info/10 text-info">
            <UserPlus aria-hidden="true" className="size-5" />
          </div>
          <div className="min-w-0 space-y-3">
            <p className="text-sm leading-5 text-base-content/70">
              {cause === "ssoWithUrl"
                ? t("membership.ssoRequired.instructionsWithUrl")
                : cause === "ssoUrlless"
                  ? t("membership.ssoRequired.instructionsUrlless")
                  : cause === "notAMember"
                    ? t("membership.notAMember.instructions")
                    : t("membership.generic.instructions")}
            </p>

            {cause === "ssoWithUrl" && ssoUrl && (
              <a
                href={ssoUrl}
                className="btn btn-primary btn-sm"
                rel="noopener noreferrer"
              >
                {t("membership.ssoRequired.authorizeButton")}
              </a>
            )}

            {cause === "generic" && onRetry && (
              <button
                type="button"
                className="btn btn-primary btn-sm"
                onClick={onRetry}
              >
                {t("membership.generic.retry")}
              </button>
            )}
          </div>
        </div>
      </div>

      <CopyableDetails details={details} />
    </div>
  )
}
