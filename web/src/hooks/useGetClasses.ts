import { useGitHubClient } from "@/context/github/GitHubProvider"
import { useQuery } from "@tanstack/react-query"
import { jsonFileQuery } from "@/github-core/queries"
import { CONFIG_REPO } from "@/util/configRepo"
import type { GitHubFileListing } from "@/github-core/types"

const useGetClasses = (org: string | undefined) => {
  const client = useGitHubClient()
  const classesQuery = useQuery(
    jsonFileQuery<GitHubFileListing[]>(client, org ?? "", CONFIG_REPO, ""),
  )

  return {
    classes: classesQuery.data
      ? classesQuery.data.filter(
          (c) => c.type === "dir" && c.name !== ".github",
        )
      : [],
    // Surfaced so a caller can show a loading state instead of flashing its
    // empty state: an empty `classes` array during the fetch is otherwise
    // indistinguishable from a genuinely empty org.
    isLoading: classesQuery.isLoading,
  }
}

export default useGetClasses
