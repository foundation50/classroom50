import { useId, useState } from "react"
import { useTranslation } from "react-i18next"
import { FileCheck2, Upload } from "lucide-react"

import {
  Alert,
  Button,
  FileDropzone,
  Modal,
  type PickedFile,
} from "@/components/ui"
import { useSafeSubmit } from "@/hooks/useSafeSubmit"
import { useToast } from "@/context/notifications/NotificationProvider"
import { useSubmitAssignment } from "@/hooks/mutations/useSubmitAssignment"
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
  onSubmitted,
}: {
  org: string
  repo: string
  assignment: string
  // Fired after a successful submit so the page can nudge the "grading runs in
  // the background" affordance.
  onSubmitted?: () => void
}) {
  const { t } = useTranslation()
  const { notify } = useToast()
  const run = useSafeSubmit()
  const mutation = useSubmitAssignment({ org, repo, assignment })

  const [open, setOpen] = useState(false)
  const [picked, setPicked] = useState<Picked[]>([])
  const titleId = useId()
  const submitting = mutation.isPending

  const addFiles = (files: PickedFile[]) => {
    setPicked((prev) => {
      const byPath = new Map(prev.map((p) => [p.path, p]))
      for (const { file, relativePath } of files) {
        let path: string
        try {
          path = normalizeRepoPath(relativePath)
        } catch {
          // An unsafe path (traversal) is dropped with a toast rather than
          // silently included.
          notify({
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
          notify({
            tone: "warning",
            message: t("submissions.student.upload.reservedPath", { path }),
          })
          continue
        }
        // Last pick of a path wins (re-uploading a file replaces the prior one).
        byPath.set(path, { path, file, key: `${path}:${file.lastModified}` })
      }
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
    setPicked([])
  }

  const submit = () =>
    run(async () => {
      await mutation.mutateAsync(
        picked.map(({ path, file }) => ({ path, file })),
      )
      setPicked([])
      setOpen(false)
      notify({
        tone: "success",
        durationMs: 6000,
        message: t("submissions.student.upload.success"),
      })
      onSubmitted?.()
    })

  const hasFiles = picked.length > 0

  return (
    <>
      <Button variant="primary" size="sm" onClick={() => setOpen(true)}>
        <Upload aria-hidden="true" className="size-4" />
        {t("submissions.student.upload.open")}
      </Button>

      <Modal
        open={open}
        onClose={closeModal}
        closeDisabled={submitting}
        size="2xl"
        aria-labelledby={titleId}
      >
        <div className="flex items-center gap-2">
          <FileCheck2 aria-hidden="true" className="size-5 text-primary" />
          <h3 id={titleId} className="text-lg font-bold">
            {t("submissions.student.upload.title")}
          </h3>
        </div>
        <p className="mt-1 text-sm text-base-content/70">
          {t("submissions.student.upload.intro")}
        </p>

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
              <div className="overflow-hidden rounded-box border border-base-200">
                <table className="table table-sm">
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
                            <span aria-hidden="true">✕</span>
                          </Button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>

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

          {mutation.isError && (
            <Alert tone="error">
              <div>
                {t("submissions.student.upload.error")}
                {mutation.error instanceof Error
                  ? ` ${mutation.error.message}`
                  : ""}
              </div>
            </Alert>
          )}
        </div>

        <div className="mt-6 flex flex-wrap items-center justify-end gap-2">
          <Button size="sm" disabled={submitting} onClick={closeModal}>
            {t("common.cancel")}
          </Button>
          <Button
            variant="primary"
            size="sm"
            loading={submitting}
            loadingLabel={t("submissions.student.upload.submitting")}
            disabled={submitting || !hasFiles}
            onClick={() => void submit()}
          >
            {!submitting && <Upload aria-hidden="true" className="size-4" />}
            {t("submissions.student.upload.confirmSubmit")}
          </Button>
        </div>
      </Modal>
    </>
  )
}

export default SubmitUpload
