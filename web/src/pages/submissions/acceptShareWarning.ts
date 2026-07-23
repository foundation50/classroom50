// Roster-readiness summary for the assignment share (accept-link) modal.
//
// The accept link works for any student the accept flow can turn into an active
// org member: an already-enrolled student, AND a student with a PENDING org
// invite (the accept page auto-accepts the invite inline — see
// useAcceptAndVerifyMembership). So the count of students who can accept is
// enrolled + pending; a teacher who shares before ANY student exists (zero
// enrolled and zero pending) hands out a link nobody can use yet (the #376
// case).
export type AcceptShareSummary = {
  // Students who can accept the link now or after auto-accepting their invite:
  // enrolled students + pending student invites.
  acceptableStudents: number
  // Whether to warn that no student can accept yet (acceptableStudents === 0),
  // loading/error-safe (see resolveAcceptShareSummary).
  warnNoStudents: boolean
}

// Pure decision so the branches (esp. the fail-safe on loading/error) are
// testable without React. A loading or errored roster read NEVER warns and
// reports a 0 count — asserting "no students" on a transient or permission blip
// would false-alarm a populated classroom (mirrors resolveEmptyRosterWarning).
// `pendingHidden` (a non-owner can't read invitations) drops pending from the
// tally so an unreadable count isn't guessed.
export function resolveAcceptShareSummary(input: {
  isLoading: boolean
  isError: boolean
  enrolledStudents: number
  pending: number
  pendingHidden: boolean
}): AcceptShareSummary {
  if (input.isLoading || input.isError) {
    return { acceptableStudents: 0, warnNoStudents: false }
  }
  const pending = input.pendingHidden ? 0 : input.pending
  const acceptableStudents = input.enrolledStudents + pending
  return {
    acceptableStudents,
    warnNoStudents: acceptableStudents === 0,
  }
}
