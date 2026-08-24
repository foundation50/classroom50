import { useEffect, useId, useMemo, useRef, useState } from "react"
import { useTranslation } from "react-i18next"
import type { TFunction } from "i18next"
import { SlidersIcon } from "@primer/octicons-react"

import { Alert, Button, Modal, Select } from "@/components/ui"
import { Spinner } from "@/components/Spinner"
import {
  BulkResultSection,
  type BulkPhase,
  type BulkProgress,
  type BulkResultView,
} from "@/components/bulk/resultView"
import useSetRepoFeatures from "@/hooks/mutations/useSetRepoFeatures"
import type { RepoFeaturePatch } from "@/github-core/mutations"
import { REPO_READ_CONCURRENCY } from "@/github-core/queries"
import { mapWithConcurrency } from "@/util/concurrency"
import { studentRepoName } from "@/util/studentRepo"
import { getName } from "@/util/students"
import { describeGitHubApiFailure } from "@/components/modals/collaboratorHelpers"
import { GitHubAPIError } from "@/github-core/errors"
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

// Map a rejected write to a localized reason for the result table. Reuses the
// shared groupCollaborators failure vocabulary (rate-limit/403/404) like the
// sibling BulkRepoAccessModal, then falls back to the HTTP status / raw message.
const describeFailure = (reason: unknown, t: TFunction): string | undefined => {
  const shared = describeGitHubApiFailure(reason, t)
  if (shared) return shared
  if (reason instanceof GitHubAPIError) {
    return t("components.modals.groupCollaborators.failure.httpStatus", {
      status: reason.status,
    })
  }
  return reason instanceof Error ? reason.message : undefined
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
  const titleId = useId()
  const { t } = useTranslation()
  const setFeaturesMutation = useSetRepoFeatures()
  const runningRef = useRef(false)
  const mountedRef = useRef(true)
  useEffect(() => {
    mountedRef.current = true
    return () => {
      mountedRef.current = false
      runningRef.current = false
    }
  }, [])

  const [choices, setChoices] = useState<
    Record<(typeof FEATURES)[number]["key"], FeatureChoice>
  >({ issues: "keep", wiki: "keep", projects: "keep", pull_requests: "keep" })
  const [phase, setPhase] = useState<BulkPhase>("idle")
  const [progress, setProgress] = useState<BulkProgress>({
    processed: 0,
    total: 0,
    message: "",
  })
  const [result, setResult] = useState<BulkResultView | null>(null)

  useEffect(() => {
    if (!open) {
      runningRef.current = false
      setChoices({
        issues: "keep",
        wiki: "keep",
        projects: "keep",
        pull_requests: "keep",
      })
      setPhase("idle")
      setResult(null)
      setProgress({ processed: 0, total: 0, message: "" })
    }
  }, [open])

  const total = owners.length
  const displayFor = (login: string) => getName(login, students) || login
  const patch = useMemo(() => choicesToPatch(choices), [choices])
  const nothingSelected = Object.keys(patch).length === 0

  type Outcome =
    | { owner: string; status: "ok" }
    | { owner: string; status: "deferred" }
    | { owner: string; status: "failed"; detail?: string }

  const run = async () => {
    if (runningRef.current || total === 0 || nothingSelected) return
    runningRef.current = true
    setPhase("working")
    setResult(null)
    let processed = 0
    setProgress({ processed: 0, total, message: "" })
    // Stop launching NEW writes on a secondary-rate-limit; report the rest as
    // deferred (mirrors BulkRepoAccessModal).
    let rateLimited = false

    const outcomes = await mapWithConcurrency(
      owners,
      REPO_READ_CONCURRENCY,
      async (owner): Promise<Outcome> => {
        if (rateLimited || !mountedRef.current) {
          processed += 1
          if (mountedRef.current) {
            setProgress({ processed, total, message: displayFor(owner) })
          }
          return { owner, status: "deferred" }
        }
        const repo = studentRepoName(classroom, assignment, owner)
        try {
          await setFeaturesMutation.mutateAsync({ org, repo, features: patch })
          return { owner, status: "ok" }
        } catch (err) {
          if (err instanceof GitHubAPIError && err.isRateLimited) {
            rateLimited = true
            return { owner, status: "deferred" }
          }
          return { owner, status: "failed", detail: describeFailure(err, t) }
        } finally {
          processed += 1
          if (mountedRef.current) {
            setProgress({ processed, total, message: displayFor(owner) })
          }
        }
      },
    )

    if (!mountedRef.current) {
      runningRef.current = false
      return
    }

    const succeeded = outcomes.filter((o) => o.status === "ok")
    const deferred = outcomes.filter((o) => o.status === "deferred")
    const failed = outcomes.filter((o) => o.status === "failed")

    setResult({
      headline: rateLimited
        ? t("submissions.bulkFeatures.resultHeadlineThrottled", {
            count: succeeded.length,
            total,
          })
        : t("submissions.bulkFeatures.resultHeadline", {
            count: succeeded.length,
            total,
          }),
      sections: [
        ...(failed.length
          ? [
              {
                title: t("submissions.bulkFeatures.failedSection", {
                  count: failed.length,
                }),
                rows: failed.map((o) => ({
                  key: o.owner,
                  label: displayFor(o.owner),
                  detail: "detail" in o ? o.detail : undefined,
                })),
              },
            ]
          : []),
        ...(deferred.length
          ? [
              {
                title: t("submissions.bulkFeatures.deferredSection", {
                  count: deferred.length,
                }),
                rows: deferred.map((o) => ({
                  key: o.owner,
                  label: displayFor(o.owner),
                  detail: t("submissions.bulkFeatures.deferredDetail"),
                })),
              },
            ]
          : []),
      ],
    })
    setPhase(failed.length || deferred.length ? "error" : "complete")
    runningRef.current = false
  }

  const busy = phase === "working"
  const pct = useMemo(
    () =>
      progress.total > 0
        ? Math.round((progress.processed / progress.total) * 100)
        : 0,
    [progress],
  )

  return (
    <Modal
      open={open}
      onClose={onClose}
      closeDisabled={busy}
      size="lg"
      aria-labelledby={titleId}
    >
      <div className="flex items-start gap-4">
        <div className="flex size-11 shrink-0 items-center justify-center rounded-box bg-primary/10 text-primary">
          <SlidersIcon className="size-5" aria-hidden="true" />
        </div>
        <div className="min-w-0 flex-1">
          <h3 id={titleId} className="text-lg font-bold">
            {t("submissions.bulkFeatures.title")}
          </h3>
          <p className="mt-1 text-sm text-base-content/70">
            {t("submissions.bulkFeatures.subtitle", { count: total })}
          </p>
        </div>
      </div>

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
                    <span className="label font-bold">
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
        <div className="mt-6 flex flex-col items-center gap-3 py-6">
          <Spinner label={t("submissions.bulkFeatures.working")} />
          <progress
            className="progress progress-primary w-full"
            value={pct}
            max={100}
          />
          <p className="text-sm text-base-content/70">
            {t("submissions.bulkFeatures.progress", {
              processed: progress.processed,
              total: progress.total,
            })}
          </p>
        </div>
      )}

      {(phase === "complete" || phase === "error") && result && (
        <div className="mt-4 flex flex-col gap-4">
          <Alert
            tone={phase === "error" ? "warning" : "success"}
            className="text-sm"
          >
            {result.headline}
          </Alert>
          {result.sections.map((section) => (
            <BulkResultSection
              key={section.title}
              title={section.title}
              rows={section.rows}
            />
          ))}
        </div>
      )}

      <div className="modal-action">
        <Button variant="ghost" disabled={busy} onClick={() => onClose()}>
          {phase === "complete" || phase === "error"
            ? t("common.close")
            : t("common.cancel")}
        </Button>
        {phase === "idle" && total > 0 && (
          <Button
            variant="primary"
            disabled={nothingSelected}
            onClick={() => void run()}
          >
            {t("submissions.bulkFeatures.apply")}
          </Button>
        )}
      </div>
    </Modal>
  )
}

export default BulkRepoFeaturesModal
