import { useSyncExternalStore } from "react"
import { useTranslation } from "react-i18next"

import {
  BASE_LANG,
  availableLangs as readAvailableLangs,
  commitPack,
  installedCodes as readInstalledCodes,
  packCoverage,
  prepareFromFile,
  prepareFromUrl,
  removePack,
  selectLang,
  subscribeToPackChanges,
} from "@/i18n/customLocale"

// Stable server/initial snapshots (client-only SPA, but keep identity stable so
// useSyncExternalStore never loops).
const SERVER_AVAILABLE = [BASE_LANG]
const SERVER_INSTALLED: string[] = []

// React hook over the i18n custom-locale layer. Exposes the active language plus
// the multi-pack prepare / preview / commit / list / switch / remove API.
// Loading a pack is a two-step flow: prepare (parse + preview, no side effects)
// then commit (install + activate). Language changes come from i18next's own
// event, and pack changes (including cross-tab) come from the storage listener,
// so the component re-renders on either.
//
// The pack operations are module-level functions with stable identity, so they
// are returned directly rather than wrapped in useCallback.
export function useLanguage() {
  const { i18n } = useTranslation()

  const availableLangs = useSyncExternalStore(
    subscribeToPackChanges,
    readAvailableLangs,
    () => SERVER_AVAILABLE,
  )
  const installedLangs = useSyncExternalStore(
    subscribeToPackChanges,
    readInstalledCodes,
    () => SERVER_INSTALLED,
  )

  return {
    lang: i18n.language,
    availableLangs,
    installedLangs,
    setLang: selectLang,
    prepareFromFile,
    prepareFromUrl,
    commitPack,
    removePack,
    packCoverage,
  }
}

export default useLanguage
