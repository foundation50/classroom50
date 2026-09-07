import { useMutation, useQueryClient } from "@tanstack/react-query"
import { githubKeys, invalidateInviteQueries } from "@/github-core/queries"
import { useGitHubClient } from "@/context/github/GitHubProvider"
import { useUpdateRosterCache } from "@/hooks/useGetStudents"
import {
  useInvalidateTeamRoster,
  useSeedTeamMember,
} from "@/hooks/useTeamRoster"
import { enrollStudentInClassroom, inviteByEmail } from "@/domain/students"
import { useResolveEmailRows } from "@/hooks/useIdentityDirectory"
import { toStudent } from "@/util/roster"
import { CONFIG_REPO } from "@/util/configRepo"
import { rosterPath } from "@/util/rosterPath"

export type EnrollOrInviteFormValues = {
  first_name: string
  last_name: string
  username: string
  email: string
  section: string
}

// Add one student: a username enrolls via GitHub (resolve, team-add, org
// invite) and stores the email; an email-only value sends an org invite carrying
// the classroom team plus a per-invite metadata team, and retains the address —
// with the typed name and section — as a pending roster.csv row. Hook owns the
// cache reconcile — invite-query invalidation plus the optimistic
// seed-and-reconcile of the enrolled roster; toast/success/warning + form reset
// stay at the call site (see ./README.md).
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
  const resolveEmails = useResolveEmailRows(githubClient, org)

  return useMutation({
    meta: { keepTabOpen: true },
    mutationFn: async (value: EnrollOrInviteFormValues) => {
      const first_name = value.first_name.trim()
      const last_name = value.last_name.trim()
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

      // Email-only. Resolve-first, mirroring the upload's ladder: an address a
      // previous classroom's roster already mapped to an account is enrolled
      // directly (GitHub refuses to invite an existing member, and the
      // directory plus decision-time verification prove who owns it).
      const { links } = await resolveEmails([email])
      const link = links.at(0)
      if (link) {
        const result = await enrollStudentInClassroom(githubClient, {
          org,
          classroom,
          username: link.login,
          first_name,
          last_name,
          email,
          section: section || undefined,
        })
        return {
          kind: "username" as const,
          label: link.login,
          warning: result?.teamWarning ?? "",
          student: toStudent(result.student),
          enrolledMember: result.enrolled
            ? {
                id: Number(result.student.github_id),
                login: result.student.username,
              }
            : null,
        }
      }

      // No provable mapping -> a GitHub org invite (carrying the classroom
      // team + a per-invite metadata team that retains the email) plus a
      // pending email-only roster row. On acceptance the reconcile fills in
      // the account identity; a cancelled/expired invite's row stays on the
      // roster as "unlinked" for the teacher (the sync never removes rows).
      // The typed name/section ride along onto that row — nothing else can
      // recover them before the student has an account.
      const result = await inviteByEmail(githubClient, {
        org,
        classroom,
        email,
        first_name,
        last_name,
        section: section || undefined,
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
        // Email invite: refresh the pending-invitation view AND the roster
        // file (the invite retains the email as a pending email-only row).
        invalidateTeamRoster()
        void queryClient.invalidateQueries({
          queryKey: githubKeys.csvFile(org, CONFIG_REPO, rosterPath(classroom)),
        })
      }
    },
  })
}
