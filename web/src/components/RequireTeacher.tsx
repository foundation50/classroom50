import { type ReactNode } from "react"
import { useParams } from "@tanstack/react-router"
import { useCourseTeacherAccess } from "@/hooks/useCourseTeacherAccess"
import { useClassroomRole, isInstructorRole } from "@/hooks/useClassroomRole"
import { useGithubAuth } from "@/auth/useGithubAuth"
import NotFound from "@/components/NotFound"
import RoleResolvingFallback from "@/components/RoleResolvingFallback"

// What a guarded surface requires:
// - "staff": any classroom staff (owner/instructor/ta) — for classroom CONTENT
//   (roster, authoring, submissions). Backed by config-repo access.
// - "instructor": owner OR instructor of THIS classroom (excludes TAs) — for
//   classroom SETTINGS. Needs a `$classroom` route param.
// - "owner": org admin only — for ORG-wide settings/setup, where TA and
//   instructor can't be distinguished without a classroom context.
export type RequireRole = "staff" | "instructor" | "owner"

// Gate page content by role. While the role resolves we show a spinner (never
// flash a 404 at a real teacher), then children or NotFound. Access is
// GitHub-enforced underneath; this UX guard 404s rather than 403s by design.
// Default `allow: "staff"` preserves the original behavior.
const RequireTeacher = ({
  children,
  allow = "staff",
}: {
  children: ReactNode
  allow?: RequireRole
}) => {
  if (allow === "staff") return <RequireStaff>{children}</RequireStaff>
  return <RequireElevated allow={allow}>{children}</RequireElevated>
}

// Staff gate: any config-repo access (owner/instructor/ta). Used for classroom
// content TAs may see.
const RequireStaff = ({ children }: { children: ReactNode }) => {
  const { org } = useParams({ strict: false })
  const { showTeacherUi, roleResolved } = useCourseTeacherAccess(org)

  if (!roleResolved) return <RoleResolvingFallback />
  if (!showTeacherUi) return <NotFound />
  return <>{children}</>
}

// Elevated gate: "instructor" (owner OR instructor of this classroom) or
// "owner" (org admin). Resolves the full classroom role; TAs are excluded.
const RequireElevated = ({
  children,
  allow,
}: {
  children: ReactNode
  allow: "instructor" | "owner"
}) => {
  const { org, classroom } = useParams({ strict: false })
  const { user } = useGithubAuth()
  const { role, isLoading } = useClassroomRole(org, classroom, user?.login)

  // `unresolved` means a signal is still in flight or hit a transient error —
  // hold the spinner rather than flash NotFound at a real instructor/owner.
  if (isLoading || role === "unresolved") return <RoleResolvingFallback />

  // "instructor" allows owner OR instructor; "owner" is owner-only.
  const permitted =
    allow === "owner" ? role === "owner" : isInstructorRole(role)

  if (!permitted) return <NotFound />
  return <>{children}</>
}

export default RequireTeacher
