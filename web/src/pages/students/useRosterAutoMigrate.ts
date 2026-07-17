import { useEffect, useRef, useState } from "react"
import { useMigrateRoster } from "@/hooks/mutations/useMigrateRoster"

// Auto-migrate on open: converge a classroom bootstrapped before the roster
// rename so roster.csv always physically exists. Idempotent and cheap (a no-op
// once roster.csv is present). It runs BEFORE auto-sync (which gates on the
// returned `migrateSettledFor`) so the two roster writers don't race on the
// ref. The rename changes only the file's path, not its content, and reads
// already fall back to the legacy name, so there's no cache to invalidate — a
// plain invalidate here would refetch eventually-consistent bytes and needlessly
// re-arm auto-sync. Returns the classroom the migrate has settled for, which
// gates useRosterAutoSync.
export function useRosterAutoMigrate(
  org: string,
  classroom: string,
  ready: boolean,
): { migrateSettledFor: string | null } {
  const [migrateSettledFor, setMigrateSettledFor] = useState<string | null>(
    null,
  )
  const migrateMutation = useMigrateRoster(org, classroom)
  // Fire once per classroom (the component instance is reused across a
  // $classroom param switch, so a boolean would skip later classrooms).
  const migratedForRef = useRef<string | null>(null)
  useEffect(() => {
    if (!ready) return
    if (migratedForRef.current === classroom) return
    migratedForRef.current = classroom
    setMigrateSettledFor(null)
    // onSettled unblocks auto-sync (mount-fired UI coordination) so it lives at
    // the call site; even a migrate hiccup must still release the gate.
    migrateMutation.mutate(undefined, {
      onSettled: () => setMigrateSettledFor(classroom),
    })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [classroom, ready])

  return { migrateSettledFor }
}
