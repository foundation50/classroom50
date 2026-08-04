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

// Route id -> active row for the org "classes" level, as ordered [id, row]
// tuples (built once at module scope, not per render). The settings route also
// flips the `settings` flag; every other row is a plain selection. A route
// missing from the table (classes list, create, import, setup) falls through to
// the home row.
const CLASSES_ROWS: [string, { selected: string; settings?: boolean }][] = [
  ["/_authed/$org/settings/", { selected: "settings", settings: true }],
  ["/_authed/$org/published/", { selected: "published" }],
  ["/_authed/$org/members/", { selected: "members" }],
  ["/_authed/$org/activity/", { selected: "activity" }],
]

// Route id -> active row for the classroom level. Inside an assignment the
// AssignmentSidebarMenu self-derives its own active row, so only these
// classroom-scoped rows need mapping here; the default is the assignments list.
const CLASSROOM_ROWS: [string, string][] = [
  ["/_authed/$org/$classroom/roster/", "roster"],
  ["/_authed/$org/$classroom/settings/", "settings"],
]

export const useSidebarNav = (): SidebarNav => {
  const { org, classroom, assignment } = useParams({ strict: false })
  // The selector returns an array (router structural-sharing compares it by
  // value, avoiding needless re-renders). It's tiny (a handful of matched route
  // ids), so a direct `.includes` against the small route tables is cheaper than
  // allocating a Set per render.
  const routeIds = useRouterState({
    select: (s) => s.matches.map((m) => m.routeId as string),
  })

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
    const settings = routeIds.includes("/_authed/settings/")
    return { page, selected: settings ? "settings" : "", settings, levelKey }
  }

  // Classes level ($org/*): the org admin menu.
  if (page === "classes") {
    const hit = CLASSES_ROWS.find(([id]) => routeIds.includes(id))?.[1]
    return {
      page,
      selected: hit?.selected ?? "",
      settings: hit?.settings ?? false,
      levelKey,
    }
  }

  // Classroom level ($org/$classroom/*): the classroom/assignment menu.
  const classroomRow = CLASSROOM_ROWS.find(([id]) => routeIds.includes(id))?.[1]
  return {
    page,
    selected: classroomRow ?? "assignments",
    settings: false,
    levelKey,
  }
}
