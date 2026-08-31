import {
  ArrowLeftIcon,
  FileAddedIcon,
  FileCheckIcon,
  GearIcon,
  PeopleIcon,
} from "@/components/ui/icons"
import { Link, useMatchRoute } from "@tanstack/react-router"
import { useTranslation } from "react-i18next"
import { useGithubAuth } from "@/auth/useGithubAuth"
import { useClassroomRoleContext } from "@/context/classroomRole/ClassroomRoleProvider"
import { can } from "@/authz"
import useGetClassroom from "@/hooks/useGetClassroom"
import usePagesAssignments from "@/hooks/usePagesAssignments"
import useDotClassroom50 from "@/hooks/useDotClassroom50"
import { useClassroomSecret } from "@/hooks/useStudentClassrooms"
import useGetAssignmentRepo from "@/hooks/useGetAssignmentRepo"
import { studentRepoName, GROUP_REPO_SEGMENT } from "@/util/studentRepo"
import useMyGroupTeam from "@/hooks/useMyGroupTeam"
import { SidebarItemBody, SidebarNavItem } from "./primitives"
import { sidebarIconButton } from "./sidebarClasses"
import { rtlFlip } from "@/components/ui"
import { useSidebarCollapse } from "./collapseContext"

export const AssignmentSidebarMenu = ({
  org,
  classroom,
  assignment,
}: {
  org: string
  classroom: string
  assignment: string
}) => {
  const { collapsed } = useSidebarCollapse()
  const { t } = useTranslation()
  const { role, roleResolved, actualRole } = useClassroomRoleContext()
  const showTeacherUi = can("viewClassroomStaffContent", {
    classroomRole: role,
  })
  const matchRoute = useMatchRoute()
  const { user } = useGithubAuth()

  // A protected classroom's public Pages fetch needs the capability secret. A
  // student reads it from their own repo's .classroom50.yaml (their only
  // source); a teacher gets it from classroom.json. Gate the classroom.json read
  // on the viewer's ACTUAL role (not the preview) so a teacher previewing as
  // a student still resolves the secret for a working accept link — a real
  // student's read stays disabled (guaranteed 404).
  const studentRepoNameForSecret = user?.login
    ? studentRepoName(classroom, assignment, user.login)
    : ""
  const { secret: studentSecret } = useDotClassroom50(
    org,
    studentRepoNameForSecret,
  )
  const isActuallyStaff = can("viewClassroomStaffContent", {
    classroomRole: actualRole,
  })
  const { data: classroomMeta } = useGetClassroom(org, classroom, {
    enabled: isActuallyStaff,
  })
  const secret = studentSecret || classroomMeta?.secret
  // Custom Pages base URL: team record for a real student, classroom.json for
  // actual staff (same dual sourcing as the secret above).
  const { pagesBaseUrl: teamPagesBaseUrl, isLoading: loadingBootstrap } =
    useClassroomSecret(org, classroom)
  const pagesBaseUrl = teamPagesBaseUrl || classroomMeta?.pages_base_url
  const { assignment: publicAssignment } = usePagesAssignments(
    org,
    classroom,
    secret,
    {
      assignmentSlug: assignment,
      pagesBaseUrl,
      enabled: !loadingBootstrap,
    },
  )
  // Group assignments give students collaborators to manage; individual
  // assignments have nothing student-editable, so we omit the settings entry
  // rather than route to a dead-end. Team mode manages members too (via the
  // group team), so it gets the entry as well.
  const isGroupAssignment =
    publicAssignment?.mode === "group" || publicAssignment?.mode === "team"

  const onRoute = (to: Parameters<typeof matchRoute>[0]["to"]) =>
    Boolean(matchRoute({ to, fuzzy: false }))

  const onSubmissions =
    onRoute("/$org/$classroom/assignments/$assignment/submissions") ||
    onRoute("/$org/$classroom/assignments/$assignment")
  const onSubmission = onRoute(
    "/$org/$classroom/assignments/$assignment/submission",
  )
  const onSettings = onRoute(
    "/$org/$classroom/assignments/$assignment/settings",
  )
  const onAccept = onRoute("/$org/$classroom/assignments/$assignment/accept")

  // Students only: surface "Accept" until they have their repo. Hidden while
  // loading (avoid a flash) and for a real staffer previewing as a student —
  // they have no student repo, so "Accept" would dead-end. Team mode resolves
  // the shared group repo through the viewer's team membership.
  const isTeamAssignment = publicAssignment?.mode === "team"
  const { data: myGroupTeam, isLoading: myTeamLoading } = useMyGroupTeam(
    org,
    classroom,
    assignment,
    { enabled: isTeamAssignment && Boolean(user?.login) },
  )
  const repoOwnerSegment = isTeamAssignment
    ? myGroupTeam
      ? `${GROUP_REPO_SEGMENT}${myGroupTeam.n}`
      : undefined
    : user?.login
  const { assignment: studentRepo, isLoading: repoLoading } =
    useGetAssignmentRepo(org, classroom, assignment, repoOwnerSegment)
  const showAccept =
    !showTeacherUi &&
    !isActuallyStaff &&
    roleResolved &&
    !repoLoading &&
    !(isTeamAssignment && myTeamLoading) &&
    !studentRepo

  return (
    <>
      {collapsed ? (
        <div className="sidebar-fade-in flex justify-center py-2 text-sm">
          <Link
            to="/$org/$classroom/assignments"
            params={{ org, classroom }}
            className={sidebarIconButton("p-1")}
            data-tip={t("nav.allAssignments")}
            aria-label={t("nav.allAssignments")}
          >
            <ArrowLeftIcon aria-hidden="true" className={`size-5 ${rtlFlip}`} />
          </Link>
        </div>
      ) : (
        <div className="sidebar-fade-in py-4 text-sm">
          <Link
            to="/$org/$classroom/assignments"
            params={{ org, classroom }}
            className="inline-flex items-center gap-1"
          >
            <ArrowLeftIcon
              aria-hidden="true"
              className={`size-3.5 shrink-0 ${rtlFlip}`}
            />
            {t("nav.allAssignmentsLink")}
          </Link>
        </div>
      )}

      <div className="py-4">
        <ul className="flex flex-col gap-1">
          {!roleResolved ? (
            <>
              {[0, 1].map((i) => (
                <li key={i} className="flex px-2 py-2">
                  <span
                    aria-hidden="true"
                    className="skeleton skeleton-shimmer h-4 w-24 bg-neutral-content/10"
                  />
                </li>
              ))}
            </>
          ) : showTeacherUi ? (
            <>
              <SidebarNavItem label={t("nav.submissions")}>
                <Link
                  to="/$org/$classroom/assignments/$assignment/submissions"
                  params={{ org, classroom, assignment }}
                >
                  <SidebarItemBody
                    label={t("nav.submissions")}
                    icon={<PeopleIcon aria-hidden="true" />}
                    active={onSubmissions}
                    groupId="assignment"
                  />
                </Link>
              </SidebarNavItem>
              <SidebarNavItem label={t("nav.settings")}>
                <Link
                  to="/$org/$classroom/assignments/$assignment/settings"
                  params={{ org, classroom, assignment }}
                >
                  <SidebarItemBody
                    label={t("nav.settings")}
                    icon={<GearIcon aria-hidden="true" />}
                    active={onSettings}
                    groupId="assignment"
                  />
                </Link>
              </SidebarNavItem>
            </>
          ) : (
            <>
              {showAccept && (
                <SidebarNavItem label={t("nav.acceptAssignment")}>
                  <Link
                    to="/$org/$classroom/assignments/$assignment/accept"
                    params={{ org, classroom, assignment }}
                    search={secret ? { k: secret } : undefined}
                  >
                    <SidebarItemBody
                      label={t("nav.acceptAssignment")}
                      icon={<FileAddedIcon aria-hidden="true" />}
                      active={onAccept}
                      groupId="assignment"
                    />
                  </Link>
                </SidebarNavItem>
              )}
              <SidebarNavItem label={t("nav.mySubmission")}>
                <Link
                  to="/$org/$classroom/assignments/$assignment/submission"
                  params={{ org, classroom, assignment }}
                >
                  <SidebarItemBody
                    label={t("nav.mySubmission")}
                    icon={<FileCheckIcon aria-hidden="true" />}
                    active={onSubmission}
                    groupId="assignment"
                  />
                </Link>
              </SidebarNavItem>
              {isGroupAssignment && (
                <SidebarNavItem label={t("nav.manageGroup")}>
                  <Link
                    to="/$org/$classroom/assignments/$assignment/settings"
                    params={{ org, classroom, assignment }}
                  >
                    <SidebarItemBody
                      label={t("nav.manageGroup")}
                      icon={<PeopleIcon aria-hidden="true" />}
                      active={onSettings}
                      groupId="assignment"
                    />
                  </Link>
                </SidebarNavItem>
              )}
            </>
          )}
        </ul>
      </div>
    </>
  )
}
