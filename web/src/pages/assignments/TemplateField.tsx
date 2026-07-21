import { useQuery } from "@tanstack/react-query"
import type { ReactNode } from "react"
import { useState } from "react"
import { Trans, useTranslation } from "react-i18next"
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
import { useIsOrgOwner } from "@/context/githubOrgRole/useIsOrgOwner"
import { useGithubAuth } from "@/auth/useGithubAuth"
import {
  verifyTemplateAccess,
  type TemplateAccessVerification,
} from "@/domain/assignments"
import { teamHasRepoAccess } from "@/github-core/queries"
import { useGitHubHealth } from "@/lib/githubHealth"
import { GitHubStatusNote } from "@/components/GitHubStatusNote"
import { useReconcileTemplateAccess } from "@/hooks/mutations/useReconcileTemplateAccess"
import {
  useDebouncedValue,
  normalizeOnBlur,
  type StringField,
} from "./formFieldHelpers"
import { InlineNote, InlineCode as Code } from "@/components/InlineNote"
import { Button, FormField, Input } from "@/components/ui"
import {
  templateForkNoteView,
  templateRestrictedNoteView,
} from "./templateNoteView"

// Advisory, non-blocking pre-flight for the Template Repository field: checks
// the OAuth token can reach the typed repo and annotates without rewriting it.
// Mirrors RunnerField.
export const TemplateField = ({
  field,
  org,
  classroom,
  slug,
}: {
  field: StringField
  org?: string
  classroom?: string
  // Edit-only: enables the inline "Fix template access" recovery button. Absent
  // on the create form (there's no assignment yet to reconcile).
  slug?: string
}) => {
  const { t } = useTranslation()
  const client = useOptionalGitHubClient()
  // The "Fix template access" recovery grants a team read on the template repo
  // (addRepositoryToTeam) — an org-owner-only GitHub call. Only offer it to an
  // owner; a non-owner (e.g. a head-TA authoring) would 403. Org owner and
  // classroom teacher are independent axes (KTD-4), so gate on manageOrg.
  const { isOwner } = useIsOrgOwner()
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

  // Cleared field has nothing to verify — don't show "Checking…" while the
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
      ? {
          owner: verification.owner,
          repo: verification.repo,
          branch: verification.branch,
        }
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
      <FormField
        htmlFor={field.name}
        help={t("assignments.template.help")}
        label={
          <>
            <GitHub
              aria-hidden="true"
              className="size-4 text-base-content/30 opacity-70"
            />
            {t("assignments.template.label")}
            <span className="font-normal text-base-content/60">
              ({t("assignments.form.optional")})
            </span>
          </>
        }
      >
        {({ id }) => (
          <Input
            id={id}
            name={field.name}
            autoComplete="off"
            spellCheck={false}
            placeholder={t("assignments.template.placeholder")}
            value={rawValue}
            onBlur={normalizeOnBlur(field)}
            onChange={(e) => field.handleChange(e.target.value)}
          />
        )}
      </FormField>

      <TemplateVerificationNote
        verification={verification}
        pending={pending}
        org={org}
        teamHasAccess={teamHasAccess}
        reconcile={
          isOwner && slug && org && classroom && inOrgPrivateTemplate ? (
            <ReconcileTemplateAccessInline
              org={org}
              classroom={classroom}
              slug={slug}
              template={{
                owner: inOrgPrivateTemplate.owner,
                repo: inOrgPrivateTemplate.repo,
                branch: inOrgPrivateTemplate.branch,
              }}
            />
          ) : undefined
        }
      />
    </>
  )
}

// The inline "Fix template access" recovery button rendered inside the
// "team doesn't have access yet" note. One-click, no confirmation (idempotent,
// additive-only). On a clean grant the hook seeds the team-access query true, so
// the surrounding verdict re-renders as "already has access"; a warning is shown
// inline and the button returns to idle for a retry.
const ReconcileTemplateAccessInline = ({
  org,
  classroom,
  slug,
  template,
}: {
  org: string
  classroom: string
  slug: string
  template: { owner: string; repo: string; branch: string }
}) => {
  const { t } = useTranslation()
  const reconcile = useReconcileTemplateAccess()
  const [warning, setWarning] = useState<string | undefined>(undefined)

  return (
    <span className="mt-1.5 block">
      <Button
        variant="ghost"
        size="sm"
        loading={reconcile.isPending}
        loadingLabel={t("assignments.template.reconcile.pending")}
        disabled={reconcile.isPending}
        onClick={() => {
          setWarning(undefined)
          reconcile.mutate(
            { org, classroom, slug, template },
            { onSuccess: (result) => setWarning(result.warning) },
          )
        }}
      >
        {t("assignments.template.reconcile.action")}
      </Button>
      {warning && (
        <span className="mt-1 block text-xs text-error">
          {t("assignments.template.reconcile.failed")} {warning}
        </span>
      )}
    </span>
  )
}

const TemplateVerificationNote = ({
  verification,
  pending,
  org,
  teamHasAccess,
  reconcile,
}: {
  verification: TemplateAccessVerification | null
  pending: boolean
  org?: string
  // For an in-org private template: true if the classroom team already has
  // read, false if granted on create, undefined if N/A or unresolved.
  teamHasAccess?: boolean
  // Inline recovery button, rendered inside the "no access yet" verdict (edit
  // form only). Undefined on create or when the verdict isn't in-org-private.
  reconcile?: ReactNode
}) => {
  const { t } = useTranslation()
  const { suspected, statusDescription } = useGitHubHealth()
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

  // Working assumption is `main`. When a verified template resolves to another
  // default branch, the assignment (and student autograding) key off that
  // branch — warn without blocking. Only kinds that carry a resolved branch.
  const resolvedBranch =
    "branch" in verification ? verification.branch : undefined
  const nonMainNote =
    resolvedBranch && resolvedBranch !== "main" ? (
      <Note tone="warning" icon={Info}>
        <Trans
          i18nKey="assignments.template.nonMainBranch"
          values={{ branch: resolvedBranch }}
          components={{ branch: <Code /> }}
        />
      </Note>
    ) : null

  const verdict = renderTemplateVerdict({
    verification,
    t,
    fallbackOrg,
    teamHasAccess,
    reconcile,
    outageSuspected: suspected,
    statusDescription,
  })

  if (!nonMainNote) return verdict
  return (
    <>
      {verdict}
      {nonMainNote}
    </>
  )
}

function renderTemplateVerdict({
  verification,
  t,
  fallbackOrg,
  teamHasAccess,
  reconcile,
  outageSuspected,
  statusDescription,
}: {
  verification: Exclude<TemplateAccessVerification, { kind: "empty" }>
  t: ReturnType<typeof useTranslation>["t"]
  fallbackOrg: string
  teamHasAccess?: boolean
  reconcile?: ReactNode
  // When the app suspects a GitHub outage, the inconclusive verdicts (unknown /
  // rate-limited) get an outage hint so a transient degradation doesn't read as
  // a broken template. No effect on definitive verdicts.
  outageSuspected: boolean
  statusDescription: string | null
}): ReactNode {
  // The inconclusive verdicts hint at an outage when either the global suspicion
  // is up OR this verify itself failed with an outage — the latter matters
  // because the verify query resolves-successfully, clearing the global flag.
  const outageHintNote = (verdictIsOutage: boolean) =>
    verdictIsOutage || outageSuspected ? (
      <span className="mt-1 block text-xs text-base-content/70">
        <GitHubStatusNote statusDescription={statusDescription} />
      </span>
    ) : null

  switch (verification.kind) {
    case "ok": {
      // Students can't read an in-org private template directly; the classroom
      // team grant is what lets them. Show whether it already exists or will be
      // added on create (see tryGrantTeamTemplateRead).
      if (verification.inOrg && verification.visibility === "private") {
        if (teamHasAccess === true) {
          return (
            <Note tone="success" icon={CheckCircle2}>
              <Trans
                i18nKey="assignments.template.privateHasAccess"
                values={{
                  owner: verification.owner,
                  branch: verification.branch,
                }}
                components={{ branch: <Code /> }}
              />
            </Note>
          )
        }
        return (
          <Note tone="success" icon={CheckCircle2}>
            <Trans
              i18nKey="assignments.template.privateWillGrant"
              values={{
                owner: verification.owner,
                branch: verification.branch,
              }}
              components={{ branch: <Code /> }}
            />
            {reconcile}
          </Note>
        )
      }
      const okKey = verification.inOrg
        ? verification.visibility === "public"
          ? "assignments.template.okPublicInOrg"
          : "assignments.template.okPrivateInOrg"
        : verification.visibility === "public"
          ? "assignments.template.okPublic"
          : "assignments.template.okPrivate"
      return (
        <Note tone="success" icon={CheckCircle2}>
          <Trans
            i18nKey={okKey}
            values={{ owner: verification.owner, branch: verification.branch }}
            components={{ branch: <Code /> }}
          />
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
          <Trans
            i18nKey="assignments.template.okVerify"
            values={{ owner: verification.owner, branch: verification.branch }}
            components={{ branch: <Code /> }}
          />
        </Note>
      )

    case "private-fork": {
      const view = templateForkNoteView(verification)
      // tone/messageKey come from templateForkNoteView (tested source of
      // truth). All three message keys share this interpolation set; the
      // no-parent key simply has no {{parent}} placeholder.
      return (
        <Note
          tone={view.tone}
          icon={view.tone === "warning" ? Info : AlertTriangle}
        >
          <Trans
            i18nKey={view.messageKey}
            values={{
              owner: verification.owner,
              repo: verification.repo,
              parent: verification.parent,
              branch: verification.branch,
            }}
            components={{ branch: <Code /> }}
          />
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
          {outageHintNote(verification.outage)}
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
          <Trans
            i18nKey="assignments.template.noBranch"
            values={{ owner: verification.owner, repo: verification.repo }}
            // The literal @<branch> hint lives in the component (not the
            // translation value) so its angle brackets never collide with the
            // Trans tag parser.
            components={{ hint: <Code>@&lt;branch&gt;</Code> }}
          />
        </Note>
      )

    case "rate-limited":
      return (
        <Note tone="neutral" icon={HelpCircle}>
          {t("assignments.template.rateLimited")}
          {outageHintNote(verification.outage)}
        </Note>
      )

    default: {
      // A new verdict kind becomes a compile error here.
      const _never: never = verification
      return _never
    }
  }
}

// Wraps InlineNote with an optional OAuth-policy link for cases where an org
// owner must approve the app.
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
