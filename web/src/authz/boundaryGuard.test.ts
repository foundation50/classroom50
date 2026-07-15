import { describe, expect, it } from "vitest"
import { execFileSync } from "node:child_process"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { fileURLToPath } from "node:url"

// Proves the authz public-API boundary guard (no-restricted-imports on
// `@/authz/*` in eslint.config.js) actually trips on a deep import into the
// module's internals. Like the no-cycle guard, this rule's failure mode is
// silent — a config edit could drop or mis-scope it and nothing else in CI
// would notice, quietly re-opening the barrel. This writes a probe file OUTSIDE
// src/authz that deep-imports `@/authz/roles`, plus a control that imports the
// public barrel `@/authz`, runs eslint once, and asserts no-restricted-imports
// fires on the deep import but NOT on the barrel (a non-zero exit alone isn't
// enough — a globally-broken eslint erroring on everything must not read as a
// real catch).

const SRC_DIR = fileURLToPath(new URL("..", import.meta.url))
const WEB_ROOT = fileURLToPath(new URL("../..", import.meta.url))
const ESLINT_BIN = fileURLToPath(
  new URL("../../node_modules/.bin/eslint", import.meta.url),
)

const TIMEOUT_MS = 60_000

type EslintFileResult = {
  filePath: string
  messages: { ruleId: string | null }[]
}

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

describe("authz barrel-boundary guard is live", () => {
  it(
    "reports no-restricted-imports on a deep import into @/authz internals",
    { timeout: TIMEOUT_MS },
    () => {
      // Probe dir under src/ (NOT src/authz, which the rule ignores) so the
      // boundary applies.
      const dir = mkdtempSync(`${SRC_DIR}/__authz_probe_`)
      try {
        // Deep import of an internal file — must be flagged.
        writeFileSync(
          `${dir}/deep.ts`,
          `import { isOwnerGitHubOrgRole } from "@/authz/roles"\nexport const x = isOwnerGitHubOrgRole\n`,
        )
        // Control: importing the public barrel must NOT be flagged.
        writeFileSync(
          `${dir}/barrel.ts`,
          `import { can } from "@/authz"\nexport const y = can\n`,
        )

        const byFile = ruleIdsByFile([`${dir}/deep.ts`, `${dir}/barrel.ts`])

        expect(
          byFile["deep.ts"],
          "The authz barrel-boundary guard did not fire on a deep import of @/authz/roles — it has gone inert (check the no-restricted-imports `@/authz/*` rule + its `src/authz/**` ignore in eslint.config.js).",
        ).toContain("no-restricted-imports")
        expect(byFile["barrel.ts"] ?? []).not.toContain("no-restricted-imports")
      } finally {
        rmSync(dir, { recursive: true, force: true })
      }
    },
  )
})
