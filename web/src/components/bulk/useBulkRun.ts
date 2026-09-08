import { useCallback, useEffect, useRef, useState } from "react"

import { useBeforeUnloadGuard } from "@/hooks/useBeforeUnloadGuard"

import type { BulkPhase, BulkProgress, BulkResultView } from "./resultView"

const IDLE_PROGRESS: BulkProgress = { processed: 0, total: 0, message: "" }

export interface BulkRun {
  phase: BulkPhase
  progress: BulkProgress
  result: BulkResultView | null
  // A whole-run failure (the bars' shape: the domain call threw before any
  // per-row outcome existed). Rendered instead of `result`.
  error: string | null
  busy: boolean
  // True while the component that started the run is still mounted. Fan-outs
  // check it before every setState and before launching another write.
  isMounted: () => boolean
  // Enter "working". Returns false (and does nothing) when a run is already in
  // flight, so a double-click can't start a second fan-out.
  begin: (total: number, message?: string) => boolean
  setProgress: (progress: BulkProgress) => void
  // Leave "working" with per-row results; `phase` is "error" when any row
  // failed or was deferred, so the caller decides that from its outcomes.
  complete: (result: BulkResultView, phase: "complete" | "error") => void
  // Leave "working" because the run itself threw.
  fail: (message: string) => void
  // Back to idle with nothing shown. Modals call this on open, never on close
  // (see the close-animation note in ui/Modal).
  reset: () => void
}

// The lifecycle every bulk modal and action bar drives: idle -> working ->
// complete | error, with the progress line, the mounted/running guards, and
// the tab-close hold while working. Callers own what the run does and how its
// outcomes map to a BulkResultView; this owns everything else.
//
// `resetWhen` is the modal's `open` flag: the state resets as it turns true so
// a reopened dialog starts fresh, while a close leaves the last result in
// place through the exit animation.
export function useBulkRun(resetWhen?: boolean): BulkRun {
  const [phase, setPhase] = useState<BulkPhase>("idle")
  const [progress, setProgressState] = useState<BulkProgress>(IDLE_PROGRESS)
  const [result, setResult] = useState<BulkResultView | null>(null)
  const [error, setError] = useState<string | null>(null)
  const runningRef = useRef(false)
  const mountedRef = useRef(true)

  useEffect(() => {
    mountedRef.current = true
    return () => {
      mountedRef.current = false
      runningRef.current = false
    }
  }, [])

  const isMounted = useCallback(() => mountedRef.current, [])

  const reset = useCallback(() => {
    runningRef.current = false
    setPhase("idle")
    setResult(null)
    setError(null)
    setProgressState(IDLE_PROGRESS)
  }, [])

  useEffect(() => {
    if (resetWhen) reset()
  }, [resetWhen, reset])

  const begin = useCallback((total: number, message = "") => {
    if (runningRef.current) return false
    runningRef.current = true
    setPhase("working")
    setResult(null)
    setError(null)
    setProgressState({ processed: 0, total, message })
    return true
  }, [])

  const setProgress = useCallback((next: BulkProgress) => {
    if (mountedRef.current) setProgressState(next)
  }, [])

  const complete = useCallback(
    (view: BulkResultView, next: "complete" | "error") => {
      runningRef.current = false
      if (!mountedRef.current) return
      setResult(view)
      setPhase(next)
    },
    [],
  )

  const fail = useCallback((message: string) => {
    runningRef.current = false
    if (!mountedRef.current) return
    setError(message)
    setPhase("error")
  }, [])

  const busy = phase === "working"
  useBeforeUnloadGuard(busy)

  return {
    phase,
    progress,
    result,
    error,
    busy,
    isMounted,
    begin,
    setProgress,
    complete,
    fail,
    reset,
  }
}
