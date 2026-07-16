import { useMutation, useQueryClient } from "@tanstack/react-query"
import { tryGrantTeamTemplateRead } from "@/domain/assignments"
import type { Assignment } from "@/types/classroom"
import { useGitHubClient } from "@/context/github/GitHubProvider"
import { githubKeys } from "@/github-core/queries"

export type ReconcileTemplateAccessInput = {
  org: string
  classroom: string
  slug: string
  template: NonNullable<Assignment["template"]>
}

// A non-empty `warning` means the student grant failed (the domain layer never
// throws here — see tryGrantTeamTemplateRead); the call site surfaces it.
export type ReconcileTemplateAccessResult = { warning?: string }

// Re-grant the classroom student team (and best-effort TA team) read on an
// in-org private template, the recovery path for a grant that GitHub or a prior
// failure dropped. The hook is the single owner of the post-grant cache
// reconcile (per ./README.md — it must survive unmount) for BOTH readers of
// "team has template read": TemplateField's boolean ["template-team-access",…]
// query and the template-access modal's repoTeams list. A clean grant SEEDS the
// boolean true and invalidates repoTeams; a warning invalidates the boolean.
//
// Why seed the boolean but invalidate the list: GitHub's team reads are
// eventually consistent after a grant, so an invalidate can refetch stale "no
// access" and re-flash the verdict. TemplateField only needs a boolean, so we
// seed it true (no refetch, no flash). The modal renders each granting team's
// real name/url/permission from the list, which we can't fabricate, so it must
// refetch — the modal suppresses the transient re-flash on its side while that
// settles. Kept t()-free; call sites own toasts.
export function useReconcileTemplateAccess() {
  const client = useGitHubClient()
  const queryClient = useQueryClient()

  return useMutation<
    ReconcileTemplateAccessResult,
    Error,
    ReconcileTemplateAccessInput
  >({
    mutationFn: async ({ org, classroom, slug, template }) => {
      const warning = await tryGrantTeamTemplateRead(
        client,
        org,
        classroom,
        slug,
        template,
      )
      return { warning }
    },
    onSuccess: (result, { org, classroom, template }) => {
      const accessKey = [
        "template-team-access",
        org,
        classroom,
        template.owner,
        template.repo,
      ]
      if (result.warning) {
        void queryClient.invalidateQueries({ queryKey: accessKey })
        return
      }
      queryClient.setQueryData<boolean>(accessKey, true)
      void queryClient.invalidateQueries({
        queryKey: githubKeys.repoTeams(template.owner, template.repo),
      })
    },
  })
}

export default useReconcileTemplateAccess
