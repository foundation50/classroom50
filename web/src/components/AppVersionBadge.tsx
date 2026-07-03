import { appVersion, shortCommit } from "@/version"

// Small, unobtrusive build identifier. The version is a build-time constant
// (see version.ts), not user-facing prose, so it is not translated; the commit
// is included to make bug reports precise, and the full build date is exposed
// via the title tooltip.
export function AppVersionBadge({ className }: { className?: string }) {
  return (
    <span
      className={className}
      title={`Built ${appVersion.buildDate}`}
      data-testid="app-version"
    >
      v{appVersion.version} · {shortCommit()}
    </span>
  )
}
