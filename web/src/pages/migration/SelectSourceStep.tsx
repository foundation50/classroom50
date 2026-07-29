// FEATURE: github-classroom-migration — removable once GitHub Classroom shuts
// down (see foundation50/classroom50#312). Phase 1: list the viewer's GitHub
// Classrooms and pick one to import.

import { useState } from "react"
import { useQuery } from "@tanstack/react-query"
import { useTranslation } from "react-i18next"
import { ArrowRight } from "lucide-react"

import { useGitHubClient } from "@/context/github/GitHubProvider"
import { Alert, Button, Card, Spinner } from "@/components/ui"
import { listClassroomsWithOrg } from "@/migration/classroomApi"
import type { ClassroomWithOrg } from "@/migration/types"

export const SelectSourceStep = ({
  onPick,
}: {
  onPick: (classroom: ClassroomWithOrg) => void
}) => {
  const { t } = useTranslation()
  const client = useGitHubClient()
  const [includeArchived, setIncludeArchived] = useState(false)

  const { data, isLoading, isError, refetch } = useQuery({
    queryKey: ["migration", "classrooms", includeArchived],
    queryFn: () => listClassroomsWithOrg(client, { includeArchived }),
    staleTime: 60 * 1000,
  })

  return (
    <Card>
      <Card.Body>
        <Card.Title>{t("migration.select.title")}</Card.Title>
        <p className="text-base-content/70">{t("migration.select.body")}</p>

        <label className="mt-2 flex cursor-pointer items-center gap-2 text-sm">
          <input
            type="checkbox"
            className="checkbox checkbox-sm"
            checked={includeArchived}
            onChange={(e) => setIncludeArchived(e.target.checked)}
          />
          {t("migration.select.showArchived")}
        </label>

        {isLoading && (
          <div className="mt-4 flex items-center gap-2 text-base-content/70">
            <Spinner size="sm" />
            {t("migration.select.loading")}
          </div>
        )}

        {isError && (
          <Alert tone="error" className="mt-4 items-start">
            <span className="text-sm">{t("migration.select.loadError")}</span>
            <Button variant="ghost" size="sm" onClick={() => refetch()}>
              {t("migration.select.retry")}
            </Button>
          </Alert>
        )}

        {data && data.length === 0 && (
          <Alert tone="info" className="mt-4">
            {t("migration.select.empty")}
          </Alert>
        )}

        {data && data.length > 0 && (
          <ul className="mt-4 grid gap-2">
            {data.map((c) => (
              <li key={c.id}>
                <button
                  type="button"
                  onClick={() => onPick(c)}
                  className="flex w-full items-center justify-between gap-4 rounded-xl border border-base-300 bg-base-100 p-4 text-start hover:border-primary"
                >
                  <span className="min-w-0">
                    <span className="block font-semibold">{c.name}</span>
                    <span className="block truncate text-sm text-base-content/70">
                      {t("migration.select.orgLine", { org: c.orgLogin })}
                      {c.archived
                        ? ` · ${t("migration.select.archivedTag")}`
                        : ""}
                    </span>
                  </span>
                  <ArrowRight aria-hidden="true" className="size-4 shrink-0" />
                </button>
              </li>
            ))}
          </ul>
        )}
      </Card.Body>
    </Card>
  )
}

export default SelectSourceStep
