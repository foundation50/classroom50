import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useRef,
  useState,
  type PropsWithChildren,
} from "react"

// Coordinates every regrade tracker on a Submissions page — the "Regrade all"
// hook and each per-row RegradeButton hook — so they share one in-flight signal.
// Without it the page's `regrading` flag only saw the assignment-wide hook, so
// "Collect now" / "Regrade all" stayed enabled during a single-student regrade
// (overlapping dispatches) and two trackers polling the same regrade.yaml run
// list could bind to each other's run. Page-scoped, so membership is implicitly
// the current assignment.

type RegradeCoordinator = {
  // True while ANY regrade (whole-assignment or per-student) is in flight.
  anyInFlight: boolean
  setInFlight: (key: string, inFlight: boolean) => void
  // Whether a NEW regrade may dispatch now. False while any regrade is in
  // flight, preventing concurrent dispatches against the shared run list (the
  // monotonic-id binding assumes one outstanding dispatch at a time).
  canDispatch: () => boolean
}

const RegradeCoordinatorContext = createContext<RegradeCoordinator | null>(null)

export function RegradeCoordinatorProvider({ children }: PropsWithChildren) {
  const inFlightKeys = useRef<Set<string>>(new Set())
  const [anyInFlight, setAnyInFlight] = useState(false)

  const setInFlight = useCallback((key: string, inFlight: boolean) => {
    const set = inFlightKeys.current
    const had = set.has(key)
    if (inFlight) set.add(key)
    else set.delete(key)
    if (had !== inFlight) setAnyInFlight(set.size > 0)
  }, [])

  const canDispatch = useCallback(() => inFlightKeys.current.size === 0, [])

  const value = useMemo<RegradeCoordinator>(
    () => ({ anyInFlight, setInFlight, canDispatch }),
    [anyInFlight, setInFlight, canDispatch],
  )

  return (
    <RegradeCoordinatorContext.Provider value={value}>
      {children}
    </RegradeCoordinatorContext.Provider>
  )
}

// Optional: trackers outside a provider (isolation/tests) get a no-op
// coordinator so they keep working standalone.
export function useRegradeCoordinator(): RegradeCoordinator {
  const ctx = useContext(RegradeCoordinatorContext)
  if (ctx) return ctx
  return {
    anyInFlight: false,
    setInFlight: () => {},
    canDispatch: () => true,
  }
}
