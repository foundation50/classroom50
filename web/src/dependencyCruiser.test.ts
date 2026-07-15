import { describe, expect, it } from "vitest"
import { execFileSync } from "node:child_process"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { fileURLToPath } from "node:url"

// Proves the CI-side dependency-cruiser guard (.dependency-cruiser.cjs) actually
// trips on the invariants it claims to enforce. Same silent-failure risk as the
// eslint boundaries guard: a mis-typed `from`/`to` path regex or a dropped
// forbidden rule would leave `arch:validate` permanently green while a real
// reach-up or cycle slips through, and nothing else in CI would notice. This is
// the second, independent check — its own liveness matters as much as eslint's,
// and its no-circular rule has no eslint counterpart in the boundaries block.
//
// We write temp probe files inside real layer dirs, run depcruise over just those
// files with the project config, and assert on the violated rule `name` in the
// JSON report — not the exit code, since a globally-broken depcruise erroring on
// everything must not read as a real catch.

const COMPONENTS_DIR = fileURLToPath(new URL("./components", import.meta.url))
const GITHUB_CORE_DIR = fileURLToPath(new URL("./github-core", import.meta.url))
const DOMAIN_DIR = fileURLToPath(new URL("./domain", import.meta.url))
const WEB_ROOT = fileURLToPath(new URL("../", import.meta.url))
const DEPCRUISE_BIN = fileURLToPath(
  new URL("../node_modules/.bin/depcruise", import.meta.url),
)

const TIMEOUT_MS = 120_000

type DepcruiseReport = {
  summary: {
    violations: { rule: { name: string }; from: string; to: string }[]
  }
}

// Run depcruise over the given paths and return the set of violated rule names.
function violatedRuleNames(paths: string[]): Set<string> {
  let stdout: string
  try {
    stdout = execFileSync(
      DEPCRUISE_BIN,
      [
        "--config",
        ".dependency-cruiser.cjs",
        "--output-type",
        "json",
        ...paths,
      ],
      {
        cwd: WEB_ROOT,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
        // The JSON report embeds the full resolved dependency graph of the probe
        // targets (a page pulls in a large transitive tree), so it easily exceeds
        // execFileSync's 1MB default and would otherwise be truncated into invalid
        // JSON.
        maxBuffer: 64 * 1024 * 1024,
      },
    )
  } catch (err) {
    // Non-zero exit is expected when violations are found; the JSON we need is
    // still on stdout.
    stdout = (err as { stdout?: string }).stdout ?? ""
  }
  const report = JSON.parse(stdout) as DepcruiseReport
  return new Set(report.summary.violations.map((v) => v.rule.name))
}

describe("dependency-cruiser architecture guard is live", () => {
  it(
    "reports forbidden-rule violations on layer inversions and cycles but not on legal edges",
    { timeout: TIMEOUT_MS },
    () => {
      const compDir = mkdtempSync(`${COMPONENTS_DIR}/__depcruise_probe_`)
      const coreDir = mkdtempSync(`${GITHUB_CORE_DIR}/__depcruise_probe_`)
      const domainDir = mkdtempSync(`${DOMAIN_DIR}/__depcruise_probe_`)
      try {
        // components -> pages: must trip components-not-to-pages.
        writeFileSync(
          `${compDir}/compUpward.ts`,
          `import ClassesPage from "@/pages/ClassesPage"\nexport const a = ClassesPage\n`,
        )
        // components -> util: a legal downward edge. Must NOT trip any rule.
        writeFileSync(
          `${compDir}/compDownward.ts`,
          `import { rosterPath } from "@/util/rosterPath"\nexport const b = rosterPath\n`,
        )
        // domain -> pages: must trip domain-not-to-view.
        writeFileSync(
          `${domainDir}/domainUpward.ts`,
          `import ClassesPage from "@/pages/ClassesPage"\nexport const c = ClassesPage\n`,
        )
        // A two-file cycle inside the data layer: must trip no-circular.
        writeFileSync(
          `${coreDir}/cycleA.ts`,
          `import { b as cycleB } from "./cycleB"\nexport const a = () => cycleB\n`,
        )
        writeFileSync(
          `${coreDir}/cycleB.ts`,
          `import { a as cycleA } from "./cycleA"\nexport const b = () => cycleA\n`,
        )

        const compViolations = violatedRuleNames([`${compDir}/compUpward.ts`])
        expect(
          compViolations,
          "no-circular/components-not-to-pages did not fire on a components->pages import — the depcruise guard has gone inert (check the forbidden rules in .dependency-cruiser.cjs).",
        ).toContain("components-not-to-pages")

        const domainViolations = violatedRuleNames([
          `${domainDir}/domainUpward.ts`,
        ])
        expect(
          domainViolations,
          "domain-not-to-view did not fire on a domain->pages import — the depcruise domain rule has gone inert.",
        ).toContain("domain-not-to-view")

        // no-circular is unique to depcruise (the eslint boundaries block has no
        // cycle check), so its liveness is only guarded here.
        const cycleViolations = violatedRuleNames([
          `${coreDir}/cycleA.ts`,
          `${coreDir}/cycleB.ts`,
        ])
        expect(
          cycleViolations,
          "no-circular did not fire on a github-core cycle — the only cycle guard in depcruise has gone inert.",
        ).toContain("no-circular")

        const downwardViolations = violatedRuleNames([
          `${compDir}/compDownward.ts`,
        ])
        expect(
          [...downwardViolations],
          "a forbidden rule fired on a legal components->util downward import — a rule path is too broad.",
        ).toHaveLength(0)
      } finally {
        rmSync(compDir, { recursive: true, force: true })
        rmSync(coreDir, { recursive: true, force: true })
        rmSync(domainDir, { recursive: true, force: true })
      }
    },
  )
})
