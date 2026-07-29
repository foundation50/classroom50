// FEATURE: github-classroom-migration — removable once GitHub Classroom shuts
// down (see foundation50/classroom50#312). Delete this route file to remove the
// Import-from-GitHub-Classroom entry point.
import { createFileRoute } from "@tanstack/react-router"
import ImportClassroomPage from "@/pages/migration/ImportClassroomPage"

export const Route = createFileRoute("/_authed/$org/import/")({
  component: ImportClassroomPage,
})
