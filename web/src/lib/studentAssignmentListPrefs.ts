// Student per-classroom assignment-list display prefs, persisted per browser.
// Its own storage keys, separate from the classroom-list and teacher-list prefs.
// The view mode (grid/list) and sort persist; the search query and filters are
// session state that should reset on navigation. Defaults: list view, and
// due-soonest-first.

import { createListPrefs } from "@/lib/listPrefs"

export type StudentAssignmentViewMode = "grid" | "list"

// Due-soonest-first is the student default: what's next matters most. Owned here
// (a leaf lib layer) so the component filters module can import it without lib
// reaching up into components/ (the boundary rule).
export type StudentAssignmentSort =
  "due-asc" | "due-desc" | "name-asc" | "name-desc"

export const studentAssignmentListPrefs = createListPrefs<
  StudentAssignmentViewMode,
  StudentAssignmentSort
>({
  viewKey: "student_assignments_view_mode",
  sortKey: "student_assignments_sort_key",
  viewValues: ["grid", "list"],
  sortValues: ["due-asc", "due-desc", "name-asc", "name-desc"],
  defaultView: "list",
  defaultSort: "due-asc",
})
