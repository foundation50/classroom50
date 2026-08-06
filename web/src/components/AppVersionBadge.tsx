import { appVersion, commitUrl, shortCommit } from "@/version"

// Small, unobtrusive build identifier. The version is a build-time constant
// (version.ts), not user-facing prose, so it isn't translated; the commit links
// to the exact commit on GitHub and its full build date shows in the title
// tooltip, making bug reports precise.
export function AppVersionBadge({ className }: { className?: string }) {
  return (
    <span
      className={className}
      title={`Built ${appVersion.buildDate}`}
      data-testid="app-version"
    >
      v{appVersion.version} ·{" "}
      <a
        className="link link-hover"
        href={commitUrl()}
        target="_blank"
        rel="noreferrer"
      >
        {shortCommit()}
      </a>
    </span>
  )
}
