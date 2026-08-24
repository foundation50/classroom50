import { useState } from "react"
import { useTranslation } from "react-i18next"
import { TriangleAlert } from "lucide-react"

import { Alert, Button, Card } from "@/components/ui"
import { RenameAssignmentModal } from "@/components/modals/RenameAssignmentModal"
import { isRenameEligible, needsRenameFinish } from "@/domain/assignments"
import { GITHUB_REPO_NAME_MAX_LEN } from "@/util/repoNameBudget"
import type { Assignment } from "@/types/classroom"

// The eligibility-gated "Rename slug" section on the assignment settings page
// (#691). Rendered only when the one-shot rename remediation applies: either
// the slug is over the composed repo-name budget and never renamed (fresh), or
// a prior rename left stragglers and the assignment is still holding the
// fan-out lock (finish). Everything else renders nothing — renaming is not a
// general feature.
export function RenameSlugSection({
  org,
  classroom,
  assignment,
  assignments,
}: {
  org: string
  classroom: string
  assignment: Assignment
  assignments: Assignment[]
}) {
  const { t } = useTranslation()
  const [open, setOpen] = useState(false)
  const eligible = isRenameEligible(classroom, assignment)
  const finish = needsRenameFinish(assignment)
  if (!eligible && !finish) return null
  const mode = finish ? "finish" : "fresh"

  return (
    <Card bordered={false} className="mt-6 w-full border border-warning/40">
      <Card.Body className="gap-4">
        <h2 className="card-title flex items-center gap-2 text-lg">
          <TriangleAlert aria-hidden="true" className="size-5 text-warning" />
          {t("assignments.rename.sectionTitle")}
        </h2>
        <Alert tone="warning" className="text-sm">
          {finish
            ? t("assignments.rename.sectionFinishBody", {
                from: assignment.renamed_from,
              })
            : t("assignments.rename.sectionBody", {
                classroom,
                slug: assignment.slug,
                limit: GITHUB_REPO_NAME_MAX_LEN,
              })}
        </Alert>
        <Card.Actions className="justify-end">
          <Button variant="warning" onClick={() => setOpen(true)}>
            {finish
              ? t("assignments.rename.sectionFinishButton")
              : t("assignments.rename.sectionButton")}
          </Button>
        </Card.Actions>
      </Card.Body>
      {open ? (
        <RenameAssignmentModal
          open={open}
          onClose={() => setOpen(false)}
          org={org}
          classroom={classroom}
          assignment={assignment}
          assignments={assignments}
          mode={mode}
        />
      ) : null}
    </Card>
  )
}

export default RenameSlugSection
