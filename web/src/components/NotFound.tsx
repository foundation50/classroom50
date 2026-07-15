import { FileQuestion } from "lucide-react"
import { useEffect, useRef } from "react"
import { useTranslation } from "react-i18next"

import { RouterButton } from "@/components/ui"
import { useDocumentTitle } from "@/hooks/useDocumentTitle"

// Rendered by role/visibility-gated pages when the user can't access a resource.
// We present a 404 ("not found"), not a 403 ("forbidden"): access is enforced by
// GitHub, so this is UX-only, and a 404 avoids confirming the resource exists to
// someone whose role can't see it. Reused across teacher-only pages and TA roles.
const NotFound = ({ title, message }: { title?: string; message?: string }) => {
  const { t } = useTranslation()
  const resolvedTitle = title ?? t("notFound.title")
  const resolvedMessage = message ?? t("notFound.message")
  useDocumentTitle(resolvedTitle)
  const headingRef = useRef<HTMLHeadingElement | null>(null)

  // Client-side navigation doesn't reload, so a screen reader isn't told the
  // view changed to "not found". Move focus to the heading to announce it and
  // give keyboard users a sensible starting point.
  useEffect(() => {
    headingRef.current?.focus()
  }, [])

  return (
    <div className="flex min-h-[60vh] flex-col items-center justify-center gap-4 p-10 text-center">
      <div className="flex size-16 items-center justify-center rounded-2xl bg-base-200 text-base-content/70">
        <FileQuestion className="size-8" aria-hidden="true" />
      </div>
      <div>
        <h1 ref={headingRef} tabIndex={-1} className="text-2xl font-bold">
          {resolvedTitle}
        </h1>
        <p className="mt-1 max-w-md text-base-content/70">{resolvedMessage}</p>
      </div>
      <RouterButton to="/" variant="primary" size="sm">
        {t("common.goToDashboard")}
      </RouterButton>
    </div>
  )
}

export default NotFound
