import { useMutation } from "@tanstack/react-query"
import { useTranslation } from "react-i18next"

import { useGitHubClient } from "@/context/github/GitHubProvider"
import { bulkRemoveFromOrg } from "@/domain/orgMembers/bulkRemoveFromOrg"
import type { BulkRemoveProgress } from "@/domain/orgMembers/bulkRemoveFromClassroom"
import type { OrgMemberRow } from "@/util/orgMembers"

// Thin mutation wrapper (the useUnenrollStudent shape); the Members page owns
// the cache seeding and reconciles. `t` localizes the orchestrator's warnings.
export function useBulkRemoveFromOrg(org: string) {
  const client = useGitHubClient()
  const { t } = useTranslation()

  return useMutation({
    meta: { keepTabOpen: true },
    mutationFn: (input: {
      rows: OrgMemberRow[]
      onProgress?: (progress: BulkRemoveProgress) => void
    }) => bulkRemoveFromOrg(client, { org, ...input }, t),
  })
}
