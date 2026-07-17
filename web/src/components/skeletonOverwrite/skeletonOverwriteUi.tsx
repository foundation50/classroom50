import { useCallback, useEffect, useRef, useState } from "react"
import { Trans, useTranslation } from "react-i18next"

import { ConfirmModal } from "@/components/modals"
import {
  makeConfirmSkeletonOverwrite,
  settleOverwrite,
} from "./overwriteConfirm"

// Wires the skeleton-overwrite confirmation into a React surface: owns the
// modal-open state, the resolver ref, and the unmount cleanup that settles a
// parked run rather than letting it hang. Shared by the wizard (OrgSetupPage)
// and re-run surface (RerunOrgSetup). Pass the returned
// `confirmSkeletonOverwrite` to initClassroom50 and render
// <SkeletonOverwriteModal> with `overwritePaths`/`resolveOverwrite`.
export function useSkeletonOverwriteConfirm() {
  const [overwritePaths, setOverwritePaths] = useState<string[] | null>(null)
  const resolveRef = useRef<((ok: boolean) => void) | null>(null)
  const mountedRef = useRef(true)

  useEffect(() => {
    mountedRef.current = true
    return () => {
      mountedRef.current = false
      settleOverwrite(resolveRef, false)
    }
  }, [])

  const resolveOverwrite = (ok: boolean) => {
    settleOverwrite(resolveRef, ok)
    setOverwritePaths(null)
  }

  // Built lazily (useCallback) so the resolver ref is only touched when invoked
  // mid-run, not during render.
  const confirmSkeletonOverwrite = useCallback(
    (paths: string[]) =>
      makeConfirmSkeletonOverwrite(
        resolveRef,
        setOverwritePaths,
        () => mountedRef.current,
      )(paths),
    [],
  )

  return {
    overwritePaths,
    resolveOverwrite,
    confirmSkeletonOverwrite,
    mountedRef,
  }
}

// The "are you sure" prompt before overwriting drifted skeleton files. Open when
// `paths` is non-null; the copy explains overwriting resets local customizations
// (matching the CLI's stance that these files are user-editable).
export function SkeletonOverwriteModal({
  paths,
  onConfirm,
  onClose,
}: {
  paths: string[] | null
  onConfirm: () => void
  onClose: () => void
}) {
  const { t } = useTranslation()
  const count = paths?.length ?? 0
  return (
    <ConfirmModal
      open={paths !== null}
      dangerous={false}
      needsConfirm={false}
      title={t("orgSettings.overwrite.title")}
      confirmLabel={t("orgSettings.overwrite.confirmLabel")}
      cancelLabel={t("orgSettings.overwrite.cancelLabel")}
      description={
        <>
          <p>{t("orgSettings.overwrite.body", { count })}</p>
          <ul className="mt-2 list-disc space-y-0.5 ps-5 font-mono text-xs">
            {paths?.map((p) => (
              <li key={p}>{p}</li>
            ))}
          </ul>
          <p className="mt-3">
            <Trans
              i18nKey="orgSettings.overwrite.warning"
              components={{ keepMine: <strong /> }}
            />
          </p>
        </>
      }
      onConfirm={() => {
        onConfirm()
        return Promise.resolve()
      }}
      onClose={onClose}
    />
  )
}
