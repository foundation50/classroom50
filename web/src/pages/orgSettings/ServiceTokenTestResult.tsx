import { Link } from "@tanstack/react-router"
import type { TFunction } from "i18next"
import type { ReactNode } from "react"
import { Trans, useTranslation } from "react-i18next"

import { Alert, Button, cx, type AlertTone } from "@/components/ui"
import { LinkExternalIcon } from "@/components/ui/icons"
import { ProbeWorkflowMissingError } from "@/github-core/mutations"
import type { RunAnnotation } from "@/github-core/queries"
import type useTestServiceToken from "@/hooks/useTestServiceToken"
import { errorText } from "@/types/localizedMessage"

type TestState = ReturnType<typeof useTestServiceToken>

// DOM anchor of the Re-run org setup section (see RerunOrgSetup), where an org
// whose workflow files predate probe-token.yaml gets them.
const RERUN_ORG_SETUP_ANCHOR = "rerun-org-setup"

// The messages worth relaying from a finished probe run: the failure verdict
// (which checks did not pass, and the fix). Notices only restate "passed".
const failureMessages = (annotations: RunAnnotation[] | undefined) =>
  (annotations ?? []).filter((a) => a.level === "failure").map((a) => a.message)

type SimpleOutcome = {
  tone: AlertTone
  body: (t: TFunction) => ReactNode
  // Whether the "View run" link belongs beside it (a rejected dispatch has no
  // run to view).
  showRun: boolean
}

// The single-sentence outcomes, keyed by what the tracker reports.
function simpleOutcome({
  phase,
  failure,
  error,
}: Pick<TestState, "phase" | "failure" | "error">): SimpleOutcome | null {
  if (phase === "completed") {
    return {
      tone: "success",
      showRun: true,
      body: (t) => t("orgSettings.serviceToken.test.passed"),
    }
  }
  if (phase === "timeout") {
    return {
      tone: "warning",
      showRun: true,
      body: (t) => t("orgSettings.serviceToken.test.timeout"),
    }
  }
  if (phase === "failed" && failure === "dispatch") {
    if (error instanceof ProbeWorkflowMissingError) {
      return {
        tone: "warning",
        showRun: false,
        body: () => (
          <Trans
            i18nKey="orgSettings.serviceToken.test.workflowMissing"
            components={{
              updateLink: (
                <Link className="link" to="." hash={RERUN_ORG_SETUP_ANCHOR} />
              ),
            }}
          />
        ),
      }
    }
    return {
      tone: "error",
      showRun: false,
      body: (t) =>
        t("orgSettings.serviceToken.test.startFailed", {
          reason: errorText(t, error),
        }),
    }
  }
  return null
}

// The outcome of the last "Test token" run, below the token row. In-flight
// progress is not shown here: the button spins and the Actions banner carries
// the run. What stays is what the banner can't say: pass/fail with the probe's
// own verdict, a rejected dispatch, and this client's poll timeout.
export default function ServiceTokenTestResult({
  state,
  className,
}: {
  state: TestState
  className?: string
}) {
  const { t } = useTranslation()
  const { phase, failure, run, error, annotations, inFlight } = state
  if (phase === "idle" || inFlight) {
    return null
  }

  const viewRun = run?.html_url ? (
    <Button
      href={run.html_url}
      target="_blank"
      rel="noreferrer"
      variant="ghost"
      size="xs"
      className="ms-auto shrink-0"
    >
      {t("actionsBanner.viewRun")}
      <LinkExternalIcon aria-hidden="true" className="size-3.5" />
    </Button>
  ) : null

  // Every outcome but a failed RUN is one sentence in one tone, so simpleOutcome
  // keeps a new outcome to one branch. A failed run is the one shape with
  // structure (the probe's own verdict list), rendered below.
  const simple = simpleOutcome({ phase, failure, error })
  if (simple) {
    return (
      <Alert tone={simple.tone} className={cx("text-sm", className)}>
        <span>{simple.body(t)}</span>
        {simple.showRun && viewRun}
      </Alert>
    )
  }

  const details = failureMessages(annotations)
  return (
    <Alert tone="error" className={cx("text-sm", className)}>
      <div className="flex min-w-0 flex-col gap-2">
        <p className="font-semibold">
          {t("orgSettings.serviceToken.test.failedTitle")}
        </p>
        {annotations === undefined ? (
          <span>{t("orgSettings.serviceToken.test.failedLoading")}</span>
        ) : details.length > 0 ? (
          <ul className="list-disc space-y-1 ps-5">
            {details.map((message, index) => (
              // The probe may repeat a message (one per failed check), so the
              // text alone is not a stable key.
              <li key={`${index}-${message}`}>{message}</li>
            ))}
          </ul>
        ) : (
          <span>{t("orgSettings.serviceToken.test.failedNoDetails")}</span>
        )}
        <span>{t("orgSettings.serviceToken.test.failedNext")}</span>
      </div>
      {viewRun}
    </Alert>
  )
}
