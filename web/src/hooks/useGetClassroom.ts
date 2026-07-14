import { useQuery } from "@tanstack/react-query"
import { jsonFileQuery } from "./github/queries"
import { CONFIG_REPO } from "@/util/configRepo"
import { useGitHubClient } from "@/context/github/GitHubProvider"
import type { Classroom } from "@/types/classroom"

const useGetClassroom = (
  org: string | undefined,
  classroom: string | undefined,
  options?: { enabled?: boolean },
) => {
  const client = useGitHubClient()
  return useQuery({
    ...jsonFileQuery<Classroom>(
      client,
      org ?? "",
      CONFIG_REPO,
      `${classroom ?? ""}/classroom.json`,
    ),
    // classroom.json lives in the private config repo, so a student fetch is a
    // guaranteed 404. Student-reachable callers pass enabled:false (or gate on
    // teacher role); the default stays enabled for teacher views.
    enabled: Boolean(org && classroom) && (options?.enabled ?? true),
  })
}

export default useGetClassroom
