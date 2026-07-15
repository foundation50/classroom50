import { useNavigate } from "@tanstack/react-router"
import { useTranslation } from "react-i18next"
import { Copy, Eye, Pencil, Trash2, UserRound, UsersRound } from "lucide-react"

import GitHub from "@/assets/github.svg?react"
import useGetScores from "@/hooks/useGetScores"
import { formatDueDate } from "@/util/formatDate"
import { githubTemplateRepoUrl } from "@/util/orgUrl"
import { Link } from "@tanstack/react-router"
import { useState } from "react"
import { ConfirmModal } from "@/components/modals"
import { ReuseAssignmentModal } from "@/components/modals/ReuseAssignmentModal"
import { githubKeys } from "@/github-core/queries"
import { CONFIG_REPO } from "@/util/configRepo"
import { useMutation, useQueryClient } from "@tanstack/react-query"
import {
  deleteAssignment,
  type DeleteAssignmentInput,
} from "@/domain/assignments"
import { useGitHubClient } from "@/context/github/GitHubProvider"
import type { Assignment } from "@/types/classroom"
import { EnterDiv } from "@/lib/motionComponents"
import { Badge, Button } from "@/components/ui"

const DeleteAssignmentButton = ({
  org,
  classroom,
  assignment,
  onDeleteAssignment,
}: {
  org: string
  classroom: string
  assignment: Assignment
  onDeleteAssignment: () => void
}) => {
  const { t } = useTranslation()
  const client = useGitHubClient()
  const [open, setOpen] = useState(false)
  const deleteAssignmentMutation = useMutation({
    mutationFn: (input: DeleteAssignmentInput) =>
      deleteAssignment(client, input),
    onSuccess: () => onDeleteAssignment(),
  })

  return (
    <>
      <Button
        variant="ghost"
        size="sm"
        shape="circle"
        onClick={(e) => {
          e.stopPropagation()
          setOpen(true)
        }}
        className="text-error"
        aria-label={t("assignments.table.deleteAria", {
          name: assignment.name || assignment.slug,
        })}
      >
        <Trash2 className="size-4" aria-hidden="true" />
      </Button>

      <ConfirmModal
        open={open}
        title={t("assignments.table.deleteTitle")}
        description={
          <>
            {t("assignments.table.deleteDescription_1")}{" "}
            <span className="font-semibold text-base-content">
              {assignment.name || assignment.slug}
            </span>{" "}
            {t("assignments.table.deleteDescription_2")}{" "}
            <span className="font-semibold text-base-content">
              {org}/{classroom}
            </span>{" "}
            {t("assignments.table.deleteDescription_3")}
          </>
        }
        confirmText={assignment.slug}
        confirmLabel={t("assignments.table.deleteConfirm")}
        cancelLabel={t("assignments.table.deleteCancel")}
        dangerous
        onConfirm={async () => {
          await deleteAssignmentMutation.mutateAsync({
            org,
            classroom,
            assignment: assignment.slug,
          })
          onDeleteAssignment()
        }}
        onClose={() => setOpen(false)}
      />
    </>
  )
}

const ReuseAssignmentButton = ({
  org,
  classroom,
  assignment,
}: {
  org: string
  classroom: string
  assignment: Assignment
}) => {
  const { t } = useTranslation()
  const [open, setOpen] = useState(false)

  return (
    <>
      <Button
        variant="ghost"
        size="sm"
        shape="circle"
        onClick={(e) => {
          e.stopPropagation()
          setOpen(true)
        }}
        title={t("assignments.table.reuseTitle")}
        aria-label={t("assignments.table.reuseAria")}
      >
        <Copy aria-hidden="true" className="size-4" />
      </Button>

      {open ? (
        <ReuseAssignmentModal
          org={org}
          classroom={classroom}
          assignment={assignment}
          onClose={() => setOpen(false)}
        />
      ) : null}
    </>
  )
}

const SkeletonRows = ({ rows = 4 }: { rows?: number }) => (
  <>
    {Array.from({ length: rows }).map((_, i) => (
      <tr key={i}>
        <td>
          <div className="skeleton skeleton-shimmer h-4 w-40" />
        </td>
        <td>
          <div className="skeleton skeleton-shimmer h-4 w-24" />
        </td>
        <td>
          <div className="skeleton skeleton-shimmer h-6 w-28" />
        </td>
        <td>
          <div className="skeleton skeleton-shimmer h-4 w-56" />
        </td>
        <td>
          <div className="skeleton skeleton-shimmer ml-auto h-8 w-16" />
        </td>
      </tr>
    ))}
  </>
)

const AssignmentsTable = ({
  org,
  classroom,
  assignments,
  studentCount,
  loading = false,
  archived = false,
}: {
  org: string
  classroom: string
  assignments?: Assignment[]
  // Authoritative student-role count (from useStudentCount), the denominator for
  // the submission ratio. undefined while the count is still resolving.
  studentCount?: number
  loading?: boolean
  // When archived, hide per-row mutating actions (edit/reuse/delete); viewing
  // stays available.
  archived?: boolean
}) => {
  const { t } = useTranslation()
  const queryClient = useQueryClient()
  const { data: scoresData } = useGetScores(org, classroom)
  const navigate = useNavigate()

  return (
    <EnterDiv
      key={loading ? "loading" : "loaded"}
      className="overflow-x-auto rounded-box border border-base-content/5 bg-base-100"
    >
      <table className="table">
        <caption className="sr-only">{t("assignments.table.caption")}</caption>
        <thead>
          <tr>
            <th scope="col">{t("assignments.table.colAssignment")}</th>
            <th scope="col">{t("assignments.table.colType")}</th>
            <th scope="col">{t("assignments.table.colDueDate")}</th>
            <th scope="col">{t("assignments.table.colSubmissions")}</th>
            <th scope="col">
              <span className="sr-only">
                {t("assignments.table.colActions")}
              </span>
            </th>
          </tr>
        </thead>
        <tbody>
          {loading && <SkeletonRows />}
          {!loading && !assignments?.length && (
            <tr>
              <td colSpan={5} className="text-center">
                {t("assignments.table.empty")}
              </td>
            </tr>
          )}
          {!loading &&
            assignments?.map((assignment) => (
              <tr
                key={assignment.slug}
                className="hover:cursor-pointer hover:bg-base-200"
              >
                <td
                  onClick={() =>
                    navigate({
                      to: "/$org/$classroom/assignments/$assignment/submissions",
                      params: { org, classroom, assignment: assignment.slug },
                    })
                  }
                  className="truncate"
                >
                  <div className="font-bold link link-info no-underline">
                    {assignment.name}
                  </div>
                  <div className="font-mono text-xs text-base-content/70">
                    {assignment.slug}
                  </div>
                </td>
                <td
                  onClick={() =>
                    navigate({
                      to: "/$org/$classroom/assignments/$assignment/submissions",
                      params: { org, classroom, assignment: assignment.slug },
                    })
                  }
                  className="max-xl:text-xs"
                >
                  {assignment.mode === "individual" && (
                    <div className="flex gap-2 h-full">
                      <UserRound className="max-xl:size-3" aria-hidden="true" />{" "}
                      {t("assignments.table.individual")}
                    </div>
                  )}
                  {assignment.mode === "group" && (
                    <div className="flex gap-2 h-full">
                      <UsersRound
                        className="max-xl:size-3"
                        aria-hidden="true"
                      />{" "}
                      {t("assignments.table.group")}
                    </div>
                  )}
                </td>
                <td
                  onClick={() =>
                    navigate({
                      to: "/$org/$classroom/assignments/$assignment/submissions",
                      params: { org, classroom, assignment: assignment.slug },
                    })
                  }
                >
                  <Badge
                    tone="neutral"
                    size="md"
                    className="max-xl:text-xs xl:text-sm whitespace-nowrap w-full"
                  >
                    {assignment.due
                      ? formatDueDate(assignment.due)
                      : t("assignments.table.noDueDate")}
                  </Badge>
                </td>
                <td
                  onClick={() =>
                    navigate({
                      to: "/$org/$classroom/assignments/$assignment/submissions",
                      params: { org, classroom, assignment: assignment.slug },
                    })
                  }
                >
                  {(() => {
                    const submitted =
                      scoresData?.submissions?.[assignment.slug]?.length || 0

                    // Group assignments submit per-repo, not per-student, so a
                    // roster denominator is meaningless — show the count.
                    if (assignment.mode === "group") {
                      return (
                        <span className="whitespace-nowrap">
                          {t("assignments.table.groupsSubmitted", {
                            count: submitted,
                          })}
                        </span>
                      )
                    }

                    // Denominator is the authoritative student-role count, not
                    // the roster row count (which includes staff). The
                    // numerator is a repo-count from scores.json with no role
                    // join, so a submission from a non-student repo could push
                    // it past the denominator — clamp the displayed fraction and
                    // the bar to 100% (KTD4). undefined count reads as 0 until it
                    // resolves.
                    const denominator = studentCount ?? 0
                    const shown = Math.min(submitted, denominator)
                    return (
                      <>
                        {shown} / {denominator}{" "}
                        <progress
                          className="progress progress-info w-56"
                          value={
                            denominator === 0 ? 0 : (shown / denominator) * 100
                          }
                          max="100"
                        ></progress>
                      </>
                    )
                  })()}
                </td>
                <td>
                  {assignment.template && (
                    <a
                      href={githubTemplateRepoUrl(
                        assignment.template.owner,
                        assignment.template.repo,
                        assignment.template.branch,
                      )}
                      target="_blank"
                      rel="noreferrer"
                      className="btn btn-circle btn-sm btn-ghost"
                      title={t("assignments.table.sourceRepoTitle")}
                      aria-label={t("assignments.table.sourceRepoAria", {
                        name: assignment.name || assignment.slug,
                      })}
                      onClick={(event) => {
                        event.stopPropagation()
                      }}
                    >
                      <GitHub aria-hidden="true" className="size-4" />
                    </a>
                  )}
                  <Link
                    className="btn btn-circle btn-sm btn-ghost"
                    to="/$org/$classroom/assignments/$assignment/edit"
                    params={{
                      org,
                      classroom,
                      assignment: assignment.slug,
                    }}
                    title={
                      archived
                        ? t("assignments.table.viewAssignment")
                        : t("assignments.table.editAssignment")
                    }
                    onClick={(event) => {
                      event.stopPropagation()
                    }}
                  >
                    {archived ? (
                      <Eye aria-hidden="true" className="size-4" />
                    ) : (
                      <Pencil aria-hidden="true" className="size-4" />
                    )}
                  </Link>
                  {archived ? null : (
                    <>
                      <ReuseAssignmentButton
                        org={org}
                        classroom={classroom}
                        assignment={assignment}
                      />
                      <DeleteAssignmentButton
                        org={org}
                        classroom={classroom}
                        assignment={assignment}
                        onDeleteAssignment={() =>
                          queryClient.invalidateQueries({
                            queryKey: githubKeys.jsonFile(
                              org,
                              CONFIG_REPO,
                              `${classroom}/assignments.json`,
                            ),
                          })
                        }
                      />
                    </>
                  )}
                </td>
              </tr>
            ))}
        </tbody>
      </table>
    </EnterDiv>
  )
}

export default AssignmentsTable
