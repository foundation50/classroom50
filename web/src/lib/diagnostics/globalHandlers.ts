// Passive global capture of async / out-of-render errors that otherwise reach
// only the browser console — an uncaught exception outside a React render, or
// an unhandled promise rejection. They feed the same diagnostics buffer as
// GitHub API errors so a snapshot reflects them too.
//
// Passive by design: the handlers only record. They never preventDefault, so
// the console output and the router errorComponent still fire as before.

import { recordError } from "./buffer"

let installed = false

export function installDiagnosticsHandlers(): void {
  // StrictMode double-invoke and HMR can call this twice; register once.
  if (installed || typeof window === "undefined") return
  installed = true

  window.addEventListener("error", (event) => {
    // event.error is the thrown value when available; fall back to the message
    // (e.g. cross-origin script errors that null out error).
    recordError(event.error ?? new Error(event.message || "Unknown error"))
  })

  window.addEventListener("unhandledrejection", (event) => {
    recordError(event.reason)
  })
}
