import type { Rule } from "eslint"

// daisyUI's CSS tooltip (`class="tooltip" data-tip="..."`) positions its bubble
// inside the trigger's own box, so near any edge it is cut off: by the
// viewport, by an `overflow` ancestor (modal box, scrolling table, the sidebar
// rail), or by a z-indexed sibling painting over it (issue #1026). <Tooltip>
// renders the bubble as a top-layer popover and keeps it on screen, so it is
// the only sanctioned tooltip; this rule makes the raw markup a lint error.
//
// Two shapes are caught: the `data-tip` attribute (the hook daisyUI needs to
// show anything) and the base `tooltip` class token in a className, whether a
// plain string, a `cx(...)` argument, or a template-literal chunk. Modifier
// classes (`tooltip-warning`) are inert without the base class and stay
// allowed.

// Token match: start of string, whitespace, or a variant colon before
// `tooltip`, and nothing word-like after it (so `tooltip-bubble` and
// `tooltip-warning` do not match).
export const tooltipClassPattern = "(?:^|[\\s:])tooltip(?![A-Za-z0-9_-])"

export const tooltipDataTipSelector = "JSXAttribute[name.name='data-tip']"
export const tooltipClassLiteralSelector = `JSXAttribute[name.name='className'] Literal[value=/${tooltipClassPattern}/]`
// Template-literal classNames have no Literal child; their static chunks are
// TemplateElement nodes.
export const tooltipClassTemplateSelector = `JSXAttribute[name.name='className'] TemplateElement[value.raw=/${tooltipClassPattern}/]`

export const tooltipMarkupMessage =
  "Raw daisyUI tooltip markup (`tooltip` class / `data-tip`) is positioned inside its container and gets clipped or covered near an edge (see #1026). Use <Tooltip> from @/components/ui (or <HelpTooltip> for a help icon): it renders the bubble in the top layer and keeps it on screen."

export const tooltipMarkupRule: Rule.RuleModule = {
  meta: {
    type: "problem",
    docs: {
      description:
        "Disallow raw daisyUI tooltip markup in favor of the shared <Tooltip>",
    },
    schema: [],
    messages: { rawTooltip: tooltipMarkupMessage },
  },
  create(context) {
    const report = (node: Rule.Node) =>
      context.report({ node, messageId: "rawTooltip" })
    return {
      [tooltipDataTipSelector]: report,
      [tooltipClassLiteralSelector]: report,
      [tooltipClassTemplateSelector]: report,
    }
  },
}
