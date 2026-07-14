import { useQuery } from "@tanstack/react-query"
import { fetchPagesAssignments } from "@/github-core/queries"

const useGetPublicAssignment = (
  org: string | undefined,
  classroom: string | undefined,
  assignment: string | undefined,
  // Optional capability-URL secret, supplied by the caller (see
  // usePagesAssignments). Not fetched here — students can't read the private
  // classroom.json. Empty/undefined uses the plain path.
  secret?: string,
) => {
  const assignmentQuery = useQuery({
    queryKey: ["pages", org, classroom, secret ?? ""],
    queryFn: () => fetchPagesAssignments(org ?? "", classroom ?? "", secret),
    enabled: Boolean(org && classroom),
    staleTime: 10 * 60 * 1000,
    retry: false,
  })

  return {
    ...assignmentQuery,
    assignment: assignmentQuery.data?.find((a) => a.slug === assignment),
  }
}

export default useGetPublicAssignment
