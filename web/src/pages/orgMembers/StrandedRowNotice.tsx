import { useTranslation } from "react-i18next"
import { Link } from "@tanstack/react-router"

import { ChevronRightIcon } from "@/components/ui/icons"
import { rtlFlip } from "@/components/ui"
import type { OrgMemberRow } from "@/util/orgMembers"

// The detail modal's panel for a roster row with no org membership the
// Members page can act on: a live invitation (resend/cancel), an unlinked
// address (re-invite/link/remove), or an account with no id on file. Those
// actions are per classroom and live on the roster row, so this says exactly
// what the state is and links to that row (the roster's `?q=` pre-fills its
// search) instead of telling the teacher to go find it.
const StrandedRowNotice = ({
  row,
  org,
  onNavigate,
}: {
  row: OrgMemberRow
  org: string
  onNavigate: () => void
}) => {
  const { t } = useTranslation()
  const who = row.username || row.email
  const failed = row.failed_invitation
  const message =
    row.classification === "invitation-pending"
      ? t(
          row.username
            ? "orgMembers.strandedPendingAccount"
            : "orgMembers.strandedPendingEmail",
          { who },
        )
      : row.classification === "unlinked"
        ? failed
          ? t(
              failed.kind === "expired"
                ? "orgMembers.strandedExpired"
                : "orgMembers.strandedFailed",
              { who, reason: failed.reason ?? "" },
            )
          : t("orgMembers.strandedUnlinked", { who })
        : t("orgMembers.strandedNoId", { who })

  // Active classrooms first: an archived roster can't take the action.
  const classrooms = [...row.classrooms].sort(
    (a, b) => Number(a.archived) - Number(b.archived),
  )

  return (
    <div className="flex flex-col gap-3 rounded-box border border-base-300 bg-base-200/50 p-4 text-sm">
      <p className="text-base-content/80">{message}</p>
      {classrooms.length > 0 ? (
        <ul className="divide-y divide-base-300 rounded-box border border-base-300 bg-base-100">
          {classrooms.map((access) => (
            <li key={access.classroom}>
              <Link
                to="/$org/$classroom/roster"
                params={{ org, classroom: access.classroom }}
                search={{ q: who }}
                onClick={onNavigate}
                className="group/row flex items-center justify-between gap-3 px-3 py-2 first:rounded-t-box last:rounded-b-box hover:bg-base-200"
              >
                <span>
                  {t("orgMembers.openInRoster", {
                    classroom: access.classroom,
                  })}
                  {access.archived ? (
                    <span className="ms-2 text-xs text-base-content/60">
                      {t("orgMembers.archivedParen")}
                    </span>
                  ) : null}
                </span>
                <ChevronRightIcon
                  aria-hidden="true"
                  className={`size-4 text-base-content/30 transition-transform duration-150 ltr:group-hover/row:translate-x-0.5 rtl:group-hover/row:-translate-x-0.5 group-hover/row:text-base-content/70 ${rtlFlip}`}
                />
              </Link>
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  )
}

export default StrandedRowNotice
