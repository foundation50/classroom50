import { useTranslation } from "react-i18next"
import { resolveAppEnv } from "@/lib/appEnv"
import { Tip } from "./primitives"
import { useSidebarCollapse } from "./collapseContext"

// Persistent "you're on dev/preview, not production" marker. Renders nothing in
// production so the real site is unmarked. Preview borrows the same `warning`
// tone as the footer's role-preview badge (this is also a not-the-real-thing
// state); dev is a quieter `info`.
//
// Two variants:
//   - "inline" sits next to the account role badge (org routes, expanded rail):
//     a bare compact pill, no chrome of its own.
//   - "row" (default) is the standalone fallback that keeps the marker visible
//     where the inline one can't be — on non-org routes and in the collapsed
//     rail. It owns a top border and, when it's the first footer element (no org
//     indicator above it), the `pushToBottom` anchor.
export const DeployEnvBadge = ({
  variant = "row",
  pushToBottom = false,
}: {
  variant?: "row" | "inline"
  pushToBottom?: boolean
}) => {
  const { t } = useTranslation()
  const { collapsed } = useSidebarCollapse()
  const env = resolveAppEnv()

  if (env === "production") return null

  const label = env === "preview" ? t("nav.envPreview") : t("nav.envDev")
  const tone = env === "preview" ? "badge-warning" : "badge-info"
  const tooltip = t("nav.envIndicator", { env: label })

  if (variant === "inline") {
    return (
      <span
        className={`badge badge-xs ${tone} font-medium uppercase tracking-wide`}
        role="status"
        title={tooltip}
      >
        {label}
      </span>
    )
  }

  return (
    <div
      className={`border-t border-neutral-content/20 py-2 ${pushToBottom ? "mt-auto" : ""} ${collapsed ? "flex justify-center" : ""}`}
    >
      <Tip label={tooltip}>
        {collapsed ? (
          <span
            className={`badge badge-xs ${tone}`}
            role="status"
            aria-label={tooltip}
          />
        ) : (
          <span
            className={`badge badge-sm ${tone} w-full justify-center gap-1 font-medium uppercase tracking-wide`}
            role="status"
          >
            {label}
          </span>
        )}
      </Tip>
    </div>
  )
}
