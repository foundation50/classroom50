import { useParams, Link } from "@tanstack/react-router"
import { useTranslation } from "react-i18next"
import {
  BookOpen,
  ExternalLink,
  GraduationCap,
  Pencil,
  Plus,
  UserRound,
  UsersRound,
} from "lucide-react"
import GitHub from "@/assets/github.svg?react"

import useGetClasses from "@/hooks/useGetClasses"
import { useSafeSubmit } from "@/hooks/useSafeSubmit"

import PageShell from "@/components/PageShell"
import { useDocumentTitle } from "@/hooks/useDocumentTitle"
import type { GitHubRepo } from "@/hooks/github/types"
import MissingParams from "@/components/MissingParams"
import { useCourseTeacherAccess } from "@/hooks/useCourseTeacherAccess"
import useGetOwnOrgMembership from "@/hooks/useGetOwnOrgMembership"
import { useMutation, useQueryClient } from "@tanstack/react-query"
import { acceptPendingOrgInvite } from "@/api/mutations/users"
import { useGitHubClient } from "@/context/github/GitHubProvider"
import useGetOrgRepos from "@/hooks/useGetMyOrgRepos"
import useDotClassroom50 from "@/hooks/useDotClassroom50"
import useGetPublicAssignment from "@/hooks/useGetPublicAssignment"
import OrgPreflightNotice from "@/pages/orgSettings/OrgPreflightNotice"
import ClassroomList from "@/pages/classes/ClassroomList"
import { EnterDiv } from "@/lib/motionComponents"
import { githubOrgUrl } from "@/util/orgUrl"

const CreateClassroomPane = ({ org }: { org: string }) => {
  const { t } = useTranslation()
  return (
    <div className="card border border-dashed border-base-300 bg-base-100 shadow-sm">
      <div className="card-body items-center py-12 text-center">
        <div className="mb-2 flex size-14 items-center justify-center rounded-full bg-primary/10 text-primary">
          <Plus aria-hidden="true" className="size-7" />
        </div>

        <h2 className="card-title text-xl">{t("classes.empty.title")}</h2>

        <p className="max-w-md text-base-content/70">
          {t("classes.empty.body")}
        </p>

        <div className="card-actions mt-4">
          <Link
            to="/$org/classes/new"
            params={{ org }}
            type="button"
            className="btn btn-primary"
          >
            <Plus aria-hidden="true" className="size-4" />
            {t("classes.empty.createButton")}
          </Link>
        </div>
      </div>
    </div>
  )
}

const JoinOrgCard = ({ org }: { org: string }) => {
  const { t } = useTranslation()
  const client = useGitHubClient()
  const queryClient = useQueryClient()
  const run = useSafeSubmit()

  const mutation = useMutation({
    mutationFn: () => acceptPendingOrgInvite(client, org),
    onSuccess: () => {
      queryClient.invalidateQueries({
        queryKey: ["github", "memberships", "orgs", org],
      })
      queryClient.invalidateQueries({ queryKey: ["orgs"] })
    },
  })

  return (
    <div className="card border border-dashed border-base-300 bg-base-100 shadow-sm">
      <div className="card-body items-center py-12 text-center">
        <div className="mb-2 flex size-14 items-center justify-center rounded-full bg-primary/10 text-primary">
          <Plus aria-hidden="true" className="size-7" />
        </div>

        <h2 className="card-title text-xl">{t("classes.join.title")}</h2>

        <p className="max-w-md text-base-content/70">
          {t("classes.join.body_prefix")}{" "}
          <span className="font-medium text-base-content">{org}</span>
          {t("classes.join.body_suffix")}
        </p>

        {mutation.isError ? (
          <div className="alert alert-error mt-4 max-w-md text-left">
            {t("classes.join.error")}
          </div>
        ) : null}

        <div className="card-actions mt-4">
          <button
            type="button"
            className="btn btn-primary"
            disabled={mutation.isPending}
            onClick={() => void run(() => mutation.mutateAsync())}
          >
            {mutation.isPending ? (
              <span
                className="loading loading-spinner loading-sm"
                aria-hidden="true"
              />
            ) : (
              <Plus aria-hidden="true" className="size-4" />
            )}
            {mutation.isPending
              ? t("classes.join.joining")
              : t("classes.join.joinButton")}
          </button>
        </div>
      </div>
    </div>
  )
}

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
    <EnterDiv className="card relative col-span-12 rounded-2xl border border-base-200 bg-base-100 md:col-span-6 xl:col-span-4">
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

      <div className="card-body gap-4">
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

        <div className="card-actions items-center justify-between pt-1">
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
        </div>
      </div>
    </EnterDiv>
  )
}

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

  let maintainRepos = repos.filter((repo) => repo.permissions?.maintain)
  if (classroom) {
    maintainRepos = maintainRepos.filter((repo) =>
      repo.name.startsWith(classroom),
    )
  }

  if (maintainRepos.length === 0) {
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
      {maintainRepos.map((repo) => (
        <RepoCard key={repo.id ?? repo.full_name} org={org} repo={repo} />
      ))}
    </div>
  )
}

const ClassesPage = () => {
  const { t } = useTranslation()
  useDocumentTitle(t("documentTitle.classes"))
  const { org } = useParams({ strict: false })
  const { classes } = useGetClasses(org)
  const {
    isTeacher,
    isStudent,
    isLoading: roleLoading,
  } = useCourseTeacherAccess(org)
  const { data: membership, isLoading: loadingMembership } =
    useGetOwnOrgMembership(org)

  const isMember = membership?.state === "active"
  // The org preflight (service token + policy audit) is an OWNER concern: a
  // non-owner can't read the service-token secret and would see a false
  // "failed" alert. Gate on ownership, not the broad teacher signal.
  const isOwner = membership?.role === "admin"

  if (!org) {
    return <MissingParams message={t("classes.missingOrg")} />
  }

  return (
    <PageShell page="classes" selected="assignments">
      <div className="mb-8">
        <div className="flex flex-col gap-6 p-6 sm:flex-row sm:items-center sm:justify-between">
          <div className="space-y-4">
            <div className="flex items-center gap-3">
              <GitHub aria-hidden="true" className="size-5 opacity-70" />

              <div>
                <div className="text-xs font-medium uppercase tracking-wide text-base-content/70">
                  {t("classes.githubOrganization")}
                </div>
                <a
                  href={githubOrgUrl(org)}
                  target="_blank"
                  rel="noreferrer"
                  title={t("common.openOrgOnGitHub", { org })}
                  className="font-mono text-sm font-semibold text-base-content hover:text-primary hover:underline"
                >
                  {org}
                </a>
              </div>
            </div>

            <div>
              {roleLoading ? (
                <div className="skeleton skeleton-shimmer h-8 w-48" />
              ) : (
                <h1 className="text-2xl font-bold tracking-tight">
                  {isTeacher
                    ? t("classes.myClasses")
                    : t("classes.myAssignments")}
                </h1>
              )}
              <p className="mt-2 max-w-2xl text-sm text-base-content/70">
                {t("classes.manageSubtitle")}
              </p>
            </div>
          </div>
        </div>
        {isStudent && !isMember && !loadingMembership && (
          <JoinOrgCard org={org} />
        )}
      </div>
      {isOwner && <OrgPreflightNotice org={org} />}
      {roleLoading ? (
        <div className="grid grid-cols-12 gap-4 mb-6">
          {Array.from({ length: 3 }).map((_, i) => (
            <div
              key={i}
              className="skeleton skeleton-shimmer col-span-6 h-32 rounded-xl xl:col-span-4"
            />
          ))}
        </div>
      ) : (
        <>
          {classes.length === 0 && isTeacher && (
            <CreateClassroomPane org={org} />
          )}
          {isTeacher && classes.length > 0 && (
            <ClassroomList org={org} dirs={classes} />
          )}
          {isStudent && isMember && <OrgRepos org={org} />}
        </>
      )}
    </PageShell>
  )
}

export default ClassesPage
