import { useTranslation } from "react-i18next"
import { Alert, Button } from "@/components/ui"
import type { AssignmentForm } from "../assignmentFormModel"
import { deriveFormShape } from "../formShape"
import { useTemplateRepo } from "../useTemplateRepo"

// True when a `datetime-local` value parses to a future instant.
const isFutureDatetimeLocal = (value: string): boolean => {
  if (!value) return false
  const time = new Date(value).getTime()
  return !Number.isNaN(time) && time > Date.now()
}

// A release date reads like an access control but only gates the student
// listing: saving grants the classroom team read on a private in-org template
// right away (issue #884). Surface that at the point of decision, with the
// one-click fix (lock) and, once locked, the reminder that nothing unlocks it
// at the release date.
export function ReleaseDateAccessNotice({
  form,
  org,
}: {
  form: AssignmentForm
  org?: string
}) {
  return (
    <form.Subscribe
      selector={(state) => ({
        templateRepo: deriveFormShape(state.values).showTemplateFields
          ? state.values.template_repo.trim()
          : "",
        futureRelease: isFutureDatetimeLocal(state.values.available_from_date),
        locked: state.values.locked,
      })}
    >
      {({ templateRepo, futureRelease, locked }) =>
        templateRepo && futureRelease ? (
          <PrivateTemplateNotice
            templateRepo={templateRepo}
            org={org}
            locked={locked}
            onLock={() => form.setFieldValue("locked", true)}
          />
        ) : null
      }
    </form.Subscribe>
  )
}

function PrivateTemplateNotice({
  templateRepo,
  org,
  locked,
  onLock,
}: {
  templateRepo: string
  org?: string
  locked: boolean
  onLock: () => void
}) {
  const { t } = useTranslation()
  const { parsed, query } = useTemplateRepo(templateRepo, org)
  const repo = query.data
  // Only a private template inside the org gets a team grant; a public one is
  // readable regardless and a private out-of-org one can't be granted at all.
  const privateInOrg =
    Boolean(repo?.private) &&
    Boolean(org) &&
    parsed?.owner.toLowerCase() === org?.toLowerCase()
  if (!privateInOrg) return null

  if (locked) {
    return (
      <Alert tone="info" role="status" className="mt-2 text-sm">
        <span>{t("assignments.form.releaseLockedReminder")}</span>
      </Alert>
    )
  }
  return (
    <Alert
      tone="warning"
      role="status"
      className="mt-2 text-sm"
      title={t("assignments.form.releaseTemplateReadableTitle")}
    >
      <p>{t("assignments.form.releaseTemplateReadableBody")}</p>
      <Button variant="outline" size="sm" className="mt-2" onClick={onLock}>
        {t("assignments.form.lockAssignment")}
      </Button>
    </Alert>
  )
}
