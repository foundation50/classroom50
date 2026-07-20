// Physical directional Tailwind utilities break RTL: <html dir="rtl"> mirrors
// the layout only where spacing/positioning is expressed in logical properties
// (ms-/me-/ps-/pe-/start-/end-/text-start/border-s/rounded-s...). A class token
// is matched at start-of-string, after whitespace, or after a variant colon,
// with an optional negative prefix. Deliberately NOT matched: translate-x
// (no logical form — pair with ltr:/rtl: variants), space-x/inset-x (already
// logical in Tailwind v4), DaisyUI tooltip-left/right (no logical variant —
// pair with rtl: overrides), and grid col-start/justify-start.
//
// Kept in sync with PHYSICAL_CLASS_RE in web/src/locales/audit_i18n.py — the
// line-based CI backstop that also sees template-literal chunks in .ts class
// recipes, which these AST selectors cannot reach.
export const directionalClassPattern =
  "(?:^|[\\s:])-?(?:(?:scroll-)?[mp][lr]|left|right)-(?:\\d|\\[|auto|full|px)" +
  "|(?:^|[\\s:])text-(?:left|right)(?![A-Za-z0-9_-])" +
  "|(?:^|[\\s:])(?:border|rounded)-(?:[lr]|t[lr]|b[lr])(?![A-Za-z])" +
  "|(?:^|[\\s:])(?:float|clear)-(?:left|right)(?![A-Za-z0-9_-])"

export const directionalClassLiteralSelector = `JSXAttribute[name.name='className'] > Literal[value=/${directionalClassPattern}/]`

// Template-literal classNames (className={`... ${x}`}) have no Literal child;
// their static chunks are TemplateElement nodes, matched by raw value.
export const directionalClassTemplateSelector = `JSXAttribute[name.name='className'] TemplateElement[value.raw=/${directionalClassPattern}/]`

export const directionalClassMessage =
  "Physical directional class breaks RTL mirroring: use the logical equivalent " +
  "(ms-/me-/ps-/pe-/start-/end-/text-start/text-end/border-s/border-e/rounded-s/rounded-e). " +
  "If a physical edge is genuinely intended, add a same-line `physical-ok: <reason>` " +
  "comment (which also exempts it from the audit_i18n.py CI backstop) plus an eslint-disable."
