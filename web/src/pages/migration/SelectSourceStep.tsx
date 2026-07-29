// FEATURE: github-classroom-migration — removable once GitHub Classroom shuts
// down (see foundation50/classroom50#312). Phase 1: list the viewer's GitHub
// Classrooms and pick one to import.

import { useEffect, useState } from "react"
import { useQuery } from "@tanstack/react-query"
import { useTranslation } from "react-i18next"
import { ChevronRight, Inbox } from "lucide-react"

import { useGitHubClient } from "@/context/github/GitHubProvider"
import { Alert, Badge, Button, Card, rtlFlip } from "@/components/ui"
import GitHub from "@/assets/github.svg?react"
import { listClassroomsWithOrg } from "@/migration/classroomApi"
import type { ClassroomWithOrg } from "@/migration/types"

const ClassroomRowButton = ({
  classroom,
  onPick,
}: {
  classroom: ClassroomWithOrg
  onPick: (c: ClassroomWithOrg) => void
}) => {
  const { t } = useTranslation()
  return (
    <button
      type="button"
      onClick={() => onPick(classroom)}
      className="group flex w-full cursor-pointer items-center gap-3 rounded-xl border border-base-300 bg-base-100 p-4 text-start transition hover:border-primary hover:bg-primary/5"
    >
      {classroom.orgAvatarUrl ? (
        <img
          src={classroom.orgAvatarUrl}
          alt=""
          className="size-9 shrink-0 rounded-lg border border-base-300"
        />
      ) : (
        <span className="flex size-9 shrink-0 items-center justify-center rounded-lg border border-base-300 bg-base-200">
          <GitHub aria-hidden="true" className="size-5 text-base-content/70" />
        </span>
      )}

      <span className="min-w-0 flex-1">
        <span className="flex items-center gap-2">
          <span className="truncate font-semibold">{classroom.name}</span>
          {classroom.archived && (
            <Badge tone="neutral" size="sm" soft>
              {t("migration.select.archivedTag")}
            </Badge>
          )}
        </span>
        <span className="mt-0.5 block truncate text-sm text-base-content/60">
          {t("migration.select.orgLine", { org: classroom.orgLogin })}
        </span>
      </span>

      <ChevronRight
        aria-hidden="true"
        className={`size-5 shrink-0 text-base-content/30 transition group-hover:text-primary ${rtlFlip}`}
      />
    </button>
  )
}

export const SelectSourceStep = ({
  onPick,
  preselectOrg,
}: {
  onPick: (classroom: ClassroomWithOrg) => void
  // A source org slug (from the `?from=` deep link) to auto-select once the list
  // loads, when exactly one classroom matches it.
  preselectOrg?: string
}) => {
  const { t } = useTranslation()
  const client = useGitHubClient()
  const [includeArchived, setIncludeArchived] = useState(false)

  const { data, isLoading, isError, refetch } = useQuery({
    queryKey: ["migration", "classrooms", includeArchived],
    queryFn: () => listClassroomsWithOrg(client, { includeArchived }),
    staleTime: 60 * 1000,
  })

  // Auto-advance from a `?from=<org>` deep link: when the list resolves and
  // exactly one classroom matches the org, pick it. Guarded so it fires once and
  // never fights a manual selection.
  const [autoPicked, setAutoPicked] = useState(false)
  useEffect(() => {
    if (autoPicked || !preselectOrg || !data) return
    const want = preselectOrg.toLowerCase()
    const matches = data.filter((c) => c.orgLogin.toLowerCase() === want)
    if (matches.length === 1) {
      setAutoPicked(true)
      onPick(matches[0])
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [data, preselectOrg, autoPicked])

  return (
    <Card>
      <Card.Body>
        <Card.Title>{t("migration.select.title")}</Card.Title>
        <p className="text-base-content/70">{t("migration.select.body")}</p>

        <label className="mt-2 flex w-fit cursor-pointer items-center gap-2 text-sm text-base-content/70">
          <input
            type="checkbox"
            className="checkbox checkbox-sm"
            checked={includeArchived}
            onChange={(e) => setIncludeArchived(e.target.checked)}
          />
          {t("migration.select.showArchived")}
        </label>

        {isLoading && (
          <ul className="mt-4 grid gap-2" aria-hidden="true">
            {Array.from({ length: 3 }).map((_, i) => (
              <li
                key={i}
                className="flex items-center gap-3 rounded-xl border border-base-300 bg-base-100 p-4"
              >
                <div className="skeleton skeleton-shimmer size-9 rounded-lg" />
                <div className="flex-1 space-y-2">
                  <div className="skeleton skeleton-shimmer h-4 w-40 rounded" />
                  <div className="skeleton skeleton-shimmer h-3 w-56 rounded" />
                </div>
              </li>
            ))}
          </ul>
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
          <div className="mt-4 rounded-xl border border-dashed border-base-300 p-8 text-center">
            <div className="mx-auto mb-2 flex size-12 items-center justify-center rounded-full bg-base-200 text-base-content/50">
              <Inbox aria-hidden="true" className="size-6" />
            </div>
            <p className="text-sm text-base-content/70">
              {t("migration.select.empty")}
            </p>
          </div>
        )}

        {data && data.length > 0 && (
          <ul className="mt-4 grid gap-2">
            {data.map((c) => (
              <li key={c.id}>
                <ClassroomRowButton classroom={c} onPick={onPick} />
              </li>
            ))}
          </ul>
        )}
      </Card.Body>
    </Card>
  )
}

export default SelectSourceStep
