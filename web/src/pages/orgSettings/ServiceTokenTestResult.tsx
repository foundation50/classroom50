import { Link } from "@tanstack/react-router"
import { Trans, useTranslation } from "react-i18next"

import { Alert, Button, cx } from "@/components/ui"
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
  const { phase, failure, run, error, annotations } = state
  if (phase === "idle" || phase === "dispatching" || phase === "running") {
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

  if (phase === "completed") {
    return (
      <Alert tone="success" className={cx("text-sm", className)}>
        <span>{t("orgSettings.serviceToken.test.passed")}</span>
        {viewRun}
      </Alert>
    )
  }

  if (phase === "timeout") {
    return (
      <Alert tone="warning" className={cx("text-sm", className)}>
        <span>{t("orgSettings.serviceToken.test.timeout")}</span>
        {viewRun}
      </Alert>
    )
  }

  // phase === "failed"
  if (failure === "dispatch") {
    if (error instanceof ProbeWorkflowMissingError) {
      return (
        <Alert tone="warning" className={cx("text-sm", className)}>
          <span>
            <Trans
              i18nKey="orgSettings.serviceToken.test.workflowMissing"
              components={{
                updateLink: (
                  <Link className="link" to="." hash={RERUN_ORG_SETUP_ANCHOR} />
                ),
              }}
            />
          </span>
        </Alert>
      )
    }
    return (
      <Alert tone="error" className={cx("text-sm", className)}>
        {t("orgSettings.serviceToken.test.startFailed", {
          reason: errorText(t, error),
        })}
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
            {details.map((message) => (
              <li key={message}>{message}</li>
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
