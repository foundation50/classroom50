import js from "@eslint/js"
import globals from "globals"
import reactHooks from "eslint-plugin-react-hooks"
import reactRefresh from "eslint-plugin-react-refresh"
import jsxA11y from "eslint-plugin-jsx-a11y"
import { importX } from "eslint-plugin-import-x"
import { createTypeScriptImportResolver } from "eslint-import-resolver-typescript"
import tseslint from "typescript-eslint"
import prettier from "eslint-config-prettier/flat"
import { defineConfig, globalIgnores } from "eslint/config"

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
          selector:
            ":matches(JSXElement[openingElement.name.name='form'], JSXElement:has(JSXAttribute[name.name='as'][value.value='form'])) JSXOpeningElement[name.name='Button']:not(:has(JSXAttribute[name.name=/^(type|as|href)$/]))",
          message:
            'A <Button> inside a <form> needs an explicit `type`: add type="submit" for the submit action or type="button" for a click handler. The <Button> default is "button", which silently disables implicit form submit.',
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
  // Last: turn off ESLint rules that conflict with Prettier (formatting is
  // Prettier's job). Must stay at the end of the array to win.
  prettier,
])
