import { createFileRoute } from "@tanstack/react-router"
import StudentListPage from "@/pages/StudentListPage"

// `q` pre-fills the roster search, so another page (the org Members detail
// modal) can land the teacher on one person's row by username or email.
export const Route = createFileRoute("/_authed/$org/$classroom/roster/")({
  component: StudentListPage,
  validateSearch: (search: Record<string, unknown>): { q?: string } => {
    const q = typeof search.q === "string" ? search.q.trim() : ""
    return q ? { q } : {}
  },
})
