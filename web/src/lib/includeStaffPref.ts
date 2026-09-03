// Per-browser "Include teaching staff" preference for the assignments table's
// funnel counts. A display preference, not server data, so it lives in
// localStorage like src/lib/hiddenOrgsStore.ts. One value across classrooms:
// a teacher testing an assignment flips it for the session, not per class.

import { localStorageOrNull } from "@/lib/webStorage"

export const INCLUDE_STAFF_STORAGE_KEY = "classroom50:assignments-include-staff"

export function readIncludeStaff(): boolean {
  return localStorageOrNull()?.getItem(INCLUDE_STAFF_STORAGE_KEY) === "1"
}

export function persistIncludeStaff(on: boolean): void {
  const ls = localStorageOrNull()
  if (!ls) return
  if (on) ls.setItem(INCLUDE_STAFF_STORAGE_KEY, "1")
  else ls.removeItem(INCLUDE_STAFF_STORAGE_KEY)
}
