import { Alert } from "@/components/ui"
import type { PropsWithChildren } from "react"

// The "this classroom is archived" info banner. Owns the daisyUI alert shell +
// ARIA so the three teacher pages that surface it (assignments list, edit
// assignment, settings) can't drift in markup; each passes its own copy as
// children. `className` tunes spacing per page.
export const ArchivedClassroomNotice = ({
  className = "mb-4",
  children,
}: PropsWithChildren<{ className?: string }>) => (
  <Alert tone="info" className={className}>
    <span className="text-sm">{children}</span>
  </Alert>
)

export default ArchivedClassroomNotice
