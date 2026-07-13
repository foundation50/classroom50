import { Component, type ErrorInfo, type ReactNode } from "react"
import { Link } from "@tanstack/react-router"
import { useTranslation } from "react-i18next"
import { ShieldAlert } from "lucide-react"
import { GitHubAPIError } from "@/hooks/github/errors"
import { Alert } from "@/components/ui"
import { logger } from "@/lib/logger"

const log = logger.scope("permission-error-boundary")

// A permission failure the boundary is meant to catch: a GitHub 403 (blocked)
// or 404 (not found / not a member) escaping a role-gated read. Pre-flight UI
// gating (the classroom role context) makes these rare, but a role change
// mid-session or a direct-URL navigation can still surface one — catch it here
// so the user sees a friendly message instead of the app-wide crash screen.
function isPermissionError(error: unknown): boolean {
  return (
    error instanceof GitHubAPIError && (error.isForbidden || error.isNotFound)
  )
}

// The translated fallback UI. A function component so it can use hooks (t, Link)
// that the class boundary can't.
function PermissionDeniedMessage() {
  const { t } = useTranslation()
  return (
    <div className="flex min-h-[60vh] flex-col items-center justify-center gap-4 p-10 text-center">
      <div className="flex size-16 items-center justify-center rounded-2xl bg-warning/10 text-warning">
        <ShieldAlert aria-hidden="true" className="size-8" />
      </div>
      <Alert tone="warning" className="max-w-md flex-col text-center">
        <h1 className="text-lg font-bold">{t("permissionDenied.title")}</h1>
        <p className="text-sm">{t("permissionDenied.message")}</p>
      </Alert>
      <Link to="/" className="btn btn-primary btn-sm">
        {t("permissionDenied.back")}
      </Link>
    </div>
  )
}

// Error boundary mounted at the classroom route. Catches instructor/owner-only
// 403/404 that slip past pre-flight gating and renders a friendly, translated
// message. Any non-permission error is rethrown so the app-wide error boundary
// (or an ancestor) still handles it.
export class PermissionErrorBoundary extends Component<
  { children: ReactNode },
  { error: unknown }
> {
  state = { error: null as unknown }

  static getDerivedStateFromError(error: unknown) {
    return { error }
  }

  componentDidCatch(error: unknown, info: ErrorInfo) {
    if (isPermissionError(error)) {
      log.info("permission error caught at classroom boundary", {
        status: error instanceof GitHubAPIError ? error.status : undefined,
        componentStack: info.componentStack,
      })
    }
  }

  render() {
    const { error } = this.state
    if (error) {
      if (isPermissionError(error)) return <PermissionDeniedMessage />
      // Not a permission error — rethrow so an ancestor boundary handles it.
      throw error
    }
    return this.props.children
  }
}

export default PermissionErrorBoundary
