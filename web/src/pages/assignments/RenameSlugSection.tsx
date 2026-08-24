import { useState } from "react"
import { Trans, useTranslation } from "react-i18next"
import { TriangleAlert } from "lucide-react"

import { Alert, Button, Card, EmphasisLtr } from "@/components/ui"
import { RenameAssignmentModal } from "@/components/modals/RenameAssignmentModal"
import { isRenameEligible, needsRenameFinish } from "@/domain/assignments"
import { GITHUB_REPO_NAME_MAX_LEN } from "@/util/repoNameBudget"
import type { Assignment } from "@/types/classroom"

// The eligibility-gated "Slug update needed" callout on the assignment
// settings page (#691). Rendered only when the one-shot slug-update
// remediation applies: either the slug is over the composed repo-name budget
// and never renamed (fresh), or a prior update left stragglers and the
// assignment is still holding the fan-out lock (finish). Everything else
// renders nothing — renaming is not a general feature.
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
  // Keep rendering while the modal is open: a successful rename flips both
  // gates false on the invalidation refetch, and unmounting then would
  // destroy the modal's results report mid-display.
  if (!eligible && !finish && !open) return null
  const mode = finish ? "finish" : "fresh"

  return (
    <Card bordered={false} className="mb-6 w-full border border-warning/40">
      <Card.Body className="gap-4">
        <h2 className="card-title flex items-center gap-2 text-lg">
          <TriangleAlert aria-hidden="true" className="size-5 text-warning" />
          {finish
            ? t("assignments.rename.sectionFinishTitle")
            : t("assignments.rename.sectionTitle")}
        </h2>
        <Alert tone="warning" className="text-sm">
          <span className="break-all">
            {finish ? (
              <Trans
                i18nKey="assignments.rename.sectionFinishBody"
                values={{ from: assignment.renamed_from }}
                components={{
                  from: <EmphasisLtr className="font-mono font-bold" />,
                }}
              />
            ) : (
              <Trans
                i18nKey="assignments.rename.sectionBody"
                values={{
                  slug: assignment.slug,
                  limit: GITHUB_REPO_NAME_MAX_LEN,
                }}
                components={{
                  slug: <EmphasisLtr className="font-mono font-bold" />,
                }}
              />
            )}
          </span>
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
