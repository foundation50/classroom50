import { createFileRoute } from "@tanstack/react-router"
import StudentListPage from "@/pages/StudentListPage"

export const Route = createFileRoute("/_authed/$org/$classroom/roster/")({
  component: StudentListPage,
})
