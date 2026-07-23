import { ExternalLink } from "lucide-react"
import { useId } from "react"
import { useTranslation } from "react-i18next"

import { Button, Modal } from "@/components/ui"
import GitHub from "@/assets/github.svg?react"
import useGetOrgPlanDetails from "@/hooks/useGetOrgPlanDetails"
import { isOwnerGitHubOrgRole } from "@/authz"
import type { Classroom50OrgSummary } from "@/github-core/queries"
import {
  githubOrgUrl,
  githubOrgPeopleUrl,
  githubOrgTeamsUrl,
  githubOrgSettingsUrl,
} from "@/util/orgUrl"

// A read-only summary of an org's basic info plus github.com deep-links, opened
// from the home-card kebab. Reuses the shared ["github","orgs",login] cache (via
// useGetOrgPlanDetails) for the display name + plan, so opening it costs no extra
// request once the card has resolved the name.
function OrgDetailsModal({
  summary,
  open,
  onClose,
}: {
  summary: Classroom50OrgSummary
  open: boolean
  onClose: () => void
}) {
  const { t } = useTranslation()
  const titleId = useId()
  const { org, membership } = summary
  const { data: details } = useGetOrgPlanDetails(open ? org.login : undefined)

  const displayName = details?.name ?? undefined
  const isOwner = isOwnerGitHubOrgRole(membership.role)

  const rows: { label: string; value: string }[] = [
    ...(displayName
      ? [{ label: t("orgs.detailsModal.displayName"), value: displayName }]
      : []),
    { label: t("orgs.detailsModal.slug"), value: org.login },
    { label: t("orgs.detailsModal.orgId"), value: String(org.id) },
    ...(details?.plan?.name
      ? [{ label: t("orgs.detailsModal.plan"), value: details.plan.name }]
      : []),
    {
      label: t("orgs.detailsModal.role"),
      value: isOwner
        ? t("orgs.detailsModal.roleAdmin")
        : t("orgs.detailsModal.roleMember"),
    },
  ]

  const links: { label: string; href: string }[] = [
    { label: t("orgs.detailsModal.linkProfile"), href: org.html_url },
    { label: t("orgs.detailsModal.linkRepos"), href: githubOrgUrl(org.login) },
    {
      label: t("orgs.detailsModal.linkTeams"),
      href: githubOrgTeamsUrl(org.login),
    },
    {
      label: t("orgs.detailsModal.linkPeople"),
      href: githubOrgPeopleUrl(org.login),
    },
    ...(isOwner
      ? [
          {
            label: t("orgs.detailsModal.linkSettings"),
            href: githubOrgSettingsUrl(org.login),
          },
        ]
      : []),
  ]

  return (
    <Modal open={open} onClose={onClose} size="lg" aria-labelledby={titleId}>
      <div className="flex items-center gap-3 pe-8">
        <img
          src={org.avatar_url}
          alt=""
          className="size-10 shrink-0 rounded-lg border border-base-300"
        />
        <div className="min-w-0">
          <h3 id={titleId} className="truncate text-lg font-bold">
            {displayName ?? org.login}
          </h3>
          <p className="truncate text-sm text-base-content/60">
            {t("orgs.detailsModal.title")}
          </p>
        </div>
      </div>

      {org.description && (
        <p className="mt-4 text-sm leading-6 text-base-content/80">
          {org.description}
        </p>
      )}

      <dl className="mt-4 grid grid-cols-1 gap-x-6 gap-y-3 sm:grid-cols-2">
        {rows.map((row) => (
          <div key={row.label}>
            <dt className="text-xs uppercase tracking-wide text-base-content/50">
              {row.label}
            </dt>
            <dd className="mt-0.5 break-words text-sm font-medium">
              {row.value}
            </dd>
          </div>
        ))}
      </dl>

      <div className="mt-6">
        <p className="text-xs uppercase tracking-wide text-base-content/50">
          {t("orgs.detailsModal.linksHeading")}
        </p>
        <div className="mt-2 flex flex-wrap gap-2">
          {links.map((link) => (
            <Button
              key={link.label}
              as="a"
              href={link.href}
              target="_blank"
              rel="noreferrer"
              variant="outline"
              size="sm"
            >
              <GitHub aria-hidden="true" className="size-4" />
              {link.label}
              <ExternalLink aria-hidden="true" className="size-3" />
            </Button>
          ))}
        </div>
      </div>

      <div className="modal-action">
        <Button variant="ghost" size="sm" onClick={onClose}>
          {t("orgs.detailsModal.close")}
        </Button>
      </div>
    </Modal>
  )
}

export default OrgDetailsModal
