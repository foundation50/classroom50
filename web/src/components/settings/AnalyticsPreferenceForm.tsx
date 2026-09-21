import { useTranslation } from "react-i18next"

import { PreferenceForm, type PreferenceOption } from "./PreferenceForm"
import { useUserPreferences } from "@/context/userPreferences/UserPreferencesProvider"
import type { AnalyticsPref } from "@/types/preferences"

// The anonymous-analytics opt-out, shared by Settings and the public /privacy
// page. The loader in index.html reads the stored value only on the next page
// load, hence the wording of the saved message.
export function AnalyticsPreferenceForm() {
  const { t } = useTranslation()
  const { preferences, setPreference } = useUserPreferences()

  const options: PreferenceOption<AnalyticsPref>[] = [
    {
      value: "on",
      label: t("settings.analytics.on"),
      hint: t("settings.analytics.onHint"),
    },
    {
      value: "off",
      label: t("settings.analytics.off"),
      hint: t("settings.analytics.offHint"),
    },
  ]

  return (
    <PreferenceForm
      name="analytics-pref"
      legend={t("settings.analytics.groupAria")}
      value={preferences.analytics}
      onSave={(next) => setPreference("analytics", next)}
      options={options}
      savedMessage={t("settings.analytics.saved")}
    />
  )
}
