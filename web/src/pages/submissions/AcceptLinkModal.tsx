import {
  AlertTriangle,
  ChevronRight,
  Info,
  LinkIcon,
  UserPlus,
} from "lucide-react"
import { Trans, useTranslation } from "react-i18next"

import {
  Alert,
  CopyableCode,
  EmphasisLtr,
  Modal,
  RouterButton,
  rtlFlip,
} from "@/components/ui"
import { useCopyToClipboard } from "@/hooks/useCopyToClipboard"
import type { AcceptShareWarning } from "./acceptShareWarning"

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
  warning,
}: {
  open: boolean
  onClose: () => void
  url: string
  cli: string
  hasSecret: boolean
  // For the roster warning's "manage roster" link. Optional so a call site
  // without a resolved classroom can omit the warning entirely.
  org?: string
  classroom?: string
  // Human-readable classroom name for the warning copy (classroom.json name /
  // short_name), falling back to the classroom slug at the call site.
  classroomName?: string
  // Roster-readiness warning: whether anyone can actually accept this link yet.
  // Resolved by the page (which already reads the team roster) and passed in so
  // this component stays presentational. Omit / "none" to show no warning.
  warning?: AcceptShareWarning
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
        <AcceptShareWarningNotice
          warning={warning}
          org={org}
          classroom={classroom}
          classroomName={classroomName}
        />

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

// Roster-readiness notice shown inside the share modal. Warns (error tone) when
// no student can accept the link yet, or informs (info tone) when some invited
// students are still pending and can't accept until they join the org. Renders
// nothing for "none" or a missing classroom.
function AcceptShareWarningNotice({
  warning,
  org,
  classroom,
  classroomName,
}: {
  warning?: AcceptShareWarning
  org?: string
  classroom?: string
  classroomName?: string
}) {
  const { t } = useTranslation()
  if (!warning || warning.kind === "none" || !org || !classroom) return null

  if (warning.kind === "noStudents") {
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
    <Alert
      tone="info"
      className="flex flex-col items-stretch gap-3 sm:flex-row sm:items-center sm:justify-between"
    >
      <div className="flex items-start gap-2">
        <Info aria-hidden="true" className="mt-0.5 size-4 shrink-0" />
        <span className="text-sm">
          {t("submissions.accept.warnPending", { count: warning.pending })}
        </span>
      </div>
      <RouterButton
        to="/$org/$classroom/roster"
        params={{ org, classroom }}
        variant="info"
        size="sm"
        className="whitespace-nowrap sm:shrink-0"
      >
        <UserPlus aria-hidden="true" className="size-4" />
        {t("submissions.accept.manageRoster")}
      </RouterButton>
    </Alert>
  )
}
