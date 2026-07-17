import js from "@eslint/js"
import globals from "globals"
import reactHooks from "eslint-plugin-react-hooks"
import reactRefresh from "eslint-plugin-react-refresh"
import jsxA11y from "eslint-plugin-jsx-a11y"
import { importX } from "eslint-plugin-import-x"
import boundaries from "eslint-plugin-boundaries"
import { createTypeScriptImportResolver } from "eslint-import-resolver-typescript"
import tseslint from "typescript-eslint"
import prettier from "eslint-config-prettier/flat"
import { defineConfig, globalIgnores } from "eslint/config"
import {
  buttonFormSelector,
  buttonFormMessage,
} from "./src/eslint/buttonFormRule.ts"
import {
  directionalClassLiteralSelector,
  directionalClassTemplateSelector,
  directionalClassMessage,
} from "./src/eslint/directionalClassRule.ts"

export default defineConfig([
  globalIgnores(["dist"]),
  {
    files: ["**/*.{ts,tsx}"],
    extends: [
      js.configs.recommended,
      tseslint.configs.recommended,
      reactHooks.configs.flat.recommended,
      reactRefresh.configs.vite,
      jsxA11y.flatConfigs.recommended,
    ],
    languageOptions: {
      globals: globals.browser,
    },
  },
  {
    files: ["**/*.{ts,tsx}"],
    rules: {
      "react-refresh/only-export-components": "off",
      // Advisory, not blocking: these flag legitimate patterns here (mount-time
      // init reading localStorage / the OAuth callback, and resetting modal
      // state on close). Surface as warnings rather than forcing risky
      // refactors. Revisit case-by-case.
      "react-hooks/set-state-in-effect": "warn",
      "react-hooks/exhaustive-deps": "warn",
      // Route all console output through `src/lib/logger.ts` (leveled,
      // timestamped, scoped, call-site tagged). Raw `console` is forbidden
      // everywhere else — the wrapper centralises formatting AND the privacy
      // contract (a recurring source of GitHub API response bodies leaking to
      // the production console). The logger module and the deliberate release
      // banner in main.tsx are the only exceptions (per-file overrides below).
      "no-console": "error",
      // Keep the accessibility invariants self-checking. Advisory
      // (warn) so the plugin's stricter defaults don't block the build on
      // pre-existing markup, but new violations (missing alt/label, invalid
      // aria-*, click-without-keyboard) surface in `npm run check` output.
      // Downgraded from the recommended-set's `error` to match the repo's
      // advisory-warning convention (react-hooks/no-console above).
      "jsx-a11y/alt-text": "warn",
      "jsx-a11y/anchor-ambiguous-text": "warn",
      "jsx-a11y/anchor-has-content": "warn",
      "jsx-a11y/anchor-is-valid": "warn",
      "jsx-a11y/aria-activedescendant-has-tabindex": "warn",
      "jsx-a11y/aria-props": "warn",
      "jsx-a11y/aria-proptypes": "warn",
      "jsx-a11y/aria-role": "warn",
      "jsx-a11y/aria-unsupported-elements": "warn",
      "jsx-a11y/autocomplete-valid": "warn",
      "jsx-a11y/click-events-have-key-events": "warn",
      "jsx-a11y/control-has-associated-label": "warn",
      "jsx-a11y/heading-has-content": "warn",
      "jsx-a11y/html-has-lang": "warn",
      "jsx-a11y/iframe-has-title": "warn",
      "jsx-a11y/img-redundant-alt": "warn",
      "jsx-a11y/interactive-supports-focus": "warn",
      "jsx-a11y/label-has-associated-control": "warn",
      "jsx-a11y/media-has-caption": "warn",
      "jsx-a11y/mouse-events-have-key-events": "warn",
      "jsx-a11y/no-access-key": "warn",
      // Off: the app uses autoFocus deliberately in modals/forms (a focus-
      // management aid, not a hazard here).
      "jsx-a11y/no-autofocus": "off",
      "jsx-a11y/no-distracting-elements": "warn",
      "jsx-a11y/no-interactive-element-to-noninteractive-role": "warn",
      "jsx-a11y/no-noninteractive-element-interactions": "warn",
      "jsx-a11y/no-noninteractive-element-to-interactive-role": "warn",
      "jsx-a11y/no-noninteractive-tabindex": "warn",
      "jsx-a11y/no-redundant-roles": "warn",
      "jsx-a11y/no-static-element-interactions": "warn",
      "jsx-a11y/role-has-required-aria-props": "warn",
      "jsx-a11y/role-supports-aria-props": "warn",
      "jsx-a11y/scope": "warn",
      "jsx-a11y/tabindex-no-positive": "warn",
      // Nudge new loading UI toward the accessible <Spinner> (role=status +
      // sr-only label) instead of a bare, silent daisyUI spinner span. In-button
      // spinners may stay inline when the button already carries an aria-label;
      // this only flags the literal utility class in JSX className literals.
      "no-restricted-syntax": [
        "warn",
        {
          selector:
            "JSXAttribute[name.name='className'] > Literal[value=/\\bloading-spinner\\b/]",
          message:
            'Prefer the accessible <Spinner> component over a bare `loading loading-spinner` span (it adds role="status" + an sr-only label). In-button spinners may stay inline if the button already has an accessible name.',
        },
        {
          // Warn when a <Button> sits in a form without an explicit `type`: a
          // bare <button> defaults to submit, our <Button> defaults to "button",
          // so an unmarked one is a likely silent no-op submit. Advisory only —
          // the Button default + form-submit tests are the real enforcement.
          // Two deliberate limits: matches <form> AND `<Card as="form">` (the
          // app uses the latter); same-file lexical only, so a <Button> in a
          // child component rendered inside a form isn't reachable here.
          selector: buttonFormSelector,
          message: buttonFormMessage,
        },
        // RTL support: physical directional utilities (ml-/pr-/left-/
        // text-left/border-l/rounded-r...) don't mirror under dir="rtl";
        // the codebase is fully converted to logical equivalents and these
        // keep it that way. Two selectors because template-literal
        // classNames have no Literal child — their static chunks are
        // TemplateElements. audit_i18n.py carries the same regex as a CI
        // backstop for non-JSX class recipes these selectors can't see.
        {
          selector: directionalClassLiteralSelector,
          message: directionalClassMessage,
        },
        {
          selector: directionalClassTemplateSelector,
          message: directionalClassMessage,
        },
      ],
    },
  },
  // Guard the data-layer boundary: no runtime import cycle. The old api/ <-> data
  // layer once cycled (barrel re-exports + a TDZ workaround), as did the two
  // data-layer giants (mutations.ts <-> queries.ts) via shared primitives; both
  // are now broken (primitives extracted into leaf modules) and this keeps them
  // broken. Scoped to github-core/ + domain/ where cycles are the real risk;
  // unbounded (no maxDepth) so a cycle that closes through a longer detour can't
  // hide — measured negligible over this scope, and ignoreExternal keeps
  // node_modules out of the walk. Type-only imports are ignored by the rule, so
  // the remaining `import type` edges don't trip it.
  //
  // no-cycle is inert without BOTH a parser (import-x/parsers) AND a resolver
  // that understands the `@/*` tsconfig alias every data-layer edge uses —
  // without them it parses/resolves nothing and passes green while a cycle
  // exists. So this block wires both, and enables no-unresolved on the same
  // scope as a LOUD tripwire: if the alias ever stops resolving, CI fails here
  // instead of no-cycle silently going inert. Verified against an injected
  // fixture cycle before trusting it.
  {
    files: ["src/github-core/**/*.{ts,tsx}", "src/domain/**/*.{ts,tsx}"],
    plugins: { "import-x": importX },
    settings: {
      "import-x/parsers": {
        "@typescript-eslint/parser": [".ts", ".tsx"],
      },
      "import-x/resolver-next": [
        createTypeScriptImportResolver({
          project: ["tsconfig.app.json", "tsconfig.node.json"],
          alwaysTryTypes: true,
          noWarnOnMultipleProjects: true,
        }),
      ],
    },
    rules: {
      "import-x/no-unresolved": "error",
      "import-x/no-cycle": ["error", { ignoreExternal: true }],
    },
  },
  // Enforce the authz module's public-API boundary: everything access-control
  // (role vocabulary, resolution reducers, the can() policy) lives in src/authz/
  // and is consumed ONLY through the barrel `@/authz`. Reaching into an internal
  // file (`@/authz/roles`, `@/authz/resolveRole`, `@/authz/capabilities`) is
  // forbidden, so the module's internals can be refactored without breaking
  // callers and can() stays the single decision surface. The authz files
  // themselves import each other by relative path (`./roles`), which the
  // `ignores` below excludes, so the module is free internally. Turns the
  // single-source-of-truth from a convention into an enforced invariant.
  //
  // The patterns block BOTH spellings of a deep import — the `@/` alias
  // (`@/authz/roles`) and a relative path (`../authz/roles`) — because they
  // resolve to the same internal module, and a rule that only caught the alias
  // would go green while a relative deep import breached the barrel. The public
  // barrel itself (`@/authz` and its explicit `/index` spelling) is excluded via
  // a negated glob so importing the API is never flagged; the relative-path
  // `regex` matches any `.../authz/<internal>` tail regardless of the `../`
  // prefix (glob `**` can't cross a leading-dot segment).
  {
    files: ["**/*.{ts,tsx}"],
    ignores: ["src/authz/**"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          patterns: [
            {
              group: ["@/authz/*", "!@/authz/index"],
              message:
                "Import authz through the public barrel `@/authz`, not its internal files. The barrel is the module's only public API (see src/authz/index.ts).",
            },
            {
              regex: "(^|/)authz/(roles|resolveRole|capabilities)$",
              message:
                "Import authz through the public barrel `@/authz`, not its internal files by relative path. The barrel is the module's only public API (see src/authz/index.ts).",
            },
          ],
        },
      ],
    },
  },
  // The only files allowed to touch `console` directly: the logger wrapper
  // (it IS the console centralisation point) and the main.tsx release banner
  // (a deliberate always-on marker so the deployed build is identifiable from
  // the console — it must print even in prod, outside the leveled model).
  {
    files: ["src/lib/logger.ts", "src/main.tsx"],
    rules: {
      "no-console": "off",
    },
  },
  // Enforce the layered architecture (features -> components -> domain ->
  // github-core -> util/types, strictly downward) by disallowing the
  // load-bearing inversions. `default: allow` + explicit disallows (not
  // deny-by-default) keeps benign lateral edges quiet; dependency-cruiser adds
  // the CI-side holistic pass. The leaf layers (util/lib/types) are guarded by
  // the leaf policy below — they may not import ANY higher layer, at value OR
  // type kind (a leaf that needs a view/data type means the type is misfiled;
  // lift it into types/). Rationale for the policy shape lives in the Tier-2E
  // PR (#290); the leaf rule landed in Tier-3.
  //
  // Adding a new src/<layer>/ dir needs THREE coordinated edits or it is
  // silently unenforced: (1) a boundaries/elements entry below, (2) a disallow
  // policy for its illegal edges, and (3) a matching .dependency-cruiser.cjs
  // path rule. dependency-cruiser's path-regex rules are the CI backstop.
  {
    files: ["src/**/*.{ts,tsx}"],
    ignores: ["src/**/*.test.{ts,tsx}", "src/**/*.d.ts"],
    plugins: { boundaries },
    settings: {
      // Classify all upward-reachable value edges, not just static `import`:
      // a re-export (`export { X } from "@/pages/.."`), `require`, or dynamic
      // `import()` is just as much a reach-up. `dependency.kind: "value"` on
      // each disallow still scopes them to runtime edges, so type-only imports
      // stay allowed (matching import-x/no-cycle).
      "boundaries/dependency-nodes": [
        "import",
        "export",
        "dynamic-import",
        "require",
      ],
      // boundaries resolves each import to a file to classify its target
      // element; without the `@/*` alias resolver it can't resolve the alias
      // imports every layer uses and would treat targets as unknown (skipped).
      "import/resolver": {
        typescript: {
          project: ["tsconfig.app.json", "tsconfig.node.json"],
          alwaysTryTypes: true,
        },
      },
      "boundaries/elements": [
        { type: "pages", pattern: "src/pages/**", partialMatch: false },
        { type: "routes", pattern: "src/routes/**", partialMatch: false },
        {
          type: "components",
          pattern: "src/components/**",
          partialMatch: false,
        },
        { type: "context", pattern: "src/context/**", partialMatch: false },
        { type: "hooks", pattern: "src/hooks/**", partialMatch: false },
        { type: "auth", pattern: "src/auth/**", partialMatch: false },
        { type: "domain", pattern: "src/domain/**", partialMatch: false },
        { type: "authz", pattern: "src/authz/**", partialMatch: false },
        { type: "orgPolicy", pattern: "src/orgPolicy/**", partialMatch: false },
        {
          type: "githubCore",
          pattern: "src/github-core/**",
          partialMatch: false,
        },
        { type: "skeleton", pattern: "src/skeleton/**", partialMatch: false },
        { type: "lib", pattern: "src/lib/**", partialMatch: false },
        { type: "util", pattern: "src/util/**", partialMatch: false },
        { type: "types", pattern: "src/types/**", partialMatch: false },
        { type: "i18n", pattern: "src/i18n/**", partialMatch: false },
        { type: "locales", pattern: "src/locales/**", partialMatch: false },
        {
          type: "eslintTooling",
          pattern: "src/eslint/**",
          partialMatch: false,
        },
      ],
    },
    rules: {
      "boundaries/dependencies": [
        "error",
        {
          default: "allow",
          policies: [
            {
              // components are feature-agnostic and must never import a feature
              // page (the reach-up P7/Tier-2E fixed).
              from: { element: { type: "components" } },
              disallow: {
                to: { element: { type: "pages" } },
                dependency: { kind: "value" },
              },
              message:
                "components/ is a lower layer than pages/: a shared component must not import a feature page. Lift the shared piece into components/ (see Tier-2E).",
            },
            {
              // domain is framework-free orchestration below the view layers.
              from: { element: { type: "domain" } },
              disallow: {
                to: {
                  element: {
                    type: ["pages", "components", "hooks", "context", "routes"],
                  },
                },
                dependency: { kind: "value" },
              },
              message:
                "domain/ must not import view-layer code (pages/components/hooks/context/routes). Domain depends downward on github-core/util/types only.",
            },
            {
              // github-core is the lowest data layer; it must not reach up into
              // domain or any view layer at runtime (type-only input edges are
              // left alone via dependency.kind: value).
              from: { element: { type: "githubCore" } },
              disallow: {
                to: {
                  element: {
                    type: [
                      "domain",
                      "pages",
                      "components",
                      "hooks",
                      "context",
                      "routes",
                    ],
                  },
                },
                dependency: { kind: "value" },
              },
              message:
                "github-core/ is the lowest data layer: it must not import domain or view code at runtime. Keep dependencies downward (util/types).",
            },
            {
              // Leaf layers: pure helpers (util), app infra (lib), shared types
              // (types), and lint tooling (eslintTooling) must not import the
              // view or orchestration layers, at value OR type kind. A leaf that
              // "needs" a page/component/hook/context/domain type means the type
              // is misfiled — lift it into types/ (see the BadgeTone -> types/
              // move in Tier-3). They may still depend downward/laterally on
              // github-core, authz, auth, and each other, which is why those are
              // NOT in the disallow set. eslintTooling (src/eslint/**) is a lint
              // rule impl that must never import app code at all.
              from: {
                element: { type: ["util", "lib", "types", "eslintTooling"] },
              },
              disallow: {
                to: {
                  element: {
                    type: [
                      "pages",
                      "components",
                      "hooks",
                      "context",
                      "routes",
                      "domain",
                      "orgPolicy",
                      "skeleton",
                    ],
                  },
                },
              },
              message:
                "util/lib/types/eslint are leaf layers: they must not import view or orchestration code (pages/components/hooks/context/routes/domain/orgPolicy/skeleton). Move any shared type into types/.",
            },
          ],
        },
      ],
    },
  },
  // Last: turn off ESLint rules that conflict with Prettier (formatting is
  // Prettier's job). Must stay at the end of the array to win.
  prettier,
])
