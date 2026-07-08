import { useQuery } from "@tanstack/react-query"
import { useGitHubClient } from "@/context/github/GitHubProvider"
import { GitHubAPIError, retryTransientGitHubError } from "./github/errors"
import { verifyClassroom50ConfigRepo } from "./github/queries"

export type OrgClassroom50Status = "ready" | "missing" | "unknown"

// The status query resolves only to "ready" or "missing"; "unknown" is the
// undefined-data state React Query surfaces when this rethrows, so a transient
// blip never resolves as "missing".
type OrgClassroom50Probe = "ready" | "missing"

// Probe the `classroom50` config repo for one org. 404 = missing (unset or
// private to me); any other error rethrows so the query stays "unknown" rather
// than reporting a transient failure as missing. A readable repo lacking the
// config marker is reported "missing" (see verifyClassroom50ConfigRepo). Pure
// over its client so the 404-vs-rethrow contract the gate depends on is
// unit-testable.
export async function probeOrgClassroom50Status(
  client: { request: (path: string) => Promise<unknown> },
  org: string,
): Promise<OrgClassroom50Probe> {
  try {
    await client.request(`/repos/${org}/classroom50`)
    const isConfigRepo = await verifyClassroom50ConfigRepo(client, org)
    return isConfigRepo ? "ready" : "missing"
  } catch (error) {
    if (error instanceof GitHubAPIError && error.status === 404) {
      return "missing"
    }
    throw error
  }
}

// Single-org probe for the `classroom50` config repo, to gate /$org/* routes.
// Distinct from getClassroom50OrgSummary, which fans out across every org on the
// landing page.
export function useOrgClassroom50Status(org: string | undefined) {
  const client = useGitHubClient()

  return useQuery<OrgClassroom50Status>({
    queryKey: ["github", "repos", org, "classroom50", "exists"],
    queryFn: () => probeOrgClassroom50Status(client, org ?? ""),
    staleTime: 10 * 60 * 1000,
    retry: retryTransientGitHubError,
    enabled: Boolean(org),
  })
}
