import { useEffect } from "react"
import { useTranslation } from "react-i18next"

import { useOptionalToast } from "@/context/notifications/NotificationProvider"
import { languageLabel, subscribeToPackUpdates } from "@/i18n/customLocale"

// Bridges the non-React startup auto-refresh (refreshInstalledPacks in
// customLocale.ts) to a toast. That refresh runs before the app mounts, so any
// codes it updated are buffered and flushed to this subscriber on mount; later
// in-session refreshes notify live. Renders nothing itself. Mount under
// NotificationProvider (see main.tsx). Uses the optional toast hook so it is a
// no-op if ever mounted without a provider.
export function LanguagePackUpdateToaster() {
  const { t, i18n } = useTranslation()
  const toast = useOptionalToast()

  useEffect(() => {
    if (!toast) return
    return subscribeToPackUpdates((codes) => {
      if (codes.length === 0) return
      const list = codes.map((c) => languageLabel(c, i18n.language)).join(", ")
      toast.notify({
        tone: "success",
        // Keyed so a burst of updates replaces in place rather than stacking.
        key: "language-packs-updated",
        message: t("language.updatedToast", { count: codes.length, list }),
        durationMs: 8000,
      })
    })
  }, [toast, t, i18n.language])

  return null
}

export default LanguagePackUpdateToaster
