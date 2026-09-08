import { useEffect, useMemo, useState } from "react"
import { useTranslation } from "react-i18next"
import { SlidersIcon } from "@/components/ui/icons"

import {
  Alert,
  fieldLabelClass,
  Modal,
  ModalIcon,
  Select,
} from "@/components/ui"
import {
  BulkPhaseFooter,
  BulkProgressBlock,
  BulkResultBody,
} from "@/components/bulk/resultView"
import {
  failedAndDeferredSections,
  ownerDisplayName,
  partitionOutcomes,
  runBulkFanOut,
} from "@/components/bulk/fanOut"
import { useBulkRun } from "@/components/bulk/useBulkRun"
import useSetRepoFeatures from "@/hooks/mutations/useSetRepoFeatures"
import type { RepoFeaturePatch } from "@/github-core/mutations"
import { studentRepoName } from "@/util/studentRepo"
import type { Student } from "@/types/classroom"

type BulkRepoFeaturesModalProps = {
  open: boolean
  onClose: () => void
  org: string
  classroom: string
  assignment: string
  // Accepted students; each login is the owner segment of their own repo.
  owners: string[]
  students?: Student[]
}

// A per-feature choice in the modal. "keep" leaves the feature untouched on the
// student repos; on/off force it. Distinct from the assignment form's tri-state
// (inherit/on/off) — there's no template to inherit from when reconciling
// existing repos, so the neutral option is "leave as-is".
type FeatureChoice = "keep" | "on" | "off"

const FEATURES = [
  { key: "issues", patchKey: "has_issues" },
  { key: "wiki", patchKey: "has_wiki" },
  { key: "projects", patchKey: "has_projects" },
  { key: "pull_requests", patchKey: "has_pull_requests" },
] as const

// Build the PATCH body from the four choices: only on/off keys are sent.
function choicesToPatch(
  choices: Record<(typeof FEATURES)[number]["key"], FeatureChoice>,
): RepoFeaturePatch {
  const patch: RepoFeaturePatch = {}
  for (const { key, patchKey } of FEATURES) {
    if (choices[key] === "on") patch[patchKey] = true
    else if (choices[key] === "off") patch[patchKey] = false
  }
  return patch
}

// Whole-assignment repo-feature editor: set Issues/Wiki/Projects/Pull-requests
// across every accepted student's repo in one bounded fan-out. The way to
// reconcile existing repos with an assignment's settings, since repo_features
// is applied at accept-time only. Sibling of BulkRepoAccessModal.
export function BulkRepoFeaturesModal({
  open,
  onClose,
  org,
  classroom,
  assignment,
  owners,
  students = [],
}: BulkRepoFeaturesModalProps) {
  const { t } = useTranslation()
  const setFeaturesMutation = useSetRepoFeatures()
  const bulk = useBulkRun(open)
  const { phase, progress, result, busy } = bulk

  const [choices, setChoices] = useState<
    Record<(typeof FEATURES)[number]["key"], FeatureChoice>
  >({ issues: "keep", wiki: "keep", projects: "keep", pull_requests: "keep" })
  // The form state resets with the run state, on open (see useBulkRun).
  useEffect(() => {
    if (!open) return
    setChoices({
      issues: "keep",
      wiki: "keep",
      projects: "keep",
      pull_requests: "keep",
    })
  }, [open])

  const total = owners.length
  const displayFor = ownerDisplayName(students)
  const patch = useMemo(() => choicesToPatch(choices), [choices])
  const nothingSelected = Object.keys(patch).length === 0

  const run = async () => {
    if (total === 0 || nothingSelected) return
    if (!bulk.begin(total)) return

    const { outcomes, rateLimited } = await runBulkFanOut({
      owners,
      isMounted: bulk.isMounted,
      onProgress: (processed, owner) =>
        bulk.setProgress({ processed, total, message: displayFor(owner) }),
      t,
      perOwner: async (owner) => {
        const repo = studentRepoName(classroom, assignment, owner)
        await setFeaturesMutation.mutateAsync({ org, repo, features: patch })
      },
    })
    if (!bulk.isMounted()) return

    const { succeeded, deferred, failed } = partitionOutcomes(outcomes)

    bulk.complete(
      {
        headline: rateLimited
          ? t("submissions.bulkFeatures.resultHeadlineThrottled", {
              count: succeeded.length,
              total,
            })
          : t("submissions.bulkFeatures.resultHeadline", {
              count: succeeded.length,
              total,
            }),
        sections: failedAndDeferredSections(
          t,
          "submissions.bulkFeatures",
          { failed, deferred },
          displayFor,
        ),
      },
      failed.length || deferred.length ? "error" : "complete",
    )
  }

  return (
    <Modal
      open={open}
      onClose={onClose}
      closeDisabled={busy}
      size="lg"
      title={t("submissions.bulkFeatures.title")}
      subtitle={t("submissions.bulkFeatures.subtitle", { count: total })}
      headerVisual={
        <ModalIcon>
          <SlidersIcon className="size-4" aria-hidden="true" />
        </ModalIcon>
      }
      footer={
        <BulkPhaseFooter
          phase={phase}
          busy={busy}
          showApply={total > 0}
          applyDisabled={nothingSelected}
          applyLabel={t("submissions.bulkFeatures.apply")}
          onApply={() => void run()}
          onClose={onClose}
        />
      }
    >
      {phase === "idle" && (
        <div className="mt-4 flex flex-col gap-4">
          {total === 0 ? (
            <Alert tone="info" className="text-sm">
              {t("submissions.bulkFeatures.noRepos")}
            </Alert>
          ) : (
            <>
              <div className="grid grid-cols-1 gap-x-8 gap-y-3 sm:grid-cols-2">
                {FEATURES.map(({ key }) => (
                  <label key={key} className="flex flex-col gap-1.5">
                    <span className={fieldLabelClass}>
                      {t(`assignments.form.repoFeatures.${key}.label`)}
                    </span>
                    <Select
                      className="w-full"
                      value={choices[key]}
                      onChange={(e) =>
                        setChoices((prev) => ({
                          ...prev,
                          [key]: e.target.value as FeatureChoice,
                        }))
                      }
                    >
                      <option value="keep">
                        {t("submissions.bulkFeatures.keep")}
                      </option>
                      <option value="on">
                        {t("assignments.form.repoFeatures.choices.on")}
                      </option>
                      <option value="off">
                        {t("assignments.form.repoFeatures.choices.off")}
                      </option>
                    </Select>
                  </label>
                ))}
              </div>
              <Alert tone="warning" className="text-sm">
                {t("submissions.bulkFeatures.warning", { count: total })}
              </Alert>
            </>
          )}
        </div>
      )}

      {busy && (
        <BulkProgressBlock
          workingLabel={t("submissions.bulkFeatures.working")}
          progress={progress}
          caption={t("submissions.bulkFeatures.progress", {
            processed: progress.processed,
            total: progress.total,
          })}
        />
      )}

      <BulkResultBody phase={phase} result={result} />
    </Modal>
  )
}

export default BulkRepoFeaturesModal
