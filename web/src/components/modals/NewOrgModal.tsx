import { useNavigate } from "@tanstack/react-router"
import { ExternalLink, RefreshCw } from "lucide-react"
import { useId, useState } from "react"
import { useTranslation } from "react-i18next"

import PlanBadge from "@/components/PlanBadge"
import MissingOrgNotice from "@/components/MissingOrgNotice"
import FreePlanInfoModal from "@/components/modals/FreePlanInfoModal"
import { Badge, Button, Modal, Spinner, cx } from "@/components/ui"
import type { Classroom50OrgSummary } from "@/github-core/queries"
import useNeedsSetupPlans from "@/hooks/useNeedsSetupPlans"
import useScrollFade from "@/hooks/useScrollFade"
import { classifyPlan } from "@/lib/orgPlan"

// The pickable orgs plus the control that reloads them. Mounted only while the
// modal is open, so the "which orgs did we start with" snapshot resets on every
// open: GitHub exposes no grant timestamp, so an org that shows up mid-session
// (the notice's auto-refresh after a grant) is the closest thing to
// "just granted" — those sort first and carry a New badge.
function OrgPicker({
  needsSetupOrgs,
  refreshing,
  onRefresh,
  onSelect,
  onFreePlan,
}: {
  needsSetupOrgs: Classroom50OrgSummary[]
  refreshing: boolean
  onRefresh: () => void
  onSelect: (login: string) => void
  onFreePlan: (login: string) => void
}) {
  const { t } = useTranslation()
  const listRef = useScrollFade<HTMLUListElement>()
  const logins = needsSetupOrgs.map((summary) => summary.org.login)
  const { byLogin: plans, pending: pendingPlans } = useNeedsSetupPlans(logins)
  const [seenOnOpen] = useState(() => new Set(logins))

  // An empty snapshot has nothing to contrast against (the list hadn't loaded),
  // so wait for a baseline rather than flagging every org as new.
  const newLogins = new Set(
    seenOnOpen.size === 0
      ? []
      : logins.filter((login) => !seenOnOpen.has(login)),
  )

  // Newly appeared first, then A-Z — GitHub returns memberships in no useful
  // order, and the home page already sorts by name. Not memoized: this list is
  // a handful of rows and feeds nothing but the render below.
  const sorted = [...needsSetupOrgs].sort(
    (a, b) =>
      Number(newLogins.has(b.org.login)) - Number(newLogins.has(a.org.login)) ||
      a.org.login.localeCompare(b.org.login),
  )

  return (
    <>
      <div className="mt-6 flex items-center justify-between gap-3">
        <p className="text-xs font-semibold uppercase tracking-wide text-base-content/60">
          {needsSetupOrgs.length > 0
            ? t("orgs.newOrg.pickPrompt", { count: needsSetupOrgs.length })
            : null}
        </p>
        <Button
          variant="outline"
          size="xs"
          disabled={refreshing}
          onClick={onRefresh}
        >
          {/* Spin the icon rather than Button's `loading` spinner: at btn-xs
              daisyUI's loading-xs outsizes this 14px icon. The adjacent label
              announces the busy state, so the icon stays aria-hidden. */}
          <RefreshCw
            aria-hidden="true"
            className={cx("size-3.5", refreshing && "animate-spin")}
          />
          {refreshing ? t("orgs.newOrg.refreshing") : t("orgs.newOrg.refresh")}
        </Button>
      </div>

      {needsSetupOrgs.length === 0 ? (
        <p className="mt-2 rounded-box border border-base-300 bg-base-200/50 p-4 text-sm text-base-content/70">
          {t("orgs.newOrg.allSetUp")}
        </p>
      ) : (
        <ul
          ref={listRef}
          className="scroll-fade-y mt-2 flex max-h-80 flex-col gap-2"
        >
          {sorted.map((summary) => {
            const { org } = summary
            const planName = plans[org.login]
            const planLoading = pendingPlans.has(org.login)
            const isFree = classifyPlan(planName) === "free"
            return (
              <li key={org.id}>
                <button
                  type="button"
                  disabled={planLoading}
                  onClick={() =>
                    isFree ? onFreePlan(org.login) : onSelect(org.login)
                  }
                  className="flex w-full items-center gap-3 rounded-xl border border-base-300 p-3 text-start transition-colors hover:bg-base-200 disabled:cursor-wait disabled:opacity-60 disabled:hover:bg-transparent"
                >
                  <img
                    src={org.avatar_url}
                    alt=""
                    className="size-9 shrink-0 rounded-lg border border-base-300"
                  />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate font-semibold">
                      {org.login}
                    </span>
                    {org.description && (
                      <span className="block truncate text-sm text-base-content/60">
                        {org.description}
                      </span>
                    )}
                  </span>
                  {newLogins.has(org.login) && (
                    <Badge tone="success" size="sm" className="shrink-0">
                      {t("orgs.newOrg.newBadge")}
                    </Badge>
                  )}
                  {planName && !isFree && (
                    <PlanBadge
                      name={planName}
                      title={t("orgs.card.planTitlePaid")}
                      className="shrink-0"
                    />
                  )}
                  {planLoading ? (
                    <Spinner size="sm" className="shrink-0" />
                  ) : isFree ? (
                    <>
                      <Badge tone="warning" size="sm" className="shrink-0">
                        {t("orgs.newOrg.notSupportedBadge")}
                      </Badge>
                      <span className="btn btn-outline btn-xs shrink-0">
                        {t("orgs.newOrg.details")}
                      </span>
                    </>
                  ) : (
                    <span className="btn btn-primary btn-xs shrink-0">
                      {t("orgs.newOrg.setUp")}
                    </span>
                  )}
                </button>
              </li>
            )
          })}
        </ul>
      )}
    </>
  )
}

// Modal that lets a teacher start Classroom 50 setup on an existing GitHub org.
// GitHub orgs can't be created client-side, so this lists the orgs the user
// already owns that lack a classroom50 config repo (needs_setup) and routes the
// chosen one into the existing /$org/setup wizard. Free-plan orgs can't complete
// setup, so their row opens an explainer (upgrade via GitHub Education) instead
// of routing into a dead-end wizard.
function NewOrgModal({
  open,
  needsSetupOrgs,
  refreshing,
  onRefresh,
  onClose,
}: {
  open: boolean
  needsSetupOrgs: Classroom50OrgSummary[]
  refreshing: boolean
  onRefresh: () => void
  onClose: () => void
}) {
  const { t } = useTranslation()
  const navigate = useNavigate()
  const titleId = useId()
  const [freePlanOrg, setFreePlanOrg] = useState<string | null>(null)

  const handleSelect = (login: string) => {
    onClose()
    void navigate({ to: "/$org/setup", params: { org: login } })
  }

  return (
    <>
      <Modal open={open} onClose={onClose} size="2xl" aria-labelledby={titleId}>
        <div className="flex items-start justify-between gap-4">
          <div className="min-w-0">
            <h3 id={titleId} className="text-lg font-bold">
              {t("orgs.newOrg.title")}
            </h3>
            <p className="mt-1 text-sm text-base-content/70">
              {t("orgs.newOrg.description")}
            </p>
          </div>
        </div>

        <div className="mt-6">
          <MissingOrgNotice
            onRefresh={onRefresh}
            // Nothing to set up means a missing grant is the likeliest answer,
            // so don't make the teacher find the disclosure first.
            defaultOpen={needsSetupOrgs.length === 0}
          />
        </div>

        {open && (
          <OrgPicker
            needsSetupOrgs={needsSetupOrgs}
            refreshing={refreshing}
            onRefresh={onRefresh}
            onSelect={handleSelect}
            onFreePlan={setFreePlanOrg}
          />
        )}

        <div className="modal-action">
          <Button
            as="a"
            href="https://github.com/organizations/new"
            target="_blank"
            rel="noreferrer"
            variant="ghost"
            size="sm"
          >
            {t("orgs.newOrg.createOnGitHub")}
            <ExternalLink aria-hidden="true" className="size-4" />
          </Button>
        </div>
      </Modal>

      <FreePlanInfoModal
        open={open && freePlanOrg !== null}
        orgLogin={freePlanOrg}
        onClose={() => setFreePlanOrg(null)}
      />
    </>
  )
}

export default NewOrgModal
