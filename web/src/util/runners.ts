// Advisory, non-blocking verification for the "GitHub Runner" field. Per the
// autograder spec, `runtime.runs-on` is one or more GitHub Actions labels with
// no allow-list: a single GitHub-hosted label ("ubuntu-latest") or AND-ed
// labels for a self-hosted runner ("self-hosted, linux, x64"). Helpers only
// classify the teacher's value, never rewrite it.

// GitHub-hosted labels (from the org's default runner settings). Not
// exhaustive; only used to recognize a label as always-available.
const KNOWN_HOSTED_RUNNER_LABELS = [
  "ubuntu-latest",
  "ubuntu-24.04",
  "ubuntu-22.04",
  "windows-latest",
  "windows-2025",
  "windows-2022",
  "windows-11-arm",
  "macos-latest",
  "macos-latest-large",
  "macos-latest-xl",
  "macos-15",
  "macos-15-intel",
  "macos-15-xlarge",
  "macos-14-large",
] as const

const KNOWN_HOSTED_RUNNER_SET = new Set<string>(
  KNOWN_HOSTED_RUNNER_LABELS.map((label) => label.toLowerCase()),
)

// Default labels a self-hosted runner gets at registration (self-hosted + OS +
// arch). Recognized as valid so the UI doesn't flag them as typos when the org
// runner list can't be read.
const STANDARD_SELF_HOSTED_LABELS = new Set<string>([
  "self-hosted",
  "linux",
  "windows",
  "macos",
  "x64",
  "arm",
  "arm64",
])

export function isStandardSelfHostedLabel(label: string): boolean {
  return STANDARD_SELF_HOSTED_LABELS.has(label.trim().toLowerCase())
}

// Split a runner value into labels on commas/whitespace; tolerates an array.
export function parseRunnerLabels(raw: string | string[]): string[] {
  const parts = Array.isArray(raw) ? raw : raw.split(/[\s,]+/)
  return parts.map((p) => p.trim()).filter(Boolean)
}

// Identical to the CLI's RunsOnLabelPattern (anti-injection shape gate).
const RUNS_ON_LABEL_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/

export function isRunnerLabelShapeValid(label: string): boolean {
  return RUNS_ON_LABEL_PATTERN.test(label)
}

// The CLI rejects more than 10 labels.
export const MAX_RUNNER_LABELS = 10

export function isKnownHostedRunnerLabel(label: string): boolean {
  return KNOWN_HOSTED_RUNNER_SET.has(label.trim().toLowerCase())
}

export type OrgRunner = {
  id: number
  name: string
  os: string
  status: string
  labels: { name: string }[]
}

// "Unavailable" (token lacks admin:org, or org unreachable) is distinct from
// an empty runner list (readable, but none registered).
export type OrgRunnersResult =
  | { available: true; runners: OrgRunner[] }
  | { available: false; reason: "no-access" | "error" }

function selfHostedRunnersForLabel(
  result: OrgRunnersResult,
  label: string,
): string[] {
  if (!result.available) return []
  const target = label.trim().toLowerCase()
  if (!target) return []

  return result.runners
    .filter((runner) =>
      (runner.labels ?? []).some((l) => l.name.trim().toLowerCase() === target),
    )
    .map((runner) => runner.name)
}

type LabelVerification =
  | { kind: "invalid-shape"; label: string }
  | { kind: "known-hosted"; label: string }
  | { kind: "standard"; label: string }
  | { kind: "self-hosted-match"; label: string; runnerNames: string[] }
  | { kind: "unverified"; label: string }
  | { kind: "unknown"; label: string; reason: "no-access" | "error" }

function verifyOneLabel(
  label: string,
  orgRunners: OrgRunnersResult,
): LabelVerification {
  if (!isRunnerLabelShapeValid(label)) return { kind: "invalid-shape", label }
  if (isKnownHostedRunnerLabel(label)) return { kind: "known-hosted", label }
  if (isStandardSelfHostedLabel(label)) return { kind: "standard", label }

  const runnerNames = selfHostedRunnersForLabel(orgRunners, label)
  if (runnerNames.length > 0) {
    return { kind: "self-hosted-match", label, runnerNames }
  }

  if (!orgRunners.available) {
    return { kind: "unknown", label, reason: orgRunners.reason }
  }

  return { kind: "unverified", label }
}

export type RunnerVerification =
  | { kind: "empty" }
  | { kind: "hosted"; labels: LabelVerification[] }
  | { kind: "self-hosted"; labels: LabelVerification[]; confirmed: boolean }
  | { kind: "problem"; labels: LabelVerification[] }
  | { kind: "too-many"; count: number }
  | { kind: "unknown"; labels: LabelVerification[] }

export function verifyRunnerLabels(
  raw: string,
  orgRunners: OrgRunnersResult,
): RunnerVerification {
  const parsed = parseRunnerLabels(raw)
  if (parsed.length === 0) return { kind: "empty" }
  if (parsed.length > MAX_RUNNER_LABELS) {
    return { kind: "too-many", count: parsed.length }
  }

  const labels = parsed.map((label) => verifyOneLabel(label, orgRunners))

  if (
    labels.some((l) => l.kind === "invalid-shape" || l.kind === "unverified")
  ) {
    return { kind: "problem", labels }
  }

  if (labels.length === 1 && labels[0].kind === "known-hosted") {
    return { kind: "hosted", labels }
  }

  const looksSelfHosted = labels.some(
    (l) => l.kind === "standard" || l.kind === "self-hosted-match",
  )

  if (looksSelfHosted) {
    // Unconfirmed only when an unrecognized label couldn't be checked (org list
    // unreadable); standard/known-hosted labels are self-evidently fine.
    const confirmed = !labels.some((l) => l.kind === "unknown")
    return { kind: "self-hosted", labels, confirmed }
  }

  return { kind: "unknown", labels }
}
