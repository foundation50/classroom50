import { useQuery } from "@tanstack/react-query"
import { jsonFileQuery } from "./github/queries"
import { CONFIG_REPO } from "@/util/configRepo"
import { useGitHubClient } from "@/context/github/GitHubProvider"
import type { Assignment } from "@/types/classroom"

// Mirrors classroom50/assignments/v1: a `schema` sentinel plus the list.
// `runtime`, `max_group_size`, `tests`, `due`, etc. are optional — a minimal
// assignment carries only slug/name/template/mode/autograder.
type AssignmentsSchema = {
  schema: string
  assignments: Assignment[]
}
const useGetClassroomAssignments = (
  org: string | undefined,
  classroom: string | undefined,
  options?: { enabled?: boolean },
) => {
  const client = useGitHubClient()
  const query = jsonFileQuery<AssignmentsSchema>(
    client,
    org ?? "",
    CONFIG_REPO,
    `${classroom ?? ""}/assignments.json`,
  )
  return useQuery({
    ...query,
    enabled: query.enabled && (options?.enabled ?? true),
  })
}

export default useGetClassroomAssignments
