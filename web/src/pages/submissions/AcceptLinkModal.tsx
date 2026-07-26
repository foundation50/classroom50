import { AlertTriangle, ChevronRight, LinkIcon, UserPlus } from "lucide-react"
import { Trans, useTranslation } from "react-i18next"
import { Link } from "@tanstack/react-router"

import {
  Alert,
  CopyableCode,
  EmphasisLtr,
  Modal,
  RouterButton,
  rtlFlip,
} from "@/components/ui"
import { useCopyToClipboard } from "@/hooks/useCopyToClipboard"
import { OrgRepoCreationNotice } from "@/components/OrgRepoCreationNotice"
import type { AcceptShareSummary } from "./acceptShareSummary"

// The "How students accept" content, moved out of the page into a modal so the
// roster surfaces higher. Owns its own clipboard state (two independent copy
// buttons) so the page stays uninvolved.
export function AcceptLinkModal({
  open,
  onClose,
  url,
  cli,
  hasSecret,
  org,
  classroom,
  classroomName,
  summary,
}: {
  open: boolean
  onClose: () => void
  url: string
  cli: string
  hasSecret: boolean
  // For the roster warning's "manage roster" link. Optional so a call site
  // without a resolved classroom can omit the summary entirely.
  org?: string
  classroom?: string
  // Human-readable classroom name for the warning copy (classroom.json name /
  // short_name), falling back to the classroom slug at the call site.
  classroomName?: string
  // Roster-readiness summary: how many students can accept, and whether to warn
  // that none can yet. Resolved by the page (which already reads the team
  // roster) and passed in so this component stays presentational.
  summary?: AcceptShareSummary
}) {
  const { t } = useTranslation()
  const { copied: copiedUrl, copy: copyUrl } = useCopyToClipboard(url, 1500)
  const { copied: copiedCli, copy: copyCli } = useCopyToClipboard(cli, 1500)

  return (
    <Modal open={open} onClose={onClose} size="2xl">
      <div className="flex items-start gap-3">
        <div className="rounded-xl bg-primary/10 p-2.5 text-primary">
          <LinkIcon aria-hidden="true" className="size-5" />
        </div>
        <div className="min-w-0 flex-1">
          <h3 className="text-lg font-bold">
            {t("submissions.accept.heading")}
          </h3>
          <p className="text-sm text-base-content/70">
            {t("submissions.accept.subheading")}
          </p>
        </div>
      </div>

      <div className="mt-4 flex flex-col gap-4">
        <AcceptShareSummaryNotice
          summary={summary}
          org={org}
          classroom={classroom}
          classroomName={classroomName}
        />

        {/* Sharing the link is the last moment before students hit the
            accept-time 403, and an org that refuses member repo creation breaks
            every accept regardless of how ready the roster is — so this sits
            beside the roster notice rather than replacing it. No margin: the
            wrapper's `gap-4` owns the spacing. */}
        <OrgRepoCreationNotice org={org} className="" />

        {hasSecret ? (
          <p className="text-sm text-base-content/70">
            {t("submissions.accept.unlistedNote")}
          </p>
        ) : null}

        <CopyableCode
          value={url}
          copied={copiedUrl}
          onCopy={copyUrl}
          label={t("submissions.accept.copyLink")}
        />

        <details className="group/cli">
          <summary className="flex w-fit cursor-pointer list-none items-center gap-1 text-sm text-base-content/70 hover:text-base-content">
            <ChevronRight
              aria-hidden="true"
              className={`size-4 transition-transform ${rtlFlip} group-open/cli:rotate-90`}
            />
            {t("submissions.accept.preferCli")}
          </summary>
          <CopyableCode
            className="mt-2"
            value={cli}
            copied={copiedCli}
            onCopy={copyCli}
            label={t("submissions.accept.copyCli")}
          />
        </details>
      </div>
    </Modal>
  )
}

export default AcceptLinkModal

// Roster-readiness notice shown inside the share modal. Warns (warning tone)
// when no student can accept the link yet, otherwise shows how many students
// the link reaches (enrolled + pending, since the accept flow auto-accepts a
// pending invite). Renders nothing while unresolved or without a classroom.
function AcceptShareSummaryNotice({
  summary,
  org,
  classroom,
  classroomName,
}: {
  summary?: AcceptShareSummary
  org?: string
  classroom?: string
  classroomName?: string
}) {
  const { t } = useTranslation()
  if (!summary || !summary.resolved || !org || !classroom) return null

  if (summary.warnNoStudents) {
    return (
      <Alert
        tone="warning"
        className="flex flex-col items-stretch gap-3 sm:flex-row sm:items-center sm:justify-between"
      >
        <div className="flex items-start gap-2">
          <AlertTriangle
            aria-hidden="true"
            className="mt-0.5 size-4 shrink-0"
          />
          <span className="text-sm">
            <Trans
              i18nKey="submissions.accept.warnNoStudents"
              values={{ classroom: classroomName || classroom }}
              components={{ classroom: <EmphasisLtr /> }}
            />
          </span>
        </div>
        <RouterButton
          to="/$org/$classroom/roster"
          params={{ org, classroom }}
          variant="warning"
          size="sm"
          className="whitespace-nowrap sm:shrink-0"
        >
          <UserPlus aria-hidden="true" className="size-4" />
          {t("submissions.accept.manageRoster")}
        </RouterButton>
      </Alert>
    )
  }

  return (
    <p className="text-sm text-base-content/70">
      <Trans
        i18nKey="submissions.accept.shareWithCount"
        count={summary.acceptableStudents}
        values={{ count: summary.acceptableStudents }}
        components={{
          count: (
            <Link
              to="/$org/$classroom/roster"
              params={{ org, classroom }}
              className="font-bold text-info underline decoration-info/40 underline-offset-2 hover:decoration-info"
            />
          ),
        }}
      />
    </p>
  )
}
