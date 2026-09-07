import { createFileRoute } from "@tanstack/react-router"
import SubmissionsPage from "@/pages/SubmissionsPage"
import {
  DEFAULT_PAGE_SIZE,
  PAGE_SIZE_OPTIONS,
  STATUS_SELECT_VALUES,
  type StatusSelectValue,
} from "@/pages/submissions/dashboard"

// `status` optionally deep-links the dashboard to a pre-filtered cohort
// (e.g. ?status=not-accepted from the assignments table's Accepted cell).
// An unknown value degrades to no filter; "all" is the default so it never
// needs to travel in the URL.
const parseStatus = (value: unknown): StatusSelectValue | undefined =>
  typeof value === "string" &&
  value !== "all" &&
  (STATUS_SELECT_VALUES as readonly string[]).includes(value)
    ? (value as StatusSelectValue)
    : undefined

// Pagination is URL state (Primer): reload/back keep the page, and a row's
// location is sharable. 1-based in the URL for humans; page 1 and the
// default size never travel. Invalid values degrade to the defaults.
const parsePage = (value: unknown): number | undefined => {
  const n = typeof value === "string" ? Number(value) : value
  return typeof n === "number" && Number.isInteger(n) && n >= 2 ? n : undefined
}

const parsePageSize = (value: unknown): number | undefined => {
  const n = typeof value === "string" ? Number(value) : value
  return typeof n === "number" &&
    n !== DEFAULT_PAGE_SIZE &&
    (PAGE_SIZE_OPTIONS as readonly number[]).includes(n)
    ? n
    : undefined
}

export const Route = createFileRoute(
  "/_authed/$org/$classroom/assignments/$assignment/submissions/",
)({
  validateSearch: (
    search: Record<string, unknown>,
  ): { status?: StatusSelectValue; page?: number; pageSize?: number } => ({
    status: parseStatus(search.status),
    page: parsePage(search.page),
    pageSize: parsePageSize(search.pageSize),
  }),
  component: SubmissionsPage,
})
