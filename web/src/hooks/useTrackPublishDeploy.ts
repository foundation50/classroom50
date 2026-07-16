import { useCallback } from "react"
import { useActionActivityRegistry } from "@/context/actions/ActionActivityProvider"

// Single-sources the `{ kind: "sha" }` publish-deploy anchor + no-SHA guard
// that four create/edit write call sites otherwise hand-copy.
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
