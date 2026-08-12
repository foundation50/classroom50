import { useTranslation } from "react-i18next"

import { CopyableCode } from "@/components/ui"
import { isGlobPattern } from "@/domain/assignments/submissionDetection"
import { useCopyToClipboard } from "@/hooks/useCopyToClipboard"
import type { SubmissionMode } from "@/types/classroom"

// The example milestone tag shown in tag-mode guidance: the first configured
// pattern that is a literal tag name (no glob metacharacters), so the copied
// command is runnable. Falls back to a generic name when only globs are set.
const exampleMilestoneTag = (submissionTags?: string[]): string => {
  const literal = submissionTags?.find((p) => !isGlobPattern(p))
  return literal ?? "milestone"
}

// How a student submits from a terminal. Mode-aware:
//   - every-push (default, prop omitted): clone, then `gh student submit`
//     (snapshots the branch and pushes; the autograder tags submit/* and
//     publishes the release the submission page reads).
//   - tag: same submit command (it pushes the submit/* tag that triggers
//     grading in tag mode), plus the milestone-tag push flow when the teacher
//     configured named tags. Omitting the mode preserves the every-push copy so
//     existing callers are unaffected.
export function SubmitGuidance({
  repoHtmlUrl,
  submissionMode,
  submissionTags,
}: {
  repoHtmlUrl: string
  submissionMode?: SubmissionMode
  submissionTags?: string[]
}) {
  const { t } = useTranslation()
  const isTagMode = submissionMode === "tag"
  const cloneUrl = `${repoHtmlUrl}.git`
  const cloneCmd = `git clone ${cloneUrl}`
  const submitCmd = "gh student submit"
  const milestoneTag = exampleMilestoneTag(submissionTags)
  const milestoneCmd = `git tag ${milestoneTag} && git push origin ${milestoneTag}`

  const { copied: cloneCopied, copy: copyClone } = useCopyToClipboard(
    cloneCmd,
    1500,
  )
  const { copied: submitCopied, copy: copySubmit } = useCopyToClipboard(
    submitCmd,
    1500,
  )
  const { copied: milestoneCopied, copy: copyMilestone } = useCopyToClipboard(
    milestoneCmd,
    1500,
  )

  return (
    <details open className="group mt-4 rounded-box border border-base-200 p-4">
      <summary className="flex cursor-pointer items-center gap-2 text-sm font-semibold marker:content-none">
        <span className="transition-transform group-open:rotate-90">▶</span>
        {t("submissions.student.submitGuide.title")}
      </summary>
      <p className="mt-2 text-sm text-base-content/70">
        {isTagMode
          ? t("submissions.student.submitGuide.tagIntro")
          : t("submissions.student.submitGuide.intro")}
      </p>
      <ol className="mt-3 space-y-3">
        <li className="space-y-1.5">
          <p className="text-sm text-base-content/70">
            {t("submissions.student.submitGuide.step1")}
          </p>
          <CopyableCode
            value={cloneCmd}
            copied={cloneCopied}
            onCopy={copyClone}
            label={t("submissions.student.submitGuide.copyClone")}
          />
        </li>
        <li className="space-y-1.5">
          <p className="text-sm text-base-content/70">
            {isTagMode
              ? t("submissions.student.submitGuide.tagStep2")
              : t("submissions.student.submitGuide.step2")}
          </p>
          <CopyableCode
            value={submitCmd}
            copied={submitCopied}
            onCopy={copySubmit}
            label={t("submissions.student.submitGuide.copySubmit")}
          />
        </li>
        {isTagMode ? (
          <li className="space-y-1.5">
            <p className="text-sm text-base-content/70">
              {t("submissions.student.submitGuide.milestoneStep", {
                tags: milestoneTag,
              })}
            </p>
            <CopyableCode
              value={milestoneCmd}
              copied={milestoneCopied}
              onCopy={copyMilestone}
              label={t("submissions.student.submitGuide.copyMilestone")}
            />
          </li>
        ) : null}
      </ol>
    </details>
  )
}

export default SubmitGuidance
