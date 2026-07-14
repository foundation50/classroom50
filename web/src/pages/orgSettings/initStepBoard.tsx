import {
  AlertCircle,
  AlertTriangle,
  CheckCircle,
  ChevronDown,
  ChevronRight,
  ExternalLink,
} from "lucide-react"
import { useEffect, useRef, useState, type ReactNode } from "react"
import { useTranslation } from "react-i18next"

import type {
  InitStepId,
  InitStepStatus,
  InitStepUpdate,
} from "@/hooks/github/mutations"
import { UnenforcedDefaultsList } from "./UnenforcedDefaultsList"
import {
  isOrgDefaultsStepData,
  unenforcedDefaultItems,
} from "./orgDefaultsStepData"
import { Spinner } from "@/components/ui"
import { CONFIG_REPO } from "@/util/configRepo"

// Shared init "badge board" used by the org setup wizard (OrgSetupPage) and the
// re-run action on Org Settings. One source of truth for step order, titles,
// explanations, and rendering so the two surfaces can't drift.

export const INIT_STEP_ORDER: InitStepId[] = [
  "orgDefaults",
  "orgActions",
  "orgPrCreation",
  "configRepo",
  "skeleton",
  "branchProtection",
  "workflowPermissions",
  "reusableWorkflowAccess",
  "pages",
  "rulesets",
]

// Per-step explanation shared by the wizard and re-run surface. `what` = what we
// change, `why` = why Classroom 50 needs it, `remediation` = the teacher's next
// step on warn/error (paired with the GitHub deep link). The three text fields
// hold i18n keys (resolved with `t()` at render), so this map stays the single
// source of truth for which steps exist and where they deep-link.
type InitStepMeta = {
  what: string
  why: string
  remediation: string
  // GitHub settings page where the teacher inspects/fixes this step (org- or
  // config-repo-scoped). Null for steps with no single page (repo + file
  // creation), where remediation is "retry" rather than "go change X".
  settingsUrl: (org: string) => string | null
}

const orgSettingsBase = (org: string) =>
  `https://github.com/organizations/${org}/settings`
const repoSettingsBase = (org: string) =>
  `https://github.com/${org}/${CONFIG_REPO}/settings`

export const INIT_STEP_META: Record<InitStepId, InitStepMeta> = {
  orgDefaults: {
    what: "orgSettings.steps.orgDefaults.what",
    why: "orgSettings.steps.orgDefaults.why",
    remediation: "orgSettings.steps.orgDefaults.remediation",
    settingsUrl: (org) => `${orgSettingsBase(org)}/member_privileges`,
  },
  orgActions: {
    what: "orgSettings.steps.orgActions.what",
    why: "orgSettings.steps.orgActions.why",
    remediation: "orgSettings.steps.orgActions.remediation",
    settingsUrl: (org) => `${orgSettingsBase(org)}/actions`,
  },
  orgPrCreation: {
    what: "orgSettings.steps.orgPrCreation.what",
    why: "orgSettings.steps.orgPrCreation.why",
    remediation: "orgSettings.steps.orgPrCreation.remediation",
    settingsUrl: (org) => `${orgSettingsBase(org)}/actions`,
  },
  configRepo: {
    what: "orgSettings.steps.configRepo.what",
    why: "orgSettings.steps.configRepo.why",
    remediation: "orgSettings.steps.configRepo.remediation",
    settingsUrl: () => null,
  },
  skeleton: {
    what: "orgSettings.steps.skeleton.what",
    why: "orgSettings.steps.skeleton.why",
    remediation: "orgSettings.steps.skeleton.remediation",
    settingsUrl: () => null,
  },
  branchProtection: {
    what: "orgSettings.steps.branchProtection.what",
    why: "orgSettings.steps.branchProtection.why",
    remediation: "orgSettings.steps.branchProtection.remediation",
    settingsUrl: (org) => `${repoSettingsBase(org)}/branches`,
  },
  workflowPermissions: {
    what: "orgSettings.steps.workflowPermissions.what",
    why: "orgSettings.steps.workflowPermissions.why",
    remediation: "orgSettings.steps.workflowPermissions.remediation",
    settingsUrl: (org) => `${repoSettingsBase(org)}/actions`,
  },
  reusableWorkflowAccess: {
    what: "orgSettings.steps.reusableWorkflowAccess.what",
    why: "orgSettings.steps.reusableWorkflowAccess.why",
    remediation: "orgSettings.steps.reusableWorkflowAccess.remediation",
    settingsUrl: (org) => `${repoSettingsBase(org)}/actions`,
  },
  pages: {
    what: "orgSettings.steps.pages.what",
    why: "orgSettings.steps.pages.why",
    remediation: "orgSettings.steps.pages.remediation",
    settingsUrl: (org) => `${repoSettingsBase(org)}/pages`,
  },
  rulesets: {
    what: "orgSettings.steps.rulesets.what",
    why: "orgSettings.steps.rulesets.why",
    remediation: "orgSettings.steps.rulesets.remediation",
    settingsUrl: (org) => `${orgSettingsBase(org)}/rules`,
  },
}

export const initialInitSteps: Record<InitStepId, InitStepUpdate> = {
  orgDefaults: {
    id: "orgDefaults",
    status: "pending",
    title: "orgSettings.steps.orgDefaults.title",
  },
  orgActions: {
    id: "orgActions",
    status: "pending",
    title: "orgSettings.steps.orgActions.title",
  },
  orgPrCreation: {
    id: "orgPrCreation",
    status: "pending",
    title: "orgSettings.steps.orgPrCreation.title",
  },
  configRepo: {
    id: "configRepo",
    status: "pending",
    title: "orgSettings.steps.configRepo.title",
  },
  skeleton: {
    id: "skeleton",
    status: "pending",
    title: "orgSettings.steps.skeleton.title",
  },
  branchProtection: {
    id: "branchProtection",
    status: "pending",
    title: "orgSettings.steps.branchProtection.title",
  },
  workflowPermissions: {
    id: "workflowPermissions",
    status: "pending",
    title: "orgSettings.steps.workflowPermissions.title",
  },
  reusableWorkflowAccess: {
    id: "reusableWorkflowAccess",
    status: "pending",
    title: "orgSettings.steps.reusableWorkflowAccess.title",
  },
  pages: {
    id: "pages",
    status: "pending",
    title: "orgSettings.steps.pages.title",
  },
  rulesets: {
    id: "rulesets",
    status: "pending",
    title: "orgSettings.steps.rulesets.title",
  },
}

export function applyStepUpdate(
  steps: Record<InitStepId, InitStepUpdate>,
  update: InitStepUpdate,
): Record<InitStepId, InitStepUpdate> {
  return {
    ...steps,
    [update.id]: {
      ...steps[update.id],
      ...update,
    },
  }
}

const STATUS_BADGE_CLASS: Record<InitStepStatus, string> = {
  complete: "badge-success",
  warning: "badge-warning",
  error: "badge-error",
  pending: "badge-neutral badge-ghost",
  running: "badge-neutral badge-ghost",
  skipped: "badge-neutral badge-ghost",
}

const STATUS_ICON: Record<InitStepStatus, ReactNode> = {
  complete: <CheckCircle aria-hidden="true" className="size-4" />,
  warning: <AlertCircle aria-hidden="true" className="size-4" />,
  error: <AlertTriangle aria-hidden="true" className="size-4" />,
  running: <Spinner size="xs" className="size-4" />,
  pending: null,
  skipped: null,
}

export const InitStep = ({
  id,
  title,
  status,
  message,
  org,
  data,
}: {
  id: InitStepId
  title: string
  status: InitStepStatus
  message?: string
  // Without an org the per-step GitHub deep link can't be built, so it's
  // omitted; the explanation and remediation still render.
  org?: string
  // The step's structured result (InitStepUpdate.data); orgDefaults narrows it
  // to OrgDefaultsStepData before rendering.
  data?: unknown
}) => {
  const { t } = useTranslation()
  const meta = INIT_STEP_META[id]
  const needsAttention = status === "warning" || status === "error"
  // Auto-expand steps needing action so the teacher sees the fix without
  // hunting; the rest start collapsed. `open` is the single source of truth
  // (seeded from needsAttention, re-opened on each transition into attention) so
  // the toggle can always collapse a panel — even a warning/error one.
  const [open, setOpen] = useState(needsAttention)
  const prevNeedsAttention = useRef(needsAttention)
  useEffect(() => {
    if (needsAttention && !prevNeedsAttention.current) setOpen(true)
    prevNeedsAttention.current = needsAttention
  }, [needsAttention])

  const settingsUrl = org ? meta.settingsUrl(org) : null

  return (
    <div className="rounded-xl border border-base-300 bg-base-100">
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setOpen((prev) => !prev)}
        className="flex w-full items-start justify-between gap-4 p-4 text-left"
      >
        <div className="flex min-w-0 items-start gap-2">
          {open ? (
            <ChevronDown
              aria-hidden="true"
              className="mt-0.5 size-4 shrink-0 text-base-content/70"
            />
          ) : (
            <ChevronRight
              aria-hidden="true"
              className="mt-0.5 size-4 shrink-0 text-base-content/70"
            />
          )}
          <div className="min-w-0">
            <div className="font-semibold">{t(title)}</div>
            <p className="mt-1 text-sm text-base-content/70">
              {message || t(meta.what)}
            </p>
          </div>
        </div>
        <span className={`badge shrink-0 ${STATUS_BADGE_CLASS[status]}`}>
          {STATUS_ICON[status]}
        </span>
      </button>

      {open && (
        <div className="border-t border-base-200 px-4 pb-4 pt-3 pl-10 text-sm">
          <p className="text-base-content/70">{t(meta.what)}</p>
          <p className="mt-1 text-base-content/70">
            <span className="font-medium text-base-content/70">
              {t("orgSettings.steps.whyLabel")}{" "}
            </span>
            {t(meta.why)}
          </p>

          {needsAttention && (
            <div
              className={`mt-3 rounded-lg border p-3 ${
                status === "error"
                  ? "border-error/30 bg-error/10"
                  : "border-warning/30 bg-warning/10"
              }`}
            >
              <p className="font-medium text-base-content/80">
                {status === "error"
                  ? t("orgSettings.steps.howToFix")
                  : t("orgSettings.steps.whatToDo")}
              </p>
              <p className="mt-1 text-base-content/70">{t(meta.remediation)}</p>
              {settingsUrl && (
                <a
                  href={settingsUrl}
                  target="_blank"
                  rel="noreferrer"
                  className="mt-2 inline-flex items-center gap-1 text-base-content/70 hover:text-primary"
                >
                  {t("orgSettings.steps.openGitHubSettings")}
                  <ExternalLink aria-hidden="true" className="size-3.5" />
                </a>
              )}
              {id === "orgDefaults" && isOrgDefaultsStepData(data) && (
                <UnenforcedDefaultsList items={unenforcedDefaultItems(data)} />
              )}
            </div>
          )}
        </div>
      )}
    </div>
  )
}

export const InitStepBoard = ({
  steps,
  org,
}: {
  steps: Record<InitStepId, InitStepUpdate>
  org?: string
}) => (
  <div className="grid gap-3">
    {INIT_STEP_ORDER.map((id) => {
      const step = steps[id]
      return (
        <InitStep
          key={step.id}
          id={step.id}
          title={step.title ?? step.id}
          status={step.status}
          message={step.message ?? step.error}
          org={org}
          data={step.data}
        />
      )
    })}
  </div>
)
