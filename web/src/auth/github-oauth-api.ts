import { GITHUB_OAUTH_WORKER_BASE } from "./constants"
import type { GithubDeviceCodeResponse, GithubTokenResponse } from "./types"

// Must exactly match the OAuth App's registered callback URL (.../login).
// Deriving it from the live pathname breaks the web flow when launched from
// any other route (e.g. the re-authorize banner). See issue #57.
const OAUTH_CALLBACK_PATH = "/login"

function redirectUri() {
  return window.location.origin + OAUTH_CALLBACK_PATH
}

function assertOAuthSuccess(
  data: GithubTokenResponse,
): asserts data is GithubTokenResponse & {
  access_token: string
} {
  if (data.error) {
    throw new Error(data.error_description || data.error)
  }

  if (!data.access_token) {
    throw new Error("No access token in response")
  }
}

async function readJsonResponse<T>(res: Response): Promise<T> {
  const text = await res.text()

  let data: unknown

  try {
    data = text ? JSON.parse(text) : null
  } catch (err) {
    if (!res.ok) {
      throw new Error(`HTTP: ${res.status}: ${text || res.statusText}`, {
        cause: err,
      })
    }

    throw new Error(`Expected JSON but received: ${text.slice(0, 200)}`, {
      cause: err,
    })
  }

  if (!res.ok) {
    const maybeOAuthError = data as Partial<GithubTokenResponse>
    throw new Error(
      maybeOAuthError.error_description ||
        maybeOAuthError.error ||
        `HTTP ${res.status}`,
    )
  }

  return data as T
}

export async function exchangeWebCode(input: {
  clientId: string
  code: string
  verifier: string
}) {
  const res = await fetch(`${GITHUB_OAUTH_WORKER_BASE}/web/token`, {
    method: "POST",
    headers: {
      Accept: "application/json",
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      client_id: input.clientId,
      code: input.code,
      redirect_uri: redirectUri(),
      code_verifier: input.verifier,
    }),
  })

  const data = await readJsonResponse<GithubTokenResponse>(res)
  assertOAuthSuccess(data)
  return data
}

export async function requestDeviceCode(input: {
  clientId: string
  scope: string
}) {
  const res = await fetch(`${GITHUB_OAUTH_WORKER_BASE}/device/code`, {
    method: "POST",
    headers: {
      Accept: "application/json",
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      client_id: input.clientId,
      scope: input.scope,
    }),
  })

  const data = await readJsonResponse<GithubDeviceCodeResponse>(res)

  if (data.error) {
    throw new Error(data.error_description || data.error)
  }

  if (
    !data.device_code ||
    !data.user_code ||
    !data.verification_uri ||
    !data.expires_in
  ) {
    throw new Error("Incomplete device code response")
  }

  return data
}

export async function pollDeviceToken(input: {
  clientId: string
  deviceCode: string
  signal?: AbortSignal
}) {
  const res = await fetch(`${GITHUB_OAUTH_WORKER_BASE}/device/token`, {
    method: "POST",
    headers: {
      Accept: "application/json",
      "Content-Type": "application/json",
    },
    signal: input.signal,
    body: JSON.stringify({
      client_id: input.clientId,
      device_code: input.deviceCode,
      grant_type: "urn:ietf:params:oauth:grant-type:device_code",
    }),
  })

  return readJsonResponse<GithubTokenResponse>(res)
}

export function buildGithubAuthorizeUrl(input: {
  clientId: string
  scope: string
  state: string
  challenge: string
}) {
  const params = new URLSearchParams({
    client_id: input.clientId,
    redirect_uri: redirectUri(),
    scope: input.scope,
    state: input.state,
    code_challenge: input.challenge,
    code_challenge_method: "S256",
  })

  return `https://github.com/login/oauth/authorize?${params.toString()}`
}
