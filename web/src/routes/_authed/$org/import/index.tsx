// FEATURE: github-classroom-migration — removable once GitHub Classroom shuts
// down (see foundation50/classroom50#312). Delete this route file to remove the
// Import-from-GitHub-Classroom entry point.
import { createFileRoute } from "@tanstack/react-router"
import ImportClassroomPage from "@/pages/migration/ImportClassroomPage"

export const Route = createFileRoute("/_authed/$org/import/")({
  // `from`: a source GitHub org slug to preselect (deep link). A plain lowercased
  // login string; anything unexpected is dropped so it can't smuggle a value.
  validateSearch: (search: Record<string, unknown>): { from?: string } => ({
    from:
      typeof search.from === "string" && search.from.trim()
        ? search.from.trim()
        : undefined,
  }),
  component: ImportClassroomPage,
})
