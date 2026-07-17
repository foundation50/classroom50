import { describe, expect, it } from "vitest"
import { execFileSync } from "node:child_process"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { fileURLToPath } from "node:url"

// Proves the layered-architecture boundary guard (boundaries/dependencies in
// eslint.config.js) actually trips on an upward/inward layer inversion. Like the
// no-cycle and authz guards, this rule's failure mode is silent — a config edit
// could drop an element type or mis-scope a policy and nothing else in CI would
// notice, quietly re-allowing a components->pages or github-core->domain reach.
//
// The plugin classifies a file by its src/<layer>/ path, so probes must live in
// real layer dirs (a temp dir at src/ root would be an unknown element the rule
// skips). We write fresh temp subdirs inside src/components, src/github-core, and
// src/domain, then assert boundaries/dependencies fires on each of the three
// disallowed inversions (components->pages, github-core->domain, domain->pages)
// and stays silent on a legal downward import — a non-zero exit alone isn't
// enough, since a globally-broken eslint erroring on everything must not read as
// a real catch. We also probe a re-export and a dynamic import() reach-up so a
// narrowed boundaries/dependency-nodes set (which would make those edge kinds
// invisible) can't silently pass.

const COMPONENTS_DIR = fileURLToPath(new URL("./components", import.meta.url))
const GITHUB_CORE_DIR = fileURLToPath(new URL("./github-core", import.meta.url))
const DOMAIN_DIR = fileURLToPath(new URL("./domain", import.meta.url))
const UTIL_DIR = fileURLToPath(new URL("./util", import.meta.url))
const ESLINT_TOOLING_DIR = fileURLToPath(new URL("./eslint", import.meta.url))
const WEB_ROOT = fileURLToPath(new URL("../", import.meta.url))
const ESLINT_BIN = fileURLToPath(
  new URL("../node_modules/.bin/eslint", import.meta.url),
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

describe("layered-architecture boundary guard is live", () => {
  it(
    "reports boundaries/dependencies on upward layer imports but not downward ones",
    { timeout: TIMEOUT_MS },
    () => {
      // Probe dirs inside real layers so the plugin classifies the files.
      const compDir = mkdtempSync(`${COMPONENTS_DIR}/__boundaries_probe_`)
      const coreDir = mkdtempSync(`${GITHUB_CORE_DIR}/__boundaries_probe_`)
      const domainDir = mkdtempSync(`${DOMAIN_DIR}/__boundaries_probe_`)
      const utilDir = mkdtempSync(`${UTIL_DIR}/__boundaries_probe_`)
      const eslintToolingDir = mkdtempSync(
        `${ESLINT_TOOLING_DIR}/__boundaries_probe_`,
      )
      try {
        // components -> pages: an upward reach-up. Must be flagged.
        writeFileSync(
          `${compDir}/compUpward.ts`,
          `import ClassesPage from "@/pages/ClassesPage"\nexport const a = ClassesPage\n`,
        )
        // components -> util: a legal downward import. Must NOT be flagged.
        writeFileSync(
          `${compDir}/compDownward.ts`,
          `import { rosterPath } from "@/util/rosterPath"\nexport const b = rosterPath\n`,
        )
        // github-core -> domain (value): the lowest layer reaching up. Must fire.
        writeFileSync(
          `${coreDir}/coreUpward.ts`,
          `import { syncRosterFromTeam } from "@/domain/students"\nexport const c = syncRosterFromTeam\n`,
        )
        // domain -> pages (value): the third policy. Must fire — probing it here
        // is what keeps the domain->view policy from silently going inert.
        writeFileSync(
          `${domainDir}/domainUpward.ts`,
          `import ClassesPage from "@/pages/ClassesPage"\nexport const d = ClassesPage\n`,
        )
        // A re-export reach-up (`export … from`). The plugin only sees this as a
        // dependency when `export` is in boundaries/dependency-nodes; probing it
        // guards against the narrowed-node-set blind spot.
        writeFileSync(
          `${compDir}/compReexport.ts`,
          `export { default as ClassesPage } from "@/pages/ClassesPage"\n`,
        )
        // A dynamic-import() reach-up (lazy loading a page). Likewise only seen
        // when `dynamic-import` is in the node set.
        writeFileSync(
          `${compDir}/compDynamic.ts`,
          `export const load = () => import("@/pages/ClassesPage")\n`,
        )
        // util -> components (value): a leaf reaching into the view layer. Must
        // fire — this is the Tier-3 leaf-layer policy.
        writeFileSync(
          `${utilDir}/leafUpwardValue.ts`,
          `import { Badge } from "@/components/ui"\nexport const e = Badge\n`,
        )
        // util -> components (TYPE-only): the leaf policy omits dependency.kind,
        // so it must block even a type edge (unlike the value-scoped policies).
        // This is what caught the BadgeTone reach-up the Tier-3 move fixed.
        writeFileSync(
          `${utilDir}/leafUpwardType.ts`,
          `import type { BadgeTone } from "@/components/ui"\nexport type F = BadgeTone\n`,
        )
        // util -> github-core (value): a legal downward leaf import (util
        // already depends on github-core). Must NOT fire — proves the leaf
        // policy deliberately allows the github-core edge.
        writeFileSync(
          `${utilDir}/leafDownward.ts`,
          `import { GitHubAPIError } from "@/github-core/errors"\nexport const g = GitHubAPIError\n`,
        )
        // eslintTooling -> components: the eslintTooling element shares the leaf
        // policy's `from`-set, but src/eslint/** imports no app code today, so
        // only this probe proves it's actually classified and enforced — without
        // it, dropping eslintTooling (or lib/types) from the `from`-set would
        // pass green since util alone still trips the rule.
        writeFileSync(
          `${eslintToolingDir}/toolingUpward.ts`,
          `import { Badge } from "@/components/ui"\nexport const h = Badge\n`,
        )

        const byFile = ruleIdsByFile([
          `${compDir}/compUpward.ts`,
          `${compDir}/compDownward.ts`,
          `${coreDir}/coreUpward.ts`,
          `${domainDir}/domainUpward.ts`,
          `${compDir}/compReexport.ts`,
          `${compDir}/compDynamic.ts`,
          `${utilDir}/leafUpwardValue.ts`,
          `${utilDir}/leafUpwardType.ts`,
          `${utilDir}/leafDownward.ts`,
          `${eslintToolingDir}/toolingUpward.ts`,
        ])

        expect(
          byFile["compUpward.ts"],
          "boundaries/dependencies did not fire on a components->pages import — the layer guard has gone inert (check boundaries/elements + the policies in eslint.config.js).",
        ).toContain("boundaries/dependencies")
        // Assert the file was actually linted before asserting it is clean, so a
        // skipped/absent file can't satisfy .not.toContain via a missing entry.
        expect(
          byFile["compDownward.ts"],
          "compDownward.ts was not linted at all — the negative control is meaningless (eslint may have skipped the probe file).",
        ).toBeDefined()
        expect(
          byFile["compDownward.ts"],
          "boundaries/dependencies fired on a legal components->util downward import — the policy is too strict.",
        ).not.toContain("boundaries/dependencies")
        expect(
          byFile["coreUpward.ts"],
          "boundaries/dependencies did not fire on a github-core->domain value import — the layer guard has gone inert.",
        ).toContain("boundaries/dependencies")
        expect(
          byFile["domainUpward.ts"],
          "boundaries/dependencies did not fire on a domain->pages value import — the domain->view policy has gone inert.",
        ).toContain("boundaries/dependencies")
        expect(
          byFile["compReexport.ts"],
          "boundaries/dependencies did not fire on a components->pages re-export — `export` is missing from boundaries/dependency-nodes, so re-export reach-ups are invisible.",
        ).toContain("boundaries/dependencies")
        expect(
          byFile["compDynamic.ts"],
          "boundaries/dependencies did not fire on a components->pages dynamic import() — `dynamic-import` is missing from boundaries/dependency-nodes, so lazy-loaded reach-ups are invisible.",
        ).toContain("boundaries/dependencies")
        expect(
          byFile["leafUpwardValue.ts"],
          "boundaries/dependencies did not fire on a util->components value import — the Tier-3 leaf-layer policy has gone inert (check the util/lib/types policy + the eslintTooling/leaf elements in eslint.config.js).",
        ).toContain("boundaries/dependencies")
        expect(
          byFile["leafUpwardType.ts"],
          "boundaries/dependencies did not fire on a util->components TYPE-only import — the leaf policy must omit dependency.kind so it blocks type edges too (this is the BadgeTone reach-up class).",
        ).toContain("boundaries/dependencies")
        expect(
          byFile["leafDownward.ts"],
          "leafDownward.ts was not linted at all — the leaf negative control is meaningless.",
        ).toBeDefined()
        expect(
          byFile["leafDownward.ts"],
          "boundaries/dependencies fired on a legal util->util downward import — the leaf policy is too strict.",
        ).not.toContain("boundaries/dependencies")
        expect(
          byFile["toolingUpward.ts"],
          "boundaries/dependencies did not fire on a src/eslint (eslintTooling) -> components import — eslintTooling was dropped from the leaf policy `from`-set or its boundaries/elements entry is missing (eslint.config.js).",
        ).toContain("boundaries/dependencies")
      } finally {
        rmSync(compDir, { recursive: true, force: true })
        rmSync(coreDir, { recursive: true, force: true })
        rmSync(domainDir, { recursive: true, force: true })
        rmSync(utilDir, { recursive: true, force: true })
        rmSync(eslintToolingDir, { recursive: true, force: true })
      }
    },
  )
})
