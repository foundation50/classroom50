import OrgSettingsPage from "@/pages/OrgSettingsPage"
import { createFileRoute } from "@tanstack/react-router"

export const Route = createFileRoute("/_authed/$org/settings/")({
  component: OrgSettingsPage,
})
