import { useTranslation } from "react-i18next"

import { PreferenceForm, type PreferenceOption } from "./PreferenceForm"
import { useUserPreferences } from "@/context/userPreferences/UserPreferencesProvider"
import { clearAnalyticsCookies } from "@/lib/analyticsCookies"
import type { AnalyticsPref } from "@/types/preferences"

// The anonymous-analytics opt-out, shared by Settings and the public /privacy
// page. The loader in index.html reads the stored value only on the next page
// load, hence the wording of the saved message; cookies Google Analytics already
// set are cleared right away so opting out leaves nothing behind.
export function AnalyticsPreferenceForm() {
  const { t } = useTranslation()
  const { preferences, setPreference } = useUserPreferences()

  const save = (next: AnalyticsPref) => {
    setPreference("analytics", next)
    if (next === "off") clearAnalyticsCookies()
  }

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
      onSave={save}
      options={options}
      savedMessage={t("settings.analytics.saved")}
    />
  )
}
