import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react"

import { applyConsent } from "@/lib/analyticsRuntime"
import {
  browserDeclinesTracking,
  clearConsent,
  readConsent,
  writeConsent,
} from "@/lib/consent"
import {
  ALL_DENIED,
  ANALYTICS_RUNTIME_GLOBAL,
  CONSENT_STORAGE_KEY,
  LEGACY_ANALYTICS_STORAGE_KEY,
  type ConsentChoices,
  type ConsentRecord,
} from "@/types/consent"

type ConsentContextValue = {
  // Null until the visitor decides (or a legacy opt-out stands in).
  record: ConsentRecord | null
  // The browser's Global Privacy Control / Do Not Track signal is on: optional
  // categories stay off and the app doesn't ask.
  browserDeclines: boolean
  // True when the app should be asking: no decision and no browser signal.
  needsDecision: boolean
  decide: (choices: ConsentChoices) => void
  // Forgets the decision: optional vendors stop as if withdrawn, and the
  // prompt asks again.
  reset: () => void
}

const ConsentContext = createContext<ConsentContextValue>({
  record: null,
  browserDeclines: false,
  needsDecision: false,
  decide: () => {},
  reset: () => {},
})

export const useConsent = () => useContext(ConsentContext)

// Holds the visitor's cookie/tracking decision reactively for the whole app
// (the prompt, Settings, /privacy), persists it, starts or stops vendors
// through the injected runtime, and follows a decision made in another tab.
export const ConsentProvider = ({ children }: { children: ReactNode }) => {
  const [record, setRecord] = useState<ConsentRecord | null>(readConsent)
  const [browserDeclines] = useState(
    () => typeof navigator !== "undefined" && browserDeclinesTracking(),
  )
  // A build with no analytics vendor injects no runtime, so there is nothing
  // to ask about (the dev server injects it even without a vendor, so the
  // prompt can be worked on).
  const [vendorsPresent] = useState(
    () =>
      typeof window !== "undefined" &&
      window[ANALYTICS_RUNTIME_GLOBAL] !== undefined,
  )

  const decide = useCallback((choices: ConsentChoices) => {
    setRecord(writeConsent(choices))
    applyConsent(choices)
  }, [])
  const reset = useCallback(() => {
    clearConsent()
    applyConsent(ALL_DENIED)
    setRecord(null)
  }, [])

  useEffect(() => {
    if (typeof window === "undefined") return
    const onStorage = (event: StorageEvent) => {
      if (
        event.key !== CONSENT_STORAGE_KEY &&
        event.key !== LEGACY_ANALYTICS_STORAGE_KEY &&
        event.key !== null
      ) {
        return
      }
      // Re-read rather than trust newValue so version and shape checks apply.
      // A record cleared elsewhere (Reset in another tab) is a withdrawal here.
      const next = readConsent()
      setRecord(next)
      applyConsent(next ?? ALL_DENIED)
    }
    window.addEventListener("storage", onStorage)
    return () => window.removeEventListener("storage", onStorage)
  }, [])

  const value = useMemo<ConsentContextValue>(
    () => ({
      record,
      browserDeclines,
      needsDecision: record === null && !browserDeclines && vendorsPresent,
      decide,
      reset,
    }),
    [record, browserDeclines, vendorsPresent, decide, reset],
  )

  return (
    <ConsentContext.Provider value={value}>{children}</ConsentContext.Provider>
  )
}
