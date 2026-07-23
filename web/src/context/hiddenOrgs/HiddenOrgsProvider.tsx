import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react"
import {
  HIDDEN_ORGS_STORAGE_KEY,
  persistHiddenOrgs,
  readHiddenOrgs,
} from "@/lib/hiddenOrgsStore"

type HiddenOrgsContextValue = {
  hidden: Set<string>
  isHidden: (login: string) => boolean
  hide: (login: string) => void
  unhide: (login: string) => void
}

const HiddenOrgsContext = createContext<HiddenOrgsContextValue>({
  hidden: new Set(),
  isHidden: () => false,
  hide: () => {},
  unhide: () => {},
})

export const useHiddenOrgs = () => useContext(HiddenOrgsContext)

// Holds the reactive hidden-org set so the home page and the settings page
// re-render together on hide/unhide without prop drilling — mirrors the
// context-over-localStorage shape of drawer/collapseContext.tsx.
export const HiddenOrgsProvider = ({ children }: { children: ReactNode }) => {
  const [hidden, setHidden] = useState<Set<string>>(readHiddenOrgs)

  const hide = useCallback((login: string) => {
    setHidden((prev) => {
      if (prev.has(login)) return prev
      const next = new Set(prev)
      next.add(login)
      persistHiddenOrgs(next)
      return next
    })
  }, [])

  const unhide = useCallback((login: string) => {
    setHidden((prev) => {
      if (!prev.has(login)) return prev
      const next = new Set(prev)
      next.delete(login)
      persistHiddenOrgs(next)
      return next
    })
  }, [])

  // Keep tabs in sync: another tab writing the pref updates this one too.
  useEffect(() => {
    if (typeof window === "undefined") return
    const onStorage = (e: StorageEvent) => {
      if (e.key === HIDDEN_ORGS_STORAGE_KEY) setHidden(readHiddenOrgs())
    }
    window.addEventListener("storage", onStorage)
    return () => window.removeEventListener("storage", onStorage)
  }, [])

  const value = useMemo<HiddenOrgsContextValue>(
    () => ({ hidden, isHidden: (login) => hidden.has(login), hide, unhide }),
    [hidden, hide, unhide],
  )

  return (
    <HiddenOrgsContext.Provider value={value}>
      {children}
    </HiddenOrgsContext.Provider>
  )
}
