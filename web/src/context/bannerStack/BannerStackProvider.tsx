import {
  createContext,
  useContext,
  useEffect,
  useState,
  useSyncExternalStore,
  type PropsWithChildren,
} from "react"

// Global app banners in priority order — offline first, since it explains
// every other degraded read. Primer (notification messaging): show at most
// two banners at once; anything lower-priority waits for a slot.
export const BANNER_PRIORITY = [
  "offline",
  "github-status",
  "scope-warning",
  "update-available",
  "skeleton-drift",
  "budget-created",
] as const

export type BannerId = (typeof BANNER_PRIORITY)[number]

const MAX_VISIBLE = 2

type BannerStore = {
  claim: (id: BannerId, visible: boolean) => void
  subscribe: (listener: () => void) => () => void
  getGranted: () => ReadonlySet<BannerId>
}

// External store (not React state) so banners can register visibility from
// effects without setState-in-effect cascades; consumers subscribe via
// useSyncExternalStore.
function createBannerStore(): BannerStore {
  const claims = new Map<BannerId, boolean>()
  const listeners = new Set<() => void>()
  let granted: ReadonlySet<BannerId> = new Set()
  return {
    claim(id, visible) {
      if ((claims.get(id) ?? false) === visible) return
      claims.set(id, visible)
      granted = new Set(
        BANNER_PRIORITY.filter((b) => claims.get(b)).slice(0, MAX_VISIBLE),
      )
      listeners.forEach((listener) => listener())
    },
    subscribe(listener) {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    getGranted: () => granted,
  }
}

const BannerStackContext = createContext<BannerStore | null>(null)

export function BannerStackProvider({ children }: PropsWithChildren) {
  // Lazy useState (not a ref) so the store is created once without touching
  // a ref during render.
  const [store] = useState(createBannerStore)
  return (
    <BannerStackContext.Provider value={store}>
      {children}
    </BannerStackContext.Provider>
  )
}

const noopSubscribe = () => () => {}
const emptyGranted: ReadonlySet<BannerId> = new Set()
const getEmptyGranted = () => emptyGranted

// A banner's slot gate: pass whether the banner WANTS to show; the return is
// whether it MAY (it holds one of the two visible slots). When a
// higher-priority banner clears, the next claimant slides in. Outside a
// provider (isolated tests) the cap is off and the wish is granted.
export function useBannerSlot(id: BannerId, visible: boolean): boolean {
  const store = useContext(BannerStackContext)
  useEffect(() => {
    if (!store) return
    store.claim(id, visible)
    return () => store.claim(id, false)
  }, [store, id, visible])
  const granted = useSyncExternalStore(
    store ? store.subscribe : noopSubscribe,
    store ? store.getGranted : getEmptyGranted,
  )
  if (!store) return visible
  return visible && granted.has(id)
}
