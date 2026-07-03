// Open-redirect guard for post-auth / post-onboarding return targets: only a
// same-origin relative path ("/" but not "//", which is a protocol-relative
// absolute URL). Shared by the login redirect and the onboarding returnTo.
export function isSafeReturnTo(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.startsWith("/") &&
    !value.startsWith("//")
  )
}
