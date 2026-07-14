import { describe, expect, it } from "vitest"
import { execFileSync } from "node:child_process"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { fileURLToPath } from "node:url"

// Proves the data-layer no-cycle guard (eslint.config.js) actually trips on a
// real cycle. The guard's failure mode is silent: it went inert once already
// (no parser/resolver → it resolved zero @/* edges and passed green while a
// cycle existed), and a future eslint-plugin-import-x bump could re-break the
// rule/resolver wiring while the co-scoped no-unresolved tripwire stays green.
// Nothing else in CI would notice. This writes a two-file cycle plus a clean
// control INSIDE the guarded scope, runs eslint once, and asserts
// import-x/no-cycle fires by rule id on the cycle files but not the control
// (a non-zero exit alone isn't enough — a no-unresolved failure must not
// masquerade as a no-cycle pass, and a globally-broken eslint must not read as
// a real catch).

const CORE_DIR = fileURLToPath(new URL(".", import.meta.url))
const WEB_ROOT = fileURLToPath(new URL("../..", import.meta.url))
const ESLINT_BIN = fileURLToPath(
  new URL("../../node_modules/.bin/eslint", import.meta.url),
)

// Spawning eslint (Node startup + the TS project resolver) is inherently slow,
// especially cold on CI — well past vitest's 5s default. Give it room.
const TIMEOUT_MS = 60_000

type EslintFileResult = {
  filePath: string
  messages: { ruleId: string | null }[]
}

// Run eslint over `paths` and return a { basename -> ruleIds[] } map. eslint
// exits non-zero when it finds errors, so execFileSync throwing is expected;
// the JSON report is on stdout either way.
function ruleIdsByFile(paths: string[]): Record<string, string[]> {
  let stdout: string
  try {
    stdout = execFileSync(ESLINT_BIN, ["--format", "json", ...paths], {
      cwd: WEB_ROOT,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    })
  } catch (err) {
    stdout = (err as { stdout?: string }).stdout ?? ""
  }
  const results = JSON.parse(stdout) as EslintFileResult[]
  const out: Record<string, string[]> = {}
  for (const r of results) {
    out[r.filePath.split("/").pop() ?? r.filePath] = r.messages.map(
      (m) => m.ruleId ?? "",
    )
  }
  return out
}

describe("data-layer no-cycle guard is live", () => {
  it(
    "reports import-x/no-cycle on a cycle inside the guarded scope",
    { timeout: TIMEOUT_MS },
    () => {
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
        // Positive control: a non-cyclic file in the same scope must NOT report
        // no-cycle — guards against a globally-broken eslint erroring on
        // everything, which would make the cycle assertion a false pass.
        writeFileSync(`${dir}/c.ts`, `export const c = () => 1\n`)

        const byFile = ruleIdsByFile([
          `${dir}/a.ts`,
          `${dir}/b.ts`,
          `${dir}/c.ts`,
        ])

        expect(
          byFile["a.ts"],
          "The no-cycle guard did not fire on a real cycle in src/github-core — it has gone inert (check the parser/resolver wiring and files glob in eslint.config.js).",
        ).toContain("import-x/no-cycle")
        expect(byFile["c.ts"] ?? []).not.toContain("import-x/no-cycle")
      } finally {
        rmSync(dir, { recursive: true, force: true })
      }
    },
  )
})
