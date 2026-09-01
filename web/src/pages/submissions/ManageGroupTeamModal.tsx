import { useState } from "react"
import { useTranslation } from "react-i18next"

import { Alert, Button, Input, Modal } from "@/components/ui"
import { GroupTeamMembersPanel } from "@/components/assignments/GroupTeamMembersPanel"
import useRenameGroupTeam from "@/hooks/mutations/useRenameGroupTeam"
import { useSyncTeamsSnapshot } from "@/hooks/mutations/useSaveTeamsSnapshot"
import { errorText } from "@/types/localizedMessage"
import type { TeamFormation } from "@/types/classroom"

// Teacher-side group management straight from a submissions row (team mode):
// edit the display name (the classroom50/group/v1 description record — the
// team slug never changes, so nothing downstream breaks) and add/remove
// members on the live GitHub Team. Every successful write resyncs the
// teams.json snapshot, like the assignment settings Teams section.
export function ManageGroupTeamModal({
  org,
  classroom,
  assignment,
  teamSlug,
  displayName,
  fallbackLabel,
  maxGroupSize,
  formation,
  onClose,
}: {
  org: string
  classroom: string
  assignment: string
  teamSlug: string
  displayName?: string
  // The label the table showed for this row ("Group <n>"), the rename field's
  // placeholder when no display name is set.
  fallbackLabel: string
  maxGroupSize?: number
  formation: TeamFormation
  onClose: () => void
}) {
  const { t } = useTranslation()
  const [nameDraft, setNameDraft] = useState(displayName ?? "")
  const [renameError, setRenameError] = useState<string | null>(null)

  const renameTeam = useRenameGroupTeam({ org, classroom, assignment })
  const syncSnapshot = useSyncTeamsSnapshot({ org, classroom, assignment })

  const resyncSnapshot = () => {
    // Best-effort like the settings section: the live team is already
    // correct; a failed snapshot write only ages the drift baseline.
    syncSnapshot.mutate({ formation })
  }

  const savedName = displayName ?? ""
  const nameDirty = nameDraft.trim() !== savedName

  const handleRename = async () => {
    if (renameTeam.isPending || !nameDirty) return
    setRenameError(null)
    try {
      await renameTeam.mutateAsync({ teamSlug, name: nameDraft.trim() })
      resyncSnapshot()
    } catch (err) {
      setRenameError(errorText(t, err))
    }
  }

  return (
    <Modal
      open
      onClose={onClose}
      title={t("submissions.manageTeam.title", {
        name: displayName || fallbackLabel,
      })}
    >
      <div className="flex flex-col gap-4">
        {renameError ? (
          <Alert tone="error" className="text-sm">
            {renameError}
          </Alert>
        ) : null}

        <div className="flex flex-col gap-2">
          <label
            className="label p-0 text-sm font-medium"
            htmlFor="team-display-name"
          >
            {t("submissions.manageTeam.nameLabel")}
          </label>
          <div className="flex flex-col gap-2 sm:flex-row">
            <Input
              id="team-display-name"
              className="flex-1"
              value={nameDraft}
              placeholder={fallbackLabel}
              onChange={(e) => setNameDraft(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault()
                  void handleRename()
                }
              }}
            />
            <Button
              variant="outline"
              disabled={!nameDirty || renameTeam.isPending}
              loading={renameTeam.isPending}
              onClick={() => void handleRename()}
            >
              {t("submissions.manageTeam.saveName")}
            </Button>
          </div>
          <p className="text-xs text-base-content/70">
            {t("submissions.manageTeam.nameHelp")}
          </p>
        </div>

        <GroupTeamMembersPanel
          org={org}
          classroom={classroom}
          assignment={assignment}
          teamSlug={teamSlug}
          teamName={displayName || fallbackLabel}
          maxGroupSize={maxGroupSize}
          // The teacher's power comes from org ownership, not team
          // membership, so the role-derived gate doesn't apply here.
          canManage
          onMembershipChange={resyncSnapshot}
        />
      </div>
    </Modal>
  )
}

export default ManageGroupTeamModal
