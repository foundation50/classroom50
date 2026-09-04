import { useQuery } from "@tanstack/react-query"
import { useOptionalGitHubClient } from "@/context/github/GitHubProvider"
import { getRepo } from "@/github-core/repoReads"
import { parseTemplateRef } from "@/domain/assignments"

// Resolve a template ref for an advisory read, accepting the same inputs the
// Template field does: `owner/repo`, `owner/repo@branch`, and a bare `repo`
// name (owner defaults to the org). Returns null on an empty/invalid ref or an
// unresolved owner (a bare name with no org), so callers stay gated on a
// resolvable template.
export function parseTemplateRefSafe(
  ref: string,
  org: string | undefined,
): { owner: string; repo: string } | null {
  if (!ref.trim()) return null
  try {
    const { owner, repo } = parseTemplateRef(ref, org ?? "")
    // A bare name with no org resolves to an empty owner — not usable.
    return owner && repo ? { owner, repo } : null
  } catch {
    return null
  }
}

// Advisory GET /repos read of the picked template, shared by every form
// surface that needs the template's live metadata (feature flags, visibility)
// so they key off one cached response instead of each fetching their own.
export function useTemplateRepo(
  templateRepo: string,
  org: string | undefined,
  enabled = true,
) {
  const client = useOptionalGitHubClient()
  const parsed = parseTemplateRefSafe(templateRepo, org)
  const isEnabled = Boolean(client && parsed && enabled)
  const query = useQuery({
    queryKey: ["template-repo", parsed?.owner, parsed?.repo],
    queryFn: () => getRepo(client!, parsed!.owner, parsed!.repo),
    enabled: isEnabled,
    staleTime: 30_000,
    retry: false,
  })
  return { parsed, enabled: isEnabled, query }
}
