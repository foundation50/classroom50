import { useMutation } from "@tanstack/react-query"

import { useGitHubClient } from "@/context/github/GitHubProvider"
import { useActionActivityRegistry } from "@/context/actions/ActionActivityProvider"
import { triggerPublishPages } from "@/github-core/mutations"
import { PUBLISH_PAGES_WORKFLOW } from "@/github-core/workflows"

// Redeploy the student site from the config repo as it stands, with no commit.
// The teacher's way to bring the site back in line with the repo after a
// failed or stuck deploy, or after re-enabling Pages. Registers the run with
// the Actions banner here (not at the call site) so the tracker appears even if
// the teacher navigates away the instant the dispatch resolves. `label` is
// pre-translated by the caller (hooks stay t()-free).
export function useRepublishSite() {
  const client = useGitHubClient()
  const { register } = useActionActivityRegistry()

  return useMutation({
    mutationFn: ({ org }: { org: string; label: string }) =>
      triggerPublishPages(client, org),
    onSuccess: ({ sinceRunId }, { org, label }) => {
      register({
        org,
        label,
        anchor: {
          kind: "sinceRunId",
          workflow: PUBLISH_PAGES_WORKFLOW,
          sinceRunId,
        },
      })
    },
  })
}

export default useRepublishSite
