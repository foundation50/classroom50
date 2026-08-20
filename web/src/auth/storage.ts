import { GITHUB_AUTH_SESSION, GITHUB_AUTH_STORAGE } from "./constants"
import { isSafeReturnTo } from "./returnTo"
import type { AuthMethod } from "./types"

function canUseBrowserStorage() {
  return typeof window !== "undefined"
}

export function getStoredGithubToken() {
  if (!canUseBrowserStorage()) return null
  return localStorage.getItem(GITHUB_AUTH_STORAGE.TOKEN)
}

export function getStoredGithubClientId() {
  if (!canUseBrowserStorage()) return ""
  return localStorage.getItem(GITHUB_AUTH_STORAGE.CLIENT_ID) ?? ""
}

export function getStoredGithubScope() {
  if (!canUseBrowserStorage()) return ""
  return localStorage.getItem(GITHUB_AUTH_STORAGE.SCOPE_GRANTED) ?? ""
}

// How the stored session signed in, or null when unknowable: a session persisted
// before this key existed, or a value localStorage no longer recognizes (it is
// user-writable, so an unrecognized string must not be trusted as a method).
export function getStoredAuthMethod(): AuthMethod | null {
  if (!canUseBrowserStorage()) return null
  const stored = localStorage.getItem(GITHUB_AUTH_STORAGE.AUTH_METHOD)
  return stored === "oauth" || stored === "pat" ? stored : null
}

export function persistGithubClientId(clientId: string) {
  if (!canUseBrowserStorage()) return
  localStorage.setItem(GITHUB_AUTH_STORAGE.CLIENT_ID, clientId)
}

export function persistGithubToken(
  token: string,
  scope = "",
  authMethod?: AuthMethod,
) {
  if (!canUseBrowserStorage()) return
  localStorage.setItem(GITHUB_AUTH_STORAGE.TOKEN, token)
  localStorage.setItem(GITHUB_AUTH_STORAGE.SCOPE_GRANTED, scope)
  // Remove rather than leave a stale value: a caller that doesn't know the
  // method must produce "unknown", not inherit the previous session's.
  if (authMethod) {
    localStorage.setItem(GITHUB_AUTH_STORAGE.AUTH_METHOD, authMethod)
  } else {
    localStorage.removeItem(GITHUB_AUTH_STORAGE.AUTH_METHOD)
  }
}

export function clearGithubToken() {
  if (!canUseBrowserStorage()) return
  localStorage.removeItem(GITHUB_AUTH_STORAGE.TOKEN)
  localStorage.removeItem(GITHUB_AUTH_STORAGE.SCOPE_GRANTED)
  localStorage.removeItem(GITHUB_AUTH_STORAGE.AUTH_METHOD)
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
  if (!canUseBrowserStorage()) return

  sessionStorage.setItem(GITHUB_AUTH_SESSION.VERIFIER, input.verifier)
  sessionStorage.setItem(GITHUB_AUTH_SESSION.STATE, input.state)
  sessionStorage.setItem(GITHUB_AUTH_SESSION.CLIENT_ID, input.clientId)
  sessionStorage.setItem(GITHUB_AUTH_SESSION.SCOPE, input.scope)

  if (isSafeReturnTo(input.returnTo)) {
    sessionStorage.setItem(GITHUB_AUTH_SESSION.RETURN_TO, input.returnTo)
  } else {
    sessionStorage.removeItem(GITHUB_AUTH_SESSION.RETURN_TO)
  }
}

export function consumeOAuthSession() {
  if (!canUseBrowserStorage()) {
    return {
      verifier: null,
      expectedState: null,
      clientId: null,
      scope: null,
      returnTo: null,
    }
  }

  const verifier = sessionStorage.getItem(GITHUB_AUTH_SESSION.VERIFIER)
  const expectedState = sessionStorage.getItem(GITHUB_AUTH_SESSION.STATE)
  const clientId = sessionStorage.getItem(GITHUB_AUTH_SESSION.CLIENT_ID)
  const scope = sessionStorage.getItem(GITHUB_AUTH_SESSION.SCOPE)
  const storedReturnTo = sessionStorage.getItem(GITHUB_AUTH_SESSION.RETURN_TO)

  sessionStorage.removeItem(GITHUB_AUTH_SESSION.VERIFIER)
  sessionStorage.removeItem(GITHUB_AUTH_SESSION.STATE)
  sessionStorage.removeItem(GITHUB_AUTH_SESSION.CLIENT_ID)
  sessionStorage.removeItem(GITHUB_AUTH_SESSION.SCOPE)
  sessionStorage.removeItem(GITHUB_AUTH_SESSION.RETURN_TO)

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
