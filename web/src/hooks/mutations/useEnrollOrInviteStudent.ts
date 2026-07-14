import { useMutation, useQueryClient } from "@tanstack/react-query"
import { invalidateInviteQueries } from "@/github-core/queries"
import { useGitHubClient } from "@/context/github/GitHubProvider"
import { useUpdateRosterCache } from "@/hooks/useGetStudents"
import {
  useInvalidateTeamRoster,
  useSeedTeamMember,
} from "@/hooks/useTeamRoster"
import { enrollStudentInClassroom, inviteByEmail } from "@/domain/students"
import { splitName, toStudent } from "@/util/roster"

export type EnrollOrInviteFormValues = {
  name: string
  username: string
  email: string
  section: string
}

// Add one student: a username enrolls via GitHub (resolve, team-add, org
// invite) and stores the email; an email-only value sends a pure org invite
// carrying the classroom team (no roster.csv write). Hook owns the cache
// reconcile — invite-query invalidation plus the optimistic seed-and-reconcile
// of the enrolled roster; toast/success/warning + form reset stay at the call
// site (see ./README.md).
export function useEnrollOrInviteStudent(
  org: string,
  classroom: string,
  // Called with the enrolled login on a successful username enrollment so the
  // parent can clear any session-unenroll suppression (a re-added student is
  // enrolled again). Data-consistency, so it fires from the hook's onSuccess.
  onEnrolled?: (username: string) => void,
) {
  const githubClient = useGitHubClient()
  const queryClient = useQueryClient()
  const updateRosterCache = useUpdateRosterCache(org, classroom)
  const invalidateTeamRoster = useInvalidateTeamRoster(org, classroom)
  const seedTeamMember = useSeedTeamMember(org, classroom)

  return useMutation({
    mutationFn: async (value: EnrollOrInviteFormValues) => {
      const { first_name, last_name } = splitName(value.name)
      const username = value.username.trim()
      const email = value.email.trim()
      const section = value.section.trim()

      // Username present -> GitHub enrolment (carry the email onto the row).
      if (username) {
        const result = await enrollStudentInClassroom(githubClient, {
          org,
          classroom,
          username,
          first_name,
          last_name,
          email: email || undefined,
          section: section || undefined,
        })
        return {
          kind: "username" as const,
          label: username,
          warning: result?.teamWarning ?? "",
          student: toStudent(result.student),
          // Already-active member: team-added directly (no invite), so seed the
          // members cache to avoid a "not in org" flash.
          enrolledMember: result.enrolled
            ? {
                id: Number(result.student.github_id),
                login: result.student.username,
              }
            : null,
        }
      }

      // Email-only -> a pure GitHub org invite (carrying the classroom team) and
      // NO roster.csv write: the team is the enrollment source of truth and an
      // email carries no reliable identity. The invite surfaces in the roster's
      // "pending" section via the org pending-invitations list; name/section are
      // captured later by adding the student by username or uploading a roster.
      const result = await inviteByEmail(githubClient, {
        org,
        classroom,
        email,
      })
      return {
        kind: "email" as const,
        label: email,
        warning: result?.inviteWarning ?? "",
      }
    },
    onSuccess: (result) => {
      invalidateInviteQueries(queryClient, org)
      if (result.kind === "username") {
        // Show the new row immediately (see useUpdateRosterCache).
        updateRosterCache((current) => [...current, result.student])
        // Clear any earlier unenroll suppression for this login so the roster's
        // auto-backfills treat the re-added student as enrolled again.
        onEnrolled?.(result.student.username)
        // Enrolled member -> seed the team-members cache so the row shows
        // enrolled at once; the invited path already shows a pending invite, so
        // just invalidate.
        if (result.enrolledMember) {
          seedTeamMember(result.enrolledMember)
        } else {
          invalidateTeamRoster()
        }
      } else {
        // Email invite writes no CSV row; just refresh so the new pending
        // org-invitation shows in the roster.
        invalidateTeamRoster()
      }
    },
  })
}
