import { GITHUB_AUTH_SESSION, GITHUB_AUTH_STORAGE } from "./constants"
import { isSafeReturnTo } from "./returnTo"
import type { AuthMethod } from "./types"
import {
  localStorageOrNull,
  sessionStorageOrNull,
  setItemOrIgnore,
} from "@/lib/webStorage"

// Every access goes through the guarded probes: touching `window.localStorage`
// throws SecurityError when storage is blocked (Safari "Block all cookies", an
// LMS iframe with third-party cookies off), and this module runs in the auth
// provider's mount effect, above every error boundary. Without storage the
// session simply doesn't persist across loads.

export function getStoredGithubToken() {
  return localStorageOrNull()?.getItem(GITHUB_AUTH_STORAGE.TOKEN) ?? null
}

export function getStoredGithubClientId() {
  return localStorageOrNull()?.getItem(GITHUB_AUTH_STORAGE.CLIENT_ID) ?? ""
}

export function getStoredGithubScope() {
  return localStorageOrNull()?.getItem(GITHUB_AUTH_STORAGE.SCOPE_GRANTED) ?? ""
}

// How the stored session signed in, or null when unknowable: a session persisted
// before this key existed, or a value localStorage no longer recognizes (it is
// user-writable, so an unrecognized string must not be trusted as a method).
export function getStoredAuthMethod(): AuthMethod | null {
  const stored = localStorageOrNull()?.getItem(GITHUB_AUTH_STORAGE.AUTH_METHOD)
  return stored === "oauth" || stored === "pat" ? stored : null
}

export function persistGithubClientId(clientId: string) {
  setItemOrIgnore(localStorageOrNull(), GITHUB_AUTH_STORAGE.CLIENT_ID, clientId)
}

export function persistGithubToken(
  token: string,
  scope = "",
  authMethod?: AuthMethod,
) {
  const storage = localStorageOrNull()
  if (!storage) return
  setItemOrIgnore(storage, GITHUB_AUTH_STORAGE.TOKEN, token)
  setItemOrIgnore(storage, GITHUB_AUTH_STORAGE.SCOPE_GRANTED, scope)
  // Remove rather than leave a stale value: a caller that doesn't know the
  // method must produce "unknown", not inherit the previous session's.
  if (authMethod) {
    setItemOrIgnore(storage, GITHUB_AUTH_STORAGE.AUTH_METHOD, authMethod)
  } else {
    storage.removeItem(GITHUB_AUTH_STORAGE.AUTH_METHOD)
  }
}

export function clearGithubToken() {
  const storage = localStorageOrNull()
  if (!storage) return
  storage.removeItem(GITHUB_AUTH_STORAGE.TOKEN)
  storage.removeItem(GITHUB_AUTH_STORAGE.SCOPE_GRANTED)
  storage.removeItem(GITHUB_AUTH_STORAGE.AUTH_METHOD)
}

export function saveOAuthSession(input: {
  verifier: string
  state: string
  clientId: string
  scope: string
  // Same-origin deep link to return to after sign-in (#71); kept only if it
  // passes isSafeReturnTo. May carry the accept ?k= key, so it's briefly
  // persisted — safe: sessionStorage is same-origin and per-tab, cleared on
  // consume, and the secret is already in the URL the user arrived from.
  returnTo?: string | null
}) {
  const storage = sessionStorageOrNull()
  if (!storage) return

  setItemOrIgnore(storage, GITHUB_AUTH_SESSION.VERIFIER, input.verifier)
  setItemOrIgnore(storage, GITHUB_AUTH_SESSION.STATE, input.state)
  setItemOrIgnore(storage, GITHUB_AUTH_SESSION.CLIENT_ID, input.clientId)
  setItemOrIgnore(storage, GITHUB_AUTH_SESSION.SCOPE, input.scope)

  if (isSafeReturnTo(input.returnTo)) {
    setItemOrIgnore(storage, GITHUB_AUTH_SESSION.RETURN_TO, input.returnTo)
  } else {
    storage.removeItem(GITHUB_AUTH_SESSION.RETURN_TO)
  }
}

export function consumeOAuthSession() {
  const storage = sessionStorageOrNull()
  if (!storage) {
    return {
      verifier: null,
      expectedState: null,
      clientId: null,
      scope: null,
      returnTo: null,
    }
  }

  const verifier = storage.getItem(GITHUB_AUTH_SESSION.VERIFIER)
  const expectedState = storage.getItem(GITHUB_AUTH_SESSION.STATE)
  const clientId = storage.getItem(GITHUB_AUTH_SESSION.CLIENT_ID)
  const scope = storage.getItem(GITHUB_AUTH_SESSION.SCOPE)
  const storedReturnTo = storage.getItem(GITHUB_AUTH_SESSION.RETURN_TO)

  storage.removeItem(GITHUB_AUTH_SESSION.VERIFIER)
  storage.removeItem(GITHUB_AUTH_SESSION.STATE)
  storage.removeItem(GITHUB_AUTH_SESSION.CLIENT_ID)
  storage.removeItem(GITHUB_AUTH_SESSION.SCOPE)
  storage.removeItem(GITHUB_AUTH_SESSION.RETURN_TO)

  // Re-validate on read: sessionStorage is user-writable.
  const returnTo = isSafeReturnTo(storedReturnTo) ? storedReturnTo : null

  return {
    verifier,
    expectedState,
    clientId,
    scope,
    returnTo,
  }
}
