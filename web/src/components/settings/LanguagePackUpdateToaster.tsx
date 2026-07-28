import { useEffect } from "react"
import { useTranslation } from "react-i18next"

import { useOptionalToast } from "@/context/notifications/NotificationProvider"
import { languageLabelList, subscribeToPackUpdates } from "@/i18n/customLocale"

// Bridges the non-React startup auto-refresh (refreshInstalledPacks) to a toast:
// codes updated before mount are buffered and flushed here; later refreshes
// notify live. Renders nothing. Mount under NotificationProvider.
export function LanguagePackUpdateToaster() {
  const { t, i18n } = useTranslation()
  const toast = useOptionalToast()

  useEffect(() => {
    if (!toast) return
    return subscribeToPackUpdates((codes) => {
      if (codes.length === 0) return
      const list = languageLabelList(codes, i18n.language)
      toast.notify({
        tone: "success",
        // Keyed so a burst replaces in place rather than stacking.
        key: "language-packs-updated",
        message: t("language.updatedToast", { count: codes.length, list }),
        durationMs: 8000,
      })
    })
  }, [toast, t, i18n.language])

  return null
}

export default LanguagePackUpdateToaster
