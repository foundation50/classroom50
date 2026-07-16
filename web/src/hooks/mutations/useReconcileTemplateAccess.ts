import { useMutation, useQueryClient } from "@tanstack/react-query"
import { tryGrantTeamTemplateRead } from "@/domain/assignments"
import type { Assignment } from "@/types/classroom"
import { useGitHubClient } from "@/context/github/GitHubProvider"

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
// failure dropped. The hook owns the team-access cache reconcile so it survives
// unmount (per ./README.md): a clean grant SEEDS the ["template-team-access",…]
// query true rather than invalidating — a post-grant read is eventually
// consistent, so an invalidate could refetch stale "no access" and re-flash the
// verdict; a warning leaves the query to refetch. Only TemplateField reads that
// key, so this reconcile is a no-op for the assignments table (which feeds back
// via a toast at the call site). Kept t()-free; call sites own toasts.
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
      const key = [
        "template-team-access",
        org,
        classroom,
        template.owner,
        template.repo,
      ]
      if (result.warning) {
        void queryClient.invalidateQueries({ queryKey: key })
      } else {
        queryClient.setQueryData<boolean>(key, true)
      }
    },
  })
}

export default useReconcileTemplateAccess
