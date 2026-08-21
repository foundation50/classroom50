import { useEffect, useId, useRef, useState } from "react"
import { useTranslation } from "react-i18next"
import { RefreshCw } from "lucide-react"

import { Alert, Button, Modal } from "@/components/ui"
import { Spinner } from "@/components/Spinner"
import useMigrateClassroomAssignments from "@/hooks/mutations/useMigrateClassroomAssignments"

type MigrateSubmissionTrackingModalProps = {
  open: boolean
  onClose: () => void
  org: string
  classroom: string
}

type Phase = "idle" | "working" | "complete" | "error"

// MIGRATION(v1.28): the schema-migration modal for pre-1.28 assignments.json
// files. Safe to remove in a future version once no legacy files remain.
// Greppable tag: MIGRATION(v1.28).
// Explicit, teacher-triggered migration of a classroom's assignments.json to
// the new submission-tracking semantics: one confirm writes an explicit
// submission_mode onto every legacy assignment, opting the submissions-page
// detection overlay in without changing any grade. Nothing runs until the
// teacher clicks Migrate. A content normalization within v1 — no schema
// version bump.
export function MigrateSubmissionTrackingModal({
  open,
  onClose,
  org,
  classroom,
}: MigrateSubmissionTrackingModalProps) {
  const titleId = useId()
  const { t } = useTranslation()
  const migrate = useMigrateClassroomAssignments(org, classroom)
  const runningRef = useRef(false)
  const mountedRef = useRef(true)
  useEffect(() => {
    mountedRef.current = true
    return () => {
      mountedRef.current = false
      runningRef.current = false
    }
  }, [])

  const [phase, setPhase] = useState<Phase>("idle")
  const [migratedCount, setMigratedCount] = useState(0)

  useEffect(() => {
    if (!open) {
      runningRef.current = false
      setPhase("idle")
      setMigratedCount(0)
    }
  }, [open])

  const run = async () => {
    if (runningRef.current) return
    runningRef.current = true
    setPhase("working")
    try {
      const result = await migrate.mutateAsync({ org, classroom })
      if (mountedRef.current) {
        setMigratedCount(result.migratedCount)
        setPhase("complete")
      }
    } catch {
      if (mountedRef.current) setPhase("error")
    } finally {
      runningRef.current = false
    }
  }

  const busy = phase === "working"

  return (
    <Modal
      open={open}
      onClose={onClose}
      closeDisabled={busy}
      size="lg"
      aria-labelledby={titleId}
    >
      <div className="flex items-start gap-4">
        <div className="flex size-11 shrink-0 items-center justify-center rounded-2xl bg-primary/10 text-primary">
          <RefreshCw className="size-5" aria-hidden="true" />
        </div>
        <div className="min-w-0 flex-1">
          <h3 id={titleId} className="text-lg font-bold">
            {t("submissions.migrateTracking.title")}
          </h3>
          <p className="mt-1 text-sm text-base-content/70">
            {t("submissions.migrateTracking.subtitle")}
          </p>
        </div>
      </div>

      {phase === "idle" && (
        <div className="mt-4 flex flex-col gap-4">
          <Alert tone="info" className="text-sm">
            {t("submissions.migrateTracking.warning")}
          </Alert>
        </div>
      )}

      {busy && (
        <div className="mt-6 flex flex-col items-center gap-3 py-6">
          <Spinner label={t("submissions.migrateTracking.working")} />
        </div>
      )}

      {phase === "error" && (
        <div className="mt-4">
          <Alert tone="error" className="text-sm">
            {t("submissions.migrateTracking.error")}
          </Alert>
        </div>
      )}

      {phase === "complete" && (
        <div className="mt-4">
          <Alert tone="success" className="text-sm">
            {t("submissions.migrateTracking.resultHeadline", {
              count: migratedCount,
            })}
          </Alert>
        </div>
      )}

      <div className="modal-action">
        <Button variant="ghost" disabled={busy} onClick={() => onClose()}>
          {phase === "complete" || phase === "error"
            ? t("common.close")
            : t("common.cancel")}
        </Button>
        {phase === "idle" && (
          <Button variant="primary" onClick={() => void run()}>
            {t("submissions.migrateTracking.apply")}
          </Button>
        )}
      </div>
    </Modal>
  )
}

export default MigrateSubmissionTrackingModal
