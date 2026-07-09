import { AlertTriangle, UserPlus } from "lucide-react"
import { useTranslation } from "react-i18next"
import { GitHubAPIError } from "@/hooks/github/errors"
import { useCopyToClipboard } from "@/hooks/useCopyToClipboard"
import { Card, CopyableDetails, Button } from "@/components/ui"

// Distinct membership-failure causes the student flow (onboarding + accept) can
// hit; each maps to a title/body and at least one recovery action.
//   - ssoWithUrl:  403 + X-GitHub-SSO carrying a usable authorization URL.
//   - ssoUrlless:  403 + X-GitHub-SSO but no parseable url (enterprise
//                  `partial-results` shape). Same screen minus the button.
//   - notAMember:  404 / accept genuinely failed — no membership record.
//   - generic:     anything else. Widest range, so never a dead end — always
//                  offers Retry.
export type MembershipErrorCause =
  "ssoWithUrl" | "ssoUrlless" | "notAMember" | "generic"

export type MembershipErrorInfo = {
  cause: MembershipErrorCause
  // Present only for `ssoWithUrl`; a validated https://github.com SSO URL.
  ssoUrl: string | null
  // Data-minimized diagnostics for the copyable "for your instructor" block.
  // NOT the raw response body or raw X-GitHub-SSO header (which carries an
  // authorization_request token) — only an allow-listed, non-sensitive subset.
  details: {
    org?: string
    username?: string
    endpoint?: string
    httpStatus?: number
    ssoRequired: boolean
    membershipState?: string
  }
}

// Classify a caught error (plus context) into a membership cause. One place so
// onboarding and accept can't diverge.
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

const MembershipDetails = ({
  details,
}: {
  details: MembershipErrorInfo["details"]
}) => {
  const { t } = useTranslation()
  // Allow-listed, human-readable diagnostics. Never the raw response body or
  // raw X-GitHub-SSO header value.
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
    <CopyableDetails
      text={text}
      copied={copied}
      onCopy={() => void copy()}
      summaryLabel={t("membership.showDetails")}
      copyLabel={t("membership.copyDetails")}
      copiedLabel={t("membership.copied")}
      className="mt-4"
      preClassName="overflow-x-auto"
    />
  )
}

// Shared, cause-specific membership error card for the onboarding and accept
// pages: a per-cause title/body, at least one recovery action (never a dead
// end), and a collapsed, data-minimized diagnostics block for the instructor.
// `onRetry` backs the generic Retry action; SSO/not-a-member causes point
// elsewhere.
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
    <Card.Body className="gap-6">
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
              <Button variant="primary" size="sm" onClick={onRetry}>
                {t("membership.generic.retry")}
              </Button>
            )}
          </div>
        </div>
      </div>

      <MembershipDetails details={details} />
    </Card.Body>
  )
}
