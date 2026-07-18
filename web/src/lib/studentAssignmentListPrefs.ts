// Student per-classroom assignment-list sort preference, persisted per browser.
// Its own storage key, separate from the classroom-list and teacher-list prefs.
// Only the sort is persisted; the search query and filters are session state
// that should reset on navigation. Default is due-soonest-first.

import { createListPrefs } from "@/lib/listPrefs"

// Due-soonest-first is the student default: what's next matters most. Owned here
// (a leaf lib layer) so the component filters module can import it without lib
// reaching up into components/ (the boundary rule).
export type StudentAssignmentSort =
  "due-asc" | "due-desc" | "name-asc" | "name-desc"

// No view-mode toggle for this list (single layout), so the view axis is a
// fixed singleton the shared factory ignores in practice.
export const studentAssignmentListPrefs = createListPrefs<
  "list",
  StudentAssignmentSort
>({
  viewKey: "student_assignments_view_mode",
  sortKey: "student_assignments_sort_key",
  viewValues: ["list"],
  sortValues: ["due-asc", "due-desc", "name-asc", "name-desc"],
  defaultView: "list",
  defaultSort: "due-asc",
})
