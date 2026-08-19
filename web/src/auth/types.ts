export type GithubTokenResponse = {
  access_token?: string
  token_type?: string
  scope?: string
  error?: string
  error_description?: string
}

export type GithubDeviceCodeResponse = {
  device_code?: string
  user_code?: string
  verification_uri?: string
  expires_in?: number
  interval?: number
  error?: string
  error_description?: string
}

export type DeviceAuthState = {
  userCode: string
  verificationUri: string
  deviceCode: string
  expiresAt: number
  intervalSeconds: number
  attempts: number
  nextPollAt: number
  progress: 0 | 1 | 2
  // Which scope tier this flow requested, so a surface offering both (the
  // elevated-access dialog) never renders a pending code under the wrong label.
  elevated: boolean
}

export type GithubAuthScreen =
  "config" | "exchanging" | "device-prompt" | "pat-prompt" | "authed"

// Options shared by every sign-in starter. `elevated` broadens the requested
// scope for one flow only (see auth/constants.ts); `returnTo` survives the
// GitHub round-trip so a caller mid-task lands back where it was (#71).
export type SignInOptions = { elevated?: boolean }
export type WebSignInOptions = SignInOptions & { returnTo?: string }

// Which personal-access-token variant the PAT sign-in prompt guides the user
// through. Classic spans every org the teacher owns (the multi-org default);
// fine-grained is scoped to one org.
export type PatTokenType = "classic" | "fine-grained"

// How the session's token was obtained. Only OAuth tokens can be re-issued from
// inside the app, so this decides whether a missing destructive scope is a
// re-auth we can offer or a token the user has to replace on GitHub (#655).
// `null` means unknown — a session stored before this was tracked.
export type AuthMethod = "oauth" | "pat"
