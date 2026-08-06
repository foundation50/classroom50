import { useSyncExternalStore } from "react"

import { checkInternetLiveness } from "@/lib/internetLiveness"

// Connectivity signal for the UI, deliberately conservative about declaring the
// device offline. navigator.onLine is only a hint in BOTH directions:
//
//   - true  -> "probably reachable" (a captive portal / dead uplink still reads
//              as online). We never treat this as a claim a specific host is up;
//              GitHub's reachability is the GitHub-health detector's job.
//   - false -> "the OS reports no link" — reliable for Wi-Fi off / cable
//              unplugged / airplane mode, but browsers ALSO flip it false (and
//              fire `offline`) on transient network-stack hiccups (a route drop,
//              a VPN/proxy flap) while the device is actually still online.
//
// That false-positive `offline` is what made a GitHub incident surface as
// "You're offline". So we no longer trust `false` blindly: on an offline signal
// we corroborate with an independent internet-liveness probe (see
// internetLiveness.ts) and only report offline when the probe also fails. An
// `online` event is trusted immediately — it can only clear an offline state.
//
// Module-level store (not React state) so every subscriber reads one source via
// useSyncExternalStore, and so the async probe result is shared rather than
// re-run per component.

let confirmedOffline = false
// Bumped on every online/offline transition so a probe that resolves after the
// state already moved on can't apply its stale verdict.
let probeEpoch = 0
const listeners = new Set<() => void>()

function emit() {
  for (const listener of listeners) listener()
}

function setConfirmedOffline(next: boolean) {
  if (confirmedOffline === next) return
  confirmedOffline = next
  emit()
}

// The browser reports no link. Corroborate before believing it: a real
// hard-offline device fails the probe (-> offline); a spurious flip or captive
// portal still reaches the internet (-> stay online, let GitHub reads speak).
function handleOffline() {
  const epoch = ++probeEpoch
  void checkInternetLiveness().then((online) => {
    // A later transition superseded this probe (e.g. `online` fired, or another
    // `offline` re-armed) — discard its now-stale result.
    if (epoch !== probeEpoch) return
    setConfirmedOffline(!online)
  })
}

// A restored link is unambiguous good news; clear immediately and invalidate any
// in-flight offline probe so it can't flip us back.
function handleOnline() {
  probeEpoch++
  setConfirmedOffline(false)
}

function subscribe(onChange: () => void) {
  listeners.add(onChange)
  window.addEventListener("online", handleOnline)
  window.addEventListener("offline", handleOffline)
  // Seed from a cold load that started offline: navigator.onLine is synchronous,
  // but confirmation is async, so kick the same corroborated path.
  if (typeof navigator !== "undefined" && !navigator.onLine) handleOffline()
  return () => {
    listeners.delete(onChange)
    window.removeEventListener("online", handleOnline)
    window.removeEventListener("offline", handleOffline)
  }
}

function getSnapshot() {
  return !confirmedOffline
}

// SSR/tests without a navigator default to online so nothing renders an offline
// state on the server.
function getServerSnapshot() {
  return true
}

// Live browser connectivity. True means "online (or at least reaching the wider
// internet)"; false means a probe-confirmed hard-offline device. It never
// claims a specific host is up — that's what the actual fetch is for.
export function useOnlineStatus(): boolean {
  return useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot)
}

// Test-only reset so the module-level state doesn't leak between cases.
export function __resetOnlineStatusForTest(): void {
  confirmedOffline = false
  probeEpoch = 0
}

export default useOnlineStatus
