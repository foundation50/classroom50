import i18n from "i18next"
import { initReactI18next } from "react-i18next"

import en from "@/locales/en.json"

import {
  BASE_LANG,
  NAMESPACE,
  applyLangFromQuery,
  getStoredLang,
  hydratePacks,
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
if (stored !== BASE_LANG && installed.includes(stored)) {
  void i18n.changeLanguage(stored)
}

// A `?lang=<code>` deep link overrides the stored choice for this visit,
// installing the pack from the registry if needed. Fire-and-forget so startup
// isn't blocked on a network fetch; it activates reactively when it resolves
// and self-heals (swallows errors, strips the param) so a shared link is safe.
void applyLangFromQuery()

export default i18n
