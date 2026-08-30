import { useState } from "react"
import { useTranslation } from "react-i18next"
import { FileCheckIcon, UploadIcon, XIcon } from "@/components/ui/icons"

import {
  Alert,
  Button,
  FileDropzone,
  InlineMessage,
  Modal,
  ModalIcon,
  TableShell,
  type PickedFile,
} from "@/components/ui"
import { useSafeSubmit } from "@/hooks/useSafeSubmit"
import { useToast } from "@/context/notifications/NotificationProvider"
import { useSubmitAssignment } from "@/hooks/mutations/useSubmitAssignment"
import type { SubmissionMode } from "@/types/classroom"
import { errorText } from "@/types/localizedMessage"
import {
  normalizeRepoPath,
  isReservedUploadPath,
  type UploadFile,
} from "@/domain/assignments"

// A picked file plus a stable key for the list (path can repeat across picks
// until dedup; the key disambiguates React rows).
type Picked = UploadFile & { key: string }

const formatBytes = (n: number): string => {
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`
  return `${(n / (1024 * 1024)).toFixed(1)} MB`
}

// Web upload submission: a button opens a modal where the student picks files
// and uploads them. Replace-all semantics (the confirm copy makes it explicit)
// with .github/** and .classroom50.yaml preserved by the domain layer.
export function SubmitUpload({
  org,
  repo,
  assignment,
  submissionMode,
  onSubmitted,
}: {
  org: string
  repo: string
  assignment: string
  // The assignment's submission_mode from assignments.json; "tag" makes the
  // upload also push the submit/* tag that triggers grading.
  submissionMode?: SubmissionMode
  // Fired after a successful submit so the page can nudge the "grading runs in
  // the background" affordance.
  onSubmitted?: () => void
}) {
  const { t } = useTranslation()
  const { notify } = useToast()
  const run = useSafeSubmit()
  const mutation = useSubmitAssignment({
    org,
    repo,
    assignment,
    submissionMode,
  })

  const [open, setOpen] = useState(false)
  const [picked, setPicked] = useState<Picked[]>([])
  const [noFilesError, setNoFilesError] = useState(false)
  // Files skipped by the last add (unsafe or reserved paths), surfaced inside
  // the open dialog rather than as page toasts. Replaced wholesale on each
  // add so the list always describes the most recent pick.
  const [skippedFiles, setSkippedFiles] = useState<
    { tone: "error" | "warning"; message: string }[]
  >([])
  const submitting = mutation.isPending

  const addFiles = (files: PickedFile[]) => {
    setNoFilesError(false)
    const skipped: { tone: "error" | "warning"; message: string }[] = []
    const accepted: Picked[] = []
    for (const { file, relativePath } of files) {
      let path: string
      try {
        path = normalizeRepoPath(relativePath)
      } catch {
        // An unsafe path (traversal) is dropped and reported rather than
        // silently included.
        skipped.push({
          tone: "error",
          message: t("submissions.student.upload.unsafePath", {
            name: relativePath,
          }),
        })
        continue
      }
      // Reject reserved control paths (.github/**, .classroom50.yaml): the
      // domain preserves the real ones, so an upload here would be ignored.
      if (isReservedUploadPath(path)) {
        skipped.push({
          tone: "warning",
          message: t("submissions.student.upload.reservedPath", { path }),
        })
        continue
      }
      accepted.push({ path, file, key: `${path}:${file.lastModified}` })
    }
    setSkippedFiles(skipped)
    setPicked((prev) => {
      const byPath = new Map(prev.map((p) => [p.path, p]))
      // Last pick of a path wins (re-uploading a file replaces the prior one).
      for (const p of accepted) byPath.set(p.path, p)
      return Array.from(byPath.values()).sort((a, b) =>
        a.path.localeCompare(b.path),
      )
    })
  }

  const removeAt = (key: string) =>
    setPicked((prev) => prev.filter((p) => p.key !== key))

  const clearAll = () => setPicked([])

  const closeModal = () => {
    if (submitting) return
    setOpen(false)
  }

  // Cleared on open, never at close — see the close-animation note in ui/Modal.
  const openModal = () => {
    setPicked([])
    setNoFilesError(false)
    setSkippedFiles([])
    setOpen(true)
  }

  const submit = () => {
    if (picked.length === 0) {
      // The button stays enabled (Primer); a no-files submit surfaces the
      // message instead of silently disabling.
      setNoFilesError(true)
      return
    }
    return run(async () => {
      await mutation.mutateAsync(
        picked.map(({ path, file }) => ({ path, file })),
      )
      setOpen(false)
      // Kept as a toast: the dialog is closing and grading continues in the
      // background, so the outcome isn't otherwise evident.
      notify({
        tone: "success",
        durationMs: 6000,
        message: t("submissions.student.upload.success"),
      })
      onSubmitted?.()
    })
  }

  const hasFiles = picked.length > 0

  return (
    <>
      <Button variant="primary" size="sm" onClick={openModal}>
        <UploadIcon aria-hidden="true" className="size-4" />
        {t("submissions.student.upload.open")}
      </Button>

      <Modal
        open={open}
        onClose={closeModal}
        closeDisabled={submitting}
        size="2xl"
        title={t("submissions.student.upload.title")}
        headerVisual={
          <ModalIcon>
            <FileCheckIcon aria-hidden="true" className="size-4" />
          </ModalIcon>
        }
        subtitle={t("submissions.student.upload.intro")}
        footer={
          <>
            <Button
              variant="ghost"
              size="sm"
              disabled={submitting}
              onClick={closeModal}
            >
              {t("common.cancel")}
            </Button>
            <Button
              variant="primary"
              size="sm"
              loading={submitting}
              loadingLabel={t("submissions.student.upload.submitting")}
              disabled={submitting}
              onClick={() => void submit()}
            >
              {!submitting && (
                <UploadIcon aria-hidden="true" className="size-4" />
              )}
              {t("submissions.student.upload.confirmSubmit")}
            </Button>
          </>
        }
      >
        <div className="mt-4 space-y-3">
          {hasFiles ? (
            <>
              <FileDropzone
                variant="compact"
                onFiles={addFiles}
                prompt=""
                hint={t("submissions.student.upload.addHint")}
                buttonLabel={t("submissions.student.upload.addFiles")}
                disabled={submitting}
              />

              <div className="flex items-center justify-between gap-2">
                <span className="text-sm text-base-content/70">
                  {t("submissions.student.upload.selectedCount", {
                    count: picked.length,
                  })}
                </span>
                <Button
                  variant="ghost"
                  size="sm"
                  disabled={submitting}
                  onClick={clearAll}
                >
                  {t("submissions.student.upload.clearAll")}
                </Button>
              </div>

              {/* Name / Size / Remove table (folder drops show their path). */}
              <TableShell animate={false} size="sm">
                <thead>
                  <tr>
                    <th>{t("submissions.student.upload.colName")}</th>
                    <th className="w-24">
                      {t("submissions.student.upload.colSize")}
                    </th>
                    <th className="w-10 text-end sr-only">
                      {t("submissions.student.upload.colRemove")}
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {picked.map((p) => (
                    <tr key={p.key}>
                      <td className="max-w-0">
                        <span className="block truncate font-mono">
                          {p.path}
                        </span>
                      </td>
                      <td className="whitespace-nowrap tabular-nums text-base-content/70">
                        {formatBytes(p.file.size)}
                      </td>
                      <td className="text-end">
                        <Button
                          variant="ghost"
                          size="sm"
                          shape="square"
                          aria-label={t("submissions.student.upload.remove", {
                            path: p.path,
                          })}
                          disabled={submitting}
                          onClick={() => removeAt(p.key)}
                        >
                          <XIcon aria-hidden="true" className="size-4" />
                        </Button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </TableShell>
              <Alert tone="warning">
                <div>
                  {t("submissions.student.upload.confirmBody", {
                    count: picked.length,
                  })}
                </div>
              </Alert>
            </>
          ) : (
            <FileDropzone
              onFiles={addFiles}
              prompt={t("submissions.student.upload.dropPrompt")}
              hint={t("submissions.student.upload.dropHint")}
              buttonLabel={t("submissions.student.upload.choose")}
              disabled={submitting}
            />
          )}

          {skippedFiles.length > 0 && (
            <div className="flex flex-col gap-1">
              {skippedFiles.map(({ tone, message }) => (
                // role="alert" so the insertion is announced — these replaced
                // toasts, and there is no focus move to carry the message.
                <InlineMessage key={message} tone={tone} role="alert">
                  {message}
                </InlineMessage>
              ))}
            </div>
          )}

          {noFilesError && (
            <InlineMessage tone="error">
              {t("submissions.student.upload.noFilesError")}
            </InlineMessage>
          )}

          {mutation.isError && (
            <Alert tone="error">
              <div>
                {t("submissions.student.upload.error")}
                {` ${errorText(t, mutation.error)}`}
              </div>
            </Alert>
          )}
        </div>
      </Modal>
    </>
  )
}

export default SubmitUpload
