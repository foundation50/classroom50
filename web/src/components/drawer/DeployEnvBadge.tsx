import { useTranslation } from "react-i18next"
import { Badge } from "@/components/ui"
import { resolveAppEnv } from "@/lib/appEnv"

// Marks a non-production build in the account footer. Preview reuses the
// footer's solid `warning` tone (also a not-the-real-thing state); dev is a
// quieter `info`. The `title` carries the label on the collapsed rail.
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
