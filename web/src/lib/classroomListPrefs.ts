// Classroom-list display preferences (My Classrooms), persisted per browser.
// Built on the shared createListPrefs factory. All three sorts read only summary
// data the parent already fetches (name/term) or the roster it fetches for the
// list, so there is no fan-out-bearing sort to guard against on load.

import { createListPrefs } from "@/lib/listPrefs"

export type ClassroomViewMode = "grid" | "list"
export type ClassroomSortKey = "name-asc" | "term" | "student-count"

export const classroomListPrefs = createListPrefs<
  ClassroomViewMode,
  ClassroomSortKey
>({
  viewKey: "classrooms_view_mode",
  sortKey: "classrooms_sort_key",
  viewValues: ["grid", "list"],
  sortValues: ["name-asc", "term", "student-count"],
  defaultView: "grid",
  defaultSort: "name-asc",
})
