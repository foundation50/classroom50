import { useEffect, useId, useRef } from "react"
import { useTranslation } from "react-i18next"
import { ExternalLink } from "lucide-react"

import GitHub from "@/assets/github.svg?react"
import { Badge, Button, Modal } from "@/components/ui"
import type { Student } from "@/types/classroom"
import { getName, getInitials } from "@/util/students"

type ProfileRow = { label: string; value: React.ReactNode }

// Read-only student profile. Opened from a gradebook/roster avatar to surface
// details hidden in the dense row (GitHub handle, email, section) plus a link to
// the student's assignment repo when known.
export const StudentProfileModal = ({
  onClose,
  student,
  students,
  repoUrl,
  repoName,
}: {
  onClose: () => void
  student: Student
  students: Student[]
  repoUrl?: string
  repoName?: string
}) => {
  const dialogRef = useRef<HTMLDialogElement | null>(null)
  const titleId = useId()
  const { t } = useTranslation()

  // Mounted only while a profile is selected (caller gates + remounts via
  // `key`), so open once; ESC/backdrop/X fire onClose to clear the selection.
  useEffect(() => {
    dialogRef.current?.showModal()
  }, [])

  const name = getName(student.username, students) || student.username || "—"
  const initials =
    getInitials(student.username, students) ||
    student.username?.[0]?.toUpperCase() ||
    student.email?.[0]?.toUpperCase() ||
    "?"

  const rows: ProfileRow[] = [
    {
      label: t("components.modals.studentProfile.github"),
      value: student.username ? (
        <a
          className="link link-hover inline-flex items-center gap-1"
          href={`https://github.com/${student.username}`}
          target="_blank"
          rel="noreferrer"
        >
          <GitHub aria-hidden="true" className="size-4" />@{student.username}
        </a>
      ) : (
        <span className="text-base-content/70">
          {t("components.modals.studentProfile.notLinkedYet")}
        </span>
      ),
    },
    {
      label: t("components.modals.studentProfile.email"),
      value: student.email || "—",
    },
    {
      label: t("components.modals.studentProfile.section"),
      value: student.section?.trim() || "—",
    },
  ]

  return (
    <Modal
      dialogRef={dialogRef}
      onClose={onClose}
      size="md"
      aria-labelledby={titleId}
    >
      <div className="flex items-center gap-4">
        <div className="avatar avatar-placeholder">
          <div className="bg-base-200 text-primary rounded-full w-14">
            <span className="text-lg">{initials}</span>
          </div>
        </div>
        <div className="min-w-0">
          <h3 id={titleId} className="truncate text-lg font-bold">
            {name}
          </h3>
          {student.section?.trim() ? (
            <Badge ghost>{student.section.trim()}</Badge>
          ) : null}
        </div>
      </div>

      <dl className="mt-6 divide-y divide-base-200">
        {rows.map((row) => (
          <div
            key={row.label}
            className="flex items-center justify-between gap-4 py-2.5 text-sm"
          >
            <dt className="text-base-content/70">{row.label}</dt>
            <dd className="min-w-0 truncate text-right font-medium">
              {row.value}
            </dd>
          </div>
        ))}
      </dl>

      {repoUrl ? (
        <Button
          as="a"
          variant="outline"
          size="sm"
          className="mt-4 w-full"
          href={repoUrl}
          target="_blank"
          rel="noreferrer"
          title={repoName}
        >
          <GitHub aria-hidden="true" className="size-4" />{" "}
          {t("components.modals.studentProfile.openRepo")}
          <ExternalLink aria-hidden="true" className="size-3.5" />
        </Button>
      ) : null}
    </Modal>
  )
}

export default StudentProfileModal
