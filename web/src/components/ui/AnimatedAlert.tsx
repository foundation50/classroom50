import { Collapse } from "./Collapse"
import { Alert, type AlertProps } from "./Alert"

// <Alert> that height-collapses on mount/unmount so a toggled alert doesn't jerk
// the layout. The collapser is padding-free (padding on the collapsing element
// would keep a sliver visible at height 0). Always-rendered alerts should use
// <Alert> directly.

export type AnimatedAlertProps = {
  // Toggles the alert; false animates it out rather than unmounting abruptly.
  show: boolean
} & AlertProps

export function AnimatedAlert({
  show,
  children,
  ...alertProps
}: AnimatedAlertProps) {
  return (
    <Collapse open={show}>
      <Alert {...alertProps}>{children}</Alert>
    </Collapse>
  )
}

export default AnimatedAlert
