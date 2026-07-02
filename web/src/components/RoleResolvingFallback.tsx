import { Spinner } from "@/components/Spinner"

// Shared pending state for the role-gated surfaces (RequireTeacher, the
// assignment index redirect, the SubmissionsPage self-guard).
const RoleResolvingFallback = ({
  className = "min-h-[60vh]",
}: {
  className?: string
}) => (
  <div className={`flex items-center justify-center ${className}`}>
    <Spinner size="lg" />
  </div>
)

export default RoleResolvingFallback
