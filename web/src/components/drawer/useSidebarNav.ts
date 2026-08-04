import { useParams, useRouterState } from "@tanstack/react-router"

export type SidebarNav = {
  // Which top-level menu the rail shows: the org list ("orgs"), the org's
  // class/admin menu ("classes"), or the classroom/assignment menu ("").
  page: "orgs" | "classes" | ""
  // Active row within that menu.
  selected: string
  settings: boolean
}

// Route-derived sidebar state. The rail now lives in the persistent `_authed`
// shell (it no longer remounts per page), so it can't take `selected` as a prop
// from the page — it reads the active row from the current route instead. This
// replaces the old per-page PageShell props (page/selected/settings) with one
// source of truth, matched by route id so a renamed path fails loudly rather
// than silently mis-highlighting.
export const useSidebarNav = (): SidebarNav => {
  const { org, classroom } = useParams({ strict: false })
  const routeIds = useRouterState({
    select: (s) => s.matches.map((m) => m.routeId as string),
  })
  const on = (id: string) => routeIds.includes(id)

  // Level: no org -> the orgs list; org but no classroom -> the class/admin
  // menu; inside a classroom -> the classroom/assignment menu (page "").
  const page: SidebarNav["page"] = !org ? "orgs" : !classroom ? "classes" : ""

  // Orgs level (top): only the account Settings page is "selected"; the orgs
  // list itself is the default row.
  if (page === "orgs") {
    const settings = on("/_authed/settings/")
    return { page, selected: settings ? "settings" : "", settings }
  }

  // Classes level ($org/*): the org admin menu (classes home, published,
  // members, activity, settings).
  if (page === "classes") {
    if (on("/_authed/$org/settings/"))
      return { page, selected: "settings", settings: true }
    if (on("/_authed/$org/published/"))
      return { page, selected: "published", settings: false }
    if (on("/_authed/$org/members/"))
      return { page, selected: "members", settings: false }
    if (on("/_authed/$org/activity/"))
      return { page, selected: "activity", settings: false }
    // classes list, create-classroom, import, setup all sit under the classes
    // home row.
    return { page, selected: "", settings: false }
  }

  // Classroom level ($org/$classroom/*): the classroom/assignment menu. Inside
  // an assignment the AssignmentSidebarMenu self-derives its active row via
  // useMatchRoute, so only the classroom-scoped rows need a `selected` here.
  if (on("/_authed/$org/$classroom/roster/"))
    return { page, selected: "roster", settings: false }
  if (on("/_authed/$org/$classroom/settings/"))
    return { page, selected: "settings", settings: false }
  return { page, selected: "assignments", settings: false }
}
