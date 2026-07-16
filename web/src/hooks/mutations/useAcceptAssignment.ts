import { useMutation, useQueryClient } from "@tanstack/react-query"
import { acceptAssignment } from "@/domain/assignments"
import type { OnAcceptStepUpdate } from "@/domain/assignments"
import { githubKeys } from "@/github-core/queries"
import { useGitHubClient } from "@/context/github/GitHubProvider"

// Accept an assignment (provision the student repo, land control files). Hook
// owns the org-repos invalidation on success so the accepted repo shows up in
// the viewer's repo list; the confetti, per-step progress state, and error UI
// stay at the call site (steps are driven via the onStepUpdate callback the
// caller passes). Mirrors useEnrollOrInviteStudent's data-callback shape.
//
// Params are bound at hook-call time (not at mutate()) because onStepUpdate
// closes over the page's step state and the one call site's params are stable;
// onStepUpdate is required here (the domain fn takes it optional) since the page
// always drives the progress UI.
export function useAcceptAssignment(params: {
  org: string
  classroom: string
  assignmentSlug: string
  secret?: string
  onStepUpdate: OnAcceptStepUpdate
}) {
  const client = useGitHubClient()
  const queryClient = useQueryClient()
  const { org, classroom, assignmentSlug, secret, onStepUpdate } = params

  return useMutation({
    mutationFn: () =>
      acceptAssignment({
        client,
        org,
        classroom,
        assignmentSlug,
        secret,
        onStepUpdate,
      }),
    onSuccess: () => {
      void queryClient.invalidateQueries({
        queryKey: githubKeys.orgRepos(org),
        exact: true,
        refetchType: "all",
      })
    },
  })
}

export default useAcceptAssignment
