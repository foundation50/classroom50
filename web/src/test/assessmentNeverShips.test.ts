import { readFileSync } from "node:fs"
import { fileURLToPath } from "node:url"
import path from "node:path"

import { describe, expect, it } from "vitest"

// Pins the dev-only assessment tool's "never ship to production" invariant.
// Two silent-pass surfaces this closes: the tool and its unauthenticated write
// endpoint must never reach a production bundle, but that guarantee lives in two
// easily-reverted spots that no runtime test otherwise covers:
//   1. assessmentApiPlugin declares `apply: "serve"`, so the /_assess write
//      middleware is dropped from `vite build` output. A revert to a default
//      (build+serve) plugin would ship the endpoint and CI would stay green.
//   2. the /assess route's beforeLoad redirects away unless import.meta.env.DEV,
//      so a production bundle dead-code-eliminates the page to a redirect.
// Lives in the node project (config/text reads only), mirroring
// browserProjectWiring.test.ts.

const here = path.dirname(fileURLToPath(import.meta.url))
const webRoot = path.resolve(here, "..", "..")

describe("dev-only assessment tool never ships to production", () => {
  it("assessmentApiPlugin is serve-only (apply: 'serve')", () => {
    const config = readFileSync(path.join(webRoot, "vite.config.ts"), "utf8")
    // The plugin factory and its apply mode, in order, so a reordering that
    // drops `apply: "serve"` from this plugin fails loudly.
    expect(config).toMatch(
      /name:\s*"classroom50:assessment-api"[\s\S]*?apply:\s*"serve"/,
    )
  })

  it("the /assess route redirects away unless import.meta.env.DEV", () => {
    const route = readFileSync(
      path.join(webRoot, "src", "routes", "assess.tsx"),
      "utf8",
    )
    expect(route).toMatch(/beforeLoad/)
    expect(route).toMatch(/if\s*\(\s*!import\.meta\.env\.DEV\s*\)/)
    expect(route).toMatch(/redirect\(\s*\{\s*to:\s*"\/"/)
  })
})
