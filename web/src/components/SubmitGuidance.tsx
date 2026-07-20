import { useTranslation } from "react-i18next"

import { CopyableCode } from "@/components/ui"
import { useCopyToClipboard } from "@/hooks/useCopyToClipboard"

// The command-line alternative to the web Upload button: clone the repo, then
// `gh student submit` (which snapshots the branch and pushes; the autograder
// then tags submit/* and publishes the release the submission page reads).
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
    <details className="group mt-4 rounded-box border border-base-200 p-4">
      <summary className="flex cursor-pointer items-center gap-2 text-sm font-semibold marker:content-none">
        <span className="transition-transform group-open:rotate-90">▶</span>
        {t("submissions.student.submitGuide.title")}
      </summary>
      <p className="mt-2 text-sm text-base-content/70">
        {t("submissions.student.submitGuide.intro")}
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
    </details>
  )
}

export default SubmitGuidance
