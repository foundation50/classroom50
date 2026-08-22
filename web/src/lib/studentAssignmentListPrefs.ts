// Student per-classroom assignment-list display prefs, persisted per browser.
// Its own storage keys, separate from the classroom-list and teacher-list
// prefs. Only the sort persists now — the grid/list view toggle was removed
// when the list adopted the teacher-table layout, so the view config below is
// dormant (createListPrefs requires it; nothing reads it). The search query
// and filters are session state that should reset on navigation. Default:
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
