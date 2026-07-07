import { useCallback, useEffect, useMemo, useState } from "react"

import { useLanguage } from "@/hooks/useLanguage"
import { type RegistryLanguage } from "@/i18n/customLocale"

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
  const [error, setError] = useState(false)

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

  // Fetch + install (as a registry pack, so it auto-updates) + activate a
  // registry language, then drop it from the offered list. Returns the installed
  // code. Throws on fetch/install failure — the caller owns error surfacing.
  const installAndActivate = useCallback(
    async (code: string): Promise<string> => {
      const preview = await prepareFromBuiltIn(code)
      const installed = await commitPreview(preview)
      setRegistry((prev) => (prev ? prev.filter((l) => l.code !== code) : prev))
      return installed
    },
    [prepareFromBuiltIn, commitPreview],
  )

  // Registry languages not already available (installed or base) — the ones a
  // switcher offers to install.
  const offered = useMemo(() => {
    const installedSet = new Set(availableLangs)
    return (registry ?? []).filter((l) => !installedSet.has(l.code))
  }, [availableLangs, registry])

  return { registry, offered, loading, error, loadRegistry, installAndActivate }
}

export default useLanguageRegistry
