import { useMutation, useQueryClient } from "@tanstack/react-query"
import { deleteClassroom } from "@/domain/classrooms"
import type { DeleteClassroomInput } from "@/domain/classrooms"
import { githubKeys } from "@/github-core/queries"
import { useGitHubClient } from "@/context/github/GitHubProvider"
import { CONFIG_REPO } from "@/util/configRepo"
import type { GitHubFileListing } from "@/github-core/types"

// Delete a classroom (removes its config-repo dir + best-effort team cleanup).
// The result (deleted / teamDeleteWarning) is returned so each call site decides
// its own toast/navigation (see ./README.md).
//
// On a real deletion the optimistic list drop is authoritative — we do NOT
// invalidate the dir-listing key we just edited. `jsonFile(org, CONFIG_REPO)`
// resolves to that exact listing key (path defaults to ""), and GitHub's
// Contents API is read-after-write eventual, so an immediate refetch can still
// return the just-deleted dir and re-add the card (a flicker). The optimistic
// drop stays authoritative and the per-query staleTime reconciles later; we
// remove the deleted classroom's own classroom.json query so its now-404 body
// isn't served stale. A { deleted: false } no-op changed nothing, so it falls
// through to a plain list invalidate to reconcile against whatever is there.
export function useDeleteClassroom(org: string, classroom: string) {
  const client = useGitHubClient()
  const queryClient = useQueryClient()

  const listKey = githubKeys.jsonFile(org, CONFIG_REPO, "")

  return useMutation({
    mutationFn: (input: DeleteClassroomInput) => deleteClassroom(client, input),
    onSuccess: (result) => {
      if (result.deleted) {
        queryClient.setQueryData(
          listKey,
          (prev: GitHubFileListing[] | undefined) =>
            prev ? prev.filter((entry) => entry.path !== classroom) : prev,
        )
        // Evict the deleted classroom's own config read (now a 404) so a later
        // view can't serve its stale body. Distinct from the listing key above.
        void queryClient.removeQueries({
          queryKey: githubKeys.jsonFile(
            org,
            CONFIG_REPO,
            `${classroom}/classroom.json`,
          ),
        })
        return
      }
      // No-op delete: nothing was optimistically changed, so reconcile the
      // listing against the server.
      void queryClient.invalidateQueries({ queryKey: listKey })
    },
  })
}

export default useDeleteClassroom
