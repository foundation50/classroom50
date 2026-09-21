import { useTranslation } from "react-i18next"

import { PreferenceForm, type PreferenceOption } from "./PreferenceForm"
import { useUserPreferences } from "@/context/userPreferences/UserPreferencesProvider"
import type { AnalyticsPref } from "@/types/preferences"

// The anonymous-analytics opt-out, shared by the Settings page and the public
// /privacy page so a visitor can object before signing in. Saving persists the
// preference; the analytics loader in index.html reads it on the next page
// load, which the "saved" copy says out loud.
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
