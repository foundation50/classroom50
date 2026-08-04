import { useTranslation } from "react-i18next"
import { resolveAppEnv } from "@/lib/appEnv"

// Small "you're on dev/preview, not production" badge shown in the account
// footer. Renders nothing in production so the real site is unmarked. Preview
// borrows the same `warning` tone as the footer's role-preview badge (this is
// also a not-the-real-thing state); dev is a quieter `info`. The label carries
// its own `title` tooltip, so it reads on the collapsed rail too.
export const DeployEnvBadge = () => {
  const { t } = useTranslation()
  const env = resolveAppEnv()

  if (env === "production") return null

  const label = env === "preview" ? t("nav.envPreview") : t("nav.envDev")
  const tone = env === "preview" ? "badge-warning" : "badge-info"

  return (
    <span
      className={`badge badge-xs ${tone} font-medium uppercase tracking-wide`}
      role="status"
      title={t("nav.envIndicator", { env: label })}
    >
      {label}
    </span>
  )
}
