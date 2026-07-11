import type { Student } from "@/types/classroom"
import { isSameGitHubUser, parseGitHubId } from "@/util/identity"

export { isSameGitHubUser, parseGitHubId }

export const capitalize = (s: string) =>
  s ? s.charAt(0).toUpperCase() + s.slice(1) : ""

// Find a roster student by username, case-insensitively: GitHub logins and
// scores.json logins can differ in case from the CSV, so `===` would miss.
const findByUsername = (key: string, students: Student[]) => {
  const k = key.trim().toLowerCase()
  return students.find((s) => s.username.trim().toLowerCase() === k)
}

// Minimal Student carrying only the username; fallback when off-roster.
export const placeholderStudent = (username: string): Student => ({
  username,
  first_name: "",
  last_name: "",
  email: "",
  section: "",
  github_id: "",
  role: "",
})

// The roster Student for a username, or a placeholder so callers always get one.
export const resolveStudent = (key: string, students: Student[]): Student =>
  findByUsername(key, students) ?? placeholderStudent(key)

export const getName = (key: string, students: Student[]) => {
  const student = findByUsername(key, students)
  if (!student) return ""
  return nameFromParts(student.first_name, student.last_name)
}

// Display name from a roster row's first/last parts; "" when neither present.
export const nameFromParts = (
  firstName?: string,
  lastName?: string,
): string => {
  const first = firstName?.trim() ?? ""
  const last = lastName?.trim() ?? ""
  if (!first && !last) return ""
  if (!first) return capitalize(last)
  if (!last) return capitalize(first)
  return `${capitalize(first)} ${capitalize(last)}`
}

export const getInitials = (key: string, students: Student[]) => {
  const student = findByUsername(key, students)
  if (!student) return ""
  return initialsFromParts(student.first_name, student.last_name)
}

// Avatar initials from first/last parts; "" when neither present.
export const initialsFromParts = (
  firstName?: string,
  lastName?: string,
): string => {
  const first = capitalize((firstName ?? "").trim().slice(0, 1))
  const last = capitalize((lastName ?? "").trim().slice(0, 1))
  return `${first}${last}`
}

// A student's section by username, or "" if unknown/unset.
export const getSection = (key: string, students: Student[]): string =>
  findByUsername(key, students)?.section?.trim() ?? ""
