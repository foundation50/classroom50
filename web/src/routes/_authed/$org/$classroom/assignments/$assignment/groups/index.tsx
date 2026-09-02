import ManageGroupsPage from "@/pages/ManageGroupsPage"
import { createFileRoute } from "@tanstack/react-router"

export const Route = createFileRoute(
  "/_authed/$org/$classroom/assignments/$assignment/groups/",
)({
  component: ManageGroupsPage,
})
