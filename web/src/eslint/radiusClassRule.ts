// Corner radii come from the theme tokens (rounded-box for panels/cards/
// modals, rounded-field for inputs/buttons, rounded-selector for badges/
// chips), so the whole product re-tunes from index.css. A raw Tailwind size
// (rounded-lg, rounded-2xl, ...) freezes one corner at a hard-coded value and
// re-introduces the competing-radii drift this rule retired. `rounded-full`
// (circles/pills) and bare `rounded`/`rounded-none` stay allowed.
//
// A class token matches at start-of-string, after whitespace, or after a
// variant colon, optionally on a logical corner axis (rounded-s-lg,
// rounded-ee-xl...). Physical axes (rounded-l-*, rounded-tr-*) are already
// banned by the directional rule.
export const radiusClassPattern =
  "(?:^|[\\s:])rounded(?:-(?:s|e|t|b|ss|se|es|ee))?" +
  "-(?:xs|sm|md|lg|xl|2xl|3xl|4xl)(?![A-Za-z0-9_-])"

export const radiusClassLiteralSelector = `JSXAttribute[name.name='className'] > Literal[value=/${radiusClassPattern}/]`

// Template-literal classNames (className={`... ${x}`}) have no Literal child;
// their static chunks are TemplateElement nodes, matched by raw value.
export const radiusClassTemplateSelector = `JSXAttribute[name.name='className'] TemplateElement[value.raw=/${radiusClassPattern}/]`

export const radiusClassMessage =
  "Raw Tailwind radius sizes drift from the theme's radius scale: use the " +
  "theme tokens instead (rounded-box for panels/cards/modals, rounded-field " +
  "for inputs/button-like controls, rounded-selector for badges/chips/small " +
  "squares). rounded-full is fine for circles and pills."
