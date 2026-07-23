import { useQuery } from "@tanstack/react-query"
import { fetchPagesAssignments } from "@/github-core/queries"

const usePagesAssignments = (
  org: string | undefined,
  classroom: string | undefined,
  // Optional capability-URL secret. The hook does NOT fetch it (students can't
  // read the private classroom.json) — the caller supplies it from whatever fits
  // its context: the `?k=` accept link, the student repo's .classroom50.yaml
  // (post-accept), or classroom.json (teachers). Empty/undefined fetches the
  // plain path (unprotected classroom).
  secret?: string,
  // Gate the read while the secret is still being resolved: fetching under a
  // not-yet-known secret would hit the unprotected path and 404 a protected
  // classroom. Defaults true for callers whose secret is available synchronously.
  enabled = true,
) => {
  return useQuery({
    queryKey: ["pages", "assignments", org, classroom, secret ?? ""],
    queryFn: () => fetchPagesAssignments(org ?? "", classroom ?? "", secret),
    enabled: enabled && Boolean(org && classroom),
  })
}

export default usePagesAssignments
