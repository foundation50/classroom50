import { useEffect, useRef } from "react"
import { useTranslation } from "react-i18next"
import {
  GitCommitIcon,
  MarkGithubIcon,
  PersonIcon,
  RepoIcon,
  TagIcon,
} from "@/components/ui/icons"

import { Button, Modal, MonoLtr, cx } from "@/components/ui"

// One row in the submission-details list. `kind` picks the icon and action
// label ("View tag" vs "View commit"); `href` is the already-built, safe GitHub
// link (omit to render the row inert). `sublabel` is a secondary line such as
// the submission time; `releaseHref` adds a "View grade" link. `author` names
// who made a commit (set only for a team's shared repo, where it disambiguates
// members); `avatarUrl` is an already-guarded URL. `count` is how many
// submissions the row represents (1 for a single tag/commit; N for a glob
// group that bundles N tags into one row), so the modal header count matches
// the row's count chip even when a group renders as one row.
export type SubmissionDetailItem = {
  key: string
  kind: "tag" | "commit"
  label: string
  sublabel?: string
  href?: string
  releaseHref?: string
  author?: { label: string; avatarUrl?: string }
  count: number
}

// The number of SUBMISSIONS a detail-item list represents: the sum of each
// item's `count`, so a glob group (one row, N tags) contributes N. Shared by
// the count chip and the modal header so they can't disagree on a group's total.
export function detailItemsCount(items: SubmissionDetailItem[]): number {
  return items.reduce((sum, item) => sum + item.count, 0)
}

// A type-aware, read-only modal listing an assignment's submissions for one
// repo. It is a pure presenter: the caller builds the items and the
// "no submissions" repo link (default branch for push mode, tags page for tag
// mode), so this component stays free of data fetching and works identically on
// the teacher table and the student page.
//
// Always openable — even with zero or one submission — so the count chip has a
// single, predictable behavior. Mounted only while open (caller gates + keys),
// so it opens once on mount; Esc/backdrop/X fire onClose.
export function SubmissionDetailsModal({
  onClose,
  title,
  subtitle,
  repo,
  repoHref,
  countLabel,
  items,
  emptyLabel,
  emptyLinkLabel,
  emptyLinkHref,
}: {
  onClose: () => void
  title: string
  subtitle?: string
  // The repo name shown under the title; linked when repoHref is set.
  repo: string
  repoHref?: string
  // The type-aware count line, e.g. "3 tagged submissions" / "3 pushes to the
  // default branch" (built by the caller from the mode + count).
  countLabel: string
  items: SubmissionDetailItem[]
  // Shown instead of the list when there are no submissions. The link points at
  // the default branch (push mode) or the tags page (tag mode).
  emptyLabel: string
  emptyLinkLabel: string
  emptyLinkHref?: string
}) {
  const dialogRef = useRef<HTMLDialogElement | null>(null)
  const { t } = useTranslation()

  useEffect(() => {
    dialogRef.current?.showModal()
  }, [])

  // Wide enough that a typical `<classroom>-<assignment>-<owner>` repo name and
  // a row's "View commit · View grade" actions fit on one line; a longer name
  // wraps rather than truncating, since the name is what identifies the repo.
  const repoClass = "mt-2 flex w-fit max-w-full items-start gap-1.5"
  const repoName = (
    <MonoLtr className="min-w-0 break-words text-sm">{repo}</MonoLtr>
  )
  // Optically aligns the 16px icon with the first 20px text line.
  const repoIcon = (
    <RepoIcon aria-hidden="true" className="mt-0.5 size-4 shrink-0" />
  )

  return (
    <Modal
      dialogRef={dialogRef}
      onClose={onClose}
      size="xl"
      title={<span className="block truncate">{title}</span>}
      subtitle={
        subtitle ? (
          <span className="block truncate text-base-content/60">
            {subtitle}
          </span>
        ) : undefined
      }
    >
      {repoHref ? (
        <a
          className={cx("link link-hover", repoClass)}
          href={repoHref}
          target="_blank"
          rel="noreferrer"
          title={t("submissions.details.viewRepository")}
        >
          {repoIcon}
          {repoName}
        </a>
      ) : (
        <p className={cx(repoClass, "text-base-content/50")}>
          {repoIcon}
          {repoName}
        </p>
      )}

      <p className="mt-4 text-sm font-medium text-base-content/70">
        {countLabel}
      </p>

      {items.length === 0 ? (
        <div className="mt-2 rounded-box border border-base-content/10 bg-base-200/40 p-4">
          <p className="text-sm text-base-content/70">{emptyLabel}</p>
          {emptyLinkHref ? (
            <Button
              as="a"
              variant="outline"
              size="sm"
              href={emptyLinkHref}
              target="_blank"
              rel="noreferrer"
              className="mt-3 w-fit"
            >
              <MarkGithubIcon aria-hidden="true" className="size-4" />
              {emptyLinkLabel}
            </Button>
          ) : null}
        </div>
      ) : (
        <ul className="mt-2 flex flex-col gap-2">
          {items.map((item) => {
            const Icon = item.kind === "tag" ? TagIcon : GitCommitIcon
            const actionLabel =
              item.kind === "tag"
                ? t("submissions.details.viewTag")
                : t("submissions.details.viewCommit")
            return (
              <li
                key={item.key}
                // The label block keeps a readable minimum, so on a narrow
                // screen the actions wrap below it instead of squeezing the
                // author and date down to ellipses.
                className="flex flex-wrap items-center gap-x-3 gap-y-1 rounded-box border border-base-300 bg-base-100 px-3 py-2 text-sm"
              >
                <Icon
                  aria-hidden="true"
                  className="size-4 shrink-0 text-base-content/70"
                />
                <span className="flex min-w-[10rem] flex-1 flex-col">
                  <MonoLtr className="truncate font-medium">
                    {item.label}
                  </MonoLtr>
                  {item.author || item.sublabel ? (
                    <span className="flex min-w-0 items-center gap-x-1.5 text-xs text-base-content/60">
                      {item.author ? (
                        <span
                          className="inline-flex min-w-0 items-center gap-1"
                          title={t("submissions.details.commitBy", {
                            author: item.author.label,
                          })}
                        >
                          {item.author.avatarUrl ? (
                            <img
                              src={item.author.avatarUrl}
                              alt=""
                              className="size-4 shrink-0 rounded-full"
                            />
                          ) : (
                            <PersonIcon
                              aria-hidden="true"
                              className="size-3.5 shrink-0"
                            />
                          )}
                          <span className="sr-only">
                            {t("submissions.details.commitBy", {
                              author: item.author.label,
                            })}
                          </span>
                          <span aria-hidden="true" className="truncate">
                            {item.author.label}
                          </span>
                        </span>
                      ) : null}
                      {item.sublabel ? (
                        <span
                          className={
                            item.author
                              ? "truncate before:me-1.5 before:text-base-content/30 before:content-['·']"
                              : "truncate"
                          }
                        >
                          {item.sublabel}
                        </span>
                      ) : null}
                    </span>
                  ) : null}
                </span>
                <span className="ms-auto flex shrink-0 items-center">
                  {item.href ? (
                    <a
                      className="link link-hover inline-flex items-center gap-1"
                      href={item.href}
                      target="_blank"
                      rel="noreferrer"
                    >
                      {actionLabel}
                    </a>
                  ) : (
                    <span className="text-base-content/50">
                      {t("submissions.details.unavailable")}
                    </span>
                  )}
                  {item.releaseHref ? (
                    <a
                      className="link link-hover ms-3 inline-flex items-center gap-1 text-base-content/70 before:me-1 before:text-base-content/30 before:content-['·']"
                      href={item.releaseHref}
                      target="_blank"
                      rel="noreferrer"
                    >
                      {t("submissions.details.viewGrade")}
                    </a>
                  ) : null}
                </span>
              </li>
            )
          })}
        </ul>
      )}
    </Modal>
  )
}

export default SubmissionDetailsModal
