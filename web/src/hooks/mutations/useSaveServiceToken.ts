import { useMutation, useQueryClient } from "@tanstack/react-query"
import {
  putRepoSecret,
  putRepoVariable,
  validateServiceToken,
} from "@/github-core/mutations"
import {
  githubKeys,
  SERVICE_TOKEN_SECRET_NAME,
  SERVICE_TOKEN_EXPIRES_AT_VAR,
  SERVICE_TOKEN_NAME_VAR,
  type ServiceTokenStatus,
} from "@/github-core/queries"
import { useGitHubClient } from "@/context/github/GitHubProvider"
import { CONFIG_REPO } from "@/util/configRepo"

// Compute the RFC 3339 expiry instant we record for the token, from the
// teacher's chosen `expires_in` (days) at save time. Advisory: it mirrors the
// value prefilled into GitHub's PAT-creation form, which GitHub does not echo
// back for a fine-grained PAT.
export function serviceTokenExpiryFromDays(
  expiresInDays: number,
  now: number = Date.now(),
): string {
  return new Date(now + expiresInDays * 24 * 60 * 60 * 1000).toISOString()
}

type SaveServiceTokenInput = {
  serviceToken: string
  // The teacher's chosen expiry window in days (the same value prefilled into
  // GitHub's token form). Omitted when unknown — then no expiry is recorded.
  expiresInDays?: number
  // The token's display name (the value prefilled into GitHub's token form).
  // Recorded so the app can show and manage it; omitted leaves it untouched.
  tokenName?: string
}

// Validate a service PAT and store it as the config repo's
// CLASSROOM50_SERVICE_TOKEN secret. When an expiry window and/or name is
// supplied, also record them as readable repo variables so the org list and
// settings surfaces can show a countdown, warn before the nightly collect
// breaks, and label the token. Hook seeds + invalidates the org list and this
// org's service-token status; the field-clear/saved-kind UI effects (and the
// useSafeSubmit composition) stay at the call site (see ./README.md).
export function useSaveServiceToken(org: string | undefined) {
  const client = useGitHubClient()
  const queryClient = useQueryClient()

  return useMutation({
    mutationFn: async ({
      serviceToken,
      expiresInDays,
      tokenName,
    }: SaveServiceTokenInput) => {
      await validateServiceToken(serviceToken, org)
      await putRepoSecret(
        client,
        org,
        CONFIG_REPO,
        SERVICE_TOKEN_SECRET_NAME,
        serviceToken,
      )
      // The expiry/name variables are advisory metadata; a failure writing them
      // must not fail the rotation (the token itself is already stored). Record
      // them best effort and swallow write errors.
      if (expiresInDays && Number.isFinite(expiresInDays)) {
        try {
          await putRepoVariable(
            client,
            org,
            CONFIG_REPO,
            SERVICE_TOKEN_EXPIRES_AT_VAR,
            serviceTokenExpiryFromDays(expiresInDays),
          )
        } catch {
          // best effort — keep the successful token save
        }
      }
      if (tokenName && tokenName.trim()) {
        try {
          await putRepoVariable(
            client,
            org,
            CONFIG_REPO,
            SERVICE_TOKEN_NAME_VAR,
            tokenName.trim(),
          )
        } catch {
          // best effort — keep the successful token save
        }
      }
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["orgs"] })
      // Seed the status to "present" before the refetch so a UI deriving its
      // state from token presence (the setup wizard) advances even if the
      // invalidation refetch fails (offline / transient GitHub error) — the
      // save itself already succeeded. The seed survives such a failure because
      // getServiceTokenStatus now rethrows transient errors, so react-query
      // keeps this seeded data rather than overwriting it with a verdict. The
      // invalidate below reconciles the real created/updated timestamps once a
      // read lands.
      const now = new Date().toISOString()
      const seeded: ServiceTokenStatus = {
        status: "present",
        secretName: SERVICE_TOKEN_SECRET_NAME,
        createdAt: now,
        updatedAt: now,
        message: "",
      }
      queryClient.setQueryData(githubKeys.serviceToken(org ?? ""), seeded)
      queryClient.invalidateQueries({
        queryKey: githubKeys.serviceToken(org ?? ""),
      })
    },
  })
}
