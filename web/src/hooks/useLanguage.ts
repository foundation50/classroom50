import { useSyncExternalStore } from "react"
import { useTranslation } from "react-i18next"

import {
  BASE_LANG,
  availableBuiltInLangs,
  availableLangs as readAvailableLangs,
  commitPack,
  installedCodes as readInstalledCodes,
  packCoverages,
  prepareFromBuiltIn,
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

// React hook over the i18n custom-locale layer. Loading a pack is two-step:
// prepare (parse + preview, no side effects) then commit (install + activate).
// Pack operations have stable module-level identity, so they're returned
// directly rather than wrapped in useCallback.
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
    prepareFromBuiltIn,
    availableBuiltInLangs,
    commitPack,
    removePack,
    packCoverages,
  }
}

export default useLanguage
