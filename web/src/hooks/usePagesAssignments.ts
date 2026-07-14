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
) => {
  return useQuery({
    queryKey: ["pages", "assignments", org, classroom, secret ?? ""],
    queryFn: () => fetchPagesAssignments(org ?? "", classroom ?? "", secret),
    enabled: Boolean(org && classroom),
  })
}

export default usePagesAssignments
