import { useGitHubClient } from "@/context/github/GitHubProvider"
import { getClassroom50Yaml, githubKeys } from "@/github-core/queries"
import { useQuery } from "@tanstack/react-query"
import { parseClassroom50Yaml, type Classroom50Yaml } from "@/util/yaml"

// A student can edit their own repo's marker file, so a malformed
// .classroom50.yaml must degrade to "no marker" rather than throw out of a
// render and take the whole repo list down with it.
const parseTolerantly = (source: string): Partial<Classroom50Yaml> => {
  try {
    return parseClassroom50Yaml(source)
  } catch {
    return {}
  }
}

const useDotClassroom50 = (
  org: string,
  repo: string,
): Partial<Classroom50Yaml> => {
  const client = useGitHubClient()

  const query = useQuery({
    queryKey: githubKeys.repoMarkerFile(org, repo),
    queryFn: () => getClassroom50Yaml(client, org, repo),
    select: parseTolerantly,
    // Skip until both coordinates are known — callers may pass "" while a
    // username/repo name resolves, and an empty repo fetches a malformed contents
    // path (guaranteed 404).
    enabled: Boolean(org && repo),
    staleTime: 10 * 60 * 1000,
  })

  return query.data ?? {}
}

export default useDotClassroom50
