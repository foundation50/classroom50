// A post-auth / post-onboarding return target is only ever a SAME-ORIGIN
// relative path: it must start with a single "/" and not "//" (which the
// browser treats as a protocol-relative absolute URL to another host). This is
// the open-redirect guard shared by the login redirect (#71) and the onboarding
// returnTo. Anything else — an absolute URL, a "//evil.com" path, a non-string
// — is rejected so a crafted link can't bounce a freshly authenticated user to
// an attacker origin.
export function isSafeReturnTo(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.startsWith("/") &&
    !value.startsWith("//")
  )
}
