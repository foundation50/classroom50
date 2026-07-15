import { useTranslation } from "react-i18next"

import GitHub from "@/assets/github.svg?react"
import type { MemberListRow } from "@/util/memberRow"

// View-agnostic member presentation primitives shared by member lists and detail
// modals (Org Members + classroom roster). They target the adapter type
// MemberListRow so both feature surfaces feed adapted rows. These live in
// components/ (not a feature page) because a shared component — MemberDetailHeader
// — needs them; the org-specific helpers (ClassificationBadge, runInviteMember)
// stay in pages/orgMembers.

// First initial of a row's best display string, for the avatar fallback.
export const initialsFor = (row: MemberListRow) =>
  (row.name || row.username || row.email || "?")[0]?.toUpperCase() ?? "?"

// GitHub identity line: shows @username and the immutable numeric GitHub id to
// make clear these are GitHub members.
export const GitHubIdentity = ({ row }: { row: MemberListRow }) => {
  const { t } = useTranslation()
  return (
    <span className="inline-flex items-center gap-1.5 text-xs text-base-content/70">
      <GitHub aria-hidden="true" className="size-3.5 opacity-50" />
      {row.username ? (
        <span className="font-mono">@{row.username}</span>
      ) : (
        <span className="italic">{t("orgMembers.noGitHubUsername")}</span>
      )}
      {row.github_id ? (
        <span className="text-base-content/70">
          {t("orgMembers.idSuffix", { id: row.github_id })}
        </span>
      ) : null}
    </span>
  )
}
