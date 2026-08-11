import { useMutation, useQueryClient } from "@tanstack/react-query"

import { useGitHubClient } from "@/context/github/GitHubProvider"
import { githubKeys } from "@/github-core/queries"
import { GitHubAPIError } from "@/github-core/errors"
import { CONFIG_REPO } from "@/util/configRepo"
import {
  editScoreOverride,
  type SetScoreOverrideInput,
  type SetScoreOverrideResult,
} from "@/domain/assignments/scoreOverride"

// Set or clear a teacher score override for one repo owner, writing the
// classroom's scores.json in the config repo (the web's only scores write).
// Invalidates the scores.json read so the submissions page reflects it. The
// domain helper wraps the read-modify-write in withGitConflictRetry, so a race
// with the nightly collect run retries transparently.
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
      void queryClient.invalidateQueries({
        queryKey: githubKeys.jsonFile(
          input.org,
          CONFIG_REPO,
          `${input.classroom}/scores.json`,
        ),
      })
      onWrite?.(result, input)
    },
  })
}

export default useSetScoreOverride
