import { useQuery } from "@tanstack/react-query"
import { fetchPagesAssignments } from "@/github-core/queries"

// The single reader for an org's published (GitHub Pages) assignment list — the
// student-safe projection of the private config repo's assignments.json. This
// is the one Pages assignments hook (the former `useGetPublicAssignment` was a
// bySlug wrapper around the same fetch; it's folded in via `assignmentSlug`).
//
// `secret` is the optional capability-URL secret. The hook does NOT fetch it
// (students can't read the private classroom.json) — the caller supplies it
// from whatever fits its context: the `?k=` accept link, the student repo's
// .classroom50.yaml (post-accept), or classroom.json (teachers previewing).
// Empty/undefined fetches the plain path (unprotected classroom).
const usePagesAssignments = (
  org: string | undefined,
  classroom: string | undefined,
  secret?: string,
  options?: {
    // Gate the read while the secret is still being resolved: fetching under a
    // not-yet-known secret would hit the unprotected path and 404 a protected
    // classroom. Defaults true for callers whose secret is available
    // synchronously.
    enabled?: boolean
    // When set, the result also exposes `assignment` (the entry with this slug),
    // so single-assignment callers don't reimplement the `.find`.
    assignmentSlug?: string
    // Custom Pages base URL for an org off the github.io default (see
    // fetchPagesAssignments). Sourced like `secret`: the team-description
    // bootstrap record for students, classroom.json for teachers.
    pagesBaseUrl?: string
  },
) => {
  const query = useQuery({
    queryKey: [
      "pages",
      "assignments",
      org,
      classroom,
      secret ?? "",
      options?.pagesBaseUrl ?? "",
    ],
    queryFn: () =>
      fetchPagesAssignments(
        org ?? "",
        classroom ?? "",
        secret,
        options?.pagesBaseUrl,
      ),
    enabled: (options?.enabled ?? true) && Boolean(org && classroom),
    // Pages is a public projection that changes rarely; cache it for 10 minutes.
    // Don't retry — a 404 (protected/unprotected path mismatch or a not-yet-
    // published classroom) is a definitive answer, and retry-storming it just
    // delays the honest empty/error state.
    staleTime: 10 * 60 * 1000,
    retry: false,
  })

  return {
    ...query,
    assignment: options?.assignmentSlug
      ? query.data?.find((a) => a.slug === options.assignmentSlug)
      : undefined,
  }
}

export default usePagesAssignments
