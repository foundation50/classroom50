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
  readConsent,
  writeConsent,
} from "@/lib/consent"
import {
  ALL_DENIED,
  ALL_GRANTED,
  CONSENT_STORAGE_KEY,
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
  acceptAll: () => void
  rejectAll: () => void
  // The preferences dialog, openable from the banner, Settings, and /privacy.
  dialogOpen: boolean
  openDialog: () => void
  closeDialog: () => void
}

const ConsentContext = createContext<ConsentContextValue>({
  record: null,
  browserDeclines: false,
  needsDecision: false,
  decide: () => {},
  acceptAll: () => {},
  rejectAll: () => {},
  dialogOpen: false,
  openDialog: () => {},
  closeDialog: () => {},
})

export const useConsent = () => useContext(ConsentContext)

// Holds the visitor's cookie/tracking decision reactively for the whole app
// (banner, dialog, Settings, /privacy), persists it, starts or stops vendors
// through the injected runtime, and follows a decision made in another tab.
export const ConsentProvider = ({ children }: { children: ReactNode }) => {
  const [record, setRecord] = useState<ConsentRecord | null>(readConsent)
  const [dialogOpen, setDialogOpen] = useState(false)
  const browserDeclines = useMemo(
    () => typeof navigator !== "undefined" && browserDeclinesTracking(),
    [],
  )
  // A build with no analytics vendor injects no runtime, so there is nothing
  // to ask about. Dev builds rarely carry a vendor but still need the prompt
  // visible to work on it.
  const vendorsPresent = useMemo(
    () =>
      typeof window !== "undefined" &&
      (window.__classroom50Analytics !== undefined || import.meta.env.DEV),
    [],
  )

  const decide = useCallback((choices: ConsentChoices) => {
    setRecord(writeConsent(choices))
    applyConsent(choices)
    setDialogOpen(false)
  }, [])
  const acceptAll = useCallback(() => decide(ALL_GRANTED), [decide])
  const rejectAll = useCallback(() => decide(ALL_DENIED), [decide])

  useEffect(() => {
    if (typeof window === "undefined") return
    const onStorage = (event: StorageEvent) => {
      if (event.key !== CONSENT_STORAGE_KEY && event.key !== null) return
      // Re-read rather than trust newValue so version and shape checks apply.
      const next = readConsent()
      setRecord(next)
      if (next) applyConsent(next)
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
      acceptAll,
      rejectAll,
      dialogOpen,
      openDialog: () => setDialogOpen(true),
      closeDialog: () => setDialogOpen(false),
    }),
    [
      record,
      browserDeclines,
      vendorsPresent,
      decide,
      acceptAll,
      rejectAll,
      dialogOpen,
    ],
  )

  return (
    <ConsentContext.Provider value={value}>{children}</ConsentContext.Provider>
  )
}
