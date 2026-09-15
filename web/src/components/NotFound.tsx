import { TelescopeIcon } from "@/components/ui/icons"
import { useEffect, useRef } from "react"
import { useTranslation } from "react-i18next"

import { RouterButton, Heading, cx } from "@/components/ui"
import { useDocumentTitle } from "@/hooks/useDocumentTitle"

// Rendered by role/visibility-gated pages when the user can't access a resource,
// and by the root route for URLs that match nothing. We present a 404 ("not
// found"), not a 403 ("forbidden"): access is enforced by GitHub, so this is
// UX-only, and a 404 avoids confirming the resource exists to someone whose role
// can't see it. `fullHeight` is for the root case, which renders without the shell.
const NotFound = ({
  title,
  message,
  fullHeight = false,
}: {
  title?: string
  message?: string
  fullHeight?: boolean
}) => {
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
    <div
      className={cx(
        "flex flex-col items-center justify-center gap-4 p-10 text-center",
        fullHeight ? "min-h-screen" : "min-h-[60vh]",
      )}
    >
      <div className="flex size-16 items-center justify-center rounded-box bg-base-200 text-base-content/70">
        <TelescopeIcon className="size-8" aria-hidden="true" />
      </div>
      <div>
        <Heading as="h1" variant="title-medium" ref={headingRef} tabIndex={-1}>
          {resolvedTitle}
        </Heading>
        <p className="mt-1 max-w-md text-base-content/70">{resolvedMessage}</p>
      </div>
      <RouterButton to="/" variant="primary" size="sm">
        {t("common.goToDashboard")}
      </RouterButton>
    </div>
  )
}

export default NotFound
