import { useMutation, useQueryClient } from "@tanstack/react-query"
import { editClassroomWithConflictRetry } from "@/domain/classrooms"
import { githubKeys } from "@/github-core/queries"
import { useGitHubClient } from "@/context/github/GitHubProvider"
import { CONFIG_REPO } from "@/util/configRepo"

// Archive / unarchive a classroom (toggles the `active` flag via the
// conflict-retried edit). Shared by the list card and the detail form, so the
// hook owns the full optimistic cache chain and both surfaces stay consistent.
// Toasts stay at the call site (see ./README.md).
//
// We do NOT invalidate the exact `classroom.json` key we flipped: GitHub's
// Contents API is read-after-write eventual, so an immediate refetch can read
// the pre-write body and clobber the optimistic value. The flip stays
// authoritative and the per-query staleTime reconciles later; the list key is
// a different query, safe to invalidate so the Active/Archived/All partition
// updates.
export function useArchiveClassroom(org: string, classroom: string) {
  const client = useGitHubClient()
  const queryClient = useQueryClient()

  const classroomKey = githubKeys.jsonFile(
    org,
    CONFIG_REPO,
    `${classroom}/classroom.json`,
  )

  return useMutation({
    // Serialize toggles on this classroom: without a scope, two rapid
    // archive/unarchive taps run concurrently and their onMutate snapshots nest
    // — toggle B captures A's optimistic value as `prev`, so if both writes fail
    // B rolls back to A's optimistic state (persistently wrong until staleTime),
    // not the true original. A shared scope id makes React Query run same-key
    // toggles one at a time, so each snapshot sees a settled state.
    scope: { id: `archive-classroom:${org}:${classroom}` },
    mutationFn: (active: boolean) =>
      editClassroomWithConflictRetry(client, { org, slug: classroom, active }),
    onMutate: async (active: boolean) => {
      // Cancel in-flight reads of this classroom.json so a late response can't
      // overwrite the optimistic flip (the missing step that let the card snap
      // back to the pre-write state).
      await queryClient.cancelQueries({ queryKey: classroomKey })
      const prev = queryClient.getQueryData(classroomKey)
      queryClient.setQueryData(
        classroomKey,
        (current: Record<string, unknown> | undefined) =>
          current ? { ...current, active } : current,
      )
      return { prev }
    },
    onError: (_err, _active, ctx) => {
      // Roll back the optimistic flip so a failed write can't strand the view
      // in the wrong lifecycle state. Toast is the call site's job.
      if (ctx) queryClient.setQueryData(classroomKey, ctx.prev)
    },
    onSettled: () => {
      // Repartition the classes list (Active/Archived/All) — a different query
      // than the per-classroom classroom.json flipped above.
      void queryClient.invalidateQueries({
        queryKey: githubKeys.jsonFile(org, CONFIG_REPO),
      })
    },
  })
}

export default useArchiveClassroom
