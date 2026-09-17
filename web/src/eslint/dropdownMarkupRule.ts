import type { Rule } from "eslint"

// daisyUI's CSS `dropdown` recipe positions its `dropdown-content` inside the
// trigger's box, so a menu near an edge is cut off by any `overflow` ancestor
// (a modal box, a scrolling table frame, the sidebar rail) or covered by a
// z-indexed sibling, the same class of bug as issue #1026 for tooltips. The
// shared <Dropdown> + <DropdownMenu> render the menu as a top-layer popover and
// keep it on screen, so they are the only sanctioned dropdown; this rule makes
// the raw markup a lint error.
//
// Any `dropdown` or `dropdown-*` class token in a className is caught, whether
// a plain string, a `cx(...)` argument, or a template-literal chunk.

// Token match: start of string, whitespace, or a variant colon before
// `dropdown`, then either the end of the token or a modifier suffix.
export const dropdownClassPattern =
  "(?:^|[\\s:])dropdown(?:-[a-z]+)*(?![A-Za-z0-9_-])"

export const dropdownClassLiteralSelector = `JSXAttribute[name.name='className'] Literal[value=/${dropdownClassPattern}/]`
// Template-literal classNames have no Literal child; their static chunks are
// TemplateElement nodes.
export const dropdownClassTemplateSelector = `JSXAttribute[name.name='className'] TemplateElement[value.raw=/${dropdownClassPattern}/]`

export const dropdownMarkupMessage =
  "Raw daisyUI dropdown markup (`dropdown` / `dropdown-content` classes) is positioned inside its container and gets clipped or covered near an edge (see #1026). Use <Dropdown> with <DropdownMenu> from @/components/ui, or <Popover> for a non-menu panel: they render in the top layer and stay on screen."

export const dropdownMarkupRule: Rule.RuleModule = {
  meta: {
    type: "problem",
    docs: {
      description:
        "Disallow raw daisyUI dropdown markup in favor of the shared <Dropdown>",
    },
    schema: [],
    messages: { rawDropdown: dropdownMarkupMessage },
  },
  create(context) {
    const report = (node: Rule.Node) =>
      context.report({ node, messageId: "rawDropdown" })
    return {
      [dropdownClassLiteralSelector]: report,
      [dropdownClassTemplateSelector]: report,
    }
  },
}
