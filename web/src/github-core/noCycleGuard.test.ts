import { describe, expect, it } from "vitest"
import { execFileSync } from "node:child_process"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { fileURLToPath } from "node:url"

// Proves the data-layer no-cycle guard (eslint.config.js) actually trips on a
// real cycle. The guard's failure mode is silent: it went inert once already
// (no parser/resolver → it resolved zero @/* edges and passed green while a
// cycle existed), and a future eslint-plugin-import-x bump could re-break the
// rule/resolver wiring while the co-scoped no-unresolved tripwire stays green.
// Nothing else in CI would notice. This writes a two-file cycle INSIDE the
// guarded scope, runs eslint, and asserts import-x/no-cycle fires by rule id
// (not just a non-zero exit — a no-unresolved failure must not masquerade as a
// no-cycle pass).

const CORE_DIR = fileURLToPath(new URL(".", import.meta.url))

type EslintMessage = { ruleId: string | null }
type EslintFileResult = { messages: EslintMessage[] }

// Run eslint over `paths` and return every rule id it reported. `npx eslint`
// exits non-zero when errors are found, so execFileSync throwing is expected;
// the JSON report is on stdout either way.
function ruleIdsFor(paths: string[]): string[] {
  let stdout: string
  try {
    stdout = execFileSync("npx", ["eslint", "--format", "json", ...paths], {
      cwd: fileURLToPath(new URL("../..", import.meta.url)),
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    })
  } catch (err) {
    stdout = (err as { stdout?: string }).stdout ?? ""
  }
  const results = JSON.parse(stdout) as EslintFileResult[]
  return results.flatMap((r) => r.messages.map((m) => m.ruleId ?? ""))
}

describe("data-layer no-cycle guard is live", () => {
  it("reports import-x/no-cycle on a cycle inside the guarded scope", () => {
    // Temp dir under src/github-core so the guard's files glob matches it.
    const dir = mkdtempSync(`${CORE_DIR}__nocycle_probe_`)
    try {
      writeFileSync(
        `${dir}/a.ts`,
        `import { b } from "./b"\nexport const a = () => b()\n`,
      )
      writeFileSync(
        `${dir}/b.ts`,
        `import { a } from "./a"\nexport const b = () => a()\n`,
      )

      const cycleIds = ruleIdsFor([`${dir}/a.ts`, `${dir}/b.ts`])
      expect(
        cycleIds,
        "The no-cycle guard did not fire on a real cycle in src/github-core — it has gone inert (check the parser/resolver wiring and files glob in eslint.config.js).",
      ).toContain("import-x/no-cycle")

      // Positive control: a non-cyclic file in the same scope must NOT report
      // no-cycle. Guards against a globally-broken eslint that errors on
      // everything (which would make the assertion above a false pass).
      writeFileSync(`${dir}/c.ts`, `export const c = () => 1\n`)
      expect(ruleIdsFor([`${dir}/c.ts`])).not.toContain("import-x/no-cycle")
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
