import { useTranslation } from "react-i18next"

import { CopyableCode } from "@/components/ui"
import { useCopyToClipboard } from "@/hooks/useCopyToClipboard"

// How-to-submit guidance shown when a student has accepted but has no graded
// release yet. The web app can't submit (that's `gh student submit`, which
// snapshots the branch and pushes; the autograder then tags submit/* and
// publishes the release the submission page reads), so this gives the student
// the two concrete steps: clone the repo, then submit from the CLI.
export function SubmitGuidance({ repoHtmlUrl }: { repoHtmlUrl: string }) {
  const { t } = useTranslation()
  const cloneUrl = `${repoHtmlUrl}.git`
  const cloneCmd = `git clone ${cloneUrl}`
  const submitCmd = "gh student submit"
  const { copied: cloneCopied, copy: copyClone } = useCopyToClipboard(
    cloneCmd,
    1500,
  )
  const { copied: submitCopied, copy: copySubmit } = useCopyToClipboard(
    submitCmd,
    1500,
  )

  return (
    <div className="mt-4 space-y-3 rounded-box border border-base-200 p-4">
      <h3 className="text-sm font-semibold">
        {t("submissions.student.submitGuide.title")}
      </h3>
      <ol className="space-y-3">
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
            {t("submissions.student.submitGuide.step2")}
          </p>
          <CopyableCode
            value={submitCmd}
            copied={submitCopied}
            onCopy={copySubmit}
            label={t("submissions.student.submitGuide.copySubmit")}
          />
        </li>
      </ol>
    </div>
  )
}

export default SubmitGuidance
