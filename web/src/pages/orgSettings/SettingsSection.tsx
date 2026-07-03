import type { PropsWithChildren, ReactNode } from "react"

// Standardized wrapper for each Org Settings group (Service Token,
// Organization Policy, Re-run Setup, Danger Zone) so the page reads as a set
// of consistent sections rather than mismatched cards. Owns the card shell and
// the header (title + optional description, an optional right-aligned action,
// and an optional adornment beside the title such as an info popover). The
// `tone="danger"` variant styles destructive groups (Danger Zone).
const SettingsSection = ({
  title,
  description,
  action,
  titleAdornment,
  tone = "default",
  id,
  children,
}: PropsWithChildren<{
  title: string
  description?: ReactNode
  action?: ReactNode
  titleAdornment?: ReactNode
  tone?: "default" | "danger"
  id?: string
}>) => {
  const isDanger = tone === "danger"

  return (
    <section
      id={id}
      className={[
        "scroll-mt-24 rounded-2xl border p-6",
        isDanger ? "border-error/30 bg-error/5" : "border-base-300 bg-base-100",
      ].join(" ")}
    >
      <div className="flex items-start justify-between gap-4">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <h2
              className={[
                "text-lg font-semibold",
                isDanger ? "text-error" : "",
              ].join(" ")}
            >
              {title}
            </h2>
            {titleAdornment}
          </div>
          {description && (
            <p className="mt-1 text-sm text-base-content/70">{description}</p>
          )}
        </div>
        {action && <div className="shrink-0">{action}</div>}
      </div>

      <div className="mt-4">{children}</div>
    </section>
  )
}

export default SettingsSection
