import AssignmentSettingsPage from "@/pages/AssignmentSettingsPage"
import { createFileRoute } from "@tanstack/react-router"

export const Route = createFileRoute(
  "/_authed/$org/$classroom/assignments/$assignment/settings/",
)({
  component: AssignmentSettingsPage,
})
