import OrgSettingsPage from "@/pages/OrgSettingsPage"
import { createFileRoute } from "@tanstack/react-router"

export const Route = createFileRoute("/_authed/$org/settings/")({
  component: OrgSettingsPage,
  // `?focus=serviceToken` deep-links from the org list's token-health chip
  // straight to the Service Token pane (scroll + expand + highlight).
  validateSearch: (
    search: Record<string, unknown>,
  ): { focus?: "serviceToken" } => {
    return search.focus === "serviceToken" ? { focus: "serviceToken" } : {}
  },
})
