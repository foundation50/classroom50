import i18n from "i18next"
import { initReactI18next } from "react-i18next"

import en from "@/locales/en.json"

import {
  BASE_LANG,
  NAMESPACE,
  applyLangFromQuery,
  getStoredLang,
  hydratePacks,
  refreshInstalledPacks,
} from "./customLocale"

// Single i18next instance. English is bundled as the base; custom packs are
// registered at runtime (see customLocale.ts). No provider needed.
void i18n.use(initReactI18next).init({
  resources: {
    [BASE_LANG]: { [NAMESPACE]: en },
  },
  lng: BASE_LANG,
  fallbackLng: BASE_LANG,
  defaultNS: NAMESPACE,
  interpolation: {
    // React already escapes rendered values; i18next escaping would double-encode.
    escapeValue: false,
  },
  returnNull: false,
})

// Re-hydrate + re-validate installed packs, then apply the persisted choice.
// Runs after init so addResourceBundle has an instance to attach to.
const installed = hydratePacks()
const stored = getStoredLang()

// Activate the stored language, THEN apply any `?lang=<code>` deep link, in that
// order. A `?lang=` deep link sets the active language and persists it (it
// overrides the stored choice going forward, not just for this visit), so it
// must be the last write to both i18n.language and the persisted lang. Chaining
// (rather than firing both unawaited) prevents a startup race where the stored
// activation resolves after applyLangFromQuery and clobbers the deep link,
// leaving the screen and localStorage disagreeing. Fire-and-forget the chain so
// startup isn't blocked; both steps swallow errors, so a shared link is safe.
void (async () => {
  if (stored !== BASE_LANG && installed.includes(stored)) {
    await i18n.changeLanguage(stored)
  }
  await applyLangFromQuery()
  // Silently pull any newer registry packs (runs last so a just-installed
  // deep-link pack is considered and the active pack live-updates). Swallows
  // its own failures; updated codes toast via LanguagePackUpdateToaster.
  await refreshInstalledPacks()
})()

export default i18n
