import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type PropsWithChildren,
} from "react"
import { X } from "lucide-react"
import { AnimatePresence, motion } from "motion/react"
import { toastVariants } from "@/lib/motion"
import { Button, alertToneClass } from "@/components/ui"
import { recordErrorToast } from "@/lib/activity/activityStore"

export type ToastTone = "info" | "success" | "warning" | "error"

export type Toast = {
  // Stable id for React keys + dismissal. Auto-generated unless `key` is given.
  id: string
  tone: ToastTone
  message: React.ReactNode
  // Auto-dismiss after this many ms; 0/undefined means it stays until dismissed.
  durationMs?: number
}

export type NotifyInput = {
  tone?: ToastTone
  // Toast content. The toast viewport mounts ABOVE the RouterProvider (so toasts
  // survive route changes), so it has NO router context. Do NOT put a TanStack
  // <Link> here — it throws on render and blanks the app (the throw escapes the
  // route-level errorComponent). Use plain text, a plain <a href>, or a button
  // calling router.navigate.
  message: React.ReactNode
  // Optional dedup key: a later notify() with the same key replaces the prior
  // toast in place instead of stacking a duplicate (e.g. repeated retries).
  key?: string
  durationMs?: number
}

type NotificationContextValue = {
  notify: (input: NotifyInput) => string
  dismiss: (id: string) => void
}

const NotificationContext = createContext<NotificationContextValue | null>(null)

let toastSeq = 0
const nextId = () => `toast-${++toastSeq}`

// App-wide toast surface. Lives above the router so a toast survives the
// component that fired it unmounting (archiving removes the card, reuse
// navigates away). Modeled on EnrolledStudents' inline-alert region (tones,
// keyed dedup, dismissible); migrating that onto notify()/useToast is a follow-up.
export function NotificationProvider({ children }: PropsWithChildren) {
  const [toasts, setToasts] = useState<Toast[]>([])
  // Track auto-dismiss timers so a keyed replace / manual dismiss clears them.
  const timers = useRef(new Map<string, ReturnType<typeof setTimeout>>())

  const clearTimer = useCallback((id: string) => {
    const timer = timers.current.get(id)
    if (timer) {
      clearTimeout(timer)
      timers.current.delete(id)
    }
  }, [])

  const dismiss = useCallback(
    (id: string) => {
      clearTimer(id)
      setToasts((prev) => prev.filter((t) => t.id !== id))
    },
    [clearTimer],
  )

  const notify = useCallback(
    ({ tone = "info", message, key, durationMs }: NotifyInput): string => {
      // Record error toasts as session activity — a deliberate error toast is,
      // by construction, a real failure the app chose to show. Only string
      // messages are recorded (JSX carries no clean label). recordErrorToast
      // suppresses the toast when a structural error (MutationCache/global
      // handler) for the same failure was just recorded, so one error isn't
      // double-listed.
      if (tone === "error" && typeof message === "string") {
        recordErrorToast(message)
      }

      // A keyed toast reuses its id so a replace updates in place; otherwise a
      // fresh id stacks a new toast.
      const id = key ?? nextId()
      clearTimer(id)

      const toast: Toast = { id, tone, message, durationMs }
      setToasts((prev) => {
        const without = prev.filter((t) => t.id !== id)
        return [...without, toast]
      })

      if (durationMs && durationMs > 0) {
        timers.current.set(
          id,
          setTimeout(() => dismiss(id), durationMs),
        )
      }
      return id
    },
    [clearTimer, dismiss],
  )

  // Snapshot the timer map for cleanup on unmount.
  useEffect(() => {
    const map = timers.current
    return () => {
      map.forEach((timer) => clearTimeout(timer))
      map.clear()
    }
  }, [])

  const value = useMemo(() => ({ notify, dismiss }), [notify, dismiss])

  return (
    <NotificationContext.Provider value={value}>
      {children}
      <ToastViewport toasts={toasts} onDismiss={dismiss} />
    </NotificationContext.Provider>
  )
}

const ToastViewport = ({
  toasts,
  onDismiss,
}: {
  toasts: Toast[]
  onDismiss: (id: string) => void
}) => {
  // Keep the container mounted even when empty so AnimatePresence can play the
  // exit animation of the last toast before it disappears.
  return (
    <div className="toast toast-end toast-bottom z-50">
      <AnimatePresence>
        {toasts.map((toast) => (
          <motion.div
            key={toast.id}
            layout
            variants={toastVariants}
            initial="initial"
            animate="animate"
            exit="exit"
            role="alert"
            aria-live={toast.tone === "error" ? "assertive" : "polite"}
            className={`${alertToneClass(toast.tone)} max-w-sm`}
          >
            <span className="text-sm">{toast.message}</span>
            <Button
              variant="ghost"
              size="xs"
              aria-label="Dismiss notification"
              onClick={() => onDismiss(toast.id)}
            >
              <X aria-hidden="true" className="size-4" />
            </Button>
          </motion.div>
        ))}
      </AnimatePresence>
    </div>
  )
}

// Access notify()/dismiss() from any component under the provider.
export function useToast() {
  const ctx = useContext(NotificationContext)
  if (!ctx) {
    throw new Error("useToast must be used within a NotificationProvider")
  }
  return ctx
}

// Like useToast() but returns null instead of throwing when no provider is
// mounted, for consumers rendered both inside and outside it (e.g. the banner).
export function useOptionalToast() {
  return useContext(NotificationContext)
}
