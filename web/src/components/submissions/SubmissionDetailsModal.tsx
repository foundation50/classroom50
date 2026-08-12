import { useEffect, useId, useRef } from "react"
import { useTranslation } from "react-i18next"
import { GitCommitHorizontal, Tag } from "lucide-react"

import GitHub from "@/assets/github.svg?react"
import { Button, Modal, MonoLtr } from "@/components/ui"

// One row in the submission-details list. `kind` picks the icon and action
// label ("View tag" vs "View commit"); `href` is the already-built, safe GitHub
// link (omit to render the row inert). `sublabel` is a secondary line such as
// the submission time; `releaseHref` adds a "View grade" link. `count` is how
// many submissions the row represents (1 for a single tag/commit; N for a glob
// group that bundles N tags into one row), so the modal header count matches
// the row's count chip even when a group renders as one row.
export type SubmissionDetailItem = {
  key: string
  kind: "tag" | "commit"
  label: string
  sublabel?: string
  href?: string
  releaseHref?: string
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
  const titleId = useId()
  const { t } = useTranslation()

  useEffect(() => {
    dialogRef.current?.showModal()
  }, [])

  return (
    <Modal
      dialogRef={dialogRef}
      onClose={onClose}
      size="lg"
      aria-labelledby={titleId}
    >
      <h3 id={titleId} className="truncate pe-8 text-lg font-bold">
        {title}
      </h3>
      {subtitle ? (
        <p className="mt-0.5 truncate text-sm text-base-content/60">
          {subtitle}
        </p>
      ) : null}
      {repoHref ? (
        <a
          className="link link-hover mt-2 inline-flex w-fit max-w-full items-center gap-1.5"
          href={repoHref}
          target="_blank"
          rel="noreferrer"
          title={t("submissions.details.viewRepository")}
        >
          <GitHub aria-hidden="true" className="size-4 shrink-0" />
          <MonoLtr className="truncate text-sm">{repo}</MonoLtr>
        </a>
      ) : (
        <p className="mt-2 inline-flex w-fit max-w-full items-center gap-1.5 text-base-content/50">
          <GitHub aria-hidden="true" className="size-4 shrink-0" />
          <MonoLtr className="truncate text-sm">{repo}</MonoLtr>
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
              <GitHub aria-hidden="true" className="size-4" />
              {emptyLinkLabel}
            </Button>
          ) : null}
        </div>
      ) : (
        <ul className="mt-2 flex flex-col gap-2">
          {items.map((item) => {
            const Icon = item.kind === "tag" ? Tag : GitCommitHorizontal
            const actionLabel =
              item.kind === "tag"
                ? t("submissions.details.viewTag")
                : t("submissions.details.viewCommit")
            return (
              <li
                key={item.key}
                className="flex items-center gap-3 rounded-box border border-base-content/5 bg-base-100 px-3 py-2 text-sm"
              >
                <Icon
                  aria-hidden="true"
                  className="size-4 shrink-0 text-base-content/70"
                />
                <span className="flex min-w-0 flex-col">
                  <MonoLtr className="truncate font-medium">
                    {item.label}
                  </MonoLtr>
                  {item.sublabel ? (
                    <span className="truncate text-xs text-base-content/60">
                      {item.sublabel}
                    </span>
                  ) : null}
                </span>
                {item.href ? (
                  <a
                    className="link link-hover ms-auto inline-flex shrink-0 items-center gap-1"
                    href={item.href}
                    target="_blank"
                    rel="noreferrer"
                  >
                    {actionLabel}
                  </a>
                ) : (
                  <span className="ms-auto shrink-0 text-base-content/50">
                    {t("submissions.details.unavailable")}
                  </span>
                )}
                {item.releaseHref ? (
                  <a
                    className="link link-hover inline-flex shrink-0 items-center gap-1 text-base-content/70 before:me-1 before:text-base-content/30 before:content-['·']"
                    href={item.releaseHref}
                    target="_blank"
                    rel="noreferrer"
                  >
                    {t("submissions.details.viewGrade")}
                  </a>
                ) : null}
              </li>
            )
          })}
        </ul>
      )}
    </Modal>
  )
}

export default SubmissionDetailsModal
