import { useCallback, useEffect, useMemo, useRef, useState } from "react"

import { useLanguage } from "@/hooks/useLanguage"
import {
  type RegistryLanguage,
  refreshInstalledPacks,
} from "@/i18n/customLocale"

// Shared registry mechanism for both language switchers (the login menu and the
// settings modal). Owns the fetch-on-mount, the loading/error state, and the
// install-on-select flow, so the two switchers can't drift on how a registry
// pack is stamped — both install it as source:"registry" (auto-updating) via
// installAndActivate. Each switcher keeps its own re-entry lock, UI shell, and
// post-action policy (close menu vs. stay open); this hook only owns the data.
export function useLanguageRegistry() {
  const {
    availableLangs,
    availableBuiltInLangs,
    prepareFromBuiltIn,
    commitPreview,
  } = useLanguage()

  const [registry, setRegistry] = useState<RegistryLanguage[] | null>(null)
  const [loading, setLoading] = useState(true)
  const [refreshing, setRefreshing] = useState(false)
  const [error, setError] = useState(false)
  // Synchronous re-entry lock for refresh: `refreshing` is async React state,
  // so a fast double-click would fire two forced fetches.
  const refreshingRef = useRef(false)

  // Prefetch on mount so the list is ready when a switcher opens. Set state only
  // after the fetch resolves, and bail if unmounted mid-flight.
  useEffect(() => {
    let active = true
    availableBuiltInLangs()
      .then((langs) => {
        if (active) setRegistry(langs)
      })
      .catch(() => {
        if (active) setError(true)
      })
      .finally(() => {
        if (active) setLoading(false)
      })
    return () => {
      active = false
    }
  }, [availableBuiltInLangs])

  // Retry hook for switchers that also load on open (the login button); no-op
  // once a fetch is in flight or the list is already loaded.
  const loadRegistry = useCallback(async () => {
    if (registry || loading) return
    setLoading(true)
    setError(false)
    try {
      setRegistry(await availableBuiltInLangs())
    } catch {
      setError(true)
      setRegistry(null)
    } finally {
      setLoading(false)
    }
  }, [registry, loading, availableBuiltInLangs])

  // User-driven refresh: re-read the manifest past the memo and the browser
  // cache (the registry serves it with a 10-minute max-age, so a language
  // published minutes ago is otherwise invisible until the next visit), then
  // pull any installed registry packs whose marker changed. Updated packs toast
  // via LanguagePackUpdateToaster. Resolves to the fresh list, or null when
  // the registry couldn't be reached (the caller shows `error`).
  const refresh = useCallback(async (): Promise<RegistryLanguage[] | null> => {
    if (refreshingRef.current) return null
    refreshingRef.current = true
    setRefreshing(true)
    setError(false)
    try {
      const langs = await availableBuiltInLangs({ force: true })
      setRegistry(langs)
      // The forced fetch above just repopulated the memo, so this hits it.
      await refreshInstalledPacks()
      return langs
    } catch {
      setError(true)
      return null
    } finally {
      setRefreshing(false)
      refreshingRef.current = false
    }
  }, [availableBuiltInLangs])

  // Fetch + install (as a registry pack, so it auto-updates) + activate a
  // registry language, then drop it from the offered list. Returns the installed
  // code. Throws on fetch/install failure — the caller owns error surfacing.
  // The manifest row is passed along so the stored marker matches the
  // registry's; without it the next startup refresh would refetch the pack
  // once just to discover it's unchanged.
  const installAndActivate = useCallback(
    async (code: string): Promise<string> => {
      const entry = registry?.find((l) => l.code === code)
      const preview = await prepareFromBuiltIn(code, { entry })
      const installed = await commitPreview(preview)
      setRegistry((prev) => (prev ? prev.filter((l) => l.code !== code) : prev))
      return installed
    },
    [registry, prepareFromBuiltIn, commitPreview],
  )

  // Registry languages not already available (installed or base) — the ones a
  // switcher offers to install.
  const offered = useMemo(() => {
    const installedSet = new Set(availableLangs)
    return (registry ?? []).filter((l) => !installedSet.has(l.code))
  }, [availableLangs, registry])

  return {
    registry,
    offered,
    loading,
    refreshing,
    error,
    loadRegistry,
    refresh,
    installAndActivate,
  }
}

export default useLanguageRegistry
