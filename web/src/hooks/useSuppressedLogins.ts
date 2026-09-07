import { useMemo } from "react"

// Session-scoped set of GitHub logins the teacher just unenrolled, used to stop
// the roster's automatic backfills (auto-sync, auto-reconcile, and the on-entry
// classroom reconcile) from re-adding someone they removed. Unenroll is
// classroom-scoped — it drops the CSV row and classroom-team seat but leaves an
// active member's ORG membership intact — so a removed student can momentarily
// be a live org member with no team seat, which a reconcile would otherwise
// "fix" by team-adding them back (and a sync re-appending the CSV row).
// GitHub's Contents API is eventually consistent, so a refetch right after the
// CSV delete can also resurface the row. Remembering the login across those
// windows blocks the loop.
//
// The store is MODULE-scoped and keyed per (org, classroom): the on-entry
// classroom reconcile runs at the $org/$classroom boundary, outside the roster
// page that records the unenrolls, so a component-owned ref could not reach
// it. Per-classroom keying matters because unenroll is classroom-scoped — a
// login removed from one classroom must still backfill normally in another.
// In-memory by design: a full reload re-derives roster state and clears it,
// so a genuinely still-drifted student is one refresh — or the explicit
// Sync — away. A re-enroll `forget`s the login (see AddStudent), so a
// legitimately re-added student never stays suppressed.
export type SuppressedLogins = {
  remember: (logins: Iterable<string>) => void
  forget: (logins: Iterable<string>) => void
  has: (login: string) => boolean
  // The current set, copied — the roster sync's append filter reads this at
  // decision time (per conflict-retry attempt), so a suppression added while
  // a sync is already in flight still lands.
  snapshot: () => Set<string>
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

const stores = new Map<string, Set<string>>()

const storeFor = (org: string, classroom: string): Set<string> => {
  const key = `${org}/${classroom}`
  let set = stores.get(key)
  if (!set) {
    set = new Set()
    stores.set(key, set)
  }
  return set
}

// The store's framework-free accessor, so non-page callers (the on-entry
// reconcile hook) can consult the same set the roster page writes.
export function suppressedLoginsFor(
  org: string,
  classroom: string,
): SuppressedLogins {
  const set = storeFor(org, classroom)
  return {
    remember: (logins) => {
      for (const login of logins) {
        const key = normalize(login)
        if (key) set.add(key)
      }
    },
    forget: (logins) => {
      for (const login of logins) set.delete(normalize(login))
    },
    has: (login) => set.has(login),
    snapshot: () => new Set(set),
    clear: () => set.clear(),
  }
}

export function useSuppressedLogins(
  org: string,
  classroom: string,
): SuppressedLogins {
  return useMemo(() => suppressedLoginsFor(org, classroom), [org, classroom])
}
