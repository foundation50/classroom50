import { useMutation, useQueryClient } from "@tanstack/react-query"
import { deleteClassroom } from "@/domain/classrooms"
import type { DeleteClassroomInput } from "@/domain/classrooms"
import { githubKeys } from "@/github-core/queries"
import { useGitHubClient } from "@/context/github/GitHubProvider"
import { CONFIG_REPO } from "@/util/configRepo"
import type { GitHubFileListing } from "@/github-core/types"

// Delete a classroom (removes its config-repo dir + best-effort team cleanup).
// Hook owns the cache reconcile that must always run: on a real deletion it
// optimistically drops the dir from the cached listing so a list view leaves at
// once (the Contents API is read-after-write eventual, so an immediate refetch
// can still return the just-deleted dir), then invalidates to reconcile.
// deleteClassroom returns { deleted: false } as a no-op (dir already gone) — the
// hook still invalidates but skips the optimistic drop. The result (deleted /
// teamDeleteWarning) is returned so the call site decides its own
// toast/navigation (see ./README.md); a detail view that navigates away can
// ignore the optimistic drop entirely.
export function useDeleteClassroom(org: string, classroom: string) {
  const client = useGitHubClient()
  const queryClient = useQueryClient()

  return useMutation({
    mutationFn: (input: DeleteClassroomInput) => deleteClassroom(client, input),
    onSuccess: (result) => {
      if (result.deleted) {
        const listKey = githubKeys.jsonFile(org, CONFIG_REPO, "")
        queryClient.setQueryData(
          listKey,
          (prev: GitHubFileListing[] | undefined) =>
            prev ? prev.filter((entry) => entry.path !== classroom) : prev,
        )
      }
    },
    onSettled: () => {
      void queryClient.invalidateQueries({
        queryKey: githubKeys.jsonFile(org, CONFIG_REPO),
      })
    },
  })
}

export default useDeleteClassroom
