import { useState } from "react"
import { useTranslation } from "react-i18next"

import { GitBranchIcon, WorkflowIcon } from "@/components/ui/icons"
import { ActionListRow } from "@/components/ui"
import { useGitHubClient } from "@/context/github/GitHubProvider"
import { getRepo } from "@/github-core/repoReads"
import { useSafeSubmit } from "@/hooks/useSafeSubmit"
import { updateShimSubmissionMode } from "@/domain/assignments/submissionTrigger"
import {
  addAutogradeShim,
  type BackfillMarker,
} from "@/domain/assignments/shimBackfill"
import type { SubmissionMode } from "@/types/classroom"
import { errorText } from "@/types/localizedMessage"
import { CONFIG_REPO, DEFAULT_BRANCH } from "@/util/configRepo"
import { useSubmissionFeedback } from "./submissionFeedback"

type ShimRowActionProps = {
  icon: typeof GitBranchIcon
  // The en.json namespace under submissions.* carrying title, description,
  // aria, and outcome.<status> strings.
  i18nKey: "rowTrigger" | "rowShim"
  repo: string
  // Outcomes that read as success; every other status is a warning.
  successStatuses: readonly string[]
  act: () => Promise<{ status: string }>
  noRepo: boolean
}

// One repo's shim write from the manage hub: the single-repo twin of the bulk
// modals, for a repo that was skipped or failed there, or a single late
// accepter. The domain call is idempotent; the toast reports which outcome
// happened.
const ShimRowAction = ({
  icon,
  i18nKey,
  repo,
  successStatuses,
  act,
  noRepo,
}: ShimRowActionProps) => {
  const { t } = useTranslation()
  const feedback = useSubmissionFeedback()
  // `pending` drives the disabled state; the synchronous useSafeSubmit latch is
  // the real re-entrancy guard (React state updates a render tick late, so two
  // same-tick clicks would both pass a pending check and race duplicate shim
  // commits, and the loser 422s on the non-force ref update).
  const run = useSafeSubmit()
  const [pending, setPending] = useState(false)

  const handleClick = async () => {
    if (noRepo) return
    setPending(true)
    try {
      const outcome = await act()
      feedback({
        tone: successStatuses.includes(outcome.status) ? "success" : "warning",
        message: t(`submissions.${i18nKey}.outcome.${outcome.status}`),
      })
    } catch (err) {
      feedback({ tone: "error", message: errorText(t, err) })
    } finally {
      setPending(false)
    }
  }

  return (
    <ActionListRow
      icon={icon}
      title={t(`submissions.${i18nKey}.title`)}
      description={t(`submissions.${i18nKey}.description`)}
      onClick={() => void run(handleClick)}
      disabled={noRepo || pending}
      ariaLabel={t(`submissions.${i18nKey}.aria`, { repo })}
    />
  )
}

type ShimButtonProps = {
  org: string
  repo: string
  submissionMode: SubmissionMode
  submissionTags?: string[]
  noRepo: boolean
}

// Rewrite this repo's shim trigger to the assignment's submission_mode.
export const UpdateTriggerButton = ({
  org,
  repo,
  submissionMode,
  submissionTags,
  noRepo,
}: ShimButtonProps) => {
  const client = useGitHubClient()
  return (
    <ShimRowAction
      icon={GitBranchIcon}
      i18nKey="rowTrigger"
      repo={repo}
      successStatuses={["updated", "current"]}
      noRepo={noRepo}
      act={() =>
        updateShimSubmissionMode({
          client,
          org,
          repo,
          mode: submissionMode,
          tags: submissionTags,
        })
      }
    />
  )
}

// Add the built-in autograding workflow to this repo if it was accepted while
// the autograder was off. The config repo's default branch is read first and
// fails closed: a guessed `uses:` ref would be baked into a file that is never
// rewritten. `marker` rebuilds the `.classroom50.yaml` such an accept never
// wrote (see shimBackfill.ts).
export const AddShimButton = ({
  org,
  repo,
  submissionMode,
  submissionTags,
  noRepo,
  marker,
}: ShimButtonProps & { marker: BackfillMarker }) => {
  const client = useGitHubClient()
  return (
    <ShimRowAction
      icon={WorkflowIcon}
      i18nKey="rowShim"
      repo={repo}
      successStatuses={["added", "markerAdded", "present"]}
      noRepo={noRepo}
      act={async () => {
        const config = await getRepo(client, org, CONFIG_REPO)
        return addAutogradeShim({
          client,
          org,
          repo,
          configBranch: config?.default_branch || DEFAULT_BRANCH,
          submissionMode,
          submissionTags,
          marker,
        })
      }}
    />
  )
}
