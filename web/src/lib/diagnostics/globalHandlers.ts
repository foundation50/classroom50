// Passive global capture of async / out-of-render errors that otherwise reach
// only the browser console — an uncaught exception outside a React render, or
// an unhandled promise rejection. They feed the session Activity store so the
// activity view and the diagnostics snapshot reflect them too.
//
// Passive by design: the handlers only record. They never preventDefault, so
// the console output and the router errorComponent still fire as before.

import { recordError } from "@/lib/activity/activityStore"

let installed = false

export function installDiagnosticsHandlers(): void {
  // StrictMode double-invoke and HMR can call this twice; register once.
  if (installed || typeof window === "undefined") return
  installed = true

  window.addEventListener("error", (event) => {
    // event.error is the thrown value when available; fall back to the message
    // (e.g. cross-origin script errors that null out error). The event's
    // filename:lineno is a reliable source even when a stack is unavailable.
    const source =
      event.filename && event.lineno
        ? `${event.filename.split("/").pop()}:${event.lineno}${
            event.colno ? `:${event.colno}` : ""
          }`
        : undefined
    recordError(event.error ?? new Error(event.message || "Unknown error"), {
      source,
    })
  })

  window.addEventListener("unhandledrejection", (event) => {
    recordError(event.reason)
  })
}
