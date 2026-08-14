// `overflow-hidden` on a height-animating element clips anything a descendant
// paints outside the box — a tooltip bubble, a dropdown menu, a focus ring. The
// clip is REQUIRED while the height animates (content would spill from the
// shrinking box) but must be released once the element is open, which is what
// <Collapse> does. Hand-rolling the motion.div re-introduces the bug, and it
// stays invisible until someone hovers a help icon near the panel edge.
//
// Matches a motion.* opening element that has BOTH a className containing
// `overflow-hidden` AND a `variants` attribute (our height-animating variants
// are always passed that way). <Collapse> itself is exempt via an eslint-config
// override, since it owns the correct lifecycle.
//
// Two selectors because a template-literal className has no Literal child — its
// static chunks are TemplateElements — so a single selector would silently miss
// `className={`overflow-hidden ${x}`}`.
const motionWithVariants =
  "JSXOpeningElement:matches([name.type='JSXMemberExpression'][name.object.name='motion'])" +
  ":has(JSXAttribute[name.name='variants'])"

export const collapseOverflowLiteralSelector =
  motionWithVariants +
  ":has(JSXAttribute[name.name='className'] Literal[value=/\\boverflow-hidden\\b/])"

export const collapseOverflowTemplateSelector =
  motionWithVariants +
  ":has(JSXAttribute[name.name='className'] TemplateElement[value.raw=/\\boverflow-hidden\\b/])"

export const collapseOverflowMessage =
  "A height-animating motion element with `overflow-hidden` clips descendant overlays (tooltips, dropdowns, focus rings) even after it opens. Use the shared <Collapse> from @/components/ui, which drops the clip once the open animation settles."
