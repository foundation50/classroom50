import { Link } from "@tanstack/react-router"
import { useState } from "react"
import { useTranslation } from "react-i18next"
import {
  BookIcon,
  LinkExternalIcon,
  LinkIcon,
  MortarBoardIcon,
  PencilIcon,
  PeopleIcon,
  PersonIcon,
  RepoIcon,
  RepoLockedIcon,
} from "@/components/ui/icons"

import { EmptyState } from "@/components/list"
import {
  Badge,
  Button,
  Card,
  Markdown,
  Modal,
  Heading,
  RouterButton,
} from "@/components/ui"
import type { GitHubRepo } from "@/github-core/types"
import { assignmentDescription } from "@/types/classroom"
import useGetOrgRepos from "@/hooks/useGetMyOrgRepos"
import useDotClassroom50 from "@/hooks/useDotClassroom50"
import usePagesAssignments from "@/hooks/usePagesAssignments"
import { useClassroomSecret } from "@/hooks/useStudentClassrooms"
import { EnterDiv } from "@/lib/motionComponents"

const RepoCard = ({ org, repo }: { org: string; repo: GitHubRepo }) => {
  const { t } = useTranslation()
  const [descriptionOpen, setDescriptionOpen] = useState(false)
  const cl50Yaml = useDotClassroom50(org, repo.name)
  const { classroom, assignment, secret } = cl50Yaml
  // Custom Pages base URL from the student's team-description record; the
  // read waits for it so a custom-domain org never fires a doomed github.io
  // fetch. One shared GET /user/teams query backs every card.
  const { pagesBaseUrl, isLoading: loadingBootstrap } = useClassroomSecret(
    org,
    classroom || undefined,
  )
  const { assignment: assignmentData } = usePagesAssignments(
    org,
    classroom,
    secret,
    {
      assignmentSlug: assignment,
      pagesBaseUrl,
      enabled: !loadingBootstrap,
    },
  )

  const description = assignmentDescription(assignmentData)
  // Prefer the human assignment name; the repo name is the fallback identity
  // (`<classroom>-<assignment>-<user>`) when assignment data hasn't resolved.
  const title = assignmentData?.name || assignment || repo.name

  // Only shared-repo assignments have something a student can manage (their
  // group); for individual assignments the edit page is a dead-end, so no pencil.
  const canManageGroup =
    Boolean(classroom && assignment) &&
    (assignmentData?.mode === "group" || assignmentData?.mode === "team")

  return (
    <Card
      as={EnterDiv}
      bordered={false}
      shadow={false}
      className="relative col-span-12 border border-base-200 md:col-span-6 xl:col-span-4"
    >
      {canManageGroup && classroom && assignment && (
        <RouterButton
          to="/$org/$classroom/assignments/$assignment/settings"
          params={{ org, classroom, assignment }}
          variant="ghost"
          size="sm"
          shape="circle"
          className="absolute end-3 top-3 z-10 text-base-content/70 hover:text-primary"
          aria-label={t("classes.repo.manageGroupAria", { assignment })}
          title={t("classes.repo.manageGroupTitle")}
        >
          <PencilIcon aria-hidden="true" className="size-4" />
        </RouterButton>
      )}

      <Card.Body className="gap-4">
        <div className="flex items-center gap-3 pe-8">
          <div className="flex size-10 shrink-0 items-center justify-center rounded-box bg-primary/10 text-primary">
            <BookIcon aria-hidden="true" className="size-4" />
          </div>
          <div className="min-w-0">
            {classroom && assignment ? (
              <Link
                to="/$org/$classroom/assignments/$assignment"
                params={{ org, classroom, assignment }}
                className="group inline-flex max-w-full items-center gap-1.5 transition-colors hover:text-primary"
              >
                <Heading
                  as="h3"
                  className="truncate underline decoration-base-content/30 underline-offset-2 group-hover:decoration-primary"
                >
                  {title}
                </Heading>
                <LinkIcon
                  aria-hidden="true"
                  className="size-4 shrink-0 text-base-content/40 group-hover:text-primary"
                />
              </Link>
            ) : (
              <Heading as="h3" className="truncate">
                {title}
              </Heading>
            )}
            <div className="mt-1 flex flex-col gap-0.5 text-xs text-base-content/70">
              {classroom ? (
                <span className="inline-flex max-w-full items-center gap-1.5">
                  <MortarBoardIcon
                    aria-hidden="true"
                    className="size-4 shrink-0 text-base-content/50"
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
                {/* Octicons specific-use pair: repo (muted) for public,
                    repo-locked (attention) for private. */}
                {repo.private ? (
                  <RepoLockedIcon
                    aria-hidden="true"
                    className="size-4 shrink-0 text-warning"
                  />
                ) : (
                  <RepoIcon
                    aria-hidden="true"
                    className="size-4 shrink-0 text-base-content/50"
                  />
                )}
                <span className="truncate font-mono">{repo.name}</span>
              </span>
            </div>
          </div>
        </div>

        <Card.Actions className="items-center justify-between gap-2 pt-1">
          <div className="flex items-center gap-2">
            {assignmentData?.mode === "individual" && (
              <Badge ghost className="py-3">
                <PersonIcon aria-hidden="true" className="size-4" />{" "}
                {t("classes.repo.individual")}
              </Badge>
            )}
            {assignmentData?.mode === "team" && (
              <Badge ghost className="py-3">
                <PeopleIcon aria-hidden="true" className="size-4" />{" "}
                {t("classes.repo.group")}
              </Badge>
            )}
            {assignmentData?.mode === "group" && (
              <Badge ghost className="py-3">
                <PeopleIcon aria-hidden="true" className="size-4" />{" "}
                {t("classes.repo.groupLegacy")}
              </Badge>
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
              <LinkExternalIcon aria-hidden="true" className="size-4" />
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
        title={title}
        subtitle={t("classes.repo.descriptionModalTitle")}
      >
        {description ? (
          <Markdown
            content={description}
            className="mt-4 max-h-[70vh] overflow-y-auto pe-1"
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
    // this one (e.g., "cs" wrongly matching "cs101-a1-bob").
    writableRepos = writableRepos.filter((repo) =>
      repo.name.startsWith(`${classroom}-`),
    )
  }

  if (writableRepos.length === 0) {
    return (
      <EmptyState
        icon={BookIcon}
        title={t("classes.repo.emptyTitle")}
        body={t("classes.repo.emptyBody")}
      />
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
