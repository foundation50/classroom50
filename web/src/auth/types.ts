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
}

export type GithubAuthScreen =
  "config" | "exchanging" | "device-prompt" | "pat-prompt" | "authed"

// Which personal-access-token variant the PAT sign-in prompt guides the user
// through. Classic spans every org the teacher owns (the multi-org default);
// fine-grained is scoped to one org.
export type PatTokenType = "classic" | "fine-grained"
