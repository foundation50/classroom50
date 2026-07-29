// FEATURE: github-classroom-migration — removable once GitHub Classroom shuts
// down (see foundation50/classroom50#312). Thin mutation wrapper around the
// migration execute orchestrator. Owns the config-repo classroom-listing
// invalidate so the new class appears; per-item progress state lives at the
// call site (keeps useQueryClient out of the page). Mirrors useCreateClassroom.

import { useMutation, useQueryClient } from "@tanstack/react-query"

import { useGitHubClient } from "@/context/github/GitHubProvider"
import { githubKeys } from "@/github-core/queries"
import { CONFIG_REPO } from "@/util/configRepo"
import { migrateClassroom, type MigrateOptions } from "@/migration/migrate"
import type { MigrationPreflight, MigrationResult } from "@/migration/types"

export type UseMigrateClassroomVars = {
  plan: MigrationPreflight
  options?: MigrateOptions
}

export function useMigrateClassroom(targetOrg: string) {
  const client = useGitHubClient()
  const queryClient = useQueryClient()

  return useMutation<MigrationResult, Error, UseMigrateClassroomVars>({
    mutationFn: ({ plan, options }) => migrateClassroom(client, plan, options),
    onSuccess: () => {
      void queryClient.invalidateQueries({
        queryKey: githubKeys.jsonFile(targetOrg, CONFIG_REPO),
      })
    },
  })
}

export default useMigrateClassroom
