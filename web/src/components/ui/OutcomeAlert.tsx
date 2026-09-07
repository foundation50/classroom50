import { AnimatedAlert } from "./AnimatedAlert"
import type { AlertOutcome } from "./Alert"

// The one way to render an action-outcome banner from `AlertOutcome | null`
// state: collapsed when null, animated in when set. Single-sources the
// `tone/show/message` triple that hosts used to hand-roll (with drifting
// hidden-state fallback tones — "info" here is invisible while hidden).

export type OutcomeAlertProps = {
  outcome: AlertOutcome | null | undefined
  className?: string
  onDismiss?: () => void
}

export function OutcomeAlert({
  outcome,
  className,
  onDismiss,
}: OutcomeAlertProps) {
  return (
    <AnimatedAlert
      tone={outcome?.tone ?? "info"}
      show={outcome != null}
      className={className}
      onDismiss={onDismiss}
    >
      {outcome?.message}
    </AnimatedAlert>
  )
}

export default OutcomeAlert
