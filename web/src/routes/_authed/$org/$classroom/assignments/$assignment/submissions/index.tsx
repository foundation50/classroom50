import { createFileRoute } from "@tanstack/react-router"
import SubmissionsPage from "@/pages/SubmissionsPage"
import {
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

export const Route = createFileRoute(
  "/_authed/$org/$classroom/assignments/$assignment/submissions/",
)({
  validateSearch: (
    search: Record<string, unknown>,
  ): { status?: StatusSelectValue } => ({
    status: parseStatus(search.status),
  }),
  component: SubmissionsPage,
})
