// Generic per-browser display-preference storage for list pages (view mode +
// sort key). UI state, not server data, so it lives in localStorage rather than
// React Query. Each list page instantiates its own accessor with its own
// storage keys and allowed values via createListPrefs.

function canUseStorage() {
  return typeof window !== "undefined"
}

export type ListPrefsConfig<ViewMode extends string, SortKey extends string> = {
  viewKey: string
  sortKey: string
  viewValues: readonly ViewMode[]
  sortValues: readonly SortKey[]
  defaultView: ViewMode
  defaultSort: SortKey
  // Optional hook to rewrite a validated sort on read — e.g. a page that must
  // not auto-restore a fan-out-bearing sort returns its default instead.
  sanitizeSortOnLoad?: (sort: SortKey, defaultSort: SortKey) => SortKey
}

export function createListPrefs<
  ViewMode extends string,
  SortKey extends string,
>(config: ListPrefsConfig<ViewMode, SortKey>) {
  const getStoredViewMode = (): ViewMode => {
    if (!canUseStorage()) return config.defaultView
    const raw = localStorage.getItem(config.viewKey)
    return config.viewValues.includes(raw as ViewMode)
      ? (raw as ViewMode)
      : config.defaultView
  }

  const persistViewMode = (mode: ViewMode) => {
    if (!canUseStorage()) return
    localStorage.setItem(config.viewKey, mode)
  }

  const getStoredSortKey = (): SortKey => {
    if (!canUseStorage()) return config.defaultSort
    const raw = localStorage.getItem(config.sortKey)
    const parsed = config.sortValues.includes(raw as SortKey)
      ? (raw as SortKey)
      : config.defaultSort
    return config.sanitizeSortOnLoad
      ? config.sanitizeSortOnLoad(parsed, config.defaultSort)
      : parsed
  }

  const persistSortKey = (key: SortKey) => {
    if (!canUseStorage()) return
    localStorage.setItem(config.sortKey, key)
  }

  return {
    getStoredViewMode,
    persistViewMode,
    getStoredSortKey,
    persistSortKey,
  }
}
