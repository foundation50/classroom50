import { useMutation } from "@tanstack/react-query"
import { migrateRosterFile } from "@/domain/students"
import { useGitHubClient } from "@/context/github/GitHubProvider"

// Auto-migrate on open: converge a classroom bootstrapped before the roster
// rename so roster.csv always physically exists. Idempotent and cheap (a no-op
// once roster.csv is present). The rename changes only the file's path, not its
// content, and reads already fall back to the legacy name, so there is NO cache
// to invalidate — a plain invalidate would refetch eventually-consistent bytes
// and needlessly re-arm auto-sync. Hence this hook has no onSuccess. The
// caller's `onSettled` (which unblocks auto-sync) stays at the call site.
export function useMigrateRoster(org: string, classroom: string) {
  const client = useGitHubClient()

  return useMutation({
    mutationFn: () => migrateRosterFile(client, { org, classroom }),
    // Best-effort convergence: a failure is non-fatal (reads still fall back to
    // the legacy name), so it's logged by the mutation layer, not surfaced.
  })
}
