// FEATURE: github-classroom-migration — removable once GitHub Classroom shuts
// down (see foundation50/classroom50#312). The Import-from-GitHub-Classroom
// wizard shell: an org-readiness gate then a Select -> Confirm -> Execute state
// machine. The write boundary sits between Confirm and Execute.

import { useState } from "react"
import { Link, useParams } from "@tanstack/react-router"
import { useTranslation } from "react-i18next"

import PageShell from "@/components/PageShell"
import PageHeader from "@/components/PageHeader"
import MissingParams from "@/components/MissingParams"
import { Alert, Button, Card, Spinner } from "@/components/ui"
import { useDocumentTitle } from "@/hooks/useDocumentTitle"
import { useOrgClassroom50Status } from "@/hooks/useOrgClassroom50Status"
import { githubOrgOAuthPolicyUrl } from "@/auth/constants"
import type { ClassroomWithOrg, MigrationPreflight } from "@/migration/types"
import { SelectSourceStep } from "./SelectSourceStep"
import { ConfirmStep } from "./ConfirmStep"
import { ExecuteStep } from "./ExecuteStep"

type Phase =
  | { name: "select" }
  | { name: "confirm"; source: ClassroomWithOrg }
  | { name: "execute"; plan: MigrationPreflight }

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

export const ImportClassroomPage = () => {
  const { t } = useTranslation()
  useDocumentTitle(t("migration.documentTitle"))
  const { org } = useParams({ strict: false })
  const status = useOrgClassroom50Status(org)
  const [phase, setPhase] = useState<Phase>({ name: "select" })

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
          {phase.name === "select" && (
            <SelectSourceStep
              onPick={(source) => setPhase({ name: "confirm", source })}
            />
          )}
          {phase.name === "confirm" && (
            <ConfirmStep
              source={phase.source}
              targetOrg={org}
              onBack={() => setPhase({ name: "select" })}
              onConfirm={(plan) => setPhase({ name: "execute", plan })}
            />
          )}
          {phase.name === "execute" && (
            <ExecuteStep plan={phase.plan} targetOrg={org} />
          )}
        </>
      )}
    </PageShell>
  )
}

export default ImportClassroomPage
