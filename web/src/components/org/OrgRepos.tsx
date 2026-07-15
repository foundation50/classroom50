import { Link } from "@tanstack/react-router"
import { useTranslation } from "react-i18next"
import {
  BookOpen,
  ExternalLink,
  GraduationCap,
  Pencil,
  UserRound,
  UsersRound,
} from "lucide-react"

import { Card } from "@/components/ui"
import type { GitHubRepo } from "@/github-core/types"
import useGetOrgRepos from "@/hooks/useGetMyOrgRepos"
import useDotClassroom50 from "@/hooks/useDotClassroom50"
import useGetPublicAssignment from "@/hooks/useGetPublicAssignment"
import { EnterDiv } from "@/lib/motionComponents"

const RepoCard = ({ org, repo }: { org: string; repo: GitHubRepo }) => {
  const { t } = useTranslation()
  const cl50Yaml = useDotClassroom50(org, repo.name)
  const { classroom, assignment, secret } = cl50Yaml
  const { assignment: assignmentData } = useGetPublicAssignment(
    org,
    classroom,
    assignment,
    secret,
  )

  // Only group assignments have something a student can manage (collaborators);
  // for individual assignments the edit page is a dead-end, so no pencil.
  const canManageGroup =
    Boolean(classroom && assignment) && assignmentData?.mode === "group"

  return (
    <Card
      as={EnterDiv}
      radius="2xl"
      bordered={false}
      shadow={false}
      className="relative col-span-12 border border-base-200 md:col-span-6 xl:col-span-4"
    >
      {canManageGroup && classroom && assignment && (
        <Link
          to="/$org/$classroom/assignments/$assignment/edit"
          params={{ org, classroom, assignment }}
          className="btn btn-ghost btn-sm btn-circle absolute right-3 top-3 z-10 text-base-content/70 hover:text-primary"
          aria-label={t("classes.repo.manageGroupAria", { assignment })}
          title={t("classes.repo.manageGroupTitle")}
        >
          <Pencil aria-hidden="true" className="size-4" />
        </Link>
      )}

      <Card.Body className="gap-4">
        <div className="flex items-start justify-between gap-4 pr-8">
          <div className="min-w-0">
            <div className="mb-2 flex items-center gap-2">
              <div className="flex size-10 shrink-0 items-center justify-center rounded-xl bg-primary/10 text-primary">
                <BookOpen aria-hidden="true" className="size-5" />
              </div>

              <div className="min-w-0">
                <h3 className="truncate text-base font-semibold leading-tight">
                  {repo.name}
                </h3>
                <p className="truncate text-xs text-base-content/70">
                  {repo.owner?.login}
                </p>
              </div>
            </div>
          </div>
        </div>

        <p className="line-clamp-2 min-h-10 text-sm text-base-content/70">
          {repo.description || t("classes.repo.noDescription")}
        </p>

        {(classroom || assignment) && (
          <div className="alert alert-outline flex flex-col items-start">
            {classroom && (
              <Link
                to="/$org/$classroom"
                params={{ org, classroom }}
                className="max-w-full truncate group inline-flex w-fit gap-1.5 text-sm text-base-content/70 transition hover:text-primary"
              >
                <GraduationCap aria-hidden="true" className="size-4" />
                <span className="truncate">
                  {t("classes.repo.classroomLabel")}{" "}
                  <span className="font-medium text-base-content/80 group-hover:text-primary">
                    {classroom}
                  </span>
                </span>
              </Link>
            )}

            {classroom && assignment && (
              <Link
                to="/$org/$classroom/assignments/$assignment"
                params={{ org, classroom, assignment }}
                className="max-w-full truncate group inline-flex w-fit gap-1.5 text-sm text-base-content/70 transition hover:text-primary"
              >
                <BookOpen aria-hidden="true" className="size-4" />
                <span className="truncate">
                  {t("classes.repo.assignmentLabel")}{" "}
                  <span className="font-medium text-base-content/80 group-hover:text-primary">
                    {assignment}
                  </span>
                </span>
              </Link>
            )}
          </div>
        )}

        <Card.Actions className="items-center justify-between pt-1">
          <div className="flex flex-wrap items-end gap-2">
            {assignmentData?.mode === "individual" && (
              <div className="badge badge-ghost badge-sm py-3">
                <UserRound aria-hidden="true" className="size-4" />{" "}
                {t("classes.repo.individual")}
              </div>
            )}
            {assignmentData?.mode === "group" && (
              <div className="badge badge-ghost badge-sm">
                <UsersRound aria-hidden="true" className="size-4" />{" "}
                {t("classes.repo.group")}
              </div>
            )}
          </div>

          <a
            href={repo.html_url}
            target="_blank"
            rel="noreferrer"
            className="btn btn-sm btn-primary"
          >
            {t("classes.repo.openRepo")}
            <ExternalLink aria-hidden="true" className="size-4" />
          </a>
        </Card.Actions>
      </Card.Body>
    </Card>
  )
}

// The viewer's push-access repos in an org, optionally filtered to one
// classroom's `<classroom>-<assignment>-<user>` repos. Shared by the classes
// page (student "my repos") and the assignments page, so it lives in components/
// rather than a feature page.
export const OrgRepos = ({
  org,
  classroom,
}: {
  org: string
  classroom?: string
}) => {
  const { t } = useTranslation()
  const { data: repos } = useGetOrgRepos(org)

  if (!repos) return <></>

  let writableRepos = repos.filter((repo) => repo.permissions?.push)
  if (classroom) {
    // Classroom repos are `<classroom>-<assignment>-<user>`, so require the
    // trailing "-" to avoid matching a sibling classroom whose name extends
    // this one (e.g. "cs" wrongly matching "cs101-a1-bob").
    writableRepos = writableRepos.filter((repo) =>
      repo.name.startsWith(`${classroom}-`),
    )
  }

  if (writableRepos.length === 0) {
    return (
      <div className="rounded-2xl border border-dashed border-base-300 bg-base-100 p-8 text-center">
        <div className="mx-auto mb-3 flex size-12 items-center justify-center rounded-full bg-base-200">
          <BookOpen
            aria-hidden="true"
            className="size-6 text-base-content/70"
          />
        </div>

        <h2 className="text-lg font-semibold">
          {t("classes.repo.emptyTitle")}
        </h2>

        <p className="mx-auto mt-1 max-w-md text-sm text-base-content/70">
          {t("classes.repo.emptyBody")}
        </p>
      </div>
    )
  }

  return (
    <div className="grid grid-cols-12 gap-4">
      {writableRepos.map((repo) => (
        <RepoCard key={repo.id ?? repo.full_name} org={org} repo={repo} />
      ))}
    </div>
  )
}
