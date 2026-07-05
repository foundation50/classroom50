import { useQuery } from "@tanstack/react-query"
import type { ReactNode } from "react"
import { useTranslation } from "react-i18next"
import {
  AlertTriangle,
  CheckCircle2,
  ExternalLink,
  HelpCircle,
  Info,
  Loader2,
} from "lucide-react"
import GitHub from "@/assets/github.svg?react"
import { useOptionalGitHubClient } from "@/context/github/GitHubProvider"
import { useGithubAuth } from "@/auth/useGithubAuth"
import {
  verifyTemplateAccess,
  type TemplateAccessVerification,
} from "@/api/mutations/assignments"
import { teamHasRepoAccess } from "@/hooks/github/queries"
import {
  useDebouncedValue,
  normalizeOnBlur,
  type StringField,
} from "./formFieldHelpers"
import { InlineNote, InlineCode as Code } from "@/components/InlineNote"
import {
  templateForkNoteView,
  templateRestrictedNoteView,
} from "./templateNoteView"

// Advisory, non-blocking pre-flight for the Template Repository field: checks
// the OAuth token can reach the typed repo and annotates the field without
// rewriting it. Mirrors RunnerField.
export const TemplateField = ({
  field,
  org,
  classroom,
}: {
  field: StringField
  org?: string
  classroom?: string
}) => {
  const { t } = useTranslation()
  const client = useOptionalGitHubClient()
  const { user, isLoadingUser } = useGithubAuth()
  const viewerLogin = user?.login
  const rawValue = field.state.value
  const trimmedValue = rawValue.trim()
  const debouncedValue = useDebouncedValue(trimmedValue, 500)

  // viewerLogin decides ok vs ok-verify, so wait for it — verifying mid-load
  // would show a verdict that flips once the profile resolves.
  const enabled = Boolean(client && org && debouncedValue && !isLoadingUser)

  const verificationQuery = useQuery({
    queryKey: ["template-access", org, viewerLogin, debouncedValue],
    queryFn: () =>
      verifyTemplateAccess(client!, org!, debouncedValue, viewerLogin),
    enabled,
    staleTime: 30_000,
    retry: false,
  })

  // A cleared field has nothing to verify, so don't show "Checking…" while the
  // debounce drains.
  const pending =
    enabled &&
    trimmedValue !== "" &&
    (trimmedValue !== debouncedValue || verificationQuery.isFetching)

  const verification =
    enabled && !pending ? (verificationQuery.data ?? null) : null

  // For an in-org private template, check whether the classroom team already
  // has read. Drives the checkmark-vs-"added on create" message below.
  const inOrgPrivateTemplate =
    verification?.kind === "ok" &&
    verification.inOrg &&
    verification.visibility === "private"
      ? { owner: verification.owner, repo: verification.repo }
      : null
  const teamAccessEnabled = Boolean(
    client && org && classroom && inOrgPrivateTemplate,
  )

  const teamAccessQuery = useQuery({
    queryKey: [
      "template-team-access",
      org,
      classroom,
      inOrgPrivateTemplate?.owner ?? null,
      inOrgPrivateTemplate?.repo ?? null,
    ],
    queryFn: () =>
      teamHasRepoAccess(client!, {
        org: org!,
        classroom: classroom!,
        owner: inOrgPrivateTemplate!.owner,
        repo: inOrgPrivateTemplate!.repo,
      }),
    enabled: teamAccessEnabled,
    staleTime: 30_000,
    retry: false,
  })

  // Default to the "will be granted on create" message until the team check
  // resolves, rather than blocking the verdict.
  const teamHasAccess = teamAccessEnabled
    ? teamAccessQuery.data === true
    : undefined

  return (
    <>
      <label
        htmlFor={field.name}
        className="label font-bold mb-2 flex items-center gap-1.5"
      >
        <GitHub
          aria-hidden="true"
          className="size-4 text-base-content/30 opacity-70"
        />
        {t("assignments.template.label")}
      </label>
      <input
        id={field.name}
        name={field.name}
        type="text"
        autoComplete="off"
        spellCheck={false}
        placeholder={t("assignments.template.placeholder")}
        className="input w-full"
        value={rawValue}
        onBlur={normalizeOnBlur(field)}
        onChange={(e) => field.handleChange(e.target.value)}
      />

      <TemplateVerificationNote
        verification={verification}
        pending={pending}
        org={org}
        teamHasAccess={teamHasAccess}
      />

      <p className="label pt-2">{t("assignments.template.help")}</p>
    </>
  )
}

const TemplateVerificationNote = ({
  verification,
  pending,
  org,
  teamHasAccess,
}: {
  verification: TemplateAccessVerification | null
  pending: boolean
  org?: string
  // For an in-org private template: true if the classroom team already has
  // read, false if it'll be granted on create, undefined if N/A or unresolved.
  teamHasAccess?: boolean
}) => {
  const { t } = useTranslation()
  if (pending) {
    return (
      <p className="mt-1.5 flex items-center gap-1.5 text-sm text-base-content/70">
        <Loader2 aria-hidden="true" className="size-4 shrink-0 animate-spin" />
        {t("assignments.template.checking")}
      </p>
    )
  }

  if (!verification || verification.kind === "empty") return null

  const fallbackOrg = org ?? t("assignments.template.fallbackOrg")

  switch (verification.kind) {
    case "ok": {
      // Students can't read an in-org private template directly; the classroom
      // team grant is what lets them. Show whether that grant already exists or
      // will be added on create (see tryGrantTeamTemplateRead).
      if (verification.inOrg && verification.visibility === "private") {
        if (teamHasAccess === true) {
          return (
            <Note tone="success" icon={CheckCircle2}>
              {t("assignments.template.privateHasAccess_1", {
                owner: verification.owner,
              })}{" "}
              <Code>{verification.branch}</Code>
              {t("assignments.template.privateHasAccess_2")}
            </Note>
          )
        }
        return (
          <Note tone="success" icon={CheckCircle2}>
            {t("assignments.template.privateWillGrant_1", {
              owner: verification.owner,
            })}{" "}
            <Code>{verification.branch}</Code>
            {t("assignments.template.privateWillGrant_2")}
          </Note>
        )
      }
      const okPrefixKey = verification.inOrg
        ? verification.visibility === "public"
          ? "assignments.template.okPrefixPublicInOrg"
          : "assignments.template.okPrefixPrivateInOrg"
        : verification.visibility === "public"
          ? "assignments.template.okPrefixPublic"
          : "assignments.template.okPrefixPrivate"
      return (
        <Note tone="success" icon={CheckCircle2}>
          {t(okPrefixKey, { owner: verification.owner })}{" "}
          <Code>{verification.branch}</Code>
          {t("assignments.template.okSuffix")}
        </Note>
      )
    }

    case "ok-verify":
      return (
        <Note
          tone="warning"
          icon={Info}
          policy={{ owner: verification.owner, href: verification.policyUrl }}
        >
          {t("assignments.template.okVerify_1", { owner: verification.owner })}{" "}
          <Code>{verification.branch}</Code>
          {t("assignments.template.okVerify_2", { owner: verification.owner })}
        </Note>
      )

    case "private-fork": {
      const view = templateForkNoteView(verification)
      // labelKey/tone/suffixKey all come from templateForkNoteView (single
      // source of truth, tested). All three label keys take the same
      // interpolation set; t() ignores `parent` for the no-parent key.
      const label = t(view.labelKey, {
        owner: verification.owner,
        repo: verification.repo,
        parent: verification.parent,
      })
      // In-org parent is usually reachable (advisory, amber); a cross-org or
      // unknown parent is likely to fail at generate (error, red).
      return (
        <Note
          tone={view.tone}
          icon={view.tone === "warning" ? Info : AlertTriangle}
        >
          {label} <Code>{verification.branch}</Code>
          {t(view.suffixKey)}
        </Note>
      )
    }

    case "invalid":
      return (
        <Note tone="error" icon={AlertTriangle}>
          {verification.message}
        </Note>
      )

    case "not-visible":
      return (
        <Note tone="error" icon={AlertTriangle}>
          {t("assignments.template.notVisible", {
            owner: verification.owner,
            repo: verification.repo,
            org: fallbackOrg,
          })}
        </Note>
      )

    case "not-template":
      return (
        <Note tone="error" icon={AlertTriangle}>
          {t("assignments.template.notTemplate", {
            owner: verification.owner,
            repo: verification.repo,
          })}
        </Note>
      )

    case "restricted":
      return (
        <Note
          tone="error"
          icon={AlertTriangle}
          policy={{ owner: verification.owner, href: verification.policyUrl }}
        >
          {t(templateRestrictedNoteView(verification).messageKey, {
            owner: verification.owner,
            repo: verification.repo,
          })}
          <span className="mt-1 block text-xs text-base-content/70">
            {t("assignments.template.githubSaid", {
              status: verification.httpStatus,
            })}{" "}
            <span className="break-words italic">{verification.message}</span>
          </span>
        </Note>
      )

    case "unknown":
      return (
        <Note tone="neutral" icon={HelpCircle}>
          {t("assignments.template.unknown", {
            owner: verification.owner,
            repo: verification.repo,
          })}
        </Note>
      )

    case "private-out-of-org":
      return (
        <Note tone="error" icon={AlertTriangle}>
          {t("assignments.template.privateOutOfOrg", {
            owner: verification.owner,
            repo: verification.repo,
            org: fallbackOrg,
          })}
        </Note>
      )

    case "no-branch":
      return (
        <Note tone="error" icon={AlertTriangle}>
          {t("assignments.template.noBranch_1", {
            owner: verification.owner,
            repo: verification.repo,
          })}{" "}
          <Code>@&lt;branch&gt;</Code>
          {t("assignments.template.noBranch_2")}
        </Note>
      )

    case "rate-limited":
      return (
        <Note tone="neutral" icon={HelpCircle}>
          {t("assignments.template.rateLimited")}
        </Note>
      )

    default: {
      // A new verdict kind becomes a compile error here.
      const _never: never = verification
      return _never
    }
  }
}

// Wraps InlineNote with an optional OAuth-policy link for the cases where an
// org owner must approve the app.
const Note = ({
  tone,
  icon,
  policy,
  children,
}: {
  tone: "success" | "warning" | "error" | "neutral"
  icon: typeof Info
  policy?: { owner: string; href: string }
  children: ReactNode
}) => {
  const { t } = useTranslation()
  return (
    <InlineNote tone={tone} icon={icon} className="mt-1.5">
      <span>{children}</span>
      {policy && (
        <a
          href={policy.href}
          target="_blank"
          rel="noreferrer"
          className="mt-1 flex items-center gap-1 font-semibold underline"
        >
          {t("assignments.template.policyLink", { owner: policy.owner })}
          <ExternalLink aria-hidden="true" className="size-3.5 shrink-0" />
        </a>
      )}
    </InlineNote>
  )
}
