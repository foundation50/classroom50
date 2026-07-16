import { useCallback } from "react"
import { useActionActivityRegistry } from "@/context/actions/ActionActivityProvider"

// Track the publish-pages deploy a config-repo write triggers, in the global
// activity banner, anchored on the commit SHA. Single-sources the `{ kind:
// "sha" }` anchor shape + the no-SHA guard that four create/edit write call
// sites (classroom + assignment) otherwise hand-copy. `label` is pre-translated
// by the caller (t() stays at the call site). No-ops when `sha` is falsy — a
// write that produced no commit triggered no deploy.
export function useTrackPublishDeploy() {
  const { register } = useActionActivityRegistry()

  return useCallback(
    (org: string, sha: string | undefined, label: string) => {
      if (!org || !sha) return
      register({ org, label, anchor: { kind: "sha", sha } })
    },
    [register],
  )
}

export default useTrackPublishDeploy
