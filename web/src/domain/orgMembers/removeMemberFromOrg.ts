import type { GitHubClient } from "@/github-core/client"
import type { TFunction } from "i18next"
import { unenrollStudent } from "@/domain/students"
import { removeOrgMembership } from "@/github-core/mutations"
import { getErrorMessage } from "@/github-core/errorMessage"
import { getAuthenticatedUser } from "@/domain/queries/users"
import { isSameGitHubUser } from "@/util/students"
import type { Student } from "@/types/classroom"
import type { OrgMemberRow } from "@/util/orgMembers"
import { logger } from "@/lib/logger"

const log = logger.scope("orgMembers:removeMemberFromOrg")

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
  role: "",
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

  log.info("remove member from org: started", {
    org,
    classrooms: row.classrooms.length,
  })

  // Defense-in-depth self-guard: the Members page hides this action for the
  // viewer, but that guard is UI-only and depends on the viewer query loading.
  // Re-resolve the viewer server-side and refuse to remove the acting account.
  // This org-wide DELETE is effectively irreversible from the app, so it fails
  // CLOSED: if the viewer can't be resolved we refuse rather than risk a
  // self-lockout. (unenrollStudent can fail open — classroom-scoped and
  // reversible; this can't.)
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

  // Without a GitHub username we can't DELETE the org membership (endpoint keyed
  // by username). Bail BEFORE clearing rosters — doing so under an action that
  // can't actually remove membership would be misleading, destructive work.
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
    // assertClassroomNotArchived); the org DELETE below would still run, leaving
    // the student off the org but stuck on the archived roster — the very
    // inconsistency this flow prevents. Skip and report instead.
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
      log.warn("remove member: per-classroom unenroll failed", {
        org,
        classroom: access.classroom,
        err,
      })
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
    log.error("remove member: org membership DELETE failed", {
      org,
      err,
      record: true,
    })
    warnings.push(
      `Removing ${row.username} from the organization failed (${getErrorMessage(
        err,
      )}); retry from the organization's people page.`,
    )
  }

  log.info("remove member from org: completed", {
    org,
    unenrolled: unenrolledClassrooms.length,
    removed,
    warnings: warnings.length,
  })

  return { unenrolledClassrooms, warnings, removed }
}
