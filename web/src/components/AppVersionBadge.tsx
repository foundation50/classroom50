import { appVersion, shortCommit } from "@/version"

// Small, unobtrusive build identifier. The version is a build-time constant
// (version.ts), not user-facing prose, so it isn't translated; the commit makes
// bug reports precise and the full build date shows in the title tooltip.
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
