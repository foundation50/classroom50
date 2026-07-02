import { useCallback, useSyncExternalStore } from "react"
import { useTranslation } from "react-i18next"

import {
  BASE_LANG,
  availableLangs as readAvailableLangs,
  installedCodes as readInstalledCodes,
  loadFromFile as loadFile,
  loadFromUrl as loadUrl,
  removePack as removePackImpl,
  selectLang,
  subscribeToPackChanges,
} from "@/i18n/customLocale"

// Stable server/initial snapshots (client-only SPA, but keep identity stable so
// useSyncExternalStore never loops).
const SERVER_AVAILABLE = [BASE_LANG]
const SERVER_INSTALLED: string[] = []

// React hook over the i18n custom-locale layer. Exposes the active language plus
// the multi-pack install / list / switch / remove API. Language changes come
// from i18next's own event, and pack changes (including cross-tab) come from the
// storage listener, so the component re-renders on either.
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

  const setLang = useCallback((code: string) => selectLang(code), [])

  const loadFromFile = useCallback(
    (file: File, code: string) => loadFile(file, code),
    [],
  )

  const loadFromUrl = useCallback(
    (url: string, code: string) => loadUrl(url, code),
    [],
  )

  const removePack = useCallback((code: string) => removePackImpl(code), [])

  return {
    lang: i18n.language,
    availableLangs,
    installedLangs,
    setLang,
    loadFromFile,
    loadFromUrl,
    removePack,
  }
}

export default useLanguage
