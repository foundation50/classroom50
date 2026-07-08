import OrgActivityPage from "@/pages/OrgActivityPage"
import { createFileRoute } from "@tanstack/react-router"

export const Route = createFileRoute("/_authed/$org/activity/")({
  component: OrgActivityPage,
})
