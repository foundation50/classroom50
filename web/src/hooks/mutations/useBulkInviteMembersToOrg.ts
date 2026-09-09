import { useMutation } from "@tanstack/react-query"

import { useGitHubClient } from "@/context/github/GitHubProvider"
import {
  bulkInviteMembersToOrg,
  type BulkInviteProgress,
} from "@/domain/orgMembers/bulkInviteMembersToOrg"
import type { OrgMemberRow } from "@/util/orgMembers"

// Thin mutation wrapper (the useBulkAddToClassroom shape); the Members page
// owns the cache refresh through useOrgMembersCacheSync.afterBulkRun.
export function useBulkInviteMembersToOrg(org: string) {
  const client = useGitHubClient()

  return useMutation({
    meta: { keepTabOpen: true },
    mutationFn: (input: {
      rows: OrgMemberRow[]
      onProgress?: (progress: BulkInviteProgress) => void
    }) => bulkInviteMembersToOrg(client, { org, ...input }),
  })
}
