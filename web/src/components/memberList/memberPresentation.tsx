import { MarkGithubIcon } from "@/components/ui/icons"
import { Trans, useTranslation } from "react-i18next"

import { MonoLtr } from "@/components/ui"
import type { MemberListRow } from "@/util/memberRow"
import { firstGrapheme } from "@/util/students"

// View-agnostic member presentation primitives shared by member lists and detail
// modals (Org Members + classroom roster). They target the adapter type
// MemberListRow so both feature surfaces feed adapted rows. These live in
// components/ (not a feature page) because a shared component — MemberDetailHeader
// — needs them; the org-specific helpers (ClassificationBadge, runInviteMember)
// stay in pages/orgMembers.

// Primer-style placeholder for a cell with nothing to report (an enrolled
// member's Status, a section-less row), so an empty cell reads as intentional.
export const CellPlaceholder = () => (
  <span aria-hidden="true" className="text-base-content/60">
    —
  </span>
)

// First initial of a row's best display string, for the avatar fallback.
export const initialsFor = (row: MemberListRow) =>
  firstGrapheme(row.name || row.username || row.email || "?").toUpperCase() ||
  "?"

// GitHub identity line: shows @username and the immutable numeric GitHub id to
// make clear these are GitHub members. Single-sentence keys (not affix concat)
// so translators control the order of the username and the id note; the
// username stays LTR-isolated via MonoLtr inside RTL copy.
//
// `bare` renders the handle alone — no octocat mark, no numeric id — for
// surfaces with a dedicated Username column (the roster table) where the full
// treatment repeats what the column header already says.
export const GitHubIdentity = ({
  row,
  bare = false,
}: {
  row: MemberListRow
  bare?: boolean
}) => {
  const { t } = useTranslation()
  const withId = !bare && Boolean(row.github_id)
  const identity = row.username ? (
    withId ? (
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
  ) : withId ? (
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
  if (bare) {
    return <span className="text-sm text-base-content/70">{identity}</span>
  }
  return (
    <span className="inline-flex items-center gap-1.5 text-xs text-base-content/70">
      <MarkGithubIcon aria-hidden="true" className="size-4 opacity-50" />
      {identity}
    </span>
  )
}
