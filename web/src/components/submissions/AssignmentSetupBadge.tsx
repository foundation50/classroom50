import { useEffect, useId, useRef, useState } from "react"
import { useTranslation } from "react-i18next"
import { FileCode2, FileX2, Workflow, ClipboardCheck } from "lucide-react"

import { Badge, Button, Modal } from "@/components/ui"
import { githubTemplateRepoUrl } from "@/util/orgUrl"
import GitHub from "@/assets/github.svg?react"
import { assignmentSetupInfo } from "@/domain/assignments/autogradingState"
import type { AssignmentSetupInfo } from "@/domain/assignments/autogradingState"
import type { Assignment } from "@/types/classroom"

// The icon for a setup state, rendered as a stable component (not a capitalized
// local assigned during render, which the static-components lint forbids): a
// template shows a code file, an empty repo a crossed-out file, a custom-CI
// assignment a workflow glyph, and the built-in (template-less, autograded)
// path a graded-clipboard glyph.
const SetupIcon = ({
  info,
  className = "size-3.5",
}: {
  info: AssignmentSetupInfo
  className?: string
}) => {
  if (info.state === "empty")
    return <FileX2 aria-hidden="true" className={className} />
  if (info.state === "none")
    return <Workflow aria-hidden="true" className={className} />
  return info.hasTemplate ? (
    <FileCode2 aria-hidden="true" className={className} />
  ) : (
    <ClipboardCheck aria-hidden="true" className={className} />
  )
}

// A read-only "how this assignment is set up" badge + detail modal. Click the
// badge to explain whether student repos come from a template and what grading
// (if any) runs — most importantly, that an empty-repo / custom-CI assignment
// has autograding, scores, and the Feedback PR disabled. Shared by the teacher
// gradebook heading and the student submission page so both describe the setup
// identically. The detail modal links the template repo when one is set.
export function AssignmentSetupBadge({
  assignment,
  size = "md",
}: {
  assignment: Assignment
  size?: "sm" | "md"
}) {
  const { t } = useTranslation()
  const info = assignmentSetupInfo(assignment)
  const [open, setOpen] = useState(false)
  const dialogRef = useRef<HTMLDialogElement | null>(null)
  const titleId = useId()

  useEffect(() => {
    if (open) dialogRef.current?.showModal()
  }, [open])

  const templateHref = assignment.template
    ? githubTemplateRepoUrl(
        assignment.template.owner,
        assignment.template.repo,
        assignment.template.branch,
      )
    : undefined
  const templateLabel = assignment.template
    ? `${assignment.template.owner}/${assignment.template.repo}`
    : undefined

  return (
    <>
      <button
        type="button"
        className="contents"
        onClick={() => setOpen(true)}
        title={t("submissions.setup.viewDetailsTitle")}
        aria-label={t("submissions.setup.viewDetailsTitle")}
      >
        <Badge
          tone={info.tone}
          size={size}
          className="cursor-pointer gap-1 hover:brightness-95"
        >
          <SetupIcon info={info} />
          {t(info.badgeKey)}
        </Badge>
      </button>

      {open ? (
        <Modal
          dialogRef={dialogRef}
          onClose={() => setOpen(false)}
          size="md"
          aria-labelledby={titleId}
        >
          <h3
            id={titleId}
            className="flex items-center gap-2 text-lg font-bold"
          >
            <SetupIcon info={info} className="size-5 shrink-0" />
            {t(info.badgeKey)}
          </h3>
          <p className="mt-3 text-sm text-base-content/80">
            {t(info.detailKey)}
          </p>
          {templateHref ? (
            <Button
              as="a"
              variant="outline"
              size="sm"
              href={templateHref}
              target="_blank"
              rel="noreferrer"
              className="mt-4 w-fit"
            >
              <GitHub aria-hidden="true" className="size-4" />
              {t("submissions.setup.viewTemplate", { repo: templateLabel })}
            </Button>
          ) : null}
        </Modal>
      ) : null}
    </>
  )
}

export default AssignmentSetupBadge
