// FEATURE: github-classroom-migration — removable once GitHub Classroom shuts
// down (see foundation50/classroom50#312). The Import-from-GitHub-Classroom
// wizard shell: an org-readiness gate then a Select -> Review-and-import state
// machine. The review step runs the import in place after confirmation.

import { useState } from "react"
import {
  Link,
  getRouteApi,
  useNavigate,
  useParams,
} from "@tanstack/react-router"
import { useTranslation } from "react-i18next"
import { Check } from "lucide-react"

import PageShell from "@/components/PageShell"
import PageHeader from "@/components/PageHeader"
import MissingParams from "@/components/MissingParams"
import { Alert, Button, Card, Spinner, cx } from "@/components/ui"
import { useDocumentTitle } from "@/hooks/useDocumentTitle"
import { useOrgClassroom50Status } from "@/hooks/useOrgClassroom50Status"
import { githubOrgOAuthPolicyUrl } from "@/auth/constants"
import type { ClassroomWithOrg } from "@/migration/types"
import { SelectSourceStep } from "./SelectSourceStep"
import { ConfirmStep } from "./ConfirmStep"

type Phase = { name: "select" } | { name: "confirm"; source: ClassroomWithOrg }

const STEP_ORDER = ["select", "confirm", "execute"] as const
type StepName = (typeof STEP_ORDER)[number]

// A lightweight 3-step progress header (Choose -> Review -> Import) so the
// multi-phase wizard reads clearly. Mirrors the app's step-indicator styling.
// `complete` marks the CURRENT step done too (e.g. after the import finishes).
const MigrationSteps = ({
  current,
  complete = false,
}: {
  current: StepName
  complete?: boolean
}) => {
  const { t } = useTranslation()
  const currentIndex = STEP_ORDER.indexOf(current)
  return (
    <ol className="flex flex-wrap items-center gap-x-2 gap-y-1 text-sm">
      {STEP_ORDER.map((step, i) => {
        const done = i < currentIndex || (i === currentIndex && complete)
        const active = i === currentIndex && !complete
        return (
          <li key={step} className="flex items-center gap-2">
            <span
              className={cx(
                "flex size-6 items-center justify-center rounded-full text-xs font-semibold",
                done && "bg-primary text-primary-content",
                active && "bg-primary/15 text-primary ring-2 ring-primary/30",
                !done && !active && "bg-base-300 text-base-content/50",
              )}
            >
              {done ? <Check aria-hidden="true" className="size-3.5" /> : i + 1}
            </span>
            <span
              className={cx(
                active
                  ? "font-medium text-base-content"
                  : "text-base-content/60",
              )}
            >
              {t(`migration.steps.${step}`)}
            </span>
            {i < STEP_ORDER.length - 1 && (
              <span
                aria-hidden="true"
                className="mx-1 hidden h-px w-8 bg-base-300 sm:block"
              />
            )}
          </li>
        )
      })}
    </ol>
  )
}

const OrgSetupGate = ({ org }: { org: string }) => {
  const { t } = useTranslation()
  return (
    <Card>
      <Card.Body className="items-start">
        <Card.Title>{t("migration.gate.title")}</Card.Title>
        <p className="text-base-content/70">
          {t("migration.gate.body", { org })}
        </p>
        <Card.Actions className="mt-4">
          <Link to="/$org/setup" params={{ org }} className="btn btn-primary">
            {t("migration.gate.setupButton")}
          </Link>
        </Card.Actions>
      </Card.Body>
    </Card>
  )
}

const routeApi = getRouteApi("/_authed/$org/import/")

export const ImportClassroomPage = () => {
  const { t } = useTranslation()
  useDocumentTitle(t("migration.documentTitle"))
  const { org } = useParams({ strict: false })
  const { from } = routeApi.useSearch()
  const navigate = useNavigate()
  const status = useOrgClassroom50Status(org)
  const [phase, setPhase] = useState<Phase>({ name: "select" })
  // Set once the import reports success, so the final step gets a check.
  const [imported, setImported] = useState(false)

  // Keep the `?from=<org-slug>` deep link in sync with the selected source, so
  // the URL is shareable/refreshable and reflects the current step.
  const setFrom = (orgLogin: string | undefined) => {
    void navigate({
      to: "/$org/import",
      params: { org: org ?? "" },
      search: orgLogin ? { from: orgLogin } : {},
      replace: true,
    })
  }

  if (!org) {
    return <MissingParams message={t("migration.missingOrg")} />
  }

  return (
    <PageShell page="import" selected="assignments">
      <PageHeader
        title={t("migration.title")}
        subtitle={<p className="max-w-2xl">{t("migration.subtitle")}</p>}
      />

      {status.isLoading && (
        <div className="flex items-center gap-2 text-base-content/70">
          <Spinner size="sm" />
          {t("migration.gate.checking")}
        </div>
      )}

      {status.data === "missing" && <OrgSetupGate org={org} />}

      {status.isError && (
        <Alert tone="error" className="items-start">
          <span className="text-sm">{t("migration.gate.checkError")}</span>
          <Button variant="ghost" size="sm" onClick={() => status.refetch()}>
            {t("migration.select.retry")}
          </Button>
          <a
            href={githubOrgOAuthPolicyUrl(org)}
            target="_blank"
            rel="noreferrer"
            className="link text-sm"
          >
            {t("migration.gate.checkOrgAccess")}
          </a>
        </Alert>
      )}

      {status.data === "ready" && (
        <>
          <MigrationSteps
            current={imported ? "execute" : phase.name}
            complete={imported}
          />
          {phase.name === "select" && (
            <SelectSourceStep
              preselectOrg={from}
              onPick={(source) => {
                setFrom(source.orgLogin)
                setPhase({ name: "confirm", source })
              }}
            />
          )}
          {phase.name === "confirm" && (
            <ConfirmStep
              source={phase.source}
              targetOrg={org}
              onBack={() => {
                setFrom(undefined)
                setPhase({ name: "select" })
              }}
              onComplete={() => setImported(true)}
            />
          )}
        </>
      )}
    </PageShell>
  )
}

export default ImportClassroomPage
