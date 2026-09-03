import { useQuery } from "@tanstack/react-query"
import { useGitHubClient } from "@/context/github/GitHubProvider"
import { repoContentsPathExists } from "@/domain/assignments"

// Whether an existing assignment repo finished its accept: "incomplete" means
// the repo exists but `.classroom50.yaml` never landed, so the accept died
// between repo creation and the setup commit (issue #502). A probe error
// (anything but a 404) reads as "unknown" so a blip never flags a healthy repo.
export type AssignmentRepoSetupState = "unknown" | "complete" | "incomplete"

export function useAssignmentRepoSetup(
  org: string | undefined,
  repo: string,
  options?: { enabled?: boolean },
) {
  const client = useGitHubClient()
  const enabled = Boolean(org && repo) && (options?.enabled ?? true)

  const query = useQuery({
    queryKey: ["github", "repos", org, repo, "setup-marker"],
    queryFn: () =>
      repoContentsPathExists(client, org ?? "", repo, ".classroom50.yaml"),
    enabled,
    // Gates the accept page's repair guidance; a re-run heals the repo, so
    // never serve a stale "incomplete" on the next mount.
    staleTime: 0,
  })

  let state: AssignmentRepoSetupState = "unknown"
  if (query.data === true) state = "complete"
  else if (query.data === false) state = "incomplete"

  return {
    state,
    isLoading: enabled && query.isLoading,
    refetch: query.refetch,
  }
}

export default useAssignmentRepoSetup
