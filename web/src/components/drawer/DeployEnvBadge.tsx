import { useTranslation } from "react-i18next"
import { Badge } from "@/components/ui"
import { resolveAppEnv } from "@/lib/appEnv"

// Small "you're on dev/preview, not production" badge shown in the account
// footer. Renders nothing in production so the real site is unmarked. Preview
// borrows the same solid `warning` tone as the footer's role-preview badge (this
// is also a not-the-real-thing state); dev is a quieter `info`. The label
// carries its own `title` tooltip, so it reads on the collapsed rail too.
export const DeployEnvBadge = () => {
  const { t } = useTranslation()
  const env = resolveAppEnv()

  if (env === "production") return null

  const label = env === "preview" ? t("nav.envPreview") : t("nav.envDev")
  const tone = env === "preview" ? "warning" : "info"

  return (
    <Badge
      tone={tone}
      size="xs"
      soft={false}
      className="font-medium uppercase tracking-wide"
      title={t("nav.envIndicator", { env: label })}
    >
      {label}
    </Badge>
  )
}
