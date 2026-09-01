import { useTranslation } from "react-i18next"

import { Card, Heading, RouterButton } from "@/components/ui"
import { PeopleIcon } from "@/components/ui/icons"
import useGroupTeams from "@/hooks/useGroupTeams"

// Compact settings-page pointer to the Manage groups view: one line of
// context, the current group count (from the already-cached team listing),
// and the link. The management UI itself lives on the routed page.
export function ManageGroupsCard({
  org,
  classroom,
  assignmentSlug,
}: {
  org: string
  classroom: string
  assignmentSlug: string
}) {
  const { t } = useTranslation()
  const { data: teams } = useGroupTeams(org, classroom, assignmentSlug)

  return (
    <Card bordered={false} className="mb-6 w-full border border-base-200">
      <Card.Body className="flex-row flex-wrap items-center gap-4">
        <div className="min-w-0 flex-1">
          <Heading
            as="h2"
            variant="title-small"
            className="flex items-center gap-2"
          >
            <PeopleIcon aria-hidden="true" className="size-5" />
            {t("manageGroups.heading")}
          </Heading>
          <p className="mt-1 text-sm text-base-content/70">
            {t("manageGroups.settingsCard.description")}
            {teams !== undefined && (
              <>
                {" "}
                {t("manageGroups.settingsCard.groupCount", {
                  count: teams.length,
                })}
              </>
            )}
          </p>
        </div>
        <RouterButton
          variant="outline"
          to="/$org/$classroom/assignments/$assignment/groups"
          params={{ org, classroom, assignment: assignmentSlug }}
        >
          {t("manageGroups.title")}
        </RouterButton>
      </Card.Body>
    </Card>
  )
}

export default ManageGroupsCard
