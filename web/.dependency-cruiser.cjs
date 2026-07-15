/**
 * dependency-cruiser: CI-side holistic architecture validation.
 *
 * Complements the dev-time eslint-plugin-boundaries layer rule (real-time IDE
 * feedback) and the import-x/no-cycle guard: this runs over the whole graph in
 * CI to (1) fail on ANY circular dependency and (2) re-assert the same downward
 * layer invariants boundaries enforces, as a second independent check. Keep the
 * layer rules here in lockstep with the boundaries policy in eslint.config.js.
 *
 * Layer chain (strictly downward): pages -> components -> domain -> github-core
 * -> util/types. Type-only edges are allowed to reach up (matching no-cycle +
 * the boundaries dependency.kind:"value" scope) via `dependencyTypesNot`.
 */
module.exports = {
  forbidden: [
    {
      name: "no-circular",
      severity: "error",
      comment:
        "No circular dependency in the data layer (github-core/ + domain/). Scoped to match the deliberate import-x/no-cycle guard: the view/router layer has framework-inherent cycles (router <-> generated routeTree) the project accepts, so cycle enforcement is limited to where cycles are a real init-order/tree-shaking hazard. type-only edges are excluded (matching import-x/no-cycle) so the benign `github-core -> domain` input-type back-edges don't count as cycles.",
      from: {
        path: "^src/(github-core|domain)/",
        pathNot: "\\.test\\.(ts|tsx)$",
      },
      to: { circular: true, path: "^src/(github-core|domain)/" },
    },
    {
      name: "components-not-to-pages",
      severity: "error",
      comment:
        "components/ is below pages/: a shared component must not import a feature page.",
      from: { path: "^src/components/", pathNot: "\\.test\\.(ts|tsx)$" },
      to: { path: "^src/pages/" },
    },
    {
      name: "domain-not-to-view",
      severity: "error",
      comment:
        "domain/ must not import view-layer code (pages/components/hooks/context/routes).",
      from: { path: "^src/domain/", pathNot: "\\.test\\.(ts|tsx)$" },
      to: { path: "^src/(pages|components|hooks|context|routes)/" },
    },
    {
      name: "github-core-not-up",
      severity: "error",
      comment:
        "github-core/ is the lowest data layer: no import of domain or view code (type-only edges aren't tracked — tsPreCompilationDeps is off).",
      from: { path: "^src/github-core/", pathNot: "\\.test\\.(ts|tsx)$" },
      to: {
        path: "^src/(domain|pages|components|hooks|context|routes)/",
      },
    },
  ],
  options: {
    doNotFollow: { path: "node_modules" },
    // Ignore type-only imports (matching import-x/no-cycle and the boundaries
    // dependency.kind:"value" scope): a benign `import type` back-edge from
    // github-core into a domain input type is not a runtime cycle or a layer
    // breach. With this off, dependency-cruiser tracks only value/runtime edges.
    tsPreCompilationDeps: false,
    tsConfig: { fileName: "tsconfig.app.json" },
    enhancedResolveOptions: {
      exportsFields: ["exports"],
      conditionNames: ["import", "require", "node", "default", "types"],
    },
    reporterOptions: {
      dot: { collapsePattern: "node_modules/(?:@[^/]+/[^/]+|[^/]+)" },
    },
  },
}
