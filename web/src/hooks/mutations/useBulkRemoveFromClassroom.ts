import { useMutation } from "@tanstack/react-query"

import { useGitHubClient } from "@/context/github/GitHubProvider"
import {
  bulkRemoveFromClassroom,
  type BulkRemoveProgress,
} from "@/domain/orgMembers/bulkRemoveFromClassroom"
import type { OrgMemberRow } from "@/util/orgMembers"

// Thin mutation wrapper (the useUnenrollStudent shape): the Members page owns
// the optimistic cache seeding + delayed reconciles, so the hook carries only
// the write.
export function useBulkRemoveFromClassroom(org: string) {
  const client = useGitHubClient()

  return useMutation({
    mutationFn: (input: {
      classroom: string
      rows: OrgMemberRow[]
      onProgress?: (progress: BulkRemoveProgress) => void
    }) => bulkRemoveFromClassroom(client, { org, ...input }),
  })
}
