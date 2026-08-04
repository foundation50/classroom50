import { useParams, useRouterState } from "@tanstack/react-router"

export type SidebarNav = {
  // Which top-level menu the rail shows: the org list ("orgs"), the org's
  // class/admin menu ("classes"), or the classroom/assignment menu ("").
  page: "orgs" | "classes" | ""
  // Active row within that menu.
  selected: string
  settings: boolean
  // Stable identity of the current nav LEVEL (not the page). Constant while
  // navigating within a level so the highlight glides; changes only on a level
  // change (orgs -> classes -> classroom -> assignment) so AnimatePresence
  // cross-fades the menu body. Scoped by org/classroom/assignment so switching
  // classrooms is also a level swap.
  levelKey: string
}

// Route-derived sidebar state. The rail now lives in the persistent `_authed`
// shell (it no longer remounts per page), so it can't take `selected` as a prop
// from the page — it reads the active row from the current route instead. This
// replaces the old per-page PageShell props (page/selected/settings) with one
// source of truth, matched by route id so a renamed path fails loudly rather
// than silently mis-highlighting.
export const useSidebarNav = (): SidebarNav => {
  const { org, classroom, assignment } = useParams({ strict: false })
  const routeIds = useRouterState({
    select: (s) => s.matches.map((m) => m.routeId as string),
  })
  const on = (id: string) => routeIds.includes(id)

  // Level: no org -> the orgs list; org but no classroom -> the class/admin
  // menu; inside a classroom -> the classroom/assignment menu (page "").
  const page: SidebarNav["page"] = !org ? "orgs" : !classroom ? "classes" : ""

  // Level identity for the menu-swap animation. Assignment is its own level
  // (distinct menu); everything else keys on its scope so a same-level nav keeps
  // the body mounted (highlight glides) while a level change swaps it.
  const levelKey =
    org && classroom && assignment
      ? `assignment:${org}/${classroom}/${assignment}`
      : org && classroom
        ? `classroom:${org}/${classroom}`
        : org
          ? `classes:${org}`
          : "orgs"

  // Orgs level (top): only the account Settings page is "selected"; the orgs
  // list itself is the default row.
  if (page === "orgs") {
    const settings = on("/_authed/settings/")
    return {
      page,
      selected: settings ? "settings" : "",
      settings,
      levelKey,
    }
  }

  // Classes level ($org/*): the org admin menu (classes home, published,
  // members, activity, settings).
  if (page === "classes") {
    if (on("/_authed/$org/settings/"))
      return { page, selected: "settings", settings: true, levelKey }
    if (on("/_authed/$org/published/"))
      return { page, selected: "published", settings: false, levelKey }
    if (on("/_authed/$org/members/"))
      return { page, selected: "members", settings: false, levelKey }
    if (on("/_authed/$org/activity/"))
      return { page, selected: "activity", settings: false, levelKey }
    // classes list, create-classroom, import, setup all sit under the classes
    // home row.
    return { page, selected: "", settings: false, levelKey }
  }

  // Classroom level ($org/$classroom/*): the classroom/assignment menu. Inside
  // an assignment the AssignmentSidebarMenu self-derives its active row via
  // useMatchRoute, so only the classroom-scoped rows need a `selected` here.
  if (on("/_authed/$org/$classroom/roster/"))
    return { page, selected: "roster", settings: false, levelKey }
  if (on("/_authed/$org/$classroom/settings/"))
    return { page, selected: "settings", settings: false, levelKey }
  return { page, selected: "assignments", settings: false, levelKey }
}
