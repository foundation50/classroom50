import { useEffect, useState } from "react"
import { useTranslation } from "react-i18next"

import { Alert, Badge, Button, Card } from "@/components/ui"
import type { BadgeTone } from "@/types/badgeTone"
import { useDocumentTitle } from "@/hooks/useDocumentTitle"

// Public /accessibility page: the human-readable rendering of the WCAG 2.2
// contrast audit. Fetches the build-emitted contrast-audit.json (the source of
// truth, always current with the shipped palette) and renders it as themed
// tables; the .md download links the sibling artifact. No auth — an ADA/VPAT
// reviewer can open it directly.

type ContrastStatus = "pass" | "margin" | "fail" | "exempt"

type Row = {
  id: string
  label: string
  size: "body" | "large"
  kind: "text" | "nonText"
  ratio: number
  floor: number
  margin: number
  status: ContrastStatus
}

type AuditTheme = { theme: string; label: string; rows: Row[] }

type Audit = {
  schema: string
  standard: string
  generated: string
  thresholds: { body: number; large: number; nonText: number }
  margins: { body: number; large: number; nonText: number }
  summary: {
    total: number
    failures: number
    marginMisses: number
    allPass: boolean
  }
  themes: AuditTheme[]
}

const STATUS_TONE: Record<ContrastStatus, BadgeTone> = {
  pass: "success",
  margin: "warning",
  fail: "error",
  exempt: "neutral",
}

function StatusBadge({ status }: { status: ContrastStatus }) {
  const { t } = useTranslation()
  return (
    <Badge tone={STATUS_TONE[status]}>
      {t(`accessibility.status.${status}`)}
    </Badge>
  )
}

function ThemeTable({ theme }: { theme: AuditTheme }) {
  const { t } = useTranslation()
  return (
    <Card radius="xl" shadow={false}>
      <Card.Body className="gap-3 p-4">
        <h2 className="text-lg font-bold">{theme.label}</h2>
        <div className="overflow-x-auto">
          <table className="table table-sm">
            <thead>
              <tr>
                <th>{t("accessibility.col.pair")}</th>
                <th>{t("accessibility.col.description")}</th>
                <th>{t("accessibility.col.size")}</th>
                <th className="text-end">{t("accessibility.col.ratio")}</th>
                <th className="text-end">{t("accessibility.col.floor")}</th>
                <th>{t("accessibility.col.status")}</th>
              </tr>
            </thead>
            <tbody>
              {theme.rows.map((r) => (
                <tr key={r.id}>
                  <td className="font-mono text-xs">{r.id}</td>
                  <td>{r.label}</td>
                  <td className="text-xs text-base-content/70">{r.size}</td>
                  <td className="text-end font-mono tabular-nums">
                    {r.ratio.toFixed(2)}:1
                  </td>
                  <td className="text-end font-mono tabular-nums text-base-content/70">
                    {r.floor}:1
                  </td>
                  <td>
                    <StatusBadge status={r.status} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Card.Body>
    </Card>
  )
}

export default function AccessibilityPage() {
  const { t } = useTranslation()
  useDocumentTitle(t("accessibility.title"))
  const [audit, setAudit] = useState<Audit | null>(null)
  const [error, setError] = useState(false)

  useEffect(() => {
    let active = true
    fetch("/contrast-audit.json")
      .then((res) => {
        if (!res.ok) throw new Error(`HTTP ${res.status}`)
        return res.json() as Promise<Audit>
      })
      .then((data) => {
        if (active) setAudit(data)
      })
      .catch(() => {
        if (active) setError(true)
      })
    return () => {
      active = false
    }
  }, [])

  return (
    <div className="mx-auto flex max-w-4xl flex-col gap-6 p-6 2xl:px-8">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div className="min-w-0">
          <h1 className="text-2xl font-bold tracking-tight">
            {t("accessibility.title")}
          </h1>
          <div className="mt-1 text-sm text-base-content/70">
            {t("accessibility.subtitle")}
          </div>
        </div>
        <Button
          as="a"
          href="/CONTRAST-AUDIT.md"
          download
          variant="outline"
          size="sm"
        >
          {t("accessibility.download")}
        </Button>
      </div>

      {error && <Alert tone="error">{t("accessibility.loadError")}</Alert>}

      {!error && !audit && (
        <div className="skeleton skeleton-shimmer h-40 w-full rounded-box" />
      )}

      {audit && (
        <>
          <Alert tone={audit.summary.allPass ? "success" : "error"}>
            {audit.summary.allPass
              ? t("accessibility.summaryPass", {
                  total: audit.summary.total,
                  margin: audit.summary.marginMisses,
                })
              : t("accessibility.summaryFail", {
                  failures: audit.summary.failures,
                })}
          </Alert>

          <details className="collapse-arrow collapse rounded-box border border-base-300 bg-base-100">
            <summary className="collapse-title text-sm font-medium">
              {t("accessibility.criteria.toggle")}
            </summary>
            <div className="collapse-content text-sm text-base-content/70">
              <p>{t("accessibility.criteria.standardText")}</p>
              <ul className="mt-2 list-disc ps-5">
                <li>
                  {t("accessibility.criteria.bodyText", {
                    body: audit.thresholds.body,
                  })}
                </li>
                <li>
                  {t("accessibility.criteria.largeText", {
                    large: audit.thresholds.large,
                  })}
                </li>
                <li>
                  {t("accessibility.criteria.nonText", {
                    nonText: audit.thresholds.nonText,
                  })}
                </li>
              </ul>
              <p className="mt-2">
                {t("accessibility.criteria.generated", {
                  generated: audit.generated,
                })}
              </p>
            </div>
          </details>

          {audit.themes.map((theme) => (
            <ThemeTable key={theme.theme} theme={theme} />
          ))}

          <div className="flex flex-wrap gap-3 text-sm text-base-content/70">
            <span>
              <StatusBadge status="pass" /> {t("accessibility.legend.pass")}
            </span>
            <span>
              <StatusBadge status="margin" /> {t("accessibility.legend.margin")}
            </span>
            <span>
              <StatusBadge status="fail" /> {t("accessibility.legend.fail")}
            </span>
            <span>
              <StatusBadge status="exempt" /> {t("accessibility.legend.exempt")}
            </span>
          </div>
        </>
      )}
    </div>
  )
}
