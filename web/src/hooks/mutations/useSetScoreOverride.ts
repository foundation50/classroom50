import { useMutation, useQueryClient } from "@tanstack/react-query"

import { useGitHubClient } from "@/context/github/GitHubProvider"
import { githubKeys, seedJsonFile } from "@/github-core/queries"
import { GitHubAPIError } from "@/github-core/errors"
import {
  editScoreOverride,
  type SetScoreOverrideInput,
  type SetScoreOverrideResult,
} from "@/domain/assignments/scoreOverride"

// Set or clear a teacher score override for one repo owner, writing the
// classroom's scores.json in the config repo (the web's only scores write).
// Seeds the scores.json read with the committed file so the submissions page
// reflects it at once; a refetch could race GitHub's eventual contents API and
// show the override snapping back (#1004). The domain helper wraps the
// read-modify-write in withGitConflictRetry, so a race with the collect run
// retries transparently.
export function useSetScoreOverride(opts?: {
  onWrite?: (
    result: SetScoreOverrideResult,
    input: SetScoreOverrideInput,
  ) => void
}) {
  const { onWrite } = opts ?? {}
  const client = useGitHubClient()
  const queryClient = useQueryClient()

  return useMutation<
    SetScoreOverrideResult,
    GitHubAPIError,
    SetScoreOverrideInput
  >({
    mutationFn: (input) => editScoreOverride(client, input),
    onSuccess: (result, input) => {
      seedJsonFile(
        queryClient,
        githubKeys.scoresFile(input.org, input.classroom),
        result.scores,
      )
      onWrite?.(result, input)
    },
  })
}

export default useSetScoreOverride
