import { useGitHubRepo } from "./github/hooks"
import { useParams } from "@tanstack/react-router"
import { GitHubAPIError, retryTransientGitHubError } from "./github/errors"
import { useRoleView } from "@/context/roleView/RoleViewProvider"
import type { ViewAsRole } from "./useClassroomRole"

export type CourseManifest = {
  course: {
    slug: string
    title: string
  }
  assignments: Array<{
    id: string
    title: string
    repo: string
  }>
  students?: Array<{
    github: string
    name?: string
  }>
}

// The repo-query state the verdict depends on. Structural so the verdict stays a
// pure, testable function (no React Query).
export type TeacherVerdictInput = {
  org: string | undefined
  isSuccess: boolean
  permissions?: {
    admin?: boolean
    maintain?: boolean
    push?: boolean
    pull?: boolean
  }
  error: unknown
}

export type TeacherVerdict = {
  isTeacher: boolean
  isStudent: boolean
  isBlocked: boolean
  roleResolved: boolean
  showTeacherUi: boolean
}

// Pure, fail-closed role resolution against the org's `classroom50` config repo:
// teacher = repo GET succeeded with a non-trivial permission, student = 404,
// blocked = 403. Resolved only on a definitive verdict (success/404/403) — a
// transient 5xx/429/network error must NOT resolve, or a student during a blip
// would be promoted into teacher UI. Org-less routes have no role.
export function resolveTeacherVerdict(
  input: TeacherVerdictInput,
): TeacherVerdict {
  const { org, isSuccess, permissions, error } = input

  const isTeacher =
    isSuccess &&
    Boolean(
      permissions?.admin ||
      permissions?.maintain ||
      permissions?.push ||
      permissions?.pull,
    )

  const isStudent = error instanceof GitHubAPIError && error.status === 404
  const isBlocked = error instanceof GitHubAPIError && error.status === 403

  const roleResolved = !org || isSuccess || isStudent || isBlocked
  const showTeacherUi = Boolean(org) && isTeacher

  return { isTeacher, isStudent, isBlocked, roleResolved, showTeacherUi }
}

// Apply a "view as" preview to the coarse teacher/student verdict, so every
// surface reading showTeacherUi/isStudent transforms together. DOWNGRADE-ONLY:
// a preview can only hide teacher UI, never reveal it. Only "student" affects
// this coarse switch (a TA still sees staff content); the TA/instructor split
// lives in useClassroomRole.
export function applyViewAsToVerdict(
  verdict: TeacherVerdict,
  viewAs: ViewAsRole | null,
): TeacherVerdict {
  if (viewAs !== "student" || !verdict.isTeacher) return verdict
  return {
    ...verdict,
    isTeacher: false,
    isStudent: true,
    showTeacherUi: false,
  }
}

export function useCourseTeacherAccess(org: string | undefined) {
  const teacherRepo = "classroom50"
  // Bounded retry on transient errors only: a 404 (student) / 403 (blocked) is
  // definitive and must not retry, but a 5xx/429/network blip should self-heal
  // instead of stranding the role unresolved.
  const repoQuery = useGitHubRepo(org, teacherRepo, {
    retry: retryTransientGitHubError,
  })

  const verdict = resolveTeacherVerdict({
    org,
    isSuccess: repoQuery.isSuccess,
    permissions: repoQuery.data?.permissions,
    error: repoQuery.error,
  })

  // Apply the "view as" preview, but only on a classroom route — the preview is
  // classroom-scoped, so org-level surfaces keep the real verdict.
  const { classroom } = useParams({ strict: false })
  const { viewAs } = useRoleView()
  const effectiveVerdict = classroom
    ? applyViewAsToVerdict(verdict, viewAs)
    : verdict

  return {
    ...repoQuery,
    teacherRepo,
    ...effectiveVerdict,
  }
}
