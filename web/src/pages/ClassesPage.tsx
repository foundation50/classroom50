import { useParams, Link } from "@tanstack/react-router"
import { Trans, useTranslation } from "react-i18next"
import {
  ChevronDownIcon,
  MarkGithubIcon,
  PlusIcon,
} from "@/components/ui/icons"

import useGetClasses from "@/hooks/useGetClasses"
import { useSafeSubmit } from "@/hooks/useSafeSubmit"

import PageShell from "@/components/PageShell"
import PageHeader from "@/components/PageHeader"
import { Alert, Button, Card, EmphasisLtr } from "@/components/ui"
import { useDocumentTitle } from "@/hooks/useDocumentTitle"
import MissingParams from "@/components/MissingParams"
import { useOrgStaff } from "@/hooks/useOrgStaff"
import { useGitHubOrgRole } from "@/context/githubOrgRole/GitHubOrgRoleProvider"
import { can } from "@/authz"
import useGetOwnOrgMembership from "@/hooks/useGetOwnOrgMembership"
import { useAcceptPendingOrgInvite } from "@/hooks/mutations/useAcceptPendingOrgInvite"
import OrgPreflightNotice from "@/pages/orgSettings/OrgPreflightNotice"
import ClassroomList from "@/pages/classes/ClassroomList"
import StudentClassroomList from "@/pages/classes/StudentClassroomList"
import { useStudentClassroomSummaries } from "@/hooks/useStudentClassroomSummaries"

// Split button: "New classroom" (primary) with a chevron dropdown whose only
// item is "Import from GitHub Classroom". Mirrors the assignments-page new
// button. The dropdown item is the removable migration entry point (#312) — the
// primary Link and this whole control's shell stay if migration is dropped.
const NewClassroomButton = ({ org }: { org: string }) => {
  const { t } = useTranslation()
  return (
    <div className="join">
      <Link
        to="/$org/classes/new"
        params={{ org }}
        className="btn btn-primary join-item"
      >
        <PlusIcon aria-hidden="true" className="size-4" />
        {t("classes.empty.createButton")}
      </Link>
      {/* Not a join-item itself: daisyUI resets the join radius vars for a
          join-item's children, which would square the inner button's corners.
          The wrapper still inherits the vars as the join's last child; -ms-px
          keeps the 1px border overlap join-item would have provided. */}
      <div className="dropdown dropdown-end -ms-px">
        <Button
          variant="primary"
          tabIndex={0}
          className="join-item h-full border-s border-primary-content/20 px-2"
          aria-label={t("classes.newButton.moreOptions")}
        >
          <ChevronDownIcon aria-hidden="true" className="size-4" />
        </Button>
        <ul
          tabIndex={0}
          role="menu"
          className="dropdown-content menu z-10 mt-1 w-max rounded-box border border-base-300 bg-base-100 p-1 shadow"
        >
          {/* FEATURE: github-classroom-migration — removable entry point (#312) */}
          <li>
            <Link to="/$org/import" params={{ org }}>
              <MarkGithubIcon aria-hidden="true" className="size-4" />
              {t("migration.entryButton")}
            </Link>
          </li>
        </ul>
      </div>
    </div>
  )
}

const CreateClassroomPane = ({ org }: { org: string }) => {
  const { t } = useTranslation()
  return (
    <Card dashed>
      <Card.Body className="items-center py-12 text-center">
        <div className="mb-2 flex size-14 items-center justify-center rounded-full bg-primary/10 text-primary">
          <PlusIcon aria-hidden="true" className="size-6" />
        </div>

        <Card.Title className="text-xl">{t("classes.empty.title")}</Card.Title>

        <p className="max-w-md text-base-content/70">
          {t("classes.empty.body")}
        </p>

        <Card.Actions className="mt-4">
          <NewClassroomButton org={org} />
        </Card.Actions>
      </Card.Body>
    </Card>
  )
}

const JoinOrgCard = ({ org }: { org: string }) => {
  const { t } = useTranslation()
  const run = useSafeSubmit()

  const mutation = useAcceptPendingOrgInvite(org)

  return (
    <Card dashed>
      <Card.Body className="items-center py-12 text-center">
        <div className="mb-2 flex size-14 items-center justify-center rounded-full bg-primary/10 text-primary">
          <PlusIcon aria-hidden="true" className="size-6" />
        </div>

        <Card.Title className="text-xl">{t("classes.join.title")}</Card.Title>

        <p className="max-w-md text-base-content/70">
          <Trans
            i18nKey="classes.join.body"
            values={{ org }}
            components={{
              org: <EmphasisLtr className="font-medium text-base-content" />,
            }}
          />
        </p>

        {mutation.isError ? (
          <Alert tone="error" className="mt-4 max-w-md text-start">
            {t("classes.join.error")}
          </Alert>
        ) : null}

        <Card.Actions className="mt-4">
          <Button
            variant="primary"
            loading={mutation.isPending}
            loadingLabel={t("classes.join.joining")}
            disabled={mutation.isPending}
            onClick={() => void run(() => mutation.mutateAsync())}
          >
            {mutation.isPending ? null : (
              <PlusIcon aria-hidden="true" className="size-4" />
            )}
            {mutation.isPending
              ? t("classes.join.joining")
              : t("classes.join.joinButton")}
          </Button>
        </Card.Actions>
      </Card.Body>
    </Card>
  )
}

const StudentClasses = ({ org }: { org: string }) => {
  const { t } = useTranslation()
  const { summaries, isLoading, isError, refetch } =
    useStudentClassroomSummaries(org)
  if (isError) {
    return (
      <Alert tone="error" className="items-start">
        <span className="text-sm">{t("classes.student.loadError")}</span>
        <Button variant="ghost" size="sm" onClick={() => refetch()}>
          {t("classes.student.retry")}
        </Button>
      </Alert>
    )
  }
  return (
    <StudentClassroomList org={org} summaries={summaries} loading={isLoading} />
  )
}

const ClassesPage = () => {
  const { t } = useTranslation()
  useDocumentTitle(t("documentTitle.classes"))
  const { org } = useParams({ strict: false })
  const { classes, isLoading: classesLoading } = useGetClasses(org)
  const { isStaff, isNonStaff, isLoading: roleLoading } = useOrgStaff(org)
  const { data: membership, isLoading: loadingMembership } =
    useGetOwnOrgMembership(org)
  const { githubOrgRole } = useGitHubOrgRole()

  const isMember = membership?.state === "active"
  // The org preflight (service token + policy audit) is an OWNER concern: a
  // non-owner can't read the service-token secret and would see a false
  // "failed" alert. Gate on the org-role capability, not the broad teacher
  // signal.
  const isOwner = can("manageOrg", { githubOrgRole })

  if (!org) {
    return <MissingParams message={t("classes.missingOrg")} />
  }

  return (
    <PageShell>
      <PageHeader
        loading={roleLoading}
        // Students also land on a classroom list here (their per-classroom
        // summaries), so the title is "My classrooms" for both roles.
        title={t("classes.myClasses")}
        subtitle={<p className="max-w-2xl">{t("classes.manageSubtitle")}</p>}
      />

      {isNonStaff && !isMember && !loadingMembership && (
        <JoinOrgCard org={org} />
      )}
      {isOwner && <OrgPreflightNotice org={org} />}
      {/* Hold the skeleton until BOTH the role and (for staff) the class list
          resolve — otherwise a staff view flashes the "no classrooms" empty
          state on the empty-while-loading array before the classes arrive. */}
      {roleLoading || (isStaff && classesLoading) ? (
        <div className="grid grid-cols-12 gap-4">
          {Array.from({ length: 3 }).map((_, i) => (
            <div
              key={i}
              className="skeleton skeleton-shimmer col-span-6 h-32 rounded-box xl:col-span-4"
            />
          ))}
        </div>
      ) : (
        <>
          {classes.length === 0 && isStaff && <CreateClassroomPane org={org} />}
          {isStaff && classes.length > 0 && (
            <ClassroomList org={org} dirs={classes} />
          )}
          {isNonStaff && isMember && <StudentClasses org={org} />}
        </>
      )}
    </PageShell>
  )
}

export default ClassesPage
