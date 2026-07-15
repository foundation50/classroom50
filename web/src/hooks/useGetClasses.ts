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
    // Resolution state so callers can distinguish "no classrooms" from "not
    // loaded yet" or "errored" (an empty `classes` means all three). Fail-closed:
    // `isSuccess` is the only definitive-good settle; `isError` is a settled
    // failure a caller can surface for retry; while pending, neither is true.
    isLoading: classesQuery.isLoading,
    isSuccess: classesQuery.isSuccess,
    isError: classesQuery.isError,
    refetch: classesQuery.refetch,
  }
}

export default useGetClasses
