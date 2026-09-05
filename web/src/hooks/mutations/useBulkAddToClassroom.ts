import { useMutation } from "@tanstack/react-query"

import { useGitHubClient } from "@/context/github/GitHubProvider"
import {
  bulkAddToClassroom,
  type BulkAddProgress,
} from "@/domain/orgMembers/bulkAddToClassroom"
import type { GitHubUser } from "@/github-core/types"
import type { OrgMemberRow } from "@/util/orgMembers"

// Thin mutation wrapper (the useUnenrollStudent shape); the Members page owns
// the cache seeding and reconciles.
export function useBulkAddToClassroom(org: string) {
  const client = useGitHubClient()

  return useMutation({
    meta: { keepTabOpen: true },
    mutationFn: (input: {
      classroom: string
      rows: OrgMemberRow[]
      members: GitHubUser[]
      onProgress?: (progress: BulkAddProgress) => void
    }) => bulkAddToClassroom(client, { org, ...input }),
  })
}
