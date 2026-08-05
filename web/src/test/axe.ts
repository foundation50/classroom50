// Hermetic axe-in-render test helper (plan -003- U1 / -004-).
//
// Wraps @testing-library/react render + axe-core so a test can assert a rendered
// subtree has zero accessibility violations. This is the `automated` evidence
// source behind the VPAT: a criterion backed by an axe/structural check flips to
// `automated` Supports only while its check here stays green (per-criterion
// binding, plan KTD2).
//
// Runs under happy-dom — a test using this MUST opt in with
// `// @vitest-environment happy-dom` (mirroring the repo's DOM-test convention,
// e.g. components/ui/Badge.test.tsx). Test infra under src/test/, not app code.

import type { ReactElement } from "react"
import { render } from "@testing-library/react"
import { axe } from "vitest-axe"
import * as matchers from "vitest-axe/matchers"
import type { AxeMatchers } from "vitest-axe/matchers"
import { expect } from "vitest"
import type { AxeResults, RunOptions } from "axe-core"

// Teach vitest's `expect` about the axe matcher registered below, so `tsc`
// accepts `expect(results).toHaveNoViolations()` (the runtime extend alone
// doesn't add the type). Interface-merge onto vitest's own interfaces; the
// empty-body merge is an interface extension, not a redundant declaration.
declare module "vitest" {
  // eslint-disable-next-line @typescript-eslint/no-empty-object-type
  interface Assertion extends AxeMatchers {}
  // eslint-disable-next-line @typescript-eslint/no-empty-object-type
  interface AsymmetricMatchersContaining extends AxeMatchers {}
}

// Register `toHaveNoViolations` once, on import. Cheap + idempotent, so any test
// file importing this helper gets the matcher without a separate setup file.
expect.extend(matchers)

/**
 * Render `ui` and run axe over the resulting container.
 *
 * Returns both the axe results (assert with `expect(results).toHaveNoViolations()`)
 * and the RTL container, so a caller can make further structural assertions on
 * the same tree. `axeOptions` forwards axe-core run options (e.g. to scope
 * `runOnly` to specific rules for a criterion-focused check).
 */
export async function renderAndAxe(
  ui: ReactElement,
  axeOptions?: RunOptions,
): Promise<{ results: AxeResults; container: HTMLElement }> {
  const { container } = render(ui)
  const results = await axe(container, axeOptions)
  return { results, container }
}
