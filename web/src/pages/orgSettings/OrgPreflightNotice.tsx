import { Link } from "@tanstack/react-router"
import { useTranslation } from "react-i18next"
import { XCircle } from "lucide-react"

import useGetServiceTokenStatus from "@/hooks/useGetServiceTokenStatus"
import useGetOrgAudit from "@/hooks/useGetOrgAudit"
import useGetOrgPlanDetails from "@/hooks/useGetOrgPlanDetails"
import { CalloutDiv } from "@/lib/motionComponents"

// Teacher preflight banner shown when an org is opened. The service-token and
// policy checks live here (one org at a time) rather than on the org list,
// which would fan these reads out across every org. One aggregated banner names
// every failing category; the org settings page holds the per-item detail.
const OrgPreflightNotice = ({ org }: { org: string }) => {
  const { t } = useTranslation()
  const { data: tokenStatus, isPending: tokenPending } =
    useGetServiceTokenStatus(org)
  const { data: planDetails, isPending: planPending } =
    useGetOrgPlanDetails(org)
  const { data: audit, isLoading: auditLoading } = useGetOrgAudit(
    org,
    planDetails?.plan?.name,
  )

  // Stay invisible until every input settles. Use isLoading (not isPending) for
  // the audit: it's false for a disabled query, so an org whose plan can't be
  // read (GitHub omits it for non-owners) doesn't keep the banner suppressed.
  const checking = tokenPending || planPending || auditLoading

  if (checking) return null

  const tokenMissing = tokenStatus?.status === "missing"
  const policyFail = audit?.verdict === "fail"

  // Both categories are hard failures, so the banner is always an error; it
  // just names every failing one at once.
  const failing: string[] = []
  if (tokenMissing)
    failing.push(t("orgSettings.preflight.categoryServiceToken"))
  if (policyFail) failing.push(t("orgSettings.preflight.categoryOrgPolicy"))

  if (failing.length === 0) return null

  const categories = failing.join(", ")

  return (
    <CalloutDiv role="alert" className="alert alert-error alert-soft mb-6">
      <XCircle aria-hidden="true" className="size-5" />
      <div className="text-sm">
        <p className="font-semibold">{t("orgSettings.preflight.title")}</p>
        <p className="mt-0.5 text-base-content/70">
          {t("orgSettings.preflight.body", {
            count: failing.length,
            categories,
          })}{" "}
          {t("orgSettings.preflight.reviewFixOn")}{" "}
          <Link to="/$org/settings" params={{ org }} className="link">
            {t("orgSettings.preflight.settingsPageLink")}
          </Link>
          {t("orgSettings.preflight.reviewFixSuffix")}
        </p>
      </div>
    </CalloutDiv>
  )
}

export default OrgPreflightNotice
