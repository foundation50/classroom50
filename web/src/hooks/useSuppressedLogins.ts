import { useRef } from "react"

// Session-scoped set of GitHub logins the teacher just unenrolled, used to stop
// the roster's automatic backfills (auto-sync, auto-reconcile) from re-adding
// someone they removed. Unenroll is classroom-scoped — it drops the CSV row and
// classroom-team seat but leaves an active member's ORG membership intact — so a
// removed student can momentarily be a live org member with no team seat, which
// auto-reconcile would otherwise "fix" by team-adding them back (and auto-sync
// re-appending the CSV row). GitHub's Contents API is eventually consistent, so
// a refetch right after the CSV delete can also resurface the row. Remembering
// the login across those windows blocks the loop.
//
// Lives above EnrolledStudents + AddStudent (shared parent) so a re-enroll from
// the Add modal can `forget` the login it previously suppressed — otherwise a
// legitimately re-added student would stay suppressed until reload. In-memory by
// design: a full reload re-derives roster state and clears it (matching the
// drift-banner dismissal), so a genuinely still-drifted student is one refresh —
// or the explicit Sync/Reconcile — away.
export type SuppressedLogins = {
  remember: (logins: Iterable<string>) => void
  forget: (logins: Iterable<string>) => void
  has: (login: string) => boolean
  clear: () => void
}

const normalize = (login: string) => login.trim().toLowerCase()

// Filter `candidates` down to logins NOT currently suppressed. Pure so the
// backfill effects' skip decision is unit-testable in isolation. Case- and
// whitespace-insensitive on both sides, matching how logins are stored.
export function dropSuppressed(
  candidates: string[],
  suppressed: { has: (login: string) => boolean },
): string[] {
  return candidates.filter((login) => !suppressed.has(normalize(login)))
}

export function useSuppressedLogins(): SuppressedLogins {
  const ref = useRef<Set<string>>(new Set())
  return {
    remember: (logins) => {
      for (const login of logins) {
        const key = normalize(login)
        if (key) ref.current.add(key)
      }
    },
    forget: (logins) => {
      for (const login of logins) ref.current.delete(normalize(login))
    },
    has: (login) => ref.current.has(login),
    clear: () => ref.current.clear(),
  }
}
