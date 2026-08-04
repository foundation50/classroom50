import { useTranslation } from "react-i18next"
import { resolveAppEnv } from "@/lib/appEnv"
import { Tip } from "./primitives"
import { useSidebarCollapse } from "./collapseContext"

// Persistent "you're on dev/preview, not production" marker in the rail. Renders
// nothing in production so the real site is unmarked. Preview borrows the same
// `warning` tone as the footer's role-preview badge (this is also a
// not-the-real-thing state); dev is a quieter `info`.
//
// Placed in the account footer (below the org indicator, above the account row)
// where the drawer chrome stays mounted across navigation, so it never
// re-animates. Honors the collapsed rail like the other chrome: a full pill when
// expanded, a labelled dot behind a tooltip when collapsed.
//
// `pushToBottom` anchors the footer group to the bottom when this badge is its
// first element (no org indicator above it); with an org present the org link
// already owns that `mt-auto`. Harmless when this renders null in production —
// the account row keeps its own `mt-auto` fallback.
export const DeployEnvBadge = ({
  pushToBottom = false,
}: {
  pushToBottom?: boolean
}) => {
  const { t } = useTranslation()
  const { collapsed } = useSidebarCollapse()
  const env = resolveAppEnv()

  if (env === "production") return null

  const label = env === "preview" ? t("nav.envPreview") : t("nav.envDev")
  const tone = env === "preview" ? "badge-warning" : "badge-info"

  return (
    <div
      className={`border-t border-neutral-content/20 py-2 ${pushToBottom ? "mt-auto" : ""} ${collapsed ? "flex justify-center" : ""}`}
    >
      <Tip label={t("nav.envIndicator", { env: label })}>
        {collapsed ? (
          <span
            className={`badge badge-xs ${tone}`}
            role="status"
            aria-label={t("nav.envIndicator", { env: label })}
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
