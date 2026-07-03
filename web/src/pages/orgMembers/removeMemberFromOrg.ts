import type { GitHubClient } from "@/hooks/github/client"
import type { TFunction } from "i18next"
import { unenrollStudent } from "@/api/mutations/students"
import {
  removeOrgMembership,
  deleteRepo,
  archiveRepo,
  getErrorMessage,
} from "@/hooks/github/mutations"
import { getAuthenticatedUser } from "@/api/queries/users"
import { isSameGitHubUser } from "@/util/students"
import { onboardingRepoName } from "@/util/onboarding"
import { GitHubAPIError } from "@/hooks/github/errors"
import type { Student } from "@/types/classroom"
import type { OrgMemberRow } from "@/util/orgMembers"

export type RemoveFromOrgResult = {
  // Classrooms the student was unenrolled from before org removal.
  unenrolledClassrooms: string[]
  // Non-fatal per-classroom unenroll failures; org removal still proceeds.
  warnings: string[]
  // Whether the org-membership DELETE succeeded.
  removed: boolean
}

// Reconstruct a minimal Student for the unenroll call from an aggregated row.
// unenrollStudent matches on username/github_id/email, all carried by the row.
const rowToStudent = (row: OrgMemberRow): Student => ({
  username: row.username,
  first_name: "",
  last_name: "",
  email: row.email,
  section: "",
  github_id: row.github_id,
  enrollment_status: "enrolled",
})

// Remove a student from the org without leaving any roster inconsistent:
// unenroll from every classroom FIRST, then remove org membership LAST, so a
// partial failure never strips membership while rosters still list the student.
// Per-classroom failures are non-fatal warnings.
export async function removeMemberFromOrg(
  client: GitHubClient,
  input: { org: string; row: OrgMemberRow },
  t?: TFunction,
): Promise<RemoveFromOrgResult> {
  const { org, row } = input
  const student = rowToStudent(row)
  const unenrolledClassrooms: string[] = []
  const warnings: string[] = []

  // Defense-in-depth self-guard: the Members page hides this action for the
  // signed-in viewer, but that guard is UI-only and depends on the viewer query
  // being loaded. Re-resolve the viewer server-side and refuse to remove the
  // acting account from the org. This guards an org-wide DELETE that is
  // effectively irreversible from the app, so it fails CLOSED: if the viewer
  // can't be resolved we refuse rather than risk a self-lockout. (unenrollStudent
  // can fail open since it's classroom-scoped and reversible; this can't.)
  const viewer = await getAuthenticatedUser(client).catch(() => null)
  if (!viewer) {
    throw new Error(
      "Couldn't verify your account, so the member wasn't removed. Please try again.",
    )
  }
  if (
    isSameGitHubUser(viewer, {
      github_id: row.github_id,
      username: row.username,
    })
  ) {
    throw new Error(
      "You can't remove your own account from the organization here.",
    )
  }

  // Without a GitHub username we can't DELETE the org membership (the GitHub
  // endpoint is keyed by username). Bail BEFORE clearing any rosters — clearing
  // them under a "Remove from organization" action that can't actually remove
  // the membership would be misleading, destructive work.
  if (!row.username) {
    return {
      unenrolledClassrooms: [],
      warnings: [
        `Couldn't remove ${row.email || "this student"} from the organization: no GitHub username on file.`,
      ],
      removed: false,
    }
  }

  for (const access of row.classrooms) {
    // Archived classrooms can't be unenrolled (unenrollStudent throws via
    // assertClassroomNotArchived), and the org DELETE below would still run —
    // leaving the student off the org but stuck on the archived roster, the very
    // inconsistency this flow exists to prevent. Skip them and report instead.
    if (access.archived) {
      warnings.push(
        t
          ? t("orgMembers.warnArchived", {
              who: row.username || row.email,
              classroom: access.classroom,
            })
          : `${row.username || row.email} is still on the archived classroom "${access.classroom}"; ` +
              `unarchive it to remove them from that roster.`,
      )
      continue
    }
    try {
      await unenrollStudent(client, {
        org,
        classroom: access.classroom,
        student,
      })
      unenrolledClassrooms.push(access.classroom)
    } catch (err) {
      warnings.push(
        t
          ? t("orgMembers.warnUnenrollFailed", {
              who: row.username || row.email,
              classroom: access.classroom,
              reason: getErrorMessage(err),
            })
          : `Couldn't unenroll ${row.username || row.email} from "${access.classroom}" (${getErrorMessage(
              err,
            )}); removed the others.`,
      )
    }
  }

  let removed = false
  try {
    await removeOrgMembership(client, { org, username: row.username })
    removed = true
  } catch (err) {
    warnings.push(
      `Removing ${row.username} from the organization failed (${getErrorMessage(
        err,
      )}); retry from the organization's people page.`,
    )
  }

  // Delete the leftover onboarding repo — but ONLY once removal succeeded, else a
  // transient DELETE failure would reap a still-present student's self-report.
  // Removing a member directly bypasses the per-classroom unenroll cleanup, so
  // onboarding-<id> can dangle; the name is derivable, so delete it by name (no
  // listing). Best-effort/idempotent (404 = gone; 403 no delete_repo scope ->
  // archive); only an unexpected failure warns.
  if (removed && row.github_id) {
    const onboardingRepo = onboardingRepoName(row.github_id)
    try {
      await deleteRepo(client, { owner: org, repo: onboardingRepo })
    } catch (err) {
      if (err instanceof GitHubAPIError && err.isForbidden) {
        try {
          await archiveRepo(client, { owner: org, repo: onboardingRepo })
        } catch {
          // Best-effort: leave the repo; it's no longer tied to an org member.
        }
      } else {
        warnings.push(
          t
            ? t("orgMembers.warnOnboardingRepo", {
                repo: onboardingRepo,
                reason: getErrorMessage(err),
              })
            : `Couldn't delete the leftover onboarding repository "${onboardingRepo}" (${getErrorMessage(
                err,
              )}); you can remove it manually.`,
        )
      }
    }
  }

  return { unenrolledClassrooms, warnings, removed }
}
