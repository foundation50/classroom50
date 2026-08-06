import { useSyncExternalStore } from "react"

import { checkInternetLiveness } from "@/lib/internetLiveness"

// Connectivity signal for the UI, conservative about declaring the device
// offline. navigator.onLine is only a hint: browsers flip it false (and fire
// `offline`) on transient network-stack hiccups — a route drop, a VPN/proxy
// flap — while the device is still online. That false-positive is what made a
// GitHub incident surface as "You're offline". So a *live* `offline` event no
// longer flips us directly; we corroborate with an internet-liveness probe (see
// internetLiveness.ts) and only report offline when the probe also fails. An
// `online` event is trusted immediately — it can only clear an offline state.
//
// The initial page-load reading IS trusted synchronously (see the seed below),
// preserving the auth guard's #187 contract.
//
// Module-level store (not React state) so every subscriber reads one source via
// useSyncExternalStore and the async probe result is shared.

// Seed synchronously from navigator.onLine so a hard-offline cold load (Wi-Fi
// off) reads offline on the first render — resolveAuthStatus (#187) depends on
// this to hold a valid session at "loading" instead of bouncing it to /login.
// The probe then only ever *clears* this seed (a captive portal that in fact
// reaches the internet), never asserts offline mid-session on its own.
let confirmedOffline =
  typeof navigator !== "undefined" ? !navigator.onLine : false
// Bumped on every online/offline transition so a probe that resolves after the
// state moved on can't apply its stale verdict.
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

// A restored link is unambiguous; clear immediately and bump the epoch so an
// in-flight offline probe can't flip us back.
function handleOnline() {
  probeEpoch++
  setConfirmedOffline(false)
}

function subscribe(onChange: () => void) {
  listeners.add(onChange)
  window.addEventListener("online", handleOnline)
  window.addEventListener("offline", handleOffline)
  // A cold load that started offline already read offline synchronously (the
  // `confirmedOffline` seed above). Still run the probe so a captive portal /
  // spurious seed that actually reaches the internet gets cleared.
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

// True means online (or at least reaching the wider internet); false means a
// probe-confirmed hard-offline device.
export function useOnlineStatus(): boolean {
  return useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot)
}

// Test-only reset that re-seeds from navigator.onLine, mirroring module load so
// a test can stage a cold-offline start by setting navigator.onLine then reset.
export function __resetOnlineStatusForTest(): void {
  confirmedOffline =
    typeof navigator !== "undefined" ? !navigator.onLine : false
  probeEpoch = 0
}

export default useOnlineStatus
