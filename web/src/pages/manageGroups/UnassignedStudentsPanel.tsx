import { useState } from "react"
import { useTranslation } from "react-i18next"

import { Button, Card, Heading, Select } from "@/components/ui"
import { PeopleIcon, PlusIcon } from "@/components/ui/icons"
import { Spinner } from "@/components/Spinner"

// One roster student not yet on any group team, with the display label the
// list rows use ("First Last (login)" or the bare login).
export type UnassignedStudent = {
  key: string
  username: string
  label: string
}

// One join target: a group with room left. Full groups are omitted by the
// caller, so every option here is addable.
export type UnassignedGroupOption = {
  slug: string
  label: string
}

// Roster students who are on none of this assignment's group teams, each with
// a group picker + Add. The page owns the mutation (size/roster gates,
// snapshot resync, shared error alert); this panel is presentation + choice.
export function UnassignedStudentsPanel({
  students,
  groups,
  pending,
  busy,
  onAdd,
}: {
  students: UnassignedStudent[]
  groups: UnassignedGroupOption[]
  // Live team membership is still resolving, so "who is unassigned" is not
  // yet known — show a loading state instead of over-claiming.
  pending: boolean
  busy: boolean
  onAdd: (username: string, teamSlug: string) => void
}) {
  const { t } = useTranslation()
  const [groupByStudent, setGroupByStudent] = useState<Record<string, string>>(
    {},
  )

  return (
    <Card bordered={false} className="mb-6 w-full border border-base-200">
      <Card.Body className="gap-4">
        <div>
          <Heading
            as="h2"
            variant="title-small"
            className="flex items-center gap-2"
          >
            <PeopleIcon aria-hidden="true" className="size-5" />
            {t("manageGroups.unassigned.heading")}
          </Heading>
          <p className="mt-1 text-sm text-base-content/70">
            {t("manageGroups.unassigned.hint")}
          </p>
        </div>

        {pending ? (
          <div className="flex py-6">
            <Spinner
              className="m-auto"
              label={t("manageGroups.unassigned.loading")}
            />
          </div>
        ) : students.length === 0 ? (
          <p className="py-4 text-center text-sm text-base-content/70">
            {t("manageGroups.unassigned.empty")}
          </p>
        ) : (
          <ul className="divide-y divide-base-200 rounded-box border border-base-200">
            {students.map((student) => {
              const chosen = groupByStudent[student.key] ?? ""
              return (
                <li
                  key={student.key}
                  className="flex flex-col gap-2 px-4 py-2.5 sm:flex-row sm:items-center"
                >
                  <span className="min-w-0 flex-1 truncate text-sm">
                    {student.label}
                  </span>
                  <div className="flex items-center gap-2">
                    <Select
                      selectSize="sm"
                      value={chosen}
                      aria-label={t("manageGroups.unassigned.selectAriaLabel", {
                        name: student.label,
                      })}
                      onChange={(e) =>
                        setGroupByStudent((prev) => ({
                          ...prev,
                          [student.key]: e.target.value,
                        }))
                      }
                    >
                      <option value="">
                        {t("manageGroups.unassigned.groupPlaceholder")}
                      </option>
                      {groups.map((group) => (
                        <option key={group.slug} value={group.slug}>
                          {group.label}
                        </option>
                      ))}
                    </Select>
                    <Button
                      variant="outline"
                      size="sm"
                      disabled={busy || !chosen}
                      aria-label={t("manageGroups.unassigned.addAriaLabel", {
                        name: student.label,
                      })}
                      onClick={() => {
                        onAdd(student.username, chosen)
                        setGroupByStudent((prev) => ({
                          ...prev,
                          [student.key]: "",
                        }))
                      }}
                    >
                      <PlusIcon aria-hidden="true" className="size-4" />
                      {t("manageGroups.unassigned.addButton")}
                    </Button>
                  </div>
                </li>
              )
            })}
          </ul>
        )}
      </Card.Body>
    </Card>
  )
}

export default UnassignedStudentsPanel
