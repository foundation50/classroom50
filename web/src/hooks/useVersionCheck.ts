import { useQuery } from "@tanstack/react-query"

import { appVersion } from "@/version"

// Payload of /version.json, emitted at build time from the same release object
// as the __APP_*__ defines (see vite.config.ts). Network input — treat every
// field as possibly missing.
export type DeployedVersion = {
  version?: string
  commit?: string
  buildDate?: string
}

// State subset the verdict depends on — structural so the fail-open logic stays
// a pure, testable function (mirrors resolveSkeletonDrift).
export type UpdateAvailableInput = {
  deployedCommit: string | undefined
  runningCommit: string
}

// Fail-open verdict: prompt only when both commits are known and genuinely
// differ. A missing/empty deployed commit (fetch or parse failure) or an
// "unknown" running commit (dev build where git stamping failed) resolves to
// "no update" so we never nag on incomplete info.
//
// Prefix-tolerant: CI stamps the full 40-char github.sha on both sides, but
// local builds stamp a 12-char short hash — a running commit that prefixes the
// deployed one (or vice versa) is the same commit and must not prompt.
export function resolveUpdateAvailable(input: UpdateAvailableInput): boolean {
  const { deployedCommit, runningCommit } = input
  if (!runningCommit || runningCommit === "unknown") return false
  if (!deployedCommit) return false
  return (
    !deployedCommit.startsWith(runningCommit) &&
    !runningCommit.startsWith(deployedCommit)
  )
}

async function fetchDeployedVersion(): Promise<DeployedVersion> {
  // no-store bypasses the HTTP cache entirely — the whole point is to see the
  // currently deployed manifest, not a cached copy. BASE_URL always ends in "/".
  const res = await fetch(`${import.meta.env.BASE_URL}version.json`, {
    cache: "no-store",
  })
  if (!res.ok) throw new Error(`version.json fetch failed: ${res.status}`)
  return (await res.json()) as DeployedVersion
}

// Fail-open check for whether a newer build than the one this tab is running
// has been deployed. GitHub Pages serves hashed bundles that self-invalidate,
// but the entry index.html can't carry Cache-Control, so a long-lived tab
// could otherwise run a stale build indefinitely. Compares commits, not
// versions, so redeploys of the same version still count as updates.
export function useVersionCheck() {
  const query = useQuery({
    queryKey: ["appUpdate", "deployedVersion"],
    queryFn: fetchDeployedVersion,
    // Dev/untagged builds without a stamped commit have nothing to compare.
    enabled: appVersion.commit !== "unknown",
    refetchInterval: 5 * 60 * 1000,
    // React Query's focus manager listens to visibilitychange, so returning to
    // a long-backgrounded tab re-checks immediately (the case this exists for).
    refetchOnWindowFocus: true,
    staleTime: 60 * 1000,
    // Fail-open (see resolveUpdateAvailable); no point retrying a check whose
    // failure mode is "stay quiet".
    retry: false,
  })

  const hasUpdate = resolveUpdateAvailable({
    deployedCommit: query.data?.commit,
    runningCommit: appVersion.commit,
  })

  return { ...query, hasUpdate }
}
