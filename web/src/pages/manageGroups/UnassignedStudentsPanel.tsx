import { useState } from "react"
import { useTranslation } from "react-i18next"

import { Badge, Button, Heading, Select } from "@/components/ui"
import { CheckCircleIcon, PlusIcon } from "@/components/ui/icons"
import { EmptyState, ListSkeletonRows, SkeletonRegion } from "@/components/list"
import {
  MemberAvatarCircle,
  MemberNameLines,
} from "@/components/assignments/memberIdentity"
import type { GroupPickerStudent } from "@/hooks/useGroupRoster"

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
  students: GroupPickerStudent[]
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
    <section className="flex flex-col gap-3">
      <div>
        <div className="flex items-center gap-2">
          <Heading as="h2" variant="title-small">
            {t("manageGroups.unassigned.heading")}
          </Heading>
          {!pending && (
            <Badge ghost size="sm">
              {students.length}
            </Badge>
          )}
        </div>
        <p className="mt-1 text-sm text-base-content/70">
          {t("manageGroups.unassigned.hint")}
        </p>
      </div>

      {pending ? (
        <SkeletonRegion
          label={t("manageGroups.unassigned.loading")}
          className="rounded-box border border-base-200"
        >
          <ListSkeletonRows rows={3} />
        </SkeletonRegion>
      ) : students.length === 0 ? (
        <EmptyState
          icon={CheckCircleIcon}
          body={t("manageGroups.unassigned.empty")}
        />
      ) : (
        <ul className="divide-y divide-base-200 rounded-box border border-base-200">
          {students.map((student) => {
            const chosen = groupByStudent[student.key] ?? ""
            return (
              <li
                key={student.key}
                className="flex flex-col gap-2 px-4 py-2 sm:flex-row sm:items-center"
              >
                <div className="flex min-w-0 flex-1 items-center gap-3">
                  <MemberAvatarCircle
                    avatarUrl={student.avatarUrl}
                    fallback={
                      student.initials ||
                      student.username.charAt(0).toUpperCase()
                    }
                  />
                  <MemberNameLines
                    name={student.name}
                    login={student.username}
                  />
                </div>
                <div className="flex shrink-0 items-center gap-2">
                  <Select
                    selectSize="sm"
                    className="w-auto"
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
    </section>
  )
}

export default UnassignedStudentsPanel
