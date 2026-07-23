import SettingsPage from "@/pages/SettingsPage"
import { createFileRoute } from "@tanstack/react-router"

export const Route = createFileRoute("/_authed/settings/")({
  component: SettingsPage,
})
