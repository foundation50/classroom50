// The GUI bundles the classroom50 config-repo skeleton (workflows + scripts)
// into its deploy artifact rather than fetching it from the CLI mirror at
// runtime. The one canonical copy stays at `cli/gh-teacher/skeleton/dotgithub/`
// because the CLI embeds it via `//go:embed`, which can't reference a parent
// dir. Vite inlines the files below at build time, so each deploy carries the
// skeleton from its own commit.

// dotgithub/ is rewritten to .github/ at commit time; the source dir is named
// `dotgithub` because `//go:embed` (no `all:`) skips dot-prefixed paths.
const SKELETON_SOURCE_DIR = "dotgithub"
export const ORG_GITHUB_DIR = ".github"

// Substituted with the config repo's default branch at commit time, so
// publish-pages.yaml's push trigger fires.
export const DEFAULT_BRANCH_PLACEHOLDER = "{{DEFAULT_BRANCH}}"

// skeleton.test.ts guards this against drift from the CLI's embedded set.
const rawModules = import.meta.glob<string>(
  [
    "../../../cli/gh-teacher/skeleton/dotgithub/**/*.yaml",
    "../../../cli/gh-teacher/skeleton/dotgithub/**/*.py",
  ],
  { query: "?raw", import: "default", eager: true },
)

// The org-relative paths the GUI deploys into `<org>/classroom50`. A subset of
// the CLI skeleton tree — enough to stand a classroom up and run regrade.
export const SKELETON_PATHS = [
  "workflows/publish-pages.yaml",
  "workflows/collect-scores.yaml",
  "workflows/autograde-runner.yaml",
  "workflows/regrade.yaml",
  "scripts/collect_scores.py",
  "scripts/runner.py",
  // Expands assignments.json `tests` into per-assignment tests.json at
  // publish-pages time; without it declarative tests never grade.
  "scripts/materialize_tests.py",
  // Opt-in Feedback PR, fetched from Pages by autograde-runner.yaml.
  "scripts/ensure_feedback_pr.py",
  // Regrade fan-out invoked by regrade.yaml.
  "scripts/regrade_repos.py",
  // Teacher-triggered service-token scope probe (workflow_dispatch). Deployed
  // so GUI org setup ships the same health check as `gh teacher init`.
  "workflows/probe-token.yaml",
  "scripts/probe_token.py",
] as const

// The scaffold marker used to tell a genuine config repo from an org that
// merely owns a repo named `classroom50`. Typed as a SKELETON_PATHS member so a
// rename that drops the workflow fails the build here instead of silently
// hiding every real teacher's org behind a 404 (see verifyClassroom50ConfigRepo
// in hooks/github/queries.ts).
export const CONFIG_REPO_MARKER_REL: (typeof SKELETON_PATHS)[number] =
  "workflows/autograde-runner.yaml"

// Map a bundled module key to its org-relative skeleton path, e.g.
//   .../skeleton/dotgithub/workflows/publish-pages.yaml -> workflows/publish-pages.yaml
function toSkeletonRelPath(moduleKey: string): string | null {
  const marker = `/${SKELETON_SOURCE_DIR}/`
  const idx = moduleKey.indexOf(marker)
  if (idx === -1) return null
  return moduleKey.slice(idx + marker.length)
}

// The bundled skeleton, keyed by org-relative path (e.g.
// "workflows/publish-pages.yaml" -> contents).
const BUNDLED_SKELETON: ReadonlyMap<string, string> = (() => {
  const out = new Map<string, string>()
  for (const [key, contents] of Object.entries(rawModules)) {
    const rel = toSkeletonRelPath(key)
    if (rel) out.set(rel, contents)
  }
  return out
})()

export type SkeletonFile = {
  // Path inside the target config repo, e.g. ".github/workflows/...".
  path: string
  mode: "100644"
  type: "blob"
  content: string
}

// Resolve a declared skeleton set into target-repo files from a bundle, with the
// default-branch placeholder substituted. Throws if a declared path isn't in the
// bundle. Extracted from buildSkeletonFiles so the missing-path throw is
// exercisable in skeleton.test.ts without faking the build-time glob.
export function buildSkeletonFilesFromBundle(
  paths: readonly string[],
  bundle: ReadonlyMap<string, string>,
  defaultBranch: string,
): SkeletonFile[] {
  return paths.map((rel) => {
    const content = bundle.get(rel)
    if (content === undefined) {
      throw new Error(
        `Bundled skeleton file missing: ${rel}. The web build did not include ` +
          `cli/gh-teacher/skeleton/${SKELETON_SOURCE_DIR}/${rel}.`,
      )
    }
    return {
      path: `${ORG_GITHUB_DIR}/${rel}`,
      mode: "100644" as const,
      type: "blob" as const,
      content: content.replaceAll(DEFAULT_BRANCH_PLACEHOLDER, defaultBranch),
    }
  })
}

// Resolve the GUI's skeleton set into target-repo files with the default-branch
// placeholder substituted. Throws if a declared path isn't bundled (a build
// bug, caught by skeleton.test.ts before deploy).
export function buildSkeletonFiles(defaultBranch: string): SkeletonFile[] {
  return buildSkeletonFilesFromBundle(
    SKELETON_PATHS,
    BUNDLED_SKELETON,
    defaultBranch,
  )
}

// Org-relative paths present in the bundle; for the parity test.
export function bundledSkeletonPaths(): string[] {
  return [...BUNDLED_SKELETON.keys()].sort()
}
