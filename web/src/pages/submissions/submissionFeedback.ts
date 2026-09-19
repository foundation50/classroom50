import { createContext, useCallback, useContext } from "react"

import { useToast } from "@/context/notifications/NotificationProvider"
import type { ToastTone } from "@/context/notifications/NotificationProvider"

// Feedback channel for actions running inside the submission hub: outcomes
// render as a banner at the top of the hub dialog (Primer: feedback for a
// dialog action stays in the dialog) rather than as page-corner toasts.
// Outside a provider the hook falls back to a toast, so the action rows keep
// working if ever rendered standalone. The hub's sink is itself unmount-safe
// (falls back to a toast once the hub closes), see ManageSubmissionModal.
export type SubmissionHubFeedback = {
  tone: ToastTone
  message: string
}

export const SubmissionHubFeedbackContext = createContext<
  ((feedback: SubmissionHubFeedback) => void) | null
>(null)

export const useSubmissionFeedback = () => {
  const inHub = useContext(SubmissionHubFeedbackContext)
  const { notify } = useToast()
  return useCallback(
    (feedback: SubmissionHubFeedback) => {
      if (inHub) inHub(feedback)
      else notify(feedback)
    },
    [inHub, notify],
  )
}
