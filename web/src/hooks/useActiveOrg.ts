import { useSyncExternalStore } from "react"

import router from "@/router"
import { orgFromPathname } from "@/util/actionActivity"

// The org slug from the current URL, read from the router singleton (not
// useParams) — the banner mounts ABOVE the router, so it has no route context.
// Subscribes to navigation so it updates as the teacher moves between orgs.
function readActiveOrg(): string | undefined {
  return orgFromPathname(
    router.state.location.pathname,
    import.meta.env.BASE_URL,
  )
}

export function useActiveOrg(): string | undefined {
  return useSyncExternalStore(
    (onChange) => router.subscribe("onResolved", onChange),
    readActiveOrg,
    () => undefined,
  )
}
