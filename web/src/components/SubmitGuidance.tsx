import { useState } from "react"
import { useTranslation } from "react-i18next"
import type { Ref } from "react"

import { Button, CopyableCode } from "@/components/ui"
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

// Same three clone options GitHub's own Code dropdown offers. Teachers differ
// on which they teach (discussion #966), so the student picks; nothing else in
// the app depends on how the repo was cloned.
type CloneMethod = "https" | "ssh" | "cli"
const CLONE_METHODS: CloneMethod[] = ["https", "ssh", "cli"]

// "owner/repo" from the API's html_url; the API only ever returns github.com
// URLs, so a parse failure falls back to the raw string rather than throwing.
const repoFullName = (repoHtmlUrl: string): string => {
  try {
    return new URL(repoHtmlUrl).pathname.replace(/^\/+|\/+$/g, "")
  } catch {
    return repoHtmlUrl
  }
}

const cloneCommand = (method: CloneMethod, repoHtmlUrl: string): string => {
  const fullName = repoFullName(repoHtmlUrl)
  switch (method) {
    case "https":
      return `git clone ${repoHtmlUrl}.git`
    case "ssh":
      return `git clone git@github.com:${fullName}.git`
    case "cli":
      return `gh repo clone ${fullName}`
  }
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
  open,
  onToggle,
  ref,
}: {
  repoHtmlUrl: string
  submissionMode?: SubmissionMode
  submissionTags?: string[]
  // Controlled expansion (optional): the student page opens the guide while
  // nothing is submitted yet and collapses it once work is in, and its status
  // callout re-opens it on demand. Omitted, the guide renders always-open.
  open?: boolean
  onToggle?: (open: boolean) => void
  ref?: Ref<HTMLDetailsElement>
}) {
  const { t } = useTranslation()
  const isTagMode = submissionMode === "tag"
  const [cloneMethod, setCloneMethod] = useState<CloneMethod>("https")
  const cloneCmd = cloneCommand(cloneMethod, repoHtmlUrl)
  const submitCmd = "gh student submit"
  const milestoneTag = exampleMilestoneTag(submissionTags)
  const milestoneCmd = `git tag ${milestoneTag} && git push origin ${milestoneTag}`

  const {
    copied: cloneCopied,
    copy: copyClone,
    reset: resetCloneCopied,
  } = useCopyToClipboard(cloneCmd, 1500)
  const { copied: submitCopied, copy: copySubmit } = useCopyToClipboard(
    submitCmd,
    1500,
  )
  const { copied: milestoneCopied, copy: copyMilestone } = useCopyToClipboard(
    milestoneCmd,
    1500,
  )

  return (
    <details
      ref={ref}
      open={open ?? true}
      onToggle={(event) => onToggle?.(event.currentTarget.open)}
      className="group rounded-box border border-base-200 p-4"
    >
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
          <div
            role="group"
            aria-label={t("submissions.student.submitGuide.cloneMethodAria")}
            className="join"
          >
            {CLONE_METHODS.map((method) => (
              <Button
                key={method}
                size="xs"
                active={cloneMethod === method}
                aria-pressed={cloneMethod === method}
                className="join-item"
                onClick={() => {
                  // Drop a lingering "copied" check so it can't read as if
                  // the newly selected command were already on the clipboard.
                  resetCloneCopied()
                  setCloneMethod(method)
                }}
              >
                {t(`submissions.student.submitGuide.cloneMethod.${method}`)}
              </Button>
            ))}
          </div>
          <CopyableCode
            value={cloneCmd}
            copied={cloneCopied}
            onCopy={copyClone}
            label={t("submissions.student.submitGuide.copyClone")}
          />
          <p className="text-xs text-base-content/60">
            {t("submissions.student.submitGuide.cloneHint")}
          </p>
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
