import type { Student } from "@/types/classroom"
import type { GitHubOrgInvitation, GitHubUser } from "@/hooks/github/types"
import { isReconcilableRow } from "@/util/onboarding"
import { bindReportsToRows } from "@/util/reconcileMatch"
import { memberIdSet } from "@/util/identity"

export type InviteStatus =
  "member" | "pending" | "expired" | "onboarding" | "ready" | "removed" | "none"

// A student's onboarding self-report, parsed from the onboarding repo's YAML.
// github_id/github_username are GitHub-attested; email and the names are claimed
// by the student. The match keys (invite_token/github_id/email) classify
// "ready"; the names let the teacher roster backfill a CSV row missing first/
// last name before enrollment is confirmed. first_name/last_name are optional
// for back-compat with pre-name payloads; github_username is always present
// (YAML schema requires it). invite_token is present only for a secure-link
// onboarding (reconcile's strongest key). email_hash is precomputed by the
// reader so the synchronous classifier can match on it without re-hashing.
export type OnboardingSelfReport = {
  github_id: string
  email: string
  github_username: string
  first_name?: string
  last_name?: string
  invite_token?: string
  email_hash: string
}

export type StudentInviteStatus = {
  status: InviteStatus
  // Invitation id for an "expired" student, used to cancel before resend.
  invitationId?: number
  // The matched invitation's created_at, for "Invited <when>".
  invitedAt?: string
  // The onboarding self-report this row matched (by github_id, else email),
  // when one exists. Present for "ready" rows; the edit modal reads its names.
  selfReport?: OnboardingSelfReport
}

const lower = (value: string | null | undefined) => (value ?? "").toLowerCase()

// Re-exported so existing callers (orgMembers, EnrolledStudents) keep their
// import path; the canonical implementation lives in @/util/identity.
export { memberIdSet }

// Builds lookups once, then classifies each student. Members match on numeric id
// (login fallback); invitations on login/email. Pass `onboardedReports` undefined
// while still loading so an empty set isn't read as "nobody onboarded". `roster`
// feeds the SHARED matcher (reconcileMatch) so the "ready" badge honors exactly
// what reconcile does (token -> github_id -> email_hash, ambiguous left unbound).
export function buildInviteStatusLookup(
  members: GitHubUser[],
  pendingInvitations: GitHubOrgInvitation[],
  failedInvitations: GitHubOrgInvitation[],
  onboardedReports: OnboardingSelfReport[] = [],
  roster: Student[] = [],
) {
  const memberIds = memberIdSet(members)
  const memberLogins = new Set(members.map((member) => lower(member.login)))

  // Bind reports to rows exactly as reconcile will (only reconcilable rows are
  // candidates; enrolled rows are classified member/removed below). readyReportByRow
  // maps each bound Student to its report for the "ready" status + name display.
  const reconcilable = roster.filter(isReconcilableRow)
  const matchableReports = onboardedReports.map((report) => ({
    invite_token: report.invite_token,
    github_id: report.github_id.trim(),
    email: report.email,
    emailHash: report.email_hash,
    report,
  }))
  const bound = bindReportsToRows(
    matchableReports,
    reconcilable,
    (row) => row.email_hash ?? "",
  )
  const readyReportByRow = new Map<Student, OnboardingSelfReport>()
  for (const [row, match] of bound) {
    readyReportByRow.set(row, match.report.report)
  }

  const pendingByLogin = new Map<string, GitHubOrgInvitation>()
  const pendingByEmail = new Map<string, GitHubOrgInvitation>()
  for (const invite of pendingInvitations) {
    const login = lower(invite.login)
    const email = lower(invite.email)
    if (login && !pendingByLogin.has(login)) pendingByLogin.set(login, invite)
    if (email && !pendingByEmail.has(email)) pendingByEmail.set(email, invite)
  }

  const failedByLogin = new Map<string, GitHubOrgInvitation>()
  const failedByEmail = new Map<string, GitHubOrgInvitation>()
  for (const invite of failedInvitations) {
    const login = lower(invite.login)
    const email = lower(invite.email)
    if (login && !failedByLogin.has(login)) failedByLogin.set(login, invite)
    if (email && !failedByEmail.has(email)) failedByEmail.set(email, invite)
  }

  return (student: Student): StudentInviteStatus => {
    const login = lower(student.username)
    const email = lower(student.email)
    const githubId = student.github_id?.trim()
    const enrollment = student.enrollment_status

    // CSV records completeness, but an enrolled student can later leave the org.
    // Cross-check the immutable github_id against LIVE org members: present ->
    // "member"; absent -> "removed". Narrows the prior contract for the
    // presence check only — completeness (enrolled) stays CSV-owned.
    if (enrollment === "enrolled") {
      if (githubId && !memberIds.has(githubId)) {
        return { status: "removed" }
      }
      return { status: "member" }
    }

    // Not yet enrolled. A matching self-report (by github_id, or email for an
    // email-invited row) means they've onboarded and are READY to confirm.
    // Otherwise surface a still-pending/expired GitHub invite for resend, else
    // "onboarding" (invited, nothing to confirm yet).
    if (enrollment === "invited") {
      const matchedReport = readyReportByRow.get(student)
      if (matchedReport) {
        return { status: "ready", selfReport: matchedReport }
      }

      const pendingInvite =
        (login ? pendingByLogin.get(login) : undefined) ??
        (email ? pendingByEmail.get(email) : undefined)
      if (pendingInvite) {
        return {
          status: "pending",
          invitationId: pendingInvite.id,
          invitedAt: pendingInvite.created_at,
        }
      }
      const failedInvite =
        (login ? failedByLogin.get(login) : undefined) ??
        (email ? failedByEmail.get(email) : undefined)
      if (failedInvite) {
        return {
          status: "expired",
          invitationId: failedInvite.id,
          invitedAt: failedInvite.created_at,
        }
      }
      return { status: "onboarding" }
    }

    // Legacy rows (no enrollment_status): fall back to org-list classification.
    if ((githubId && memberIds.has(githubId)) || memberLogins.has(login)) {
      return { status: "member" }
    }

    const pending =
      (login ? pendingByLogin.get(login) : undefined) ??
      (email ? pendingByEmail.get(email) : undefined)
    if (pending) {
      return {
        status: "pending",
        invitationId: pending.id,
        invitedAt: pending.created_at,
      }
    }

    const failed =
      (login ? failedByLogin.get(login) : undefined) ??
      (email ? failedByEmail.get(email) : undefined)
    if (failed) {
      return {
        status: "expired",
        invitationId: failed.id,
        invitedAt: failed.created_at,
      }
    }

    return { status: "none" }
  }
}
