import { useSyncExternalStore } from "react"

import router from "@/router"
import { orgFromPathname } from "@/util/actionActivity"

// The org slug ("$org") from the current URL, read from the router singleton
// rather than useParams — the activity banner mounts ABOVE the router (alongside
// NotificationProvider) so it has no route context. Subscribes to router
// navigation so it updates as the teacher moves between orgs.
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
