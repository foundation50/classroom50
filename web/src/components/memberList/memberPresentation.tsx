import { Trans, useTranslation } from "react-i18next"

import GitHub from "@/assets/github.svg?react"
import { MonoLtr } from "@/components/ui"
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
// make clear these are GitHub members. Single-sentence keys (not affix concat)
// so translators control the order of the username and the id note; the
// username stays LTR-isolated via MonoLtr inside RTL copy.
export const GitHubIdentity = ({ row }: { row: MemberListRow }) => {
  const { t } = useTranslation()
  const identity = row.username ? (
    row.github_id ? (
      <Trans
        i18nKey="orgMembers.usernameWithId"
        values={{ username: row.username, id: row.github_id }}
        components={{
          username: <MonoLtr />,
          meta: <span className="text-base-content/70" />,
        }}
      />
    ) : (
      <MonoLtr>@{row.username}</MonoLtr>
    )
  ) : row.github_id ? (
    <Trans
      i18nKey="orgMembers.noUsernameWithId"
      values={{ id: row.github_id }}
      components={{
        missing: <span className="italic" />,
        meta: <span className="text-base-content/70" />,
      }}
    />
  ) : (
    <span className="italic">{t("orgMembers.noGitHubUsername")}</span>
  )
  return (
    <span className="inline-flex items-center gap-1.5 text-xs text-base-content/70">
      <GitHub aria-hidden="true" className="size-3.5 opacity-50" />
      {identity}
    </span>
  )
}
