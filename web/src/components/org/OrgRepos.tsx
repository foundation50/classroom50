import { Link } from "@tanstack/react-router"
import { useState } from "react"
import { useTranslation } from "react-i18next"
import {
  BookOpen,
  ExternalLink,
  FolderGit2,
  GraduationCap,
  Link2,
  Pencil,
  UserRound,
  UsersRound,
} from "lucide-react"

import { Button, Card, Markdown, Modal } from "@/components/ui"
import type { GitHubRepo } from "@/github-core/types"
import { assignmentDescription } from "@/types/classroom"
import useGetOrgRepos from "@/hooks/useGetMyOrgRepos"
import useDotClassroom50 from "@/hooks/useDotClassroom50"
import useGetPublicAssignment from "@/hooks/useGetPublicAssignment"
import { EnterDiv } from "@/lib/motionComponents"

const RepoCard = ({ org, repo }: { org: string; repo: GitHubRepo }) => {
  const { t } = useTranslation()
  const [descriptionOpen, setDescriptionOpen] = useState(false)
  const cl50Yaml = useDotClassroom50(org, repo.name)
  const { classroom, assignment, secret } = cl50Yaml
  const { assignment: assignmentData } = useGetPublicAssignment(
    org,
    classroom,
    assignment,
    secret,
  )

  const description = assignmentDescription(assignmentData)
  // Prefer the human assignment name; the repo name is the fallback identity
  // (`<classroom>-<assignment>-<user>`) when assignment data hasn't resolved.
  const title = assignmentData?.name || assignment || repo.name

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
          className="btn btn-ghost btn-sm btn-circle absolute end-3 top-3 z-10 text-base-content/70 hover:text-primary"
          aria-label={t("classes.repo.manageGroupAria", { assignment })}
          title={t("classes.repo.manageGroupTitle")}
        >
          <Pencil aria-hidden="true" className="size-4" />
        </Link>
      )}

      <Card.Body className="gap-4">
        <div className="flex items-center gap-3 pe-8">
          <div className="flex size-10 shrink-0 items-center justify-center rounded-xl bg-primary/10 text-primary">
            <BookOpen aria-hidden="true" className="size-5" />
          </div>
          <div className="min-w-0">
            {classroom && assignment ? (
              <Link
                to="/$org/$classroom/assignments/$assignment"
                params={{ org, classroom, assignment }}
                className="group inline-flex max-w-full items-center gap-1.5 transition-colors hover:text-primary"
              >
                <h3 className="truncate text-base font-semibold leading-tight underline decoration-base-content/30 underline-offset-2 group-hover:decoration-primary">
                  {title}
                </h3>
                <Link2
                  aria-hidden="true"
                  className="size-3.5 shrink-0 text-base-content/40 group-hover:text-primary"
                />
              </Link>
            ) : (
              <h3 className="truncate text-base font-semibold leading-tight">
                {title}
              </h3>
            )}
            <div className="mt-1 flex flex-col gap-0.5 text-xs text-base-content/70">
              {classroom ? (
                <span className="inline-flex max-w-full items-center gap-1.5">
                  <GraduationCap
                    aria-hidden="true"
                    className="size-3.5 shrink-0 text-base-content/50"
                  />
                  <span className="truncate">
                    {t("classes.repo.classroomLabel")}{" "}
                    <span className="font-medium text-base-content/80">
                      {classroom}
                    </span>
                  </span>
                </span>
              ) : null}
              <span className="inline-flex max-w-full items-center gap-1.5">
                <FolderGit2
                  aria-hidden="true"
                  className="size-3.5 shrink-0 text-base-content/50"
                />
                <span className="truncate font-mono">{repo.name}</span>
              </span>
            </div>
          </div>
        </div>

        <Card.Actions className="items-center justify-between gap-2 pt-1">
          <div className="flex items-center gap-2">
            {assignmentData?.mode === "individual" && (
              <div className="badge badge-ghost badge-sm py-3">
                <UserRound aria-hidden="true" className="size-4" />{" "}
                {t("classes.repo.individual")}
              </div>
            )}
            {assignmentData?.mode === "group" && (
              <div className="badge badge-ghost badge-sm py-3">
                <UsersRound aria-hidden="true" className="size-4" />{" "}
                {t("classes.repo.group")}
              </div>
            )}
          </div>

          <div className="flex flex-wrap items-center justify-end gap-2">
            {description ? (
              <Button
                variant="outline"
                size="sm"
                onClick={() => setDescriptionOpen(true)}
              >
                {t("classes.repo.details")}
              </Button>
            ) : null}
            <Button
              as="a"
              variant="primary"
              size="sm"
              href={repo.html_url}
              target="_blank"
              rel="noreferrer"
            >
              {t("classes.repo.openRepo")}
              <ExternalLink aria-hidden="true" className="size-4" />
            </Button>
          </div>
        </Card.Actions>
      </Card.Body>

      {/* Always mount the Modal so its open/close effect can run; gating the
          whole element on `description` would tear the open dialog out on a
          background refetch without firing onClose, stranding descriptionOpen. */}
      <Modal
        open={descriptionOpen && Boolean(description)}
        onClose={() => setDescriptionOpen(false)}
        size="2xl"
        aria-label={t("classes.repo.descriptionModalTitle")}
      >
        <div className="mb-4 pe-8">
          <p className="text-xs font-medium uppercase tracking-wide text-base-content/50">
            {t("classes.repo.descriptionModalTitle")}
          </p>
          <h3 className="text-lg font-bold">{title}</h3>
        </div>
        {description ? (
          <Markdown
            content={description}
            className="max-h-[70vh] overflow-y-auto pe-1"
          />
        ) : null}
      </Modal>
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
