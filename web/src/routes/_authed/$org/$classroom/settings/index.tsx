import ClassroomSettingsPage from "@/pages/ClassroomSettingsPage"
import { createFileRoute } from "@tanstack/react-router"

export const Route = createFileRoute("/_authed/$org/$classroom/settings/")({
  component: ClassroomSettingsPage,
})
