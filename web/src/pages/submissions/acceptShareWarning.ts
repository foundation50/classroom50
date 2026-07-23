// Roster-readiness warning for the assignment share (accept-link) modal. The
// accept link only works for ACTIVE org members enrolled on the classroom's
// student team, so a teacher who shares it before enrolling anyone (or while
// everyone is still a pending invite) hands out a link nobody can use yet.
//
//   - noStudents: zero enrolled students — nobody can accept (the #376 case).
//   - pending:    some enrolled, but `pending` invited students can't accept
//                 until they join the org.
//   - none:       at least one enrolled student and nothing pending to flag.
export type AcceptShareWarning =
  | { kind: "none" }
  | { kind: "noStudents" }
  | { kind: "pending"; pending: number }

// Pure decision so the branches (esp. the fail-safe on loading/error) are
// testable without React. Mirrors resolveEmptyRosterWarning: a loading or
// errored roster read NEVER warns — asserting "no students" on a transient or
// permission blip would false-alarm a populated classroom. `pendingHidden`
// (a non-owner can't read invitations) suppresses the pending note the same way.
export function resolveAcceptShareWarning(input: {
  isLoading: boolean
  isError: boolean
  enrolledStudents: number
  pending: number
  pendingHidden: boolean
}): AcceptShareWarning {
  if (input.isLoading || input.isError) return { kind: "none" }
  if (input.enrolledStudents === 0) return { kind: "noStudents" }
  if (!input.pendingHidden && input.pending > 0) {
    return { kind: "pending", pending: input.pending }
  }
  return { kind: "none" }
}
