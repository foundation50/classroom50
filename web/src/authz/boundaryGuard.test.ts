import { describe, expect, it } from "vitest"
import { execFileSync } from "node:child_process"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { fileURLToPath } from "node:url"

// Proves the authz public-API boundary guard (no-restricted-imports in
// eslint.config.js) actually trips on a deep import into the module's internals.
// Like the no-cycle guard, this rule's failure mode is silent — a config edit
// could drop or mis-scope it and nothing else in CI would notice, quietly
// re-opening the barrel. This writes probe files OUTSIDE src/authz that
// deep-import an internal (both the `@/authz/roles` alias AND the `../authz/roles`
// relative spelling — they resolve to the same module, and a guard that caught
// only the alias would go green while a relative deep import breached it), plus
// controls that import the public barrel (`@/authz` and its explicit `@/authz/index`
// spelling), runs eslint once, and asserts no-restricted-imports fires on every
// deep import but on NO barrel import (a non-zero exit alone isn't enough — a
// globally-broken eslint erroring on everything must not read as a real catch).

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
      // boundary applies. mkdtemp guarantees a fresh dir at src/ depth, so the
      // relative deep import below is a stable `../authz/roles`.
      const dir = mkdtempSync(`${SRC_DIR}/__authz_probe_`)
      try {
        // Deep import of an internal file via the `@/` alias — must be flagged.
        writeFileSync(
          `${dir}/deep.ts`,
          `import { isOwnerGitHubOrgRole } from "@/authz/roles"\nexport const x = isOwnerGitHubOrgRole\n`,
        )
        // Deep import of the SAME internal via a relative path — must ALSO be
        // flagged; it resolves to identical module content, so a guard that
        // caught only the alias would leave this bypass silently open.
        writeFileSync(
          `${dir}/deepRelative.ts`,
          `import { isOwnerGitHubOrgRole } from "../authz/roles"\nexport const z = isOwnerGitHubOrgRole\n`,
        )
        // Control: importing the public barrel must NOT be flagged — both the
        // bare `@/authz` and its explicit `@/authz/index` spelling are the API.
        writeFileSync(
          `${dir}/barrel.ts`,
          `import { can } from "@/authz"\nexport const y = can\n`,
        )
        writeFileSync(
          `${dir}/barrelIndex.ts`,
          `import { can } from "@/authz/index"\nexport const w = can\n`,
        )

        const byFile = ruleIdsByFile([
          `${dir}/deep.ts`,
          `${dir}/deepRelative.ts`,
          `${dir}/barrel.ts`,
          `${dir}/barrelIndex.ts`,
        ])

        expect(
          byFile["deep.ts"],
          "The authz barrel-boundary guard did not fire on an aliased deep import of @/authz/roles — it has gone inert (check the no-restricted-imports rule + its `src/authz/**` ignore in eslint.config.js).",
        ).toContain("no-restricted-imports")
        expect(
          byFile["deepRelative.ts"],
          "The authz barrel-boundary guard did not fire on a RELATIVE deep import (../authz/roles) — the relative-path `regex` pattern in eslint.config.js has gone inert, leaving a bypass around the barrel.",
        ).toContain("no-restricted-imports")
        expect(byFile["barrel.ts"] ?? []).not.toContain("no-restricted-imports")
        expect(byFile["barrelIndex.ts"] ?? []).not.toContain(
          "no-restricted-imports",
        )
      } finally {
        rmSync(dir, { recursive: true, force: true })
      }
    },
  )
})
