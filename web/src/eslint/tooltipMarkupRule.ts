import { classTokenRule } from "./classTokenRule.ts"

// daisyUI's CSS tooltip (`class="tooltip" data-tip="..."`) positions its bubble
// inside the trigger's own box, so near any edge it is cut off: by the
// viewport, by an `overflow` ancestor (modal box, scrolling table, the sidebar
// rail), or by a z-indexed sibling painting over it (issue #1026). <Tooltip>
// renders the bubble as a top-layer popover and keeps it on screen, so it is
// the only sanctioned tooltip; this rule makes the raw markup a lint error.
//
// Two shapes are caught: the `data-tip` attribute (the hook daisyUI needs to
// show anything) and the base `tooltip` class token wherever the
// `classSources` scope looks (see classTokenRule). Modifier classes
// (`tooltip-warning`) are inert without the base class and stay allowed.

// Nothing word-like after `tooltip`, so `tooltip-bubble` and `tooltip-warning`
// do not match.
export const tooltipClassPattern = "(?:^|[\\s:])tooltip(?![A-Za-z0-9_-])"

export const tooltipDataTipSelector = "JSXAttribute[name.name='data-tip']"

export const tooltipMarkupMessage =
  "Raw daisyUI tooltip markup (`tooltip` class / `data-tip`) is positioned inside its container and gets clipped or covered near an edge (see #1026). Use <Tooltip> from @/components/ui (or <HelpTooltip> for a help icon): it renders the bubble in the top layer and keeps it on screen."

export const tooltipMarkupRule = classTokenRule({
  pattern: tooltipClassPattern,
  scope: "classSources",
  description:
    "Disallow raw daisyUI tooltip markup in favor of the shared <Tooltip>",
  messageId: "rawTooltip",
  message: tooltipMarkupMessage,
  extraSelectors: [tooltipDataTipSelector],
})
