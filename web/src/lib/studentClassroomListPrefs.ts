// Student "My Classrooms" display preferences, persisted per browser. Separate
// storage keys from the teacher classroomListPrefs so the two lists don't share
// a view/sort. Sorts read only the teams-derived summary (name + accepted
// count) already in hand — no fan-out to guard on load.

import { createListPrefs } from "@/lib/listPrefs"

export type StudentClassroomViewMode = "grid" | "list"
export type StudentClassroomSortKey = "name-asc" | "accepted-desc"

export const studentClassroomListPrefs = createListPrefs<
  StudentClassroomViewMode,
  StudentClassroomSortKey
>({
  viewKey: "student_classrooms_view_mode",
  sortKey: "student_classrooms_sort_key",
  viewValues: ["grid", "list"],
  sortValues: ["name-asc", "accepted-desc"],
  defaultView: "grid",
  defaultSort: "name-asc",
})
