import type { PropsWithChildren, ReactNode } from "react"

import { Card } from "@/components/ui"

// Standardized wrapper for each Org Settings group (Service Token, Organization
// Policy, Re-run Setup, Danger Zone) so the page reads as consistent sections.
// Renders the shared Card primitive (2xl radius, no shadow) as its shell, plus
// the section header (title + optional description, optional right-aligned
// action, optional title adornment). `tone="danger"` restyles the shell for
// destructive groups (Danger Zone) via the error-tinted border/bg.
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
    <Card
      as="section"
      id={id}
      radius="2xl"
      shadow={false}
      bordered={!isDanger}
      className={
        isDanger
          ? "scroll-mt-24 border border-error/30 bg-error/5 p-6"
          : "scroll-mt-24 p-6"
      }
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
    </Card>
  )
}

export default SettingsSection
