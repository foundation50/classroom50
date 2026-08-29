import { useGitHubClient } from "@/context/github/GitHubProvider"
import { useQuery } from "@tanstack/react-query"
import { jsonFileQuery } from "@/github-core/queries"
import { GitHubAPIError } from "@/github-core/errors"
import { CONFIG_REPO } from "@/util/configRepo"
import type { GitHubFileListing } from "@/github-core/types"

const useGetClasses = (org: string | undefined) => {
  const client = useGitHubClient()
  const classesQuery = useQuery(
    jsonFileQuery<GitHubFileListing[]>(client, org ?? "", CONFIG_REPO, ""),
  )

  // A 404 (no config repo yet, or an empty repo root) is the legitimate
  // "no classrooms" zero for a fresh org — not a failure.
  const notFound =
    classesQuery.error instanceof GitHubAPIError &&
    classesQuery.error.status === 404

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
    // Surfaced for the same reason on the failure side: rendering the
    // first-use empty state on a failed read tells a teacher their classrooms
    // are gone (Primer degraded-experiences: never error-as-empty).
    isError: classesQuery.isError && !notFound,
    refetch: () => {
      void classesQuery.refetch()
    },
  }
}

export default useGetClasses
